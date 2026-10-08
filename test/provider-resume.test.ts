import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { CodexAdapter } from '../src/agents/codex.js';
import type { AgentTurn } from '../src/types.js';

// Only this disposable local child runs. It never reads real Codex settings or credentials.
const fakeServer = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const trace = value => fs.appendFileSync(process.env.PROVIDER_TRACE, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (message, result) => send({ id: message.id, result });
const reject = (message, text) => send({ id: message.id, error: { code: -32603, message: text } });
const read = () => JSON.parse(fs.readFileSync(process.env.PROVIDER_OPTIONS, 'utf8'));
trace({ spawned: true, pid: process.pid, argv: process.argv.slice(2) });
const keepAlive = setInterval(() => {}, 1000);
let threadId = '';
let turnId = '';
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  const options = read();
  trace(message);
  if (message.method === 'initialize') { reply(message, { userAgent: 'provider-fixture' }); return; }
  if (message.method === 'config/read') {
    if (options.configMode === 'hold') return;
    if (options.configMode === 'error') { reject(message, 'fixture config read failed'); return; }
    if (options.configMode === 'malformed') { reply(message, { config: null }); return; }
    const config = { model: 'configured-model' };
    if (options.configMode !== 'missing') config.model_provider = options.provider;
    reply(message, { config });
    return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (options.threadMode === 'hold') return;
    if (options.threadMode === 'error') { reject(message, 'fixture saved thread is unavailable'); return; }
    threadId = options.returnedId || message.params.threadId || 'native-new';
    const provider = Object.hasOwn(options, 'returnedProvider') ? options.returnedProvider :
      message.params.modelProvider || options.historicalProvider || 'openai';
    const result = { thread: { id: threadId }, model: message.params.model || 'configured-model', reasoningEffort: 'medium' };
    if (options.threadMode === 'large-history' && message.method === 'thread/resume') {
      // A real resume can return old browser screenshots in one large JSON envelope.
      result.thread.turns = message.params.excludeTurns === true ? [] : [{
        id: 'historical-turn', status: 'completed', items: [{
          id: 'historical-screenshot', type: 'mcpToolCall', server: 'browser', tool: 'screenshot',
          arguments: {}, status: 'completed', result: { content: [{
            type: 'image', mimeType: 'image/png', data: 'A'.repeat(17 * 1024 * 1024),
          }] },
        }],
      }];
    }
    if (options.threadMode === 'oversized-metadata') result.thread.preview = 'x'.repeat(17 * 1024 * 1024);
    if (options.providerResponseMode !== 'missing') result.modelProvider = provider;
    reply(message, result);
    return;
  }
  if (message.method === 'turn/start') {
    turnId = 'turn-one';
    reply(message, { turn: { id: turnId } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
    if (options.turnMode === 'hold') return;
    setTimeout(() => {
      if (options.turnMode === 'error-after-tool') {
        trace({ simulatedToolExecuted: true });
        send({ method: 'item/completed', params: { threadId, turnId,
          item: { id: 'tool-one', type: 'commandExecution', status: 'completed' } } });
        send({ method: 'turn/completed', params: { threadId,
          turn: { id: turnId, status: 'failed', error: { message: 'fixture failure after tool execution' }, items: [] } } });
      } else {
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [
          { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'continued reply' }
        ] } } });
      }
    }, 10);
    return;
  }
  if (message.method === 'turn/interrupt') {
    reply(message, {});
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', items: [] } } });
  }
});
input.on('close', () => { clearInterval(keepAlive); process.exit(0); });
`;

interface FixtureOptions {
  provider?: unknown;
  configMode?: 'normal' | 'missing' | 'error' | 'hold' | 'malformed';
  historicalProvider?: string;
  returnedProvider?: unknown;
  providerResponseMode?: 'normal' | 'missing';
  returnedId?: string;
  threadMode?: 'normal' | 'error' | 'hold' | 'large-history' | 'oversized-metadata';
  turnMode?: 'normal' | 'error-after-tool' | 'hold';
}
interface Trace {
  spawned?: boolean;
  simulatedToolExecuted?: boolean;
  method?: string;
  params?: Record<string, unknown>;
}

async function fixture(t: TestContext, initial: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-provider-resume-'));
  const script = join(root, 'fake provider server.cjs');
  const optionsFile = join(root, 'options.json');
  const traceFile = join(root, 'trace.jsonl');
  let options: FixtureOptions = { provider: 'custom', historicalProvider: 'openai', ...initial };
  await writeFile(script, fakeServer);
  await writeFile(optionsFile, JSON.stringify(options));
  const adapter = new CodexAdapter({ command: process.execPath, args: [script] }, {
    PROVIDER_OPTIONS: optionsFile, PROVIDER_TRACE: traceFile,
  });
  const controller = new AbortController();
  const nativeIds: string[] = [];
  const turn: AgentTurn = {
    conversation: { id: 'bridge-original', userId: 'owner', agent: 'codex', nativeId: 'native-original',
      title: 'test', cwd: root, createdAt: 'now', updatedAt: 'now' },
    text: 'continue the saved conversation', imagePaths: [], signal: controller.signal, onProgress: () => {},
    onNativeId: id => { nativeIds.push(id); turn.conversation.nativeId = id; },
  };
  const traces = async (): Promise<Trace[]> => {
    try { return (await readFile(traceFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Trace); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const untilMethod = async (method: string) => {
    const deadline = Date.now() + 4000;
    while (!(await traces()).some(trace => trace.method === method)) {
      if (Date.now() > deadline) throw new Error(`Fixture did not receive ${method}`);
      await delay(5);
    }
  };
  t.after(async () => {
    await adapter.close();
    const cleanupRoot = resolve(root);
    assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
    assert(basename(cleanupRoot).startsWith('bridge-provider-resume-'));
    const directories = [cleanupRoot];
    while (directories.length) {
      const directory = directories.pop()!;
      assert(!(await lstat(directory)).isSymbolicLink());
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        const stat = await lstat(path);
        assert(!stat.isSymbolicLink());
        if (stat.isDirectory()) directories.push(path);
      }
    }
    await rm(cleanupRoot, { recursive: true, force: true });
  });
  return { adapter, controller, turn, nativeIds, traces, untilMethod,
    async configure(next: FixtureOptions) { options = { ...options, ...next }; await writeFile(optionsFile, JSON.stringify(options)); },
  };
}

function requests(traces: Trace[], method: string): Trace[] { return traces.filter(trace => trace.method === method); }
function noGeneratedOrNewThread(traces: Trace[]): void {
  assert.equal(requests(traces, 'turn/start').length, 0, 'A rejected resume must not submit user input');
  assert.equal(requests(traces, 'thread/start').length, 0, 'A rejected resume must not lose history by creating a new thread');
}

test('新 thread 使用本轮 config/read 的 custom provider，并保留用户模型选择', async t => {
  const f = await fixture(t);
  f.turn.conversation.nativeId = null;
  f.turn.conversation.model = 'selected-model';
  const result = await f.adapter.run(f.turn);
  assert.equal(result.nativeId, 'native-new');
  const trace = await f.traces();
  assert.deepEqual(trace.filter(item => item.method).slice(0, 4).map(item => item.method),
    ['initialize', 'initialized', 'config/read', 'thread/start']);
  assert.deepEqual(requests(trace, 'config/read')[0]!.params, { includeLayers: false, cwd: f.turn.conversation.cwd });
  assert.equal(requests(trace, 'thread/start')[0]!.params!.modelProvider, 'custom');
  assert.equal(requests(trace, 'thread/start')[0]!.params!.model, 'selected-model');
  assert.equal(Object.hasOwn(requests(trace, 'thread/start')[0]!.params!, 'excludeTurns'), false);
  assert.equal(requests(trace, 'turn/start')[0]!.params!.model, 'selected-model');
  assert.deepEqual(f.nativeIds, ['native-new']);
});

test('resume 明确覆盖历史 provider 为当前 custom，原 native ID 和上下文保持', async t => {
  const f = await fixture(t, { provider: 'custom', historicalProvider: 'openai' });
  const result = await f.adapter.run(f.turn);
  assert.deepEqual(result, { nativeId: 'native-original', text: 'continued reply' });
  const trace = await f.traces();
  const resume = requests(trace, 'thread/resume');
  assert.equal(resume.length, 1);
  assert.equal(resume[0]!.params!.modelProvider, 'custom');
  assert.equal(resume[0]!.params!.threadId, 'native-original');
  assert.equal(requests(trace, 'thread/start').length, 0);
  assert.equal(requests(trace, 'turn/start')[0]!.params!.threadId, 'native-original');
  assert.deepEqual(f.nativeIds, ['native-original']);
});

test('大量图片工具历史通过 excludeTurns 轻量续接，同 native ID/provider 且只提交一次本轮', async t => {
  const f = await fixture(t, { threadMode: 'large-history', provider: 'custom', historicalProvider: 'openai' });
  const result = await f.adapter.run(f.turn);
  assert.deepEqual(result, { nativeId: 'native-original', text: 'continued reply' });
  const trace = await f.traces();
  const resume = requests(trace, 'thread/resume');
  assert.equal(resume.length, 1);
  assert.equal(resume[0]!.params!.threadId, 'native-original');
  assert.equal(resume[0]!.params!.modelProvider, 'custom');
  assert.equal(resume[0]!.params!.excludeTurns, true);
  assert.equal(Object.hasOwn(resume[0]!.params!, 'history'), false, 'Never replace the saved history');
  assert.equal(Object.hasOwn(resume[0]!.params!, 'path'), false, 'Resume the original ID without an alternate rollout');
  assert.equal(requests(trace, 'thread/start').length, 0);
  const turns = requests(trace, 'turn/start');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.params!.threadId, 'native-original');
  assert.deepEqual(turns[0]!.params!.input, [{ type: 'text', text: f.turn.text, text_elements: [] }]);
  assert.deepEqual(f.nativeIds, ['native-original']);
  assert.equal(f.turn.conversation.nativeId, 'native-original');
});

test('excludeTurns 后其他超大元数据仍触发16MiB上限，不归咎供应商且不重建或提交本轮', async t => {
  const f = await fixture(t, { threadMode: 'oversized-metadata' });
  await assert.rejects(f.adapter.run(f.turn), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /单条输出超过限制/);
    assert.match(error.message, /原会话.*保留|保留.*原会话/);
    assert.match(error.message, /尚未提交/);
    assert.doesNotMatch(error.message, /CC Switch|供应商/);
    return true;
  });
  const trace = await f.traces();
  assert.equal(requests(trace, 'thread/resume').length, 1);
  assert.equal(requests(trace, 'thread/resume')[0]!.params!.excludeTurns, true);
  noGeneratedOrNewThread(trace);
  assert.equal(f.turn.conversation.nativeId, 'native-original');
  assert.deepEqual(f.nativeIds, []);
});

for (const mode of ['null', 'missing'] as const) {
  test(`官方默认 provider ${mode} 被显式归一化为 openai，而不是沿用历史 custom`, async t => {
    const f = await fixture(t, mode === 'null'
      ? { provider: null, historicalProvider: 'custom' }
      : { configMode: 'missing', historicalProvider: 'custom' });
    await f.adapter.run(f.turn);
    const trace = await f.traces();
    assert.equal(requests(trace, 'thread/resume')[0]!.params!.modelProvider, 'openai');
    assert.equal(f.turn.conversation.nativeId, 'native-original');
  });
}

test('同一 adapter 每轮重新读取供应商，切换供应商无需换 native ID 或新 thread', async t => {
  const f = await fixture(t);
  const first = await f.adapter.run(f.turn);
  await f.configure({ provider: null });
  const second = await f.adapter.run(f.turn);
  await f.configure({ provider: 'other-current-gateway' });
  const third = await f.adapter.run(f.turn);
  assert.deepEqual([first.nativeId, second.nativeId, third.nativeId], Array(3).fill('native-original'));
  const trace = await f.traces();
  assert.equal(requests(trace, 'config/read').length, 3);
  assert.deepEqual(requests(trace, 'thread/resume').map(item => item.params!.modelProvider),
    ['custom', 'openai', 'other-current-gateway']);
  assert.equal(requests(trace, 'thread/start').length, 0);
  assert.equal(requests(trace, 'turn/start').length, 3);
});

for (const returnedProvider of ['historical-provider', '', null, 42]) {
  test(`resume 返回 provider ${JSON.stringify(returnedProvider)} 不合法或不匹配时，不提交本轮、不覆盖原 ID`, async t => {
    const f = await fixture(t, { returnedProvider });
    await assert.rejects(f.adapter.run(f.turn), /供应商|provider/i);
    const trace = await f.traces();
    noGeneratedOrNewThread(trace);
    assert.equal(requests(trace, 'thread/resume').length, 1);
    assert.equal(f.turn.conversation.nativeId, 'native-original');
    assert.deepEqual(f.nativeIds, []);
  });
}

test('resume 未返回 provider 时不能默认为请求成功', async t => {
  const f = await fixture(t, { providerResponseMode: 'missing' });
  await assert.rejects(f.adapter.run(f.turn), /供应商|provider/i);
  noGeneratedOrNewThread(await f.traces());
  assert.deepEqual(f.nativeIds, []);
});

test('resume 意外返回其他 thread ID 时阻止保存和生成，原 ID 保留', async t => {
  const f = await fixture(t, { returnedId: 'unexpected-replacement' });
  await assert.rejects(f.adapter.run(f.turn), /会话|thread/i);
  noGeneratedOrNewThread(await f.traces());
  assert.equal(f.turn.conversation.nativeId, 'native-original');
  assert.deepEqual(f.nativeIds, []);
});

for (const options of [
  { configMode: 'error' }, { configMode: 'malformed' },
  { provider: 42 }, { provider: '' }, { provider: '   ' },
] satisfies FixtureOptions[]) {
  test(`config/read 失败或无效 ${JSON.stringify(options)} 时不使用历史 provider 或偷偷切官方`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.adapter.run(f.turn));
    const trace = await f.traces();
    noGeneratedOrNewThread(trace);
    assert.equal(requests(trace, 'thread/resume').length, 0);
    assert.deepEqual(f.nativeIds, []);
    assert.equal(f.turn.conversation.nativeId, 'native-original');
  });
}

test('真实 resume RPC 错误明确保留原会话，不自动新建、不重新生成', async t => {
  const f = await fixture(t, { threadMode: 'error' });
  await assert.rejects(f.adapter.run(f.turn), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /fixture saved thread is unavailable/);
    assert.doesNotMatch(error.message, /CC Switch|供应商/);
    assert.match(error.message, /原会话.*保留|保留.*原会话/);
    assert.match(error.message, /尚未提交/);
    return true;
  });
  const trace = await f.traces();
  assert.equal(requests(trace, 'thread/resume').length, 1);
  noGeneratedOrNewThread(trace);
  assert.equal(f.turn.conversation.nativeId, 'native-original');
  assert.deepEqual(f.nativeIds, []);
});

test('已经生成并执行模拟工具后失败，不能通过 resume/start 重放任务', async t => {
  const f = await fixture(t, { turnMode: 'error-after-tool' });
  await assert.rejects(f.adapter.run(f.turn), /fixture failure after tool execution/);
  const trace = await f.traces();
  assert.equal(requests(trace, 'config/read').length, 1);
  assert.equal(requests(trace, 'thread/resume').length, 1);
  assert.equal(requests(trace, 'thread/start').length, 0);
  assert.equal(requests(trace, 'turn/start').length, 1);
  assert.equal(trace.filter(item => item.simulatedToolExecuted).length, 1);
  assert.equal(trace.filter(item => item.spawned).length, 1);
});

test('提前 abort 不启动 CLI 或读取配置', async t => {
  const f = await fixture(t);
  f.controller.abort();
  await assert.rejects(f.adapter.run(f.turn), { name: 'AbortError' });
  assert.deepEqual(await f.traces(), []);
});

for (const method of ['config/read', 'thread/resume'] as const) {
  test(`${method} 等待期间 abort 不会迟到提交 turn/start`, async t => {
    const f = await fixture(t, method === 'config/read' ? { configMode: 'hold' } : { threadMode: 'hold' });
    const running = f.adapter.run(f.turn);
    const rejected = assert.rejects(running, { name: 'AbortError' });
    await f.untilMethod(method);
    f.controller.abort();
    await rejected;
    noGeneratedOrNewThread(await f.traces());
    assert.equal(f.turn.conversation.nativeId, 'native-original');
    assert.deepEqual(f.nativeIds, []);
  });
}

test('resume 完成后 onNativeId 边界立即 abort，也不发送本轮输入', async t => {
  const f = await fixture(t);
  f.turn.onNativeId = id => { f.nativeIds.push(id); f.controller.abort(); };
  await assert.rejects(f.adapter.run(f.turn), { name: 'AbortError' });
  noGeneratedOrNewThread(await f.traces());
  assert.deepEqual(f.nativeIds, ['native-original']);
  assert.equal(f.turn.conversation.nativeId, 'native-original');
});
