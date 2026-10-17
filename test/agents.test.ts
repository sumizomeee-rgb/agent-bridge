import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import type { AgentAdapter, AgentName, AgentTurn } from '../src/types.js';

// Fixtures exercise the real spawn/stdio transport without auth or model calls.
const fakeCli = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const trace = (value) => fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify(value) + '\n');
trace({ argv: process.argv.slice(2), proxy: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY,
  all: process.env.ALL_PROXY, noProxy: process.env.NO_PROXY, cwd: process.cwd(), taskContext: process.env.BRIDGE_TASK_CONTEXT, readonlyHome: process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const mode = process.env.FAKE_MODE;
const codex = process.argv.includes('app-server');
let threadId = 'native-codex';
const keepAlive = setInterval(() => {}, 1000);
if (mode === 'tree') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  trace({ grandchildPid: child.pid });
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const msg = JSON.parse(line);
  trace(msg);
  if (codex) {
    if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake' } });
    if (msg.method === 'config/read') send({ id: msg.id, result: { config: { model_provider: 'custom' } } });
    if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
      threadId = msg.params.threadId || 'native-codex';
      send({ id: msg.id, result: { thread: { id: threadId }, modelProvider: msg.params.modelProvider } });
    }
    if (msg.method === 'turn/start') {
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } });
      send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
      if (mode === 'hang' || mode === 'tree') return;
      setTimeout(() => {
        if (mode === 'disconnect') { process.exit(7); return; }
        if (mode === 'invalid') { process.stdout.write('not json\n'); return; }
        if (mode === 'error') {
          send({ method: 'turn/completed', params: { threadId, turn: {
            id: 'turn-1', status: 'failed', error: { message: 'fake model failure' }, items: [] } } });
          return;
        }
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn-1', delta: '正在处理图片🙂' } });
        send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: {
          type: 'agentMessage', id: 'comment', phase: 'commentary', text: '这段只是进展' } } });
        send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: {
          type: 'agentMessage', id: 'final', phase: 'final_answer', text: '最终答案🙂' } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [] } } });
      }, 20);
    }
    if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'interrupted', items: [] } } });
    }
  } else if (msg.type === 'user') {
    const at = process.argv.indexOf('--resume');
    const session = at >= 0 ? process.argv[at + 1] : 'native-claude';
    send({ type: 'system', subtype: 'init', session_id: session });
    if (mode === 'hang' || mode === 'tree') return;
    setTimeout(() => {
      if (mode === 'disconnect') { process.exit(7); return; }
      if (mode === 'invalid') { process.stdout.write('not json\n'); return; }
      send({ type: 'stream_event', parent_tool_use_id: 'subagent-tool', event: {
        type: 'content_block_delta', delta: { type: 'text_delta', text: '子代理消息不转发' } } });
      send({ type: 'stream_event', parent_tool_use_id: null, event: {
        type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude 处理中🙂' } } });
      const result = mode === 'error'
        ? { type: 'result', subtype: 'error_during_execution', is_error: true,
            errors: ['fake billing error Bearer very-secret-value'], session_id: session }
        : { type: 'result', subtype: 'success', is_error: false, result: 'Claude 最终答案🙂', session_id: session };
      process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
    }, 20);
  }
});
input.on('close', () => { if (codex) { clearInterval(keepAlive); process.exit(0); } });
`;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

async function fixture(agent: AgentName, mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-agents-'));
  const cli = join(directory, 'fake cli.cjs');
  const tracePath = join(directory, 'trace.jsonl');
  const image = join(directory, 'image without extension');
  await writeFile(cli, fakeCli);
  await writeFile(image, png);
  const env = {
    FAKE_TRACE: tracePath, FAKE_MODE: mode, HTTPS_PROXY: 'http://127.0.0.1:7898',
    HTTP_PROXY: 'http://127.0.0.1:7898', ALL_PROXY: 'http://127.0.0.1:7898', NO_PROXY: 'localhost,127.0.0.1,10.101.0.8',
  };
  const command = { command: process.execPath, args: [cli] };
  const adapter: AgentAdapter = agent === 'codex' ? new CodexAdapter(command, env) : new ClaudeAdapter(command, env);
  const controller = new AbortController();
  const progress: string[] = [];
  const nativeIds: string[] = [];
  const turn: AgentTurn = {
    conversation: { id: `conversation-${agent}`, userId: 'owner', agent, nativeId: null,
      title: 'test', cwd: directory, createdAt: 'now', updatedAt: 'now' },
    text: '引号 " & $(echo unexpected) %PATH% 中文🙂', imagePaths: [image], signal: controller.signal,
    onProgress: (text) => progress.push(text), onNativeId: (id) => nativeIds.push(id),
  };
  const traces = async (): Promise<Record<string, any>[]> => {
    try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const waitStarted = async () => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const messages = await traces();
      if (messages.some((message) => agent === 'codex' ? message.method === 'turn/start' : message.type === 'user') && nativeIds.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('fake turn did not start');
  };
  const cleanup = async () => { await adapter.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); };
  return { adapter, controller, turn, progress, nativeIds, traces, waitStarted, cleanup, image, env, command };
}

for (const agent of ['codex', 'claude'] as const) {
  test(`${agent} 的任务登记上下文只属于本轮，CLI 工具可读取且不会泄漏到下一轮`, async () => {
    const f = await fixture(agent);
    const inherited = process.env.BRIDGE_TASK_CONTEXT;
    try {
      const context = join(f.turn.conversation.cwd, '本轮 context.json');
      await f.adapter.run({ ...f.turn, taskContextPath: context });
      await f.adapter.run(f.turn);
      const launches = (await f.traces()).filter(value => Array.isArray(value.argv));
      assert.equal(launches.length, 2);
      assert.equal(launches[0]!.taskContext, context);
      assert.equal(launches[1]!.taskContext, inherited);
      assert.equal(process.env.BRIDGE_TASK_CONTEXT, inherited);
    } finally { await f.cleanup(); }
  });
}

test('Codex 新会话：图片、最高权限、显式代理、先保存 ID，再返回最终回答', async () => {
  const f = await fixture('codex');
  try {
    const result = await f.adapter.run(f.turn);
    assert.deepEqual(result, { nativeId: 'native-codex', text: '最终答案🙂' });
    assert.deepEqual(f.nativeIds, ['native-codex']);
    assert.deepEqual(f.progress, ['正在处理图片🙂']);
    const traces = await f.traces();
    const header = traces[0]!;
    assert.equal(header.proxy, 'http://127.0.0.1:7898');
    assert.equal(header.http, header.proxy);
    assert.equal(header.all, header.proxy);
    assert.equal(header.noProxy, 'localhost,127.0.0.1,10.101.0.8');
    assert.equal(header.cwd, f.turn.conversation.cwd);
    assert.deepEqual(header.argv, ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(traces.slice(1, 3).map((message) => message.method), ['initialize', 'initialized']);
    const start = traces.find((message) => message.method === 'thread/start')!.params;
    assert.equal(start.approvalPolicy, 'never');
    assert.equal(start.sandbox, 'danger-full-access');
    const input = traces.find((message) => message.method === 'turn/start')!.params;
    assert.deepEqual(input.input, [{ type: 'text', text: f.turn.text, text_elements: [] }, { type: 'localImage', path: f.image }]);
    assert.deepEqual(input.sandboxPolicy, { type: 'dangerFullAccess' });
  } finally { await f.cleanup(); }
});

test('Claude 新会话：stdin 图片 base64 和 MIME、显式代理、过滤子代理进展', async () => {
  const f = await fixture('claude');
  try {
    assert.deepEqual(await f.adapter.run(f.turn), { nativeId: 'native-claude', text: 'Claude 最终答案🙂' });
    assert.deepEqual(f.nativeIds, ['native-claude']);
    assert.deepEqual(f.progress, ['Claude 处理中🙂']);
    const traces = await f.traces();
    assert.equal(traces[0]!.proxy, 'http://127.0.0.1:7898');
    assert(traces[0]!.argv.includes('--dangerously-skip-permissions'));
    assert(traces[0]!.argv.includes('--input-format'));
    assert(!traces[0]!.argv.includes(f.turn.text));
    const user = traces.find((message) => message.type === 'user')!;
    assert.deepEqual(user.message.content, [
      { type: 'text', text: f.turn.text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    ]);
  } finally { await f.cleanup(); }
});

for (const agent of ['codex', 'claude'] as const) {
  test(`${agent} 使用保存的原生 ID 续接，纯图片消息也成立`, async () => {
    const f = await fixture(agent);
    try {
      f.turn.conversation.nativeId = 'saved-native-id';
      f.turn.text = '';
      const result = await f.adapter.run(f.turn);
      assert.equal(result.nativeId, 'saved-native-id');
      assert.deepEqual(f.nativeIds, ['saved-native-id']);
      const traces = await f.traces();
      if (agent === 'codex') {
        assert(!traces.some((message) => message.method === 'thread/start'));
        assert.equal(traces.find((message) => message.method === 'thread/resume')!.params.threadId, 'saved-native-id');
        assert.deepEqual(traces.find((message) => message.method === 'turn/start')!.params.input, [{ type: 'localImage', path: f.image }]);
      } else {
        const argv: string[] = traces[0]!.argv;
        assert.equal(argv[argv.indexOf('--resume') + 1], 'saved-native-id');
        assert.equal(traces.find((message) => message.type === 'user')!.session_id, 'saved-native-id');
      }
    } finally { await f.cleanup(); }
  });

  test(`${agent} AbortSignal 中止运行中的进程${agent === 'codex' ? '，同时发送 interrupt' : ''}`, async () => {
    const f = await fixture(agent, 'hang');
    try {
      const running = f.adapter.run(f.turn);
      const rejected = assert.rejects(running, { name: 'AbortError' });
      await f.waitStarted();
      assert.equal(f.nativeIds.length, 1, 'ID is available before completion');
      f.controller.abort();
      await rejected;
      if (agent === 'codex') assert((await f.traces()).some((message) => message.method === 'turn/interrupt'));
    } finally { await f.cleanup(); }
  });

  test(`${agent} 主动 interrupt 可取消，而且 close 阻止后续启动`, async () => {
    const f = await fixture(agent, 'hang');
    try {
      const running = f.adapter.run(f.turn);
      const rejected = assert.rejects(running, { name: 'AbortError' });
      await f.waitStarted();
      await f.adapter.interrupt(f.turn.conversation.id);
      await rejected;
      await f.adapter.close();
      await assert.rejects(f.adapter.run(f.turn), /已关闭/);
    } finally { await f.cleanup(); }
  });

  test(`${agent} 意外进程断线不会返回成功或永久等待`, async () => {
    const f = await fixture(agent, 'disconnect');
    try { await assert.rejects(f.adapter.run(f.turn), /进程已断开/); }
    finally { await f.cleanup(); }
  });

  test(`${agent} Agent 失败结果传播，错误文本不暴露 bearer`, async () => {
    const f = await fixture(agent, 'error');
    try {
      await assert.rejects(f.adapter.run(f.turn), (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /执行失败/);
        assert(!error.message.includes('very-secret-value'));
        return true;
      });
    } finally { await f.cleanup(); }
  });

  test(`${agent} 损坏 JSON 明确失败并清理进程`, async () => {
    const f = await fixture(agent, 'invalid');
    try { await assert.rejects(f.adapter.run(f.turn), /不是有效 JSON/); }
    finally { await f.cleanup(); }
  });

  test(`${agent} 已取消消息不启动 CLI`, async () => {
    const f = await fixture(agent);
    try {
      f.controller.abort();
      await assert.rejects(f.adapter.run(f.turn), { name: 'AbortError' });
      assert.deepEqual(await f.traces(), []);
    } finally { await f.cleanup(); }
  });

  test(`${agent} 同一会话运行时拒绝第二次并发，close 清理活动任务`, async () => {
    const f = await fixture(agent, 'hang');
    try {
      const running = f.adapter.run(f.turn);
      const rejected = assert.rejects(running, { name: 'AbortError' });
      await f.waitStarted();
      await assert.rejects(f.adapter.run(f.turn), /仍在执行/);
      await f.adapter.close();
      await rejected;
    } finally { await f.cleanup(); }
  });

  test(`${agent} 取消会清理 CLI 启动的子进程`, async () => {
    const f = await fixture(agent, 'tree');
    let childPid: number | undefined;
    try {
      const running = f.adapter.run(f.turn);
      const rejected = assert.rejects(running, { name: 'AbortError' });
      await f.waitStarted();
      childPid = (await f.traces()).find((message) => typeof message.grandchildPid === 'number')!.grandchildPid;
      assert(childPid);
      process.kill(childPid, 0);
      f.controller.abort();
      await rejected;
      assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' });
    } finally {
      // This PID belongs only to the disposable fake fixture.
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
      await f.cleanup();
    }
  });

  test(`${agent} CLI 可执行文件缺失会明确失败`, async () => {
    const f = await fixture(agent);
    const command = { command: join(f.turn.conversation.cwd, 'missing-cli.exe'), args: [] };
    const adapter = agent === 'codex' ? new CodexAdapter(command, {}) : new ClaudeAdapter(command, {});
    try { await assert.rejects(adapter.run(f.turn), /无法启动 Agent 进程/); }
    finally { await adapter.close(); await f.cleanup(); }
  });
}


for (const agent of ['codex', 'claude'] as const) test(`${agent}的摘要只读模式隔离工具配置和任务票据，普通执行权限不变`, async () => {
  const f = await fixture(agent);
  const home = join(f.turn.conversation.cwd, 'fake-source-home'); await mkdir(home);
  Object.assign(f.env, { USERPROFILE: f.turn.conversation.cwd, HOME: f.turn.conversation.cwd,
    ...(agent === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }) });
  if (agent === 'codex') await writeFile(join(home, 'config.toml'), '[mcp_servers.dangerous]\ncommand="never-run"\n[features]\nhooks=true\n');
  else await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://fake-gateway.invalid' }, hooks: { SessionStart: ['never-run'] }, enabledPlugins: { 'dangerous@plugin': true } }));
  try {
    await f.adapter.run({ ...f.turn, readOnly: true });
    const traces = await f.traces(), launch = traces[0]!;
    assert.notEqual(launch.readonlyHome, home); assert.equal(launch.taskContext, undefined);
    await assert.rejects(readFile(join(launch.readonlyHome, agent === 'codex' ? 'config.toml' : 'settings.json')), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    if (agent === 'codex') {
      assert.equal(traces.find(value => value.method === 'thread/start')!.params.sandbox, 'read-only');
      assert.deepEqual(traces.find(value => value.method === 'turn/start')!.params.sandboxPolicy, { type: 'readOnly' });
      assert(launch.argv.includes('mcp_servers={}')); assert(launch.argv.includes('agents.enabled=false'));
    } else {
      const args: string[] = launch.argv;
      assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
      assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
      assert(args.includes('--strict-mcp-config')); assert(args.includes('--no-chrome')); assert(args.includes('--disable-slash-commands'));
      assert.equal(args[args.indexOf('--setting-sources') + 1], '');
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
      assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://fake-gateway.invalid'); assert.equal(settings.hooks, undefined); assert.equal(settings.enabledPlugins, undefined);
    }
    await assert.rejects(f.adapter.run({ ...f.turn, readOnly: true, taskContextPath: 'cannot-pass-ticket' }), /任务登记权限/);
    await assert.rejects(f.adapter.run({ ...f.turn, readOnly: true, conversation: { ...f.turn.conversation, nativeId: 'old-controller' } }), /独立的新会话/);
  } finally { await f.cleanup(); }
});
