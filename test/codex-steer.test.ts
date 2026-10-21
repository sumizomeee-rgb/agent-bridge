import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter } from '../src/agents/codex.js';
import { completedResultFromError } from '../src/agents/process.js';
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
  return { transport, adapter, run, supplement, controller, turn };
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


test('Codex reports native item lifecycle only, without deltas, commands or other thread events', async () => {
  const f = await fixture(); const activities: unknown[] = [];
  f.turn.onActivity = activity => activities.push(activity);
  const emit = (method: string, item: JsonObject, threadId = 'thread-1') => f.transport.emit({ method, params: { threadId, turnId: 'turn-1', item } });
  try {
    emit('item/started', { id: 'foreign', type: 'commandExecution', command: 'secret' }, 'other-thread');
    emit('item/started', { id: 'reasoning', type: 'reasoning', summary: ['PRIVATE THOUGHT'] });
    emit('item/started', { id: 'tool', type: 'mcpToolCall', tool: 'browser', server: 'chrome', arguments: { password: 'SECRET' } });
    emit('item/started', { id: 'tool', type: 'mcpToolCall', tool: 'browser' });
    f.transport.emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'PRIVATE OUTPUT' } });
    emit('item/completed', { id: 'tool', type: 'mcpToolCall', tool: 'browser', status: 'failed', result: 'PRIVATE OUTPUT' });
    emit('item/completed', { id: 'tool', type: 'mcpToolCall', tool: 'browser', status: 'failed' });
    f.transport.complete(); await f.run;
    assert.deepEqual(activities.map(value => (value as { type: string }).type), ['reasoning', 'tool-started', 'tool-completed']);
    assert.equal((activities[1] as { toolName: string }).toolName, 'browser');
    assert.equal((activities[2] as { status: string }).status, 'failed');
    assert.equal(JSON.stringify(activities).includes('PRIVATE'), false); assert.equal(JSON.stringify(activities).includes('SECRET'), false);
  } finally { await f.adapter.close(); }
});


test('Codex retains the final report and releases subscriptions when CLI shutdown is unconfirmed', async () => {
  const f = await fixture(); let refuse = true;
  f.transport.stop = async () => { if (refuse) throw new Error('cleanup did not confirm exit'); };
  try {
    f.transport.emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'report', type: 'agentMessage', phase: 'final_answer', text: '已保存修改，验收仍待核对' } } });
    f.transport.complete();
    await assert.rejects(f.run, error => {
      assert(error instanceof Error && 'processStillRunning' in error);
      assert.deepEqual(completedResultFromError(error), { nativeId: 'thread-1', text: '已保存修改，验收仍待核对' });
      return true;
    });
    assert.equal(f.transport.messages.size, 0); assert.equal(f.transport.failures.size, 0);
    assert.deepEqual(await f.adapter.steer('bridge-1', f.supplement), { status: 'queued' });
    await assert.rejects(f.adapter.run(f.turn), /仍在执行/);
    assert.equal(f.transport.writes.filter(value => value.method === 'turn/start').length, 1);
    refuse = false; await f.adapter.interrupt('bridge-1');
  } finally { refuse = false; await f.adapter.close(); }
});


for (const status of ['failed', 'interrupted']) test(`Codex terminal ${status} retires gracefully while preserving its original failure`, async () => {
  const f = await fixture(), modes: boolean[] = [];
  f.transport.stop = async (graceful?: boolean) => { modes.push(graceful === true); };
  try {
    f.transport.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status,
      error: { message: 'native terminal failure' }, items: [] } } });
    if (status === 'interrupted') await assert.rejects(f.run, { name: 'AbortError' });
    else await assert.rejects(f.run, /native terminal failure/);
    assert.deepEqual(modes, [true]); assert.equal(await f.adapter.confirmStopped('bridge-1'), true);
    assert.equal(f.transport.writes.filter(value => value.method === 'turn/start').length, 1);
  } finally { await f.adapter.close(); }
});
