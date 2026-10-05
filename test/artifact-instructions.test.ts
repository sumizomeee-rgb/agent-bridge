import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import type { AgentAdapter, AgentName, AgentTurn } from '../src/types.js';

// Use the same spawn/stdio protocol fixture as agents.test.ts, without model or network calls.
const fakeCli = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const trace = value => fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
trace({ argv: process.argv.slice(2) });
const codex = process.argv.includes('app-server');
const input = readline.createInterface({ input: process.stdin });
let threadId = 'native-codex';
const keepAlive = setInterval(() => {}, 1000);
input.on('line', line => {
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
      setTimeout(() => {
        send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: {
          type: 'agentMessage', id: 'final', phase: 'final_answer', text: '模拟结果🙂' } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed', items: [] } } });
      }, 10);
    }
  } else if (msg.type === 'user') {
    const at = process.argv.indexOf('--resume');
    const session = at >= 0 ? process.argv[at + 1] : 'native-claude';
    send({ type: 'system', subtype: 'init', session_id: session });
    setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success',
      is_error: false, result: '模拟结果🙂', session_id: session }) + '\n', () => process.exit(0)), 10);
  }
});
input.on('close', () => { if (codex) { clearInterval(keepAlive); process.exit(0); } });
`;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const originalText = '看看这两张图 " & $(echo unexpected) %PATH%\n中文🙂';

interface Trace {
  argv?: string[];
  method?: string;
  params?: { threadId?: string; input?: unknown[]; modelProvider?: string };
  type?: string;
  session_id?: string;
  message?: { content: unknown[] };
}

async function fixture(agent: AgentName) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-raw-user-input-'));
  const cli = join(directory, 'fake cli.cjs');
  const tracePath = join(directory, 'trace.jsonl');
  const imagePaths = [join(directory, 'first image without extension'), join(directory, 'second image.png')];
  await writeFile(cli, fakeCli);
  for (const path of imagePaths) await writeFile(path, png);
  const command = { command: process.execPath, args: [cli] };
  const env = { FAKE_TRACE: tracePath };
  const adapter: AgentAdapter = agent === 'codex' ? new CodexAdapter(command, env) : new ClaudeAdapter(command, env);
  const nativeIds: string[] = [];
  const turn: AgentTurn = {
    conversation: { id: `conversation-${agent}`, userId: 'owner', agent, nativeId: `saved-${agent}`,
      title: 'test', cwd: directory, createdAt: 'now', updatedAt: 'now' },
    text: originalText, imagePaths, signal: new AbortController().signal,
    onProgress: () => {}, onNativeId: id => nativeIds.push(id),
  };
  const traces = async (): Promise<Trace[]> => (await readFile(tracePath, 'utf8')).trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line) as Trace);
  const cleanup = async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); };
  return { adapter, turn, nativeIds, traces, cleanup };
}

function originalBlocks(agent: AgentName, turn: AgentTurn): unknown[] {
  const blocks: unknown[] = [];
  if (turn.text) blocks.push(agent === 'codex'
    ? { type: 'text', text: turn.text, text_elements: [] }
    : { type: 'text', text: turn.text });
  for (const path of turn.imagePaths) blocks.push(agent === 'codex'
    ? { type: 'localImage', path }
    : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
  return blocks;
}

function sentBlocks(agent: AgentName, traces: Trace[]): unknown[] {
  const blocks = agent === 'codex'
    ? traces.find(trace => trace.method === 'turn/start')?.params?.input
    : traces.find(trace => trace.type === 'user')?.message?.content;
  assert.ok(blocks, 'user input must reach the simulated CLI');
  return blocks;
}

for (const agent of ['codex', 'claude'] as const) {
  test(`${agent}: text and image input contains only the original user content and preserves native resume`, async () => {
    const f = await fixture(agent);
    try {
      const result = await f.adapter.run(f.turn);
      const traces = await f.traces();
      assert.deepEqual(sentBlocks(agent, traces), originalBlocks(agent, f.turn));
      assert.equal(f.turn.text, originalText);
      assert.equal(result.nativeId, `saved-${agent}`);
      assert.deepEqual(f.nativeIds, [`saved-${agent}`]);
      if (agent === 'codex') {
        assert.equal(traces.find(trace => trace.method === 'thread/resume')?.params?.threadId, 'saved-codex');
        assert.equal(traces.some(trace => trace.method === 'thread/start'), false);
      } else {
        const argv = traces[0]?.argv;
        assert.ok(argv);
        assert.equal(argv[argv.indexOf('--resume') + 1], 'saved-claude');
        assert.equal(traces.find(trace => trace.type === 'user')?.session_id, 'saved-claude');
      }
    } finally { await f.cleanup(); }
  });

  test(`${agent}: image-only input has exactly the original images without an added text block`, async () => {
    const f = await fixture(agent);
    try {
      f.turn.text = '';
      await f.adapter.run(f.turn);
      assert.deepEqual(sentBlocks(agent, await f.traces()), originalBlocks(agent, f.turn));
      assert.equal(f.turn.text, '');
    } finally { await f.cleanup(); }
  });

  test(`${agent}: text-only input is one verbatim user text block`, async () => {
    const f = await fixture(agent);
    try {
      f.turn.imagePaths = [];
      await f.adapter.run(f.turn);
      assert.deepEqual(sentBlocks(agent, await f.traces()), agent === 'codex'
        ? [{ type: 'text', text: originalText, text_elements: [] }]
        : [{ type: 'text', text: originalText }]);
      assert.equal(f.turn.text, originalText);
    } finally { await f.cleanup(); }
  });

  test(`${agent}: an empty user message is rejected without submitting a task`, async () => {
    const f = await fixture(agent);
    try {
      f.turn.text = '';
      f.turn.imagePaths = [];
      await assert.rejects(f.adapter.run(f.turn), /消息没有文字或图片/);
      if (agent === 'codex') {
        assert.equal((await f.traces()).some(trace => trace.method === 'turn/start'), false);
      }
    } finally { await f.cleanup(); }
  });
}
