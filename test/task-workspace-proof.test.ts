import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRegistry, signTaskCompletion, type TaskContextFile, type TaskOrigin, type TaskTicket } from '../src/tasks.js';

function fixture(t: TestContext, changes: Partial<TaskOrigin> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-workspace-proof-'));
  const registry = new TaskRegistry(root);
  t.after(() => { registry.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); });
  const target = { id: 'parent', userId: 'owner', agent: 'codex' as const, cwd: root, nativeId: 'native' };
  const origin: TaskOrigin = { conversationId: target.id, userId: target.userId, agent: target.agent, cwd: target.cwd,
    nativeId: target.nativeId, channelId: 'original-private', originMessageId: 'original-new', purpose: 'workspace-context', ...changes };
  const created = registry.createContext(origin);
  const context = JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile;
  const task = registry.register(context, '初始化工作区');
  const ticket = JSON.parse(readFileSync(task.ticketPath, 'utf8')) as TaskTicket;
  const complete = (status: 'completed' | 'failed' = 'completed') => {
    registry.acceptReceipt(signTaskCompletion(ticket, status, '初始化结果'));
    const event = registry.getNextEvent()!; assert.ok(event); assert.equal(registry.claimEvent(event.id), true);
    return event;
  };
  return { registry, target, origin, complete };
}

test('初始化完成证明只认可已完成且已交付事件，查询不会改变状态或生成任务', t => {
  const f = fixture(t);
  assert.equal(f.registry.completedWorkspaceInitialization(f.target), null);
  const event = f.complete();
  assert.equal(f.registry.completedWorkspaceInitialization(f.target), null);
  f.registry.markDelivered(event.id);
  const proof = { originMessageId: 'original-new', channelId: 'original-private' };
  assert.deepEqual(f.registry.completedWorkspaceInitialization(f.target), proof);
  assert.deepEqual(f.registry.completedWorkspaceInitialization(f.target), proof);
  assert.equal(f.registry.eventState(event.id), 'delivered');
  assert.equal(f.registry.activeCount(f.target.id), 0);
  assert.deepEqual(f.registry.queuedEvents(), []);
});

test('初始化完成证明不跨用户、会话、Agent、目录或原生会话，也不认可失败任务', t => {
  const f = fixture(t); const event = f.complete(); f.registry.markDelivered(event.id);
  for (const change of [{ id: 'other' }, { userId: 'other' }, { agent: 'claude' as const }, { cwd: join(f.target.cwd, 'other') }, { nativeId: 'other' }, { nativeId: null }]) {
    assert.equal(f.registry.completedWorkspaceInitialization({ ...f.target, ...change }), null);
  }
  const failed = fixture(t); const failure = failed.complete('failed'); failed.registry.markDelivered(failure.id);
  assert.equal(failed.registry.completedWorkspaceInitialization(failed.target), null);
});

test('旧初始化任务可在原生ID未回填时证明完成，普通后台结果不能冒充初始化', t => {
  const legacy = fixture(t, { nativeId: null }); const done = legacy.complete(); legacy.registry.markDelivered(done.id);
  assert.deepEqual(legacy.registry.completedWorkspaceInitialization(legacy.target), { originMessageId: 'original-new', channelId: 'original-private' });
  const ordinary = fixture(t, { purpose: undefined }); const result = ordinary.complete(); ordinary.registry.markDelivered(result.id);
  assert.equal(ordinary.registry.completedWorkspaceInitialization(ordinary.target), null);
});
