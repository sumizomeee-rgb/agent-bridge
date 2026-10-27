import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** The production catalog, deployment service and SSH adapter are never replaced here. */
export async function runConfigured({ root, runDir, configPath, agent, evidence, save, targets, controllerModel, controllerEffort = 'xhigh' }) {
  const load = file => import(pathToFileURL(join(root, 'dist/src', file)));
  const { loadHostConfig, agentEnvironment } = await load('config.js');
  const { HostRuntime } = await load('host-runtime.js');
  const { BotRuntime } = await load('bot-runtime.js');
  const { TargetCatalogService } = await load('remote/catalog.js');
  const { RemoteDeploymentService } = await load('remote/deployment.js');
  const { setRemoteDeploymentHook } = await load('remote/client.js');
  const { NativeControllerAdapter } = await load('controller/native.js');
  const { CodexAdapter } = await load('agents/codex.js');
  const { ClaudeAdapter } = await load('agents/claude.js');
  const { SessionStore } = await load('store.js');
  const { validMessageId, validChannelId } = await load('routing.js');
  const sourceHost = loadHostConfig(['--config', configPath], false);
  const source = sourceHost.configs.find(c => c.defaultAgent === agent);
  assert(source, 'Configured controller backend missing');
  const directory = join(runDir, 'configured-' + agent), workspace = join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '隔离主控测试。只执行明确的只读测试任务，不开展业务工作。\n');
  const context = source.contextWorkspace ?? source.workspace;
  const model = controllerModel ?? (agent === 'codex' ? 'gpt-6-luna' : 'haiku');
  // Preserve real registration/routing; only conversations, task journals and output are isolated.
  const labApplicationId = source.platform === 'feishu' ? 'cli_lab' + process.pid : String(700000000000000000n + BigInt(process.pid));
  const labPrefix = source.platform + ':' + labApplicationId + '|';
  const config = { ...source, applicationId: labApplicationId, botId: source.platform + ':' + labApplicationId,
    scopePrefix: labPrefix, allowedUserIds: source.allowedUserIds.map(id => labPrefix + id.slice(source.scopePrefix.length)),
    workspace, contextWorkspace: context, workingCwd: workspace, dataDir: join(directory, 'data'),
    logsDir: join(directory, 'logs'), attachmentsDir: join(directory, 'images'), controllerMode: true, token: '', appSecret: undefined,
    defaultModels: { ...source.defaultModels, [agent]: model } };
  const receipt = { agent, controllerModel: model, controllerEffort, sourceBotId: source.botId, labBotId: config.botId,
    contextWorkspace: context, actualRemoteExecution: true,
    platform: 'isolated receipt sink', deployments: [], tools: [], deliveries: [], workers: [], cases: [], defaults: [] };
  evidence.configured ??= []; evidence.configured.push(receipt); save();
  const check = async (name, work) => {
    const item = { name: agent + ': configured ' + name, status: 'running', startedAt: new Date().toISOString() };
    evidence.cases.push(item); receipt.cases.push(item); save();
    try { await work(); item.status = 'passed'; }
    catch (error) { item.status = 'failed'; item.error = String(error.message).slice(0, 500); }
    finally { item.finishedAt = new Date().toISOString(); save(); }
    return item;
  };
  const env = agentEnvironment(source), execution = { codex: new CodexAdapter(source.commands.codex, env), claude: new ClaudeAdapter(source.commands.claude, env) };
  let catalog, runtime, manager, native, store, registry, deployments, conversation, host, bot, receive;
  const channelId = labPrefix + (source.platform === 'feishu' ? 'oc_lab_' + process.pid : String(800000000000000000n + BigInt(process.pid)));
  const wait = async (predicate, label, timeout = 240000) => {
    const end = Date.now() + timeout;
    while (!predicate()) { assert(Date.now() < end, 'Lab deadline: ' + label); await delay(100); }
  };
  try {
    store = new SessionStore(config.dataDir);
    catalog = new TargetCatalogService(config, execution);
    const computers = await catalog.listTargets(context, true);
    const selected = targets?.length ? computers.filter(c => targets.includes(c.id)) : computers;
    assert(selected.length && (!targets || targets.every(id => selected.some(c => c.id === id))), 'Unknown configured target');
    receipt.configurationHashes = Object.fromEntries(['remote-agents/registry.json', 'agent-presets/registry.json'].map(name => [name,
      existsSync(join(context, name)) ? createHash('sha256').update(readFileSync(join(context, name))).digest('hex') : null]));
    receipt.targets = selected;
    const bindings = [];
    for (const target of selected.filter(c => c.transport === 'ssh')) bindings.push({ cwd: context, target: await catalog.resolveTarget(context, target.id, target.engines[0]) });
    deployments = new RemoteDeploymentService(async () => bindings, text => { receipt.deployments.push({ at: new Date().toISOString(), text }); save(); });
    setRemoteDeploymentHook((target, cwd) => deployments.ensure(target, cwd));
    const principalId = source.ownerPrincipalId ?? 'lab-owner';
    const rawOwner = source.allowedUserIds[0].slice(source.scopePrefix.length);
    config.ownerPrincipalId = principalId; config.ownerUserId = config.allowedUserIds[0];
    host = new HostRuntime({ ...sourceHost, rootDataDir: join(directory, 'host'), configs: [config], spaces: [],
      principals: [{ id: principalId, accounts: { [config.botId]: rawOwner } }] },
      { version: 3, status: 'complete', migrationId: 'configured-lab', migratedAt: new Date().toISOString(), bots: [] },
      async () => { throw new Error('Test does not restart the production bridge'); }, text => { receipt.hostLog ??= []; receipt.hostLog.push(text); save(); });
    const sink = { sendText: async (channel, text, options) => {
      assert.equal(channel, channelId); assert(!options?.files?.length, 'No business attachments in configured tests');
      receipt.deliveries.push({ at: new Date().toISOString(), text }); save();
    } };
    bot = new BotRuntime(config, host.hooks(config), {
      createExecutionAdapters: () => execution,
      createTransport: (_config, input, events) => {
        receive = input; const history = { messages: [], hasMore: false, oldestId: null, newestId: null };
        return { ...sink, botUser: { id: config.applicationId, username: 'Configured lab' }, verifyIdentity: async () => config.applicationId,
          start: async () => { await events.onReady(); }, close: async () => {}, isIdle: () => true,
          sendInteractionText: async () => { throw new Error('No external interaction'); }, readDMHistory: async () => history,
          readGroupHistory: async () => history, readConversationHistory: async () => history, downloadImages: async () => [],
          markReplyDelivered: async () => {}, setTaskCount: async () => {}, setWorkCounts() {}, onBridgeLifecycle: async () => {},
          syncSlashCommands: async () => {}, syncGroupSlashCommands: async () => {}, failureText: error => String(error.message) };
      },
      createControllerAdapters: (_config, _env, _execution, invoke) => {
        const adapters = {};
        for (const selectedAgent of ['codex', 'claude']) adapters[selectedAgent] = new NativeControllerAdapter(source.commands[selectedAgent], env, {
          agent: selectedAgent, dataDir: config.dataDir, metadataAdapter: execution[selectedAgent], defaultModels: config.defaultModels,
          invokeTool: (turn, name, args, id) => invokeTracked(invoke, turn, name, args, id) });
        native = adapters[agent]; return adapters;
      },
    });
    host.attach(bot); runtime = bot.controller; manager = bot.manager; registry = bot.tasks;
    // Only the settings table is copied read-only. Production conversations/tasks are never opened by the lab runtime.
    const dbPath = join(source.dataDir, 'controller.sqlite');
    if (existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        if (db.prepare("SELECT name FROM sqlite_master WHERE name='controller_worker_defaults'").get())
          for (const row of db.prepare('SELECT target_id,value_json FROM controller_worker_defaults').all()) {
            const choice = JSON.parse(row.value_json); runtime.store.setWorkerDefault(row.target_id, choice); receipt.defaults.push({ targetId: row.target_id, choice });
          }
      } finally { db.close(); }
    }
    conversation = store.createConversation(config.allowedUserIds[0], agent, workspace, { controllerMode: true });
    store.setActive(conversation.userId, conversation.id); store.setModel(conversation.id, model); store.setEffort(conversation.id, controllerEffort);
    host.store.setController(config.botId, principalId, { conversationId: conversation.id, generation: 1, agent, nativeId: null, model, effort: controllerEffort }, 0);
    async function invokeTracked(invoke, turn, name, args, id) {
        const event = { name, callId: id, at: new Date().toISOString(), targetId: args.targetId, status: 'running' };
        receipt.tools.push(event); save();
        assert(['bridge_list_targets', 'bridge_list_workers', 'bridge_start_worker'].includes(name), 'Lab forbids unrelated management');
        if (name === 'bridge_start_worker') {
          assert.equal(args.targetId, receipt.expected.targetId, 'Unexpected test computer');
          assert.equal(args.prompt, receipt.expected.prompt, 'Worker task changed');
          if (receipt.expected.mode === 'default') {
            assert.equal(args.agent, undefined); assert.equal(args.model, undefined); assert.equal(args.effort, undefined); assert.equal(args.presetId, undefined);
            assert(!args.assistant || args.assistant.kind === 'default', 'Default was overridden');
          } else assert.deepEqual(args.assistant, receipt.expected.assistant);
          assert(!args.imagePaths?.length); assert(!args.cwd || resolve(args.cwd) === workspace, 'Unexpected workspace override');
          receipt.dispatchCount = (receipt.dispatchCount ?? 0) + 1;
          assert.equal(receipt.dispatchCount, receipt.expected.number, 'Duplicate dispatch');
        }
        try {
          const result = await invoke(turn, name, args, id); event.status = 'completed';
          if (name === 'bridge_start_worker') { event.workerId = result.workerId; event.jobId = result.jobId; }
          return result;
        } catch (error) { event.status = 'failed'; event.error = String(error.message).slice(0, 400); throw error; }
        finally { event.finishedAt = new Date().toISOString(); save(); }
    }
    await bot.verify(); await bot.start(); await host.recover();
    const send = async (label, text) => {
      const deliveryCount = receipt.deliveries.length;
      const id = config.scopePrefix + (source.platform === 'feishu' ? Date.now() + '|om_lab_' + label : String(BigInt(Date.now()) * 1000000n));
      assert(validMessageId(id) && validChannelId(channelId), 'Invalid isolated platform envelope');
      assert(host.authorize(config.botId, conversation.userId, text), 'Isolated owner authorization failed');
      await receive({ id, text, userId: conversation.userId, channelId, attachments: [],
        source: { messageId: id, userId: conversation.userId, channelId, authorType: 'user' } });
      assert(bot.ingress.getMessage(id), 'Ingress rejected test envelope');
      await wait(() => ['completed', 'failed', 'cancelled'].includes(store.getMessage(id)?.state) && manager.isIdle(), label);
      assert.equal(store.getMessage(id).state, 'completed');
      if (text.startsWith('/')) assert(receipt.deliveries.length > deliveryCount, 'Slash reply was not delivered');
      else assert.equal(store.getMessage(id).replyState, 'delivered');
    };
    await check('real registrations and startup readiness', async () => {
      await deployments.check();
      for (const { target, cwd } of bindings) assert.equal((await deployments.ensure(target, cwd)).state, 'ready', target.id + ' executor not ready');
    });
    const discovery = await check('registered discovery through real private ingress', async () => {
      await send('configured-discovery', '这是已授权的隔离测试，只使用桥工具。调用一次 bridge_list_targets 获取真实电脑和助手清单，随后简短回复 LAB_CONFIGURED_ROSTER，不派工。');
      assert.equal(receipt.tools.filter(t => t.name === 'bridge_list_targets').length, 1);
    });
    if (discovery.status !== 'passed') return;
    let number = 0;
    for (const target of selected) {
      const choice = runtime.store.workerDefault(target.id);
      await check(target.id + ' saved default through real dispatch and result', async () => {
        const marker = 'LAB_CONFIGURED_' + agent.toUpperCase() + '_' + target.id.toUpperCase();
        const prompt = '这是用户授权的隔离测试，只读任务。仅查询本机 hostname 和当前时间，返回 ' + marker + '、真实 hostname 和时间。不修改文件，不操作浏览器，不发送消息，不连接其他机器，不派生助手；遵循所在电脑的 AGENTS 与技能入口。';
        number = (receipt.dispatchCount ?? 0) + 1;
        receipt.expected = { targetId: target.id, prompt, number, mode: 'default' }; save();
        const before = runtime.store.workers().length, start = receipt.deliveries.length;
        await send('configured-default-' + target.id, '只做一次隔离派工验证。调用 bridge_start_worker，targetId=' + target.id
          + '，title="隔离测试默认助手"，prompt 必须逐字等于 ' + JSON.stringify(prompt)
          + '。省略 agent/model/effort/presetId，不覆盖默认助手。' + (target.id === 'local' ? 'cwd=' + JSON.stringify(workspace) + '。' : '')
          + '必须等待原工具回执，失败就明确报告失败，不重新调用、不改选；成功仅说明已受理，不能说任务已完成。随后助手结果到达时，用 LAB_CONFIGURED_RESULT 加真实结果回复，不再派工。');
        assert.equal(receipt.dispatchCount, number, 'Controller did not call dispatch');
        if (!choice) {
          assert.equal(runtime.store.workers().length, before); assert(receipt.tools.some(t => t.name === 'bridge_start_worker' && t.targetId === target.id && t.status === 'failed' && t.error?.includes('尚未设置默认助手'))); return;
        }
        assert.equal(runtime.store.workers().length, before + 1, 'No durable worker; dispatch did not succeed');
        const worker = runtime.store.workers().find(w => w.origin.conversationId === conversation.id && w.title === '隔离测试默认助手' && w.target.id === target.id);
        assert(worker); if (choice.kind === 'preset') assert.equal(worker.target.preset.id, choice.presetId);
        await wait(() => runtime.store.jobs(worker.id).every(j => !['running', 'queued'].includes(j.status)) && runtime.isIdle() && manager.isIdle()
          && receipt.deliveries.slice(start).some(d => d.text.includes('LAB_CONFIGURED_RESULT')), target.id + ' actual result');
        const job = runtime.store.jobs(worker.id)[0];
        receipt.workers.push({ targetId: target.id, workerId: worker.id, jobId: job.id, status: job.status, model: worker.model, actualModel: runtime.store.getWorker(worker.id).actualModel,
          nativeId: runtime.store.getWorker(worker.id).nativeId, processStopped: job.processStopped, result: job.result?.slice(0, 1000) }); save();
        assert.equal(job.status, 'completed'); assert.equal(job.processStopped, true); assert.match(job.result, new RegExp(marker));
        if (target.expectedHostname) assert(job.result.toLowerCase().includes(target.expectedHostname.toLowerCase()), 'Wrong executing computer');
        assert(receipt.deliveries.slice(start).some(d => d.text.includes('LAB_CONFIGURED_RESULT') && (!target.expectedHostname || d.text.toLowerCase().includes(target.expectedHostname.toLowerCase()))), 'Result did not return to controller');
        await send('configured-workers-' + target.id, '/workers'); await send('configured-history-' + target.id, '/workers history');
        const last = receipt.deliveries.slice(-2); assert(last[0].text.includes('运行0个')); assert(!last[0].text.includes(marker)); assert(last[1].text.includes('历史'));
      });
    }
    // Every actual computer also gets an ordinary CLI path; remote defaults can legitimately be unset.
    for (const target of selected.filter(t => t.transport === 'ssh' && t.engines.includes(agent))) await check(target.id + ' ordinary real ' + agent + ' path', async () => {
      const marker = 'LAB_ORDINARY_' + agent.toUpperCase() + '_' + target.id.toUpperCase();
      const prompt = '用户授权的隔离只读测试。仅查询本机 hostname 与当前时间并返回 ' + marker + ' 和实际值。不修改文件，不操作浏览器，不访问业务，不派生助手。遵循所在电脑的 AGENTS 与技能入口。';
      const assistant = { kind: 'ordinary', agent, model, effort: controllerEffort };
      number = (receipt.dispatchCount ?? 0) + 1;
      receipt.expected = { targetId: target.id, prompt, number, mode: 'ordinary', assistant }; save();
      const prior = runtime.store.workers().map(w => w.id);
      await send('configured-ordinary-' + target.id, '隔离测试。仅调用一次 bridge_start_worker，targetId=' + target.id + '，assistant=' + JSON.stringify(assistant)
        + '，title="隔离测试普通助手"，prompt 必须逐字等于 ' + JSON.stringify(prompt) + '。等待真实回执再回复；失败明确说明，不重派。后续结果用 LAB_CONFIGURED_RESULT 和真实结果汇报，不派新任务。');
      assert.equal(receipt.dispatchCount, number);
      const worker = runtime.store.workers().find(w => !prior.includes(w.id)); assert(worker, 'No ordinary worker registered');
      await wait(() => runtime.store.jobs(worker.id).every(j => !['running', 'queued'].includes(j.status)) && runtime.isIdle() && manager.isIdle(), marker);
      const job = runtime.store.jobs(worker.id)[0];
      receipt.workers.push({ targetId: target.id, workerId: worker.id, jobId: job.id, status: job.status, model: worker.model, actualModel: runtime.store.getWorker(worker.id).actualModel,
        nativeId: runtime.store.getWorker(worker.id).nativeId, processStopped: job.processStopped, result: job.result?.slice(0, 1000) }); save();
      assert.equal(job.status, 'completed'); assert.equal(job.processStopped, true); assert.match(job.result, new RegExp(marker));
      assert(job.result.toLowerCase().includes(target.expectedHostname.toLowerCase()));
    });
  } catch (error) { await check('setup', async () => { throw error; }); }
  finally {
    if (store && conversation) {
      const value = store.getConversation(conversation.id);
      receipt.controller = { nativeId: value?.nativeId, requestedModel: model, actualModel: value?.actualModel, requestedEffort: controllerEffort, actualEffort: value?.actualEffort };
    }
    receipt.cleanup = [];
    for (const [name, item] of [['host', host], ['catalog', catalog], ...(!host ? Object.entries(execution) : [])]) {
      if (!item) continue; try { await item.close(); receipt.cleanup.push({ name, status: 'closed' }); }
      catch { receipt.cleanup.push({ name, status: 'unconfirmed' }); }
    }
    setRemoteDeploymentHook(undefined); await deployments?.close(); store?.close();
    if (receipt.cleanup.every(item => item.status === 'closed')) {
      const clean = path => { if (!existsSync(path)) return; for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name); if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) clean(file);
        else if (['auth.json', 'auth.json.source-hash', '.credentials.json', '.credentials.json.source-hash', '.claude.json', '.claude.json.source-hash', 'config.toml', 'settings.json'].includes(entry.name)) unlinkSync(file);
      } };
      clean(config.dataDir); receipt.credentialsRemoved = true;
    }
    await check('cleanup', async () => assert(receipt.cleanup.every(item => item.status === 'closed'), 'Isolated process shutdown unconfirmed'));
    receipt.finishedAt = new Date().toISOString(); delete receipt.expected; save();
  }
}
