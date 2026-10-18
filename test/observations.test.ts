import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { TaskRegistry, type TaskContextFile } from '../src/tasks.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';

function registryFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-progress-observation-'));
  let registry = new TaskRegistry(root);
  const context = registry.createContext({ userId: 'u', conversationId: 'parent', channelId: 'dm', originMessageId: 'human', nativeId: 'native', cwd: root, agent: 'codex' });
  const credential = JSON.parse(readFileSync(context.contextPath, 'utf8')) as TaskContextFile;
  const task = registry.register(credential, 'browser');
  t.after(() => { registry.close(); const absolute = realpathSync(root); assert.ok(absolute.startsWith(realpathSync(tmpdir()) + sep)); rmSync(absolute, { recursive: true }); });
  return { root, task, get registry() { return registry; }, restart() { registry.close(); registry = new TaskRegistry(root); } };
}
test('progress observation is nonterminal, durable, deduplicated and does not change running count', t => {
  const f = registryFixture(t);
  assert.equal(f.registry.observeTask(f.task.taskId, 'job:tool-1', 'waiting'), true);
  assert.equal(f.registry.observeTask(f.task.taskId, 'job:tool-1', 'waiting'), false);
  assert.equal(f.registry.activeCount('parent'), 1);
  const event = f.registry.getNextEvent()!;
  assert.equal(event.kind, 'worker-progress'); assert.equal(event.status, 'running');
  assert.equal(event.conversationId, 'parent'); assert.equal(event.userId, 'u');
  assert.match(event.text, /非终态/); assert.match(event.text, /不是完成结果/);
  f.restart();
  assert.equal(f.registry.getNextEvent()!.id, event.id);
  assert.equal(f.registry.observeTask(f.task.taskId, 'job:tool-1', 'waiting'), false);
  assert.equal(f.registry.claimEvent(event.id), true); f.registry.markDelivered(event.id);
  assert.equal(f.registry.getTask(f.task.taskId)!.status, 'registered');
  assert.equal(f.registry.activeCount('parent'), 1);
  assert.equal(f.registry.observeTask(f.task.taskId, 'job:tool-2', 'new stage'), true);
});
test('task completion suppresses an obsolete observation while retaining the real completion event', t => {
  const f = registryFixture(t);
  f.registry.observeTask(f.task.taskId, 'job:tool', 'waiting'); const observation = f.registry.getNextEvent()!;
  f.registry.acceptObservedResult(f.task.taskId, 'completed', 'actual result');
  assert.equal(f.registry.observationRelevant(observation.id), false);
  const events = f.registry.queuedEvents(); assert.equal(events.length, 1);
  assert.equal(events[0]!.status, 'completed'); assert.equal(events[0]!.kind, undefined);
  assert.equal(f.registry.eventState(observation.id), 'discarded'); assert.equal(f.registry.activeCount('parent'), 0);
  assert.equal(f.registry.observeTask(f.task.taskId, 'late', 'late'), false);
});
test('detached parent observations are discarded without a late notice or counter effect', t => {
  const f = registryFixture(t);
  f.registry.observeTask(f.task.taskId, 'job:tool', 'waiting'); const event = f.registry.getNextEvent()!;
  f.registry.cancelConversation('parent'); assert.deepEqual(f.registry.queuedEvents(), []);
  assert.equal(f.registry.eventState(event.id), 'discarded'); assert.equal(f.registry.observeTask(f.task.taskId, 'new', 'waiting'), false);
  assert.equal(f.registry.activeCount('parent'), 1);
});
test('an interrupted progress wake is retained as uncertain and is not replayed or publicly recovered', t => {
  const f = registryFixture(t);
  f.registry.observeTask(f.task.taskId, 'job:tool', 'waiting'); const event = f.registry.getNextEvent()!;
  f.registry.claimEvent(event.id); f.restart();
  assert.deepEqual(f.registry.recoverProcessingEvents(), []);
  assert.equal(f.registry.eventState(event.id), 'uncertain'); assert.deepEqual(f.registry.queuedEvents(), []);
  assert.equal(f.registry.activeCount('parent'), 1);
});
test('observations require an existing owned task and bounded identifier', t => {
  const f = registryFixture(t);
  assert.equal(f.registry.observeTask('unknown-task', 'stage', 'waiting'), false);
  assert.throws(() => f.registry.observeTask(f.task.taskId, '', 'waiting'), /标识/);
  assert.throws(() => f.registry.observeTask(f.task.taskId, 'bad\nkey', 'waiting'), /标识/);
});

class HeldController implements AgentAdapter {
  readonly calls: AgentTurn[] = [];
  readonly pending: Array<(result: AgentResult) => void> = [];
  private readonly finished = new Set<number>();
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.calls.push(turn); turn.onNativeId?.(turn.conversation.nativeId ?? 'parent-native');
    return new Promise(resolve => this.pending.push(resolve));
  }
  async finish(index: number): Promise<void> {
    if (this.finished.has(index)) return;
    this.finished.add(index); const turn = this.calls[index]!;
    if (!turn.event && !turn.signal.aborted) await turn.onPublicMessage!('human-final:' + turn.text, [], 'human-final-' + index);
    this.pending[index]!({ nativeId: turn.conversation.nativeId ?? 'parent-native', text: 'DONE', controlledOutput: true });
  }
  async interrupt(): Promise<void> { await Promise.all(this.pending.map((_value, index) => this.finish(index))); }
  async close(): Promise<void> { await this.interrupt(); }
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('observation manager timeout'); await delay(5); }
}
function managerFixture(t: TestContext, controllerMode = true) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-observation-manager-'));
  const adapter = new HeldController(); const messages: string[] = [];
  const config: BridgeConfig = { token: '', allowedUserIds: ['u'], defaultAgent: 'codex', controllerMode, workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const registry = new TaskRegistry(join(root, 'tasks'));
  const inspect = new SessionStore(config.dataDir);
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText(_channel, text) { messages.push(text); } }, { taskRegistry: registry, mergeDelayMs: 0 });
  t.after(async () => { await manager.close(); inspect.close(); registry.close(); const absolute = realpathSync(root); assert.ok(absolute.startsWith(realpathSync(tmpdir()) + sep)); rmSync(absolute, { recursive: true }); });
  const human = (id: string, text: string) => ({ id, text, userId: 'u', channelId: 'dm', imagePaths: [] });
  return { manager, registry, inspect, adapter, messages, human, register() {
    const credential = JSON.parse(readFileSync(adapter.calls[0]!.taskContextPath!, 'utf8')) as TaskContextFile;
    return registry.register(credential, 'browser');
  } };
}
test('human messages precede a progress event which resumes the original native parent without entering the inbox', async t => {
  const f = managerFixture(t);
  await f.manager.handle(f.human('one', 'investigate')); await until(() => f.adapter.calls.length === 1);
  const task = f.register(); await f.manager.handle(f.human('two', 'additional human request'));
  f.registry.observeTask(task.taskId, 'job:tool', 'waiting'); f.manager.completionAvailable();
  await f.adapter.finish(0); await until(() => f.adapter.calls.length === 2);
  assert.equal(f.adapter.calls[1]!.text, 'additional human request');
  await f.adapter.finish(1); await until(() => f.adapter.calls.length === 3);
  const turn = f.adapter.calls[2]!; assert.equal(turn.event?.kind, 'worker-progress');
  assert.equal(turn.conversation.nativeId, 'parent-native'); assert.equal(turn.imagePaths.length, 0);
  assert.equal(f.registry.activeCount(turn.conversation.id), 1);
  assert.equal(f.inspect.getMessage('job:tool'), null); await f.adapter.finish(2);
  await until(() => f.registry.getNextEvent() === null);
  assert.equal(f.messages.length, 2);
  assert(f.messages.some(message => message.includes('human-final:investigate')));
  assert(f.messages.some(message => message.includes('human-final:additional human request')));
  assert(f.messages.every(message => message.includes('human-final:')));
});
test('direct execution mode consumes a progress observation without generating or sending a completion', async t => {
  const f = managerFixture(t, false);
  await f.manager.handle(f.human('one', 'investigate')); await until(() => f.adapter.calls.length === 1);
  const task = f.register(); await f.adapter.finish(0); await until(() => f.inspect.getMessage('one')?.replyState === 'delivered');
  const before = f.messages.length;
  f.registry.observeTask(task.taskId, 'job:tool', 'waiting'); f.manager.completionAvailable();
  await until(() => f.registry.getNextEvent() === null);
  assert.equal(f.adapter.calls.length, 1); assert.equal(f.messages.length, before);
  assert.equal(f.registry.activeCount(f.adapter.calls[0]!.conversation.id), 1);
});
