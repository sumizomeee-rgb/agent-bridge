import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter } from '../src/agents/codex.js';
import type { JsonObject, RpcTransport } from '../src/agents/process.js';
import type { AgentTurn } from '../src/types.js';

class Transport implements RpcTransport {
  messages = new Set<(message: JsonObject) => void>();
  failures = new Set<(error: Error) => void>();
  writes: JsonObject[] = [];
  mode = 'success';
  onMessage(listener: (message: JsonObject) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onFailure(listener: (error: Error) => void) { this.failures.add(listener); return () => { this.failures.delete(listener); }; }
  emit(message: JsonObject) { for (const listener of this.messages) listener(message); }
  fail() { for (const listener of this.failures) listener(new Error('连接断开')); }
  write(message: JsonObject) {
    this.writes.push(message);
    const result = (value: JsonObject) => this.emit({ id: message.id, result: value });
    switch (message.method) {
      case 'initialize': result({}); break;
      case 'config/read': result({ config: { model_provider: 'openai' } }); break;
      case 'thread/start': result({ thread: { id: 'thread-1' }, modelProvider: 'openai' }); break;
      case 'turn/start':
        this.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
        result({ turn: { id: 'turn-1' } }); break;
      case 'turn/steer':
        if (this.mode === 'unsupported') this.emit({ id: message.id, error: { code: -32601, message: 'Method not found' } });
        else if (this.mode === 'invalid-request') this.emit({ id: message.id, error: { code: -32600, message: 'Invalid request: no active turn' } });
        else if (this.mode === 'finished') this.emit({ id: message.id, error: { code: -32602, message: 'No active turn' } });
        else if (this.mode === 'internal') this.emit({ id: message.id, error: { code: -32603, message: 'internal error' } });
        else if (this.mode === 'invalid') result({ turnId: 'other-turn' });
        else if (this.mode === 'disconnect') this.fail();
        else if (this.mode === 'hang') break;
        else result({ turnId: 'turn-1' });
        break;
      case 'turn/interrupt': result({}); break;
    }
  }
  complete() { this.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } }); }
  async stop() {}
}
async function fixture() {
  const transport = new Transport();
  const adapter = new CodexAdapter({ command: 'unused', args: [] }, {}, () => transport);
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const controller = new AbortController();
  const turn: AgentTurn = { conversation: { id: 'bridge-1', userId: 'u', agent: 'codex', nativeId: null,
    title: '', cwd: process.cwd(), createdAt: '', updatedAt: '' }, text: 'first', imagePaths: [],
    signal: controller.signal, onProgress: () => {}, onReady: ready };
  const run = adapter.run(turn);
  void run.catch(() => undefined);
  await readiness;
  const supplement = { id: 'discord-2', input: [{ type: 'text' as const, text: '补充' }, { type: 'localImage' as const, path: 'image' }] };
  return { transport, adapter, run, supplement, controller };
}

test('Codex steer 使用经核验的官方字段和有序输入，复用同一活动 transport', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.adapter.steer('bridge-1', f.supplement), { status: 'accepted' });
    assert.deepEqual(f.transport.writes.find(value => value.method === 'turn/steer')?.params, {
      threadId: 'thread-1', expectedTurnId: 'turn-1', input: [
        { type: 'text', text: '补充', text_elements: [] }, { type: 'localImage', path: 'image' },
      ],
    });
    assert.equal(f.transport.writes.filter(value => value.method === 'turn/start').length, 1);
    f.transport.complete();
    await f.run;
    assert.deepEqual(await f.adapter.steer('bridge-1', f.supplement), { status: 'queued' });
    assert.equal(f.transport.writes.filter(value => value.method === 'turn/steer').length, 1);
  } finally { await f.adapter.close(); }
});

for (const mode of ['unsupported', 'finished', 'invalid-request', 'internal', 'invalid', 'disconnect']) {
  test(`Codex steer ${mode} 区分安全排队和结果不确定，绝不盲重试`, async () => {
    const f = await fixture();
    try {
      f.transport.mode = mode;
      const result = await f.adapter.steer('bridge-1', f.supplement);
      assert.equal(result.status, ['unsupported', 'finished', 'invalid-request'].includes(mode) ? 'queued' : 'uncertain');
      assert.equal(f.transport.writes.filter(value => value.method === 'turn/steer').length, 1);
      if (mode === 'disconnect') await assert.rejects(f.run, /断开/);
      else { f.transport.complete(); await f.run; }
    } finally { await f.adapter.close(); }
  });
}

test('Codex 完成通知后即使 transport 尚未清理也不会发 steer；取消后不再提交', async () => {
  const f = await fixture();
  f.transport.complete();
  assert.deepEqual(await f.adapter.steer('bridge-1', f.supplement), { status: 'queued' });
  await f.run;
  await f.adapter.close();
  const cancelled = await fixture();
  cancelled.controller.abort();
  assert.deepEqual(await cancelled.adapter.steer('bridge-1', cancelled.supplement), { status: 'queued' });
  await assert.rejects(cancelled.run, { name: 'AbortError' });
  await cancelled.adapter.close();
});

test('在途 steer 未获确认时连接关闭返回 uncertain，不冒充明确拒绝', async () => {
  const f = await fixture();
  f.transport.mode = 'hang';
  const supplement = f.adapter.steer('bridge-1', f.supplement);
  f.transport.complete();
  await f.run;
  assert.equal((await supplement).status, 'uncertain');
  await f.adapter.close();
});
