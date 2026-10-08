import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskRegistry, TaskService, signTaskCompletion, type TaskContextFile, type TaskTicket } from '../src/tasks.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tasks-test-'));
  const registry = new TaskRegistry(dir);
  const created = registry.createContext({ conversationId: 'parent-A', userId: 'user-A', channelId: 'dm-A',
    originMessageId: 'message-A', nativeId: null, agent: 'codex', cwd: dir });
  const context = JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile;
  const registered = registry.register(context, '工位只读检查');
  const ticket = JSON.parse(readFileSync(registered.ticketPath, 'utf8')) as TaskTicket;
  return { dir, registry, context, registered, ticket };
}

test('task tickets contain no parent/Discord identity; native binding is filled once and receipt routes to original parent', () => {
  const { registry, context, registered, ticket } = fixture();
  try {
    assert.deepEqual(Object.keys(ticket).sort(), ['taskId', 'token', 'version']);
    registry.updateNativeId(context.contextId, 'native-A');
    assert.throws(() => registry.updateNativeId(context.contextId, 'native-B'), /不可替换/);
    registry.closeContext(context.contextId);
    assert.throws(() => registry.register(context, 'late registration'), /本轮已结束/);
    assert.equal(registry.activeCount('parent-A'), 1);
    assert.equal(registry.acceptReceipt(signTaskCompletion(ticket, 'completed', 'sum=50')), true);
    const event = registry.getNextEvent('parent-A')!;
    assert.equal(event.nativeId, 'native-A'); assert.equal(event.channelId, 'dm-A');
    assert.equal(event.originMessageId, 'message-A'); assert.equal(event.taskId, registered.taskId);
    assert.match(event.text, /不是用户的新指令/); assert.match(event.text, /sum=50/);
    assert.equal(registry.getNextEvent('parent-B'), null); assert.equal(registry.activeCount('parent-A'), 0);
  } finally { registry.close(); }
});

test('unknown tasks, forged payloads, bad signatures and unsafe watches are rejected', () => {
  const { registry, context, registered, ticket } = fixture();
  try {
    const valid = signTaskCompletion(ticket, 'completed', 'safe');
    assert.throws(() => registry.acceptReceipt({ ...valid, payload: valid.payload.replace('safe', 'unsafe') }), /签名/);
    assert.throws(() => registry.acceptReceipt({ ...valid, signature: '0'.repeat(64) }), /签名/);
    assert.throws(() => registry.acceptReceipt(signTaskCompletion({ ...ticket, taskId: 'unknown' }, 'completed', 'x')), /未登记/);
    assert.throws(() => registry.setWatch(context, registered.taskId, { completionFile: 'relative.json' }), /绝对路径/);
    assert.throws(() => registry.setWatch(context, registered.taskId, { completionFile: 'x', sshConfig: 'x', sshHost: '-bad' }), /别名/);
    assert.equal(registry.getNextEvent(), null);
  } finally { registry.close(); }
});

test('terminal receipts deduplicate and restart recovers queued events but never reruns processing', () => {
  const { dir, registry, ticket } = fixture();
  const receipt = signTaskCompletion(ticket, 'completed', 'done');
  registry.acceptReceipt(receipt); registry.close();
  const restarted = new TaskRegistry(dir);
  try {
    assert.equal(restarted.acceptReceipt(receipt), false);
    const event = restarted.getNextEvent()!;
    assert.equal(restarted.claimEvent(event.id), true); assert.equal(restarted.claimEvent(event.id), false);
    const unknown = restarted.recoverProcessingEvents();
    assert.equal(unknown.length, 1); assert.equal(restarted.eventState(event.id), 'uncertain');
    assert.equal(restarted.getNextEvent(), null);
    restarted.markUncertainNotified(event.id);
    assert.equal(restarted.recoverProcessingEvents().length, 0);
  } finally { restarted.close(); }
});

test('stop disables parent wake without claiming to terminate remote work; a late result remains reportable', () => {
  const { registry, context, ticket } = fixture();
  try {
    registry.cancelConversation('parent-A');
    assert.equal(registry.activeCount('parent-A'), 1);
    assert.throws(() => registry.register(context, 'late'), /本轮已结束/);
    registry.acceptReceipt(signTaskCompletion(ticket, 'failed', 'remote error'));
    const event = registry.getNextEvent()!;
    assert.equal(event.wakeAllowed, false); assert.equal(event.status, 'failed');
    assert.equal(registry.activeCount('parent-A'), 0);
  } finally { registry.close(); }
});

test('watching waits for a nonempty valid exit marker and result, truncates output, and reports count changes', async () => {
  const { dir, registry, context, registered } = fixture();
  const exitFile = join(dir, 'exit.txt'); const resultFile = join(dir, 'result.txt');
  registry.setWatch(context, registered.taskId, { exitFile, resultFile });
  writeFileSync(exitFile, '');
  const counts: number[] = []; const events: string[] = [];
  const service = new TaskService(registry, { onCountChanged: (_id, count) => { counts.push(count); },
    onCompletion: event => { events.push(event.id); } });
  try {
    await service.poll(); assert.deepEqual(counts, [1]); assert.equal(events.length, 0);
    writeFileSync(exitFile, 'unfinished'); await service.poll(); assert.equal(events.length, 0);
    writeFileSync(exitFile, '0'); await service.poll(); assert.equal(events.length, 0);
    writeFileSync(resultFile, 'x'.repeat(30 * 1024)); await service.poll();
    assert.deepEqual(counts, [1, 0]); assert.equal(events.length, 1);
    assert.match(registry.getNextEvent()!.text, /截断/);
    assert.ok(registry.getNextEvent()!.text.length < 18 * 1024);
    await service.poll(); assert.equal(events.length, 1);
  } finally { await service.close(); registry.close(); }
});

test('remote signed receipt is authenticated and persists until manager claims it', async () => {
  const { dir, registry, context, registered, ticket } = fixture();
  registry.setWatch(context, registered.taskId, { sshConfig: join(dir, 'ssh_config'), sshHost: 'workstation', completionFile: "E:\\task's output\\done.json" });
  const receipt = signTaskCompletion(ticket, 'completed', 'five rows');
  const service = new TaskService(registry, { probe: async () => ({ completion: JSON.stringify(receipt) }) });
  try {
    await service.poll(); assert.equal(registry.getNextEvent()!.status, 'completed');
    assert.equal(registry.getNextEvent()!.nativeId, null);
    registry.updateNativeId(context.contextId, 'native-final');
    assert.equal(registry.getNextEvent()!.nativeId, 'native-final');
  } finally { await service.close(); registry.close(); }
});

test('a failed remote worker with no result still reports failure instead of hanging forever', async () => {
  const { dir, registry, context, registered } = fixture();
  registry.setWatch(context, registered.taskId, { exitFile: join(dir, 'exit.txt'), resultFile: join(dir, 'absent.txt') });
  writeFileSync(join(dir, 'exit.txt'), '127');
  const service = new TaskService(registry);
  try {
    await service.poll();
    assert.equal(registry.activeCount('parent-A'), 0);
    assert.equal(registry.getNextEvent()!.status, 'failed');
    assert.match(registry.getNextEvent()!.text, /127/);
  } finally { await service.close(); registry.close(); }
});

test('explicit startup recovery closes stale contexts; service boot republishes count without closing new contexts', async () => {
  const { registry, context } = fixture();
  const counts: number[] = [];
  const service = new TaskService(registry, { pollIntervalMs: 10, onCountChanged: (_id, count) => { counts.push(count); } });
  try {
    registry.recoverContexts();
    const newContext = registry.createContext({ conversationId: 'recovered-parent', userId: 'user-A', channelId: 'dm-A',
      originMessageId: 'message-A', nativeId: 'new-native', agent: 'codex', cwd: tmpdir() });
    service.start(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(counts, [1]);
    assert.throws(() => registry.register(context, 'stale registration'), /本轮已结束/);
    assert.doesNotThrow(() => registry.register(JSON.parse(readFileSync(newContext.contextPath, 'utf8')), 'new live context'));
  } finally { await service.close(); registry.close(); }
});

test('service close during a pending probe does not dispatch new completion events', async () => {
  const { dir, registry, context, registered, ticket } = fixture();
  registry.setWatch(context, registered.taskId, { completionFile: join(dir, 'done.json') });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const service = new TaskService(registry, { probe: async () => { await gate; return { completion: JSON.stringify(signTaskCompletion(ticket, 'completed', 'done')) }; },
    onCompletion: event => { events.push(event.id); } });
  try {
    service.start(); await new Promise(resolve => setTimeout(resolve, 10));
    const closing = service.close(); release(); await closing;
    assert.equal(events.length, 0);
    assert.equal(registry.getNextEvent()!.status, 'completed');
  } finally { await service.close(); registry.close(); }
});
