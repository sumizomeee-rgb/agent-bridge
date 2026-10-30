import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// The transport is an isolated sink. A test fault defers early acknowledgement
// to reproduce an ignored error; Host, BotRuntime, the native controller,
// catalog, remote cwd check, journals and the 30s scheduler remain real.
const [rootArgument, configPath, runArgument, sourceRootArgument] = process.argv.slice(2);
assert(rootArgument && configPath && runArgument, 'root configPath runDir required');
const root = path.resolve(rootArgument), runDir = path.resolve(runArgument);
fs.mkdirSync(runDir, { recursive: true });
const load = name => import(pathToFileURL(path.join(root, 'dist/src', name)));
// Resolve portable CLI paths against the real installation, while loading every
// behavior under test from the candidate. No production journal is opened here.
const { loadHostConfig, agentEnvironment } = await import(pathToFileURL(path.join(path.resolve(sourceRootArgument ?? rootArgument), 'dist/src/config.js')));
const { HostRuntime } = await load('host-runtime.js');
const { BotRuntime } = await load('bot-runtime.js');
const { NativeControllerAdapter } = await load('controller/native.js');
const { SessionStore } = await load('store.js');
const { CodexAdapter } = await load('agents/codex.js');
const { ClaudeAdapter } = await load('agents/claude.js');
const { validMessageId, validChannelId } = await load('routing.js');
const sourceHost = loadHostConfig(['--config', configPath], false);
const source = sourceHost.configs.find(c => c.defaultAgent === 'codex');
assert(source?.ownerUserId && source.scopePrefix, 'Configured Codex owner missing');
const appId = source.platform === 'feishu' ? 'cli_labfailure' + process.pid : String(700000000000000000n + BigInt(process.pid));
const prefix = source.platform + ':' + appId + '|';
const rawOwner = source.ownerUserId.slice(source.scopePrefix.length), owner = prefix + rawOwner;
const workspace = path.join(runDir, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '隔离主控故障测试，只执行指定测试步骤，不开展业务工作。\n');
fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# 隔离测试，无业务任务\n');
const model = 'gpt-6-luna', effort = 'xhigh';
const config = { ...source, applicationId: appId, botId: source.platform + ':' + appId, scopePrefix: prefix,
  ownerUserId: owner, allowedUserIds: [owner], externalAllowedUserIds: [rawOwner],
  workspace, workingCwd: workspace, contextWorkspace: source.contextWorkspace ?? source.workspace,
  dataDir: path.join(runDir, 'data'), logsDir: path.join(runDir, 'logs'), attachmentsDir: path.join(runDir, 'images'),
  token: '', appSecret: undefined, controllerMode: true, defaultAgent: 'codex',
  defaultModels: { ...source.defaultModels, codex: model } };
const principalId = source.ownerPrincipalId ?? 'lab-owner'; config.ownerPrincipalId = principalId;
const channel = prefix + (source.platform === 'feishu' ? 'oc_lab_failure_' + process.pid : String(800000000000000000n + BigInt(process.pid)));
assert(validChannelId(channel));
const report = { status: 'running', model, effort, tools: [], deliveries: [], cases: [], logs: [] };
const save = () => fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2)); save();
const journal = () => {
  const db = new DatabaseSync(path.join(config.dataDir, 'bridge.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT value_json FROM dispatch_failures ORDER BY rowid').all().map(row => JSON.parse(row.value_json)); }
  finally { db.close(); }
};
const nativeStarts = conversation => {
  const nativeId = store.getConversation(conversation.id).nativeId;
  const pending = [path.join(config.dataDir, 'controller-homes/codex', conversation.id, 'sessions')];
  const files = []; let visited = 0;
  while (pending.length) {
    const directory = pending.pop(); assert(++visited <= 32, 'Bounded isolated session audit');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'No linked session logs');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.name.endsWith(nativeId + '.jsonl')) files.push(file);
    }
  }
  assert.equal(files.length, 1, 'Exact isolated native session log required');
  assert(fs.statSync(files[0]).size < 4 * 1024 * 1024, 'Bounded native session log');
  return fs.readFileSync(files[0], 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.type === 'event_msg' && row.payload?.type === 'task_started').map(row => row.timestamp);
};
const wait = async (condition, label, timeout = 240000) => {
  const end = Date.now() + timeout;
  while (!condition()) { assert(Date.now() < end, label); await delay(100); }
};
const env = agentEnvironment(source);
const execution = { codex: new CodexAdapter(source.commands.codex, env), claude: new ClaudeAdapter(source.commands.claude, env) };
const host = new HostRuntime({ ...sourceHost, rootDataDir: path.join(runDir, 'host'), configs: [config], spaces: [],
  principals: [{ id: principalId, accounts: { [config.botId]: rawOwner } }] },
  { version: 3, status: 'complete', migrationId: 'dispatch-failure-lab', migratedAt: new Date().toISOString(), bots: [] },
  async () => { throw new Error('Lab cannot restart bridge'); }, message => { report.logs.push(String(message).slice(0, 600)); save(); });
let receive, expected, bot, store;
try {
  bot = new BotRuntime(config, host.hooks(config), {
    createExecutionAdapters: () => execution,
    createTransport: (_selected, input, events) => {
      receive = input; const history = { messages: [], hasMore: false, oldestId: null, newestId: null };
      return { botUser: { id: appId, username: 'Failure lab' }, verifyIdentity: async () => appId,
        start: async () => events.onReady(), close: async () => {}, isIdle: () => true,
        sendText: async (destination, text, options) => { assert.equal(destination, channel); assert(!options?.files?.length); report.deliveries.push({ at: new Date().toISOString(), text }); save(); },
        sendInteractionText: async () => { throw new Error('No external interaction'); },
        readDMHistory: async () => history, readGroupHistory: async () => history, readConversationHistory: async () => history,
        downloadImages: async () => [], markReplyDelivered: async () => {}, setTaskCount: async () => {}, setWorkCounts() {},
        onBridgeLifecycle: async () => {}, syncSlashCommands: async () => {}, syncGroupSlashCommands: async () => {}, failureText: error => String(error.message) };
    },
    createControllerAdapters: (_selected, _env, _execution, invoke) => Object.fromEntries(['codex', 'claude'].map(agent => [agent,
      new NativeControllerAdapter(source.commands[agent], env, { agent, dataDir: config.dataDir, contextWorkspace: config.contextWorkspace,
        metadataAdapter: execution[agent], defaultModels: config.defaultModels,
        invokeTool: async (turn, name, args, id) => {
          assert(['bridge_start_worker', 'bridge_list_dispatch_failures', 'bridge_ack_dispatch_failure'].includes(name), 'Unrelated tool forbidden: ' + name);
          const event = { name, at: new Date().toISOString(), status: 'running', callId: id, eventKind: turn.event?.kind ?? 'owner-input', eventTool: turn.event?.toolName }; report.tools.push(event); save();
          if (name === 'bridge_start_worker') {
            assert.equal(report.tools.filter(t => t.name === name).length, 1, 'No replay permitted');
            assert.equal(args.targetId, expected.targetId); assert.equal(args.cwd, expected.cwd);
          }
          if (name === 'bridge_ack_dispatch_failure' && (turn.event?.kind !== 'wake' || !journal().some(row => row.id === args.id && row.reminders >= 1))) {
            event.status = 'injected-deferred'; event.finishedAt = new Date().toISOString(); save();
            return { performed: false, testFaultInjected: true, message: 'Isolated fault injection keeps this failure pending until an actual bridge dispatch-failure wake. End this turn without retrying; do not schedule or poll.' };
          }
          try { const value = await invoke(turn, name, args, id); event.status = 'completed';
            if (name === 'bridge_ack_dispatch_failure') event.failureId = args.id;
            if (name === 'bridge_list_dispatch_failures') event.pendingCount = value.records.length;
            return value;
          } catch (error) { event.status = 'failed'; event.error = String(error.message).slice(0, 1200); throw error; }
          finally { event.finishedAt = new Date().toISOString(); save(); }
        } })])),
  });
  host.attach(bot); store = new SessionStore(config.dataDir);
  const conversation = store.createConversation(owner, 'codex', workspace, { controllerMode: true });
  store.setActive(owner, conversation.id); store.setModel(conversation.id, model); store.setEffort(conversation.id, effort);
  host.store.setController(config.botId, principalId, { conversationId: conversation.id, generation: 1, agent: 'codex', nativeId: null, model, effort }, 0);
  const targets = await bot.targetCatalog.listTargets(config.contextWorkspace, true);
  const target = targets.find(t => t.id === 'workstation'); assert(target, 'Real workstation registration missing');
  expected = { targetId: target.id, cwd: 'F:\\__bridge_failure_lab_missing_' + randomUUID() + '\\Client' }; report.expected = expected;
  await bot.verify(); await bot.start(); await host.recover();
  const text = `这是隔离故障验收，无业务任务，也不执行工程修改。请严格按两阶段：\n第一阶段现在：只调用一次 bridge_start_worker，targetId=${JSON.stringify(expected.targetId)}，cwd=${JSON.stringify(expected.cwd)}，assistant={kind:"ordinary",agent:"codex",model:"gpt-6-luna",effort:"xhigh"}，title="隔离派工失败测试"，prompt="只读返回 hostname，不修改文件"。该目录故意不存在，这次必须实际调用来复现准备失败。收到失败后，故意暂不调用点掉工具、不修正目录、不重派；直接用 bridge_send_user 发一句“隔离测试：本轮确认已发送。”然后 DONE 结束本轮，以复刻过去失败后正常确认的情况。\n第二阶段仅当桥之后自动提醒待处理派工失败时：调用 bridge_list_dispatch_failures，再用 bridge_ack_dispatch_failure 按清单中 ID 点掉，note="隔离验收：预期失败已核对，无需重派"。然后结束，不再派工，不开展任何真实任务。不要主动预约唤醒，也不要轮询或等待；自动提醒完全交给桥。`;
  const id = prefix + (source.platform === 'feishu' ? Date.now() + '|om_lab_failure' : String(BigInt(Date.now()) * 1000000n));
  assert(validMessageId(id));
  await receive({ id, text, userId: owner, channelId: channel, attachments: [], source: { messageId: id, userId: owner, channelId: channel, authorType: 'user' } });
  await wait(() => ['completed', 'failed'].includes(store.getMessage(id)?.state) && bot.manager.isIdle(), 'Initial fault turn');
  assert.equal(store.getMessage(id).state, 'completed');
  assert(report.tools.some(t => t.name === 'bridge_start_worker' && t.status === 'failed' && /ENOENT/.test(t.error)));
  assert(report.deliveries.some(d => d.text.includes('隔离测试：本轮确认已发送')));
  assert(journal().some(row => row.handledAt === null || row.reminders >= 1), 'Injected failure must stay pending until an actual reminder');
  report.cases.push('real remote cwd rejection and premature confirmation reproduced'); save();
  await wait(() => report.tools.some(t => t.name === 'bridge_ack_dispatch_failure' && t.status === 'completed') && bot.manager.isIdle(), 'Automatic review and explicit acknowledgement');
  const handled = journal().find(row => row.handledAt !== null && row.reminders >= 1);
  assert(handled, 'A real recorded reminder must precede explicit acknowledgement');
  assert(report.tools.some(t => t.name === 'bridge_ack_dispatch_failure' && t.status === 'completed' && t.eventKind === 'wake'), 'Only the real wake may acknowledge this injected failure');
  report.verifiedJournal = { id: handled.id, reminders: handled.reminders, handledAt: handled.handledAt, autoState: handled.autoState };
  report.cases.push('30s scheduler woke real controller without owner input; list and ack succeeded'); save();
  const management = report.tools.length; await delay(35000);
  assert.equal(report.tools.length, management, 'Acknowledged failure must stop waking');
  const ack = report.tools.find(t => t.name === 'bridge_ack_dispatch_failure' && t.status === 'completed' && t.eventKind === 'wake');
  const starts = nativeStarts(conversation); assert(starts.length >= 2, 'Native turn markers must be present');
  assert.equal(starts.filter(timestamp => timestamp > ack.finishedAt).length, 0, 'No model turn may start after acknowledgement');
  report.nativeTurnAudit = { totalStarts: starts.length, afterAcknowledgement: 0, checkedAt: new Date().toISOString() };
  assert.equal(bot.controller.store.workers().length, 0, 'Failed preparation must not create fake workers');
  report.cases.push('no wake after acknowledgement and no fake workers'); report.status = 'passed'; save();
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error).slice(0, 2400); save(); process.exitCode = 1;
} finally {
  await bot?.close().catch(error => { report.closeError = String(error.message); process.exitCode = 1; });
  await host.close().catch(() => {}); store?.close(); save();
  console.log(JSON.stringify({ status: report.status, cases: report.cases, report: path.join(runDir, 'report.json'), error: report.error, closeError: report.closeError }));
}
