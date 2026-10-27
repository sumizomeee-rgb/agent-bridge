import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostRuntime } from '../src/host-runtime.js';
import { BotRuntime, type BotTransport } from '../src/bot-runtime.js';
import { NativeControllerAdapter } from '../src/controller/native.js';
import { SessionStore } from '../src/store.js';
import { AgentProcessStopError, type JsonObject, type RpcTransport } from '../src/agents/process.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, IncomingDM, ReplyOptions } from '../src/types.js';
import type { HostConfig } from '../src/config.js';
import { groupMessagePayloadHash } from '../src/group-mentions.js';

// Only platform I/O and CLI messages are simulated. Host, bot, manager, native
// controller, execution scheduler and all journals are the production classes.
class Protocol implements RpcTransport {
  listeners = new Set<(m: JsonObject) => void>();
  writes: JsonObject[] = []; turns = 0; stopped = false; failStop = false;
  onMessage(cb: (m: JsonObject) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  onFailure() { return () => {}; }
  emit(m: JsonObject) { queueMicrotask(() => this.listeners.forEach(cb => cb(m))); }
  write(m: JsonObject) {
    this.writes.push(m);
    const method = m.method;
    if (method === 'initialize') this.emit({ id: m.id, result: {} });
    if (method === 'config/read') this.emit({ id: m.id, result: { config: { model_provider: 'fixture', model: 'fixture-model' } } });
    if (method === 'model/list') this.emit({ id: m.id, result: { data: [{ model: 'fixture-model' }] } });
    if (method === 'thread/resume' || method === 'thread/start') this.emit({ id: m.id, result: { thread: { id: 'group-native' }, model: 'fixture-model', modelProvider: 'fixture' } });
    if (method === 'thread/read') this.emit({ id: m.id, result: { thread: { id: 'group-native' } } });
    if (method === 'turn/start') { this.turns++; this.emit({ id: m.id, result: { turn: { id: 'turn-' + this.turns } } }); }
  }
  tool(name: string, args: JsonObject, id: number) { this.emit({ id, method: 'item/tool/call', params: { threadId: 'group-native', turnId: 'turn-' + this.turns, callId: 'call-' + id, tool: name, arguments: JSON.stringify(args) } }); }
  complete(status = 'completed') { this.emit({ method: 'turn/completed', params: { threadId: 'group-native', turn: { id: 'turn-' + this.turns, status, error: { message: 'injected failure' } } } }); }
  async stop() { if (this.failStop) throw new AgentProcessStopError(undefined); this.stopped = true; }
  confirmStopped() { return this.stopped; }
  canRetryStop() { return !this.failStop; }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { assert(Date.now() < deadline, 'isolated group chain did not progress'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

for (const platform of ['feishu', 'discord'] as const) test(platform + ': isolated group uses production host → bot → native → worker → report; next message recovers after stop proof without restart', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-group-lab-'));
  const app = platform === 'feishu' ? 'cli_lab_' + process.pid : String(700000000000000000n + BigInt(process.pid)), botId = platform + ':' + app, prefix = botId + '|';
  const owner = '333333333333333333', group = '555555555555555555';
  mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex/config.toml'), 'model_provider="fixture"\n');
  const c: BridgeConfig = { botId, applicationId: app, platform, profile: 'isolated-group', scopePrefix: prefix,
    ownerPrincipalId: 'owner', ownerUserId: prefix + owner, allowedUserIds: [prefix + owner], token: '', defaultAgent: 'codex',
    defaultModels: { codex: 'fixture-model' }, controllerMode: true, groupMode: true,
    workspace: join(root, 'workspace'), contextWorkspace: join(root, 'workspace'), workingCwd: join(root, 'workspace'),
    dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'images'), proxyUrl: null, maxImageBytes: 1024,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } };
  const config: HostConfig = { version: 3, rootDataDir: join(root, 'host'), configs: [c],
    principals: [{ id: 'owner', accounts: { [botId]: owner } }], spaces: [{ id: 'group', accounts: { [botId]: group } }] };
  const host = new HostRuntime(config, { version: 3, status: 'complete', migrationId: 'lab', migratedAt: 'now', bots: [] }, async () => ({ accepted: true }), () => {});
  const sent: Array<{ channel: string; text: string; options?: ReplyOptions }> = [], processes: Protocol[] = [], executions: AgentTurn[] = [];
  const originals = new Map<string, IncomingDM>();
  let finishWorker!: () => void;
  const workerGate = new Promise<void>(resolve => { finishWorker = resolve; });
  const worker: AgentAdapter = { getModelInfo: async () => ({ defaultModel: 'fixture-model', models: [{ id: 'fixture-model', displayName: 'Fixture' }] }),
    async run(turn) { executions.push(turn); await workerGate; return { nativeId: 'worker-native', text: 'saved isolated worker result', processStopped: true }; },
    async interrupt() { finishWorker(); }, async close() {}, async confirmStopped() { return true; } };
  const history = { messages: [], hasMore: false, oldestId: null, newestId: null };
  const bot = new BotRuntime(c, host.hooks(c), {
    createTransport: (_c, receive, events) => ({
      botUser: { id: app, username: 'Lab' }, verifyIdentity: async () => app, start: async () => { await events.onReady(); }, close: async () => {}, isIdle: () => true,
      sendText: async (channel: string, text: string, options?: ReplyOptions) => { sent.push({ channel, text, options }); },
      sendInteractionText: async () => {}, readDMHistory: async () => history, readGroupHistory: async () => history,
      readConversationHistory: async () => { throw new Error('no external history'); },
      getGroupInfo: async (spaceId: string) => ({ spaceId, botIsMember: true }),
      getGroupMember: async (_space: string, id: string) => ({ id, idType: platform === 'feishu' ? 'open_id' as const : 'discord' as const, isBot: false }),
      listGroupMembers: async () => ({ members: [], hasMore: false, verification: 'unknown' as const }),
      readGroupMentionView: async (_raw: string, id: string) => { const m = originals.get(id)!; return { messageId: id.split('|')[1]!, createTime: id.split('|')[0]!, spaceId: group, senderId: owner, payloadHash: groupMessagePayloadHash(m), mentions: [{ key: '@_user_1', id: app }] }; }, readForwardedContent: async (m: IncomingDM) => m.forwarded,
      downloadImages: async () => [], markReplyDelivered: async () => {}, setTaskCount: async () => {}, setWorkCounts() {},
      onBridgeLifecycle: async () => {}, syncSlashCommands: async () => {}, syncGroupSlashCommands: async () => {}, failureText: () => 'failed',
    } satisfies BotTransport),
    createExecutionAdapters: () => ({ codex: worker, claude: worker }),
    createControllerAdapters: (_config, _env, _execution, invoke) => {
      const native = new NativeControllerAdapter(c.commands.codex, {}, { agent: 'codex', dataDir: c.dataDir, userHome: root, invokeTool: invoke, metadataAdapter: worker,
        createTransport: () => { const p = new Protocol(); processes.push(p); return p; } });
      return { codex: native, claude: native };
    },
    createTargetCatalog: () => ({ listTargets: async () => [{ id: 'local', label: '隔离桥电脑', transport: 'local', engines: ['codex', 'claude'], availability: 'local' }], resolveTarget: async (_workspace, id, agent, cwd) => ({ id, agent, label: id, transport: 'local', cwd: cwd ?? c.workspace, agentCommand: c.commands[agent] }), adapterFor: () => worker, handoff: async () => { throw new Error('not used'); }, computerOverview: async () => [], close: async () => {} }),
    createHealth: () => ({ refresh: async (workspace = c.workspace) => ({ version: 1, workspace, checkedAt: 'now', stale: false, scope: 'static-prerequisites', items: [], total: 0, omitted: 0 }), query: async () => { throw new Error('not used'); }, startupSummary: () => 'lab' }),
  });
  host.attach(bot);
  const store = new SessionStore(c.dataDir), conversation = store.createConversation(c.ownerUserId!, 'codex', c.workspace, { controllerMode: true });
  store.saveNativeId(conversation.id, 'group-native'); store.setModel(conversation.id, 'fixture-model');
  host.store.setController(botId, 'owner', { conversationId: conversation.id, generation: 1, agent: 'codex', nativeId: 'group-native' }, 0);
  t.after(async () => { finishWorker(); for (const p of processes) p.failStop = false; await host.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await bot.verify(); await bot.start(); await host.recover();
  let sequence = 0;
  const input = (text: string): IncomingDM => {
    ++sequence;
    const id = platform === 'feishu' ? `${1792980000000 + sequence}|om_lab_${sequence}` : String(1800000000000000000n + BigInt(sequence));
    const m: IncomingDM = { id: prefix + id, userId: c.ownerUserId!, channelId: prefix + group, text, attachments: [], space: { kind: 'group', spaceId: group, mentionedUserIds: [app] } };
    originals.set(id, m); return m;
  };
  await host.receive(botId, input('/group start'));
  assert.equal(host.store.getGroup('group')?.enabled, true);
  const targetId = () => { const g = host.store.getGroup('group')!; return `group:${g.spaceId}:${g.epoch}:${g.revision}`; };
  const publish = async (p: Protocol, text: string, id: number) => {
    p.tool('bridge_send_message', { text, targetId: targetId() }, id);
    await until(() => p.writes.some(m => m.id === id));
    const response = JSON.stringify(p.writes.find(m => m.id === id));
    if (response.includes('reassessmentPending')) {
      assert.equal(sent.some(s => s.text.includes(text)), false);
      const old = p.turns; p.complete(); await until(() => p.turns === old + 1);
      p.tool('bridge_send_message', { text, targetId: targetId() }, id + 1000);
      await until(() => p.writes.some(m => m.id === id + 1000));
      assert.equal((p.writes.find(m => m.id === id + 1000)!.result as JsonObject).success, true);
    } else assert.equal((p.writes.find(m => m.id === id)!.result as JsonObject).success, true, response);
    await until(() => sent.some(s => s.text.includes(text))); p.complete();
  };
  await bot.controller!.workerDefaultCommand('agentworker local codex worker-model');
  await host.receive(botId, input('Inspect once and report in this group'));
  await until(() => processes[0]?.turns === 1).catch(error => { t.diagnostic(JSON.stringify({ methods: processes.map(p => p.writes.map(m => m.method)), sent, events: host.store.listEvents() })); throw error; }); const p = processes[0]!;
  p.tool('bridge_start_worker', { targetId: 'local', assistant: { kind: 'default' }, title: 'isolated inspection', prompt: 'read fixture only' }, 101);
  await until(() => executions.length === 1);
  await until(() => p.writes.some(m => m.id === 101));
  assert.ok(bot.controller!.store.jobs()[0]!.origin.groupContext, 'worker must retain group origin');
  assert.equal(executions[0]!.conversation.model, 'worker-model');
  assert.equal(store.getConversation(conversation.id)!.model, 'fixture-model');
  await publish(p, 'inspection started', 102);
  await until(() => bot.manager.isIdle()); finishWorker();
  await until(() => p.turns === 2);
  const report = p.writes.filter(m => m.method === 'turn/start')[1]!.params as JsonObject;
  assert.match(JSON.stringify(report), /saved isolated worker result/);
  await publish(p, 'inspection finished', 103);
  await until(() => host.isIdle());
  assert(sent.filter(s => /inspection (started|finished)/.test(s.text)).every(s => s.channel === prefix + group));
  assert.equal(executions.length, 1);
  assert.equal(sent.some(s => s.options?.presentation?.tone === 'error' || /仍在等待主控|正在恢复主控/.test(s.text)), false);

  // Reproduce the user-visible red-frame condition, then verify recovery from
  // real stop evidence on the next ordinary input, without /restart or /new.
  const priorTurns = p.turns;
  await host.receive(botId, input('failure injection'));
  await until(() => p.turns === priorTurns + 1); p.failStop = true; p.complete('failed');
  await until(() => host.isIdle());
  await host.receive(botId, input('must not overlap the unknown old process'));
  await until(() => host.isIdle()); assert.equal(processes.length, 1);
  p.stopped = true; p.failStop = false;
  await host.receive(botId, input('continue in the same group'));
  await until(() => processes[1]?.turns === 1);
  await publish(processes[1]!, 'recovered same group', 104);
  await until(() => host.isIdle());
  assert.equal(host.store.getController(botId)!.conversationId, conversation.id);
  assert.equal(host.store.getController(botId)!.nativeId, 'group-native');
  assert.equal(executions.length, 1, 'neither the failure nor recovery may replay the worker');
  assert.equal(sent.filter(s => s.text.includes('recovered same group')).length, 1);
});
