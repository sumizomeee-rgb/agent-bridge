import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSessionAdapter, WorkerSessionRuntime } from '../src/agents/worker-session.js';
import { AgentProcessStopError } from '../src/agents/process.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { SessionStore } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import { TaskRegistry } from '../src/tasks.js';
import type { AgentAdapter, AgentName, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert(Date.now() < end, 'worker recovery did not settle'); await new Promise(r => setTimeout(r, 5)); }
}

for (const agent of ['codex', 'claude'] as AgentName[]) for (const delayed of [false, true])
test(`${agent}: executing → restart → /workers → continue keeps native session; delayed stop=${delayed}`, async t => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-worker-restart-')), 'bridge-worker-restart-');
  const profile = join(root, 'empty-profile'); mkdirSync(profile);
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: agent, workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fixture', args: [] }, claude: { command: 'fixture', args: [] } },
    dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const sessions = new SessionStore(root), parent = sessions.createConversation('owner', agent, root);
  parent.model = 'fixture-model';
  const registry = new TaskRegistry(root), context = registry.createContext({ conversationId: parent.id, userId: 'owner',
    channelId: 'dm', originMessageId: 'start', nativeId: null, agent, cwd: root });
  const turn: AgentTurn = { conversation: parent, text: 'start', imagePaths: [], taskContextPath: context.contextPath,
    signal: new AbortController().signal, onProgress() {} };
  const turns: AgentTurn[] = []; let rejectRun: ((error: Error) => void) | undefined, resolveRun: ((r: AgentResult) => void) | undefined;
  let stopProof = !delayed;
  const factory = (): AgentAdapter => ({
    getModelInfo: async () => ({ defaultModel: 'fixture-model', models: [{ id: 'fixture-model', displayName: 'Fixture' }] }),
    async run(turn) { turns.push(turn); turn.onNativeId?.(turn.conversation.nativeId ?? 'original-native'); turn.onReady?.();
      return new Promise<AgentResult>((resolve, reject) => { rejectRun = reject; resolveRun = resolve; }); },
    async interrupt() { rejectRun?.(stopProof ? new Error('execution interrupted') : new AgentProcessStopError(undefined)); },
    async close() { if (!stopProof) throw new AgentProcessStopError(undefined); },
    async confirmStopped() { return stopProof; },
  });
  const makeAdapter = () => new WorkerSessionAdapter(new WorkerSessionRuntime(root, root), agent, 'hidden', config.commands[agent],
    { CODEX_HOME: profile, CLAUDE_CONFIG_DIR: profile }, factory);
  const oldAdapter = makeAdapter();
  let adapter = oldAdapter, runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry, { pollIntervalMs: 10 });
  const replies: string[] = [];
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText(_channel, text) { replies.push(text); } },
    { onListWorkers: async (conversation, scope) => runtime.queryWorkerOverview(conversation, scope) });
  t.after(async () => { stopProof = true; await manager.close(); await runtime.close(); await adapter.close(); await oldAdapter.close(); sessions.close(); registry.close(); });
  await runtime.start();
  const worker = await runtime.invoke(turn, 'bridge_start_worker', { title: 'query', prompt: 'original operation', model: 'fixture-model' }) as { workerId: string; jobId: string };
  await until(() => turns.length === 1);
  // A queued pre-crash instruction must never silently replay during recovery.
  await runtime.invoke(turn, 'bridge_continue_worker', { workerId: worker.workerId, prompt: 'stale queued operation', delivery: 'next' });
  await runtime.close();
  adapter = makeAdapter(); runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry, { pollIntervalMs: 10 });
  await runtime.start();
  if (delayed) {
    await assert.rejects(runtime.invoke(turn, 'bridge_continue_worker', { workerId: worker.workerId, prompt: 'too early' }), /结果未知/);
    assert.equal(turns.length, 1);
    stopProof = true; assert.equal(await oldAdapter.confirmStopped(worker.workerId, worker.jobId), true);
    await until(() => runtime.store.getWorker(worker.workerId)?.blocked === false);
  }
  assert.equal(await adapter.confirmStopped(worker.workerId, 'another-dispatch'), false);
  assert.equal(runtime.store.getJob(worker.jobId)!.status, 'failed');
  assert.equal(runtime.store.getJob(worker.jobId)!.interrupted, true);
  assert.equal(runtime.store.getWorker(worker.workerId)!.nativeId, 'original-native');
  assert.equal(turns.length, 1, 'startup and listing never replay old instructions');
  await manager.handle({ id: 'workers', text: '/workers', userId: 'owner', channelId: 'dm', imagePaths: [] });
  assert.doesNotMatch(replies.at(-1)!, /待核对[1-9]/);
  await runtime.invoke(turn, 'bridge_continue_worker', { workerId: worker.workerId, prompt: 'continue from saved progress' });
  await until(() => turns.length === 2);
  assert.equal(turns[1]!.conversation.nativeId, 'original-native');
  assert.match(turns[1]!.text, /先核对历史及已保存产物/);
  assert.match(turns[1]!.text, /continue from saved progress/);
  assert.doesNotMatch(turns[1]!.text, /stale queued operation/);
  if (delayed) {
    stopProof = false; rejectRun!(new AgentProcessStopError(undefined));
    await until(() => runtime.store.jobs(worker.workerId).at(-1)?.status === 'uncertain');
    assert.equal(runtime.isIdle(), false, 'a new unconfirmed execution cannot inherit the historical idle exemption');
    stopProof = true; await until(() => runtime.store.getWorker(worker.workerId)?.blocked === false);
    await runtime.invoke(turn, 'bridge_continue_worker', { workerId: worker.workerId, prompt: 'resume after second interruption' });
    await until(() => turns.length === 3);
  }
  resolveRun!({ nativeId: 'original-native', text: 'recovered result' });
  await until(() => runtime.store.jobs(worker.workerId).at(-1)?.status === 'completed');
  await runtime.close(); adapter = makeAdapter(); runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry);
  await runtime.start(); assert.equal(turns.length, delayed ? 3 : 2, 'a second restart cannot replay any operation');
});
