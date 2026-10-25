import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Live tests run real CLI generations. Every test object is created in a fresh lab directory.
export async function runLive({ root, runDir, configPath, agent, evidence, save }) {
  const load = file => import(pathToFileURL(join(root, 'dist/src', file)));
  const { loadHostConfig, agentEnvironment } = await load('config.js');
  const { NativeControllerAdapter, isolatedCodexConfig, codexControllerOverrides } = await load('controller/native.js');
  const { CodexAdapter } = await load('agents/codex.js');
  const { ClaudeAdapter } = await load('agents/claude.js');
  const { JsonLineProcess } = await load('agents/process.js');
  const { ControllerRuntime } = await load('controller/runtime.js');
  const { SessionManager } = await load('manager.js');
  const { SessionStore } = await load('store.js');
  const { TaskRegistry } = await load('tasks.js');
  const source = loadHostConfig(['--config', configPath], false).configs.find(config => config.defaultAgent === agent);
  if (!source) throw new Error('No configured backend: ' + agent);
  const dir = join(runDir, agent), cwd = join(dir, 'workspace'), userHome = join(dir, 'user-home');
  for (const path of [cwd, join(userHome, '.codex'), join(userHome, '.claude')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(cwd, 'README.md'), '隔离桥测试。仅处理测试文字，不访问任何业务环境或外部用户。\n');
  const sourceEnv = agentEnvironment(source);
  const sourceHome = sourceEnv.USERPROFILE || sourceEnv.HOME || homedir();
  const env = { ...sourceEnv, BRIDGE_TASK_CONTEXT: undefined, CODEX_HOME: join(userHome, '.codex'), CLAUDE_CONFIG_DIR: join(userHome, '.claude') };
  const model = agent === 'codex' ? 'gpt-6-luna' : 'haiku';
  const receipt = { agent, requestedModel: model, requestedEffort: 'xhigh', models: [], efforts: [], lifecycle: [], transport: [], workerRuns: [], deliveries: [], tools: [] };
  evidence.live ??= []; evidence.live.push(receipt);
  const trace = (transport, role, instance) => {
    const pending = new Map(); const write = transport.write.bind(transport);
    transport.write = message => {
      if (message.method || message.type === 'user') {
        const event = { role, instance, method: message.method ?? 'claude/user', at: new Date().toISOString() };
        receipt.transport.push(event); if (message.id !== undefined) pending.set(message.id, { event, started: Date.now() }); save();
      }
      write(message);
    };
    transport.onMessage(message => {
      if (message.id !== undefined && pending.has(message.id) && ('result' in message || 'error' in message)) {
        const { event, started } = pending.get(message.id); pending.delete(message.id);
        event.responseMs = Date.now() - started; event.protocolError = 'error' in message; save();
      }
    });
    const stop = transport.stop.bind(transport);
    transport.stop = async (...args) => {
      const started = Date.now();
      try { return await stop(...args); }
      finally { receipt.transport.push({ role, instance, method: 'process/stop', elapsedMs: Date.now() - started, confirmed: transport.confirmStopped(), at: new Date().toISOString() }); save(); }
    };
    return transport;
  };
  const checkpoints = async (name, work) => {
    const item = { name: agent + ': ' + name, status: 'running', startedAt: new Date().toISOString() }; evidence.cases.push(item); save();
    try { await work(); item.status = 'passed'; }
    catch (error) { item.status = 'failed'; item.error = String(error.message).slice(0, 300); throw error; }
    finally { item.finishedAt = new Date().toISOString(); save(); }
  };
  let manager, runtime, registry, store, native, execution, metadata;
  let gate, gateReached = false, releaseGate = () => {}, nativeId, conversationId, instance = 0, dispatches = 0;
  let cleanupOK = true;
  const deny = { run: async () => { throw new Error('Unselected backend is disabled'); }, close: async () => {}, interrupt: async () => {} };
  const other = agent === 'codex' ? 'claude' : 'codex';
  const within = path => { const rel = relative(dir, resolve(path)); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
  const removeCredentials = path => {
    assert(within(path));
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name); if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) removeCredentials(child);
      else if (['auth.json', 'auth.json.source-hash', '.credentials.json', '.credentials.json.source-hash', '.claude.json', '.claude.json.source-hash', 'config.toml', 'settings.json'].includes(entry.name)) unlinkSync(child);
    }
  };
  try {
    // Copy only routing/auth into a private lab home, never sessions/history/plugins.
    if (agent === 'codex') {
      const src = sourceEnv.CODEX_HOME || join(sourceHome, '.codex');
      writeFileSync(join(userHome, '.codex/config.toml'), isolatedCodexConfig(readFileSync(join(src, 'config.toml'), 'utf8')));
      if (existsSync(join(src, 'auth.json'))) copyFileSync(join(src, 'auth.json'), join(userHome, '.codex/auth.json'));
    } else {
      const src = sourceEnv.CLAUDE_CONFIG_DIR || join(sourceHome, '.claude');
      const settings = existsSync(join(src, 'settings.json')) ? JSON.parse(readFileSync(join(src, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')) : {};
      writeFileSync(join(userHome, '.claude/settings.json'), JSON.stringify({ env: settings.env ?? {}, disableAllHooks: true }));
      for (const [from, to] of [[join(src, '.credentials.json'), join(userHome, '.claude/.credentials.json')], [join(sourceHome, '.claude.json'), join(userHome, '.claude.json')]]) if (existsSync(from)) copyFileSync(from, to);
      Object.assign(env, settings.env ?? {}, sourceEnv, { CLAUDE_CONFIG_DIR: join(userHome, '.claude'), CODEX_HOME: join(userHome, '.codex'), BRIDGE_TASK_CONTEXT: undefined });
    }
    const command = source.commands[agent];
    const Adapter = agent === 'codex' ? CodexAdapter : ClaudeAdapter;
    metadata = new Adapter(command, env);
    await checkpoints('model/effort preflight (no fallback)', async () => {
      const info = await metadata.getModelInfo(cwd); const selected = info.models.find(item => item.id === model);
      receipt.selection = selected ?? null;
      assert(selected, 'Requested model missing from real CLI metadata');
      assert(selected.supportedEfforts?.includes('xhigh'), 'CLI metadata did not confirm xhigh');
      await metadata.close(); metadata = undefined;
    });
    const workerTransport = (cmd, args, workdir, processEnv) => {
      assert.equal(resolve(workdir), cwd, 'Worker escaped lab workspace');
      // Use the real executor adapter/protocol, but remove native business tools.
      const extra = agent === 'codex' ? [...codexControllerOverrides(), 'features.code_mode_host=false'].flatMap(value => ['-c', value])
        : ['--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}'];
      const transport = trace(new JsonLineProcess(cmd, [...args, ...extra], workdir, processEnv), 'executor', receipt.workerRuns.length);
      const write = transport.write.bind(transport);
      transport.write = message => {
        if (['thread/start', 'thread/resume'].includes(message.method)) message = { ...message, params: { ...message.params, sandbox: 'read-only', approvalPolicy: 'never' } };
        write(message);
      };
      return transport;
    };
    execution = new Adapter(command, env, workerTransport);
    const worker = { getModelInfo: (...args) => execution.getModelInfo(...args), interrupt: (...args) => execution.interrupt(...args), close: () => execution.close(),
      run: async turn => {
        assert.equal(turn.conversation.model, model, 'Worker model must be the authorized selection');
        assert.equal(turn.effort ?? turn.conversation.effort, 'xhigh');
        const item = { model, effort: 'xhigh', startedAt: new Date().toISOString() }; receipt.workerRuns.push(item); save();
        const result = await execution.run({ ...turn, onModel: value => { item.actualModel = value; turn.onModel?.(value); }, onEffortMetadata: value => { item.effortEvidence = value; turn.onEffortMetadata?.(value); } });
        item.finishedAt = new Date().toISOString(); item.result = result.text; item.nativeId = result.nativeId; save(); return result;
      } };
    const config = { token: '', platform: 'feishu', allowedUserIds: ['lab-owner'], ownerUserId: 'lab-owner', defaultAgent: agent,
      controllerMode: true, workspace: cwd, dataDir: join(dir, 'data'), logsDir: join(dir, 'logs'), attachmentsDir: join(dir, 'images'),
      proxyUrl: null, maxImageBytes: 1024, maxFileBytes: 4096, commands: source.commands, defaultModels: { [agent]: model } };
    store = new SessionStore(config.dataDir); registry = new TaskRegistry(config.dataDir);
    const conversation = store.createConversation('lab-owner', agent, cwd, { controllerMode: true }); conversationId = conversation.id;
    store.setActive('lab-owner', conversationId); store.setModel(conversationId, model); store.setEffort(conversationId, 'xhigh');
    const sink = { sendText: async (channel, text, options) => {
      assert.equal(channel, 'lab-private'); assert(!options?.files?.length, 'Attachments are outside lab scope');
      receipt.deliveries.push({ at: new Date().toISOString(), text }); save();
    } };
    const open = async () => {
      instance++;
      runtime = new ControllerRuntime(config, { [agent]: worker, [other]: deny }, registry, { onCompletion: () => manager.completionAvailable(), pollIntervalMs: 100,
        onError: error => { receipt.runtimeErrors ??= []; receipt.runtimeErrors.push(String(error.message).slice(0, 200)); save(); } });
      native = new NativeControllerAdapter(command, env, { agent, dataDir: config.dataDir, userHome, metadataAdapter: execution,
        invokeTool: async (turn, name, args, callId) => {
          receipt.tools.push({ name, at: new Date().toISOString() }); save();
          if (!['bridge_start_worker', 'bridge_list_workers'].includes(name)) throw new Error('Lab tool not authorized: ' + name);
          if (name === 'bridge_start_worker') {
            assert.equal(dispatches++, 0, 'Only one worker dispatch allowed');
            assert(!args.agent || args.agent === agent, 'Worker backend differs from authorized selection');
            assert(!args.model || args.model === model, 'Worker model differs from authorized selection');
            assert(!args.effort || args.effort === 'xhigh', 'Worker effort differs from authorized selection');
            assert(!args.targetId || args.targetId === 'local'); assert(!args.presetId); assert(!args.cwd || resolve(args.cwd) === cwd);
            return runtime.invoke(turn, name, { ...args, agent, model, effort: 'xhigh', cwd, targetId: 'local' }, callId);
          }
          if (gate) { gateReached = true; await gate; gate = undefined; }
          return runtime.invoke(turn, name, args, callId);
        }, createTransport: (cmd, args, workdir, processEnv) => {
          return trace(new JsonLineProcess(cmd, args, workdir, processEnv), 'controller', instance);
        } });
      const adapter = { getModelInfo: (...args) => native.getModelInfo(...args), interrupt: (...args) => native.interrupt(...args), close: () => native.close(),
        run: turn => native.run({ ...turn, onModel: value => { receipt.models.push(value); turn.onModel?.(value); },
          onEffortMetadata: value => { receipt.efforts.push(value); turn.onEffortMetadata?.(value); },
          onControllerState: state => { receipt.lifecycle.push({ ...state, at: new Date().toISOString() }); save(); turn.onControllerState?.(state); } }) };
      manager = new SessionManager(config, { [agent]: adapter, [other]: deny }, sink, { mergeDelayMs: 0, taskRegistry: registry });
      await runtime.start();
    };
    const wait = async (check, label) => {
      const deadline = Date.now() + 240000;
      while (!check()) { if (Date.now() > deadline) throw new Error('Lab deadline (not production liveness): ' + label); await delay(100); }
    };
    const send = async (id, text) => manager.handle({ id, text, userId: 'lab-owner', channelId: 'lab-private', imagePaths: [], source: { messageId: id, userId: 'lab-owner', channelId: 'lab-private', authorType: 'user' } });
    const finished = async id => {
      await wait(() => ['completed', 'failed', 'cancelled'].includes(store.getMessage(id)?.state) && manager.isIdle(), id);
      assert.equal(store.getMessage(id).state, 'completed', id + ': input failed'); assert.equal(store.getMessage(id).replyState, 'delivered');
    };
    const prefix = '这是隔离测试，所有发送都进入本地接收器。不要做其他工作。';
    await open();
    await checkpoints('cold start and real worker completion round trip', async () => {
      await send('dispatch', prefix + `调用 bridge_start_worker 一次，agent=${agent}, model=${model}, effort=xhigh，任务是“禁止使用任何工具；仅计算 17+25，输出 LAB_WORKER_42”，然后通过 bridge_send_user 回复 LAB_DISPATCHED。收到后续助手结果时，只回复包含真实结果的 LAB_RESULT，不要再次派工。`);
      await finished('dispatch');
      await wait(() => receipt.workerRuns[0]?.finishedAt && runtime.isIdle() && manager.isIdle() && receipt.deliveries.some(item => item.text.includes('LAB_RESULT')), 'worker result returned to controller');
      assert.equal(receipt.workerRuns.length, 1); assert.match(receipt.workerRuns[0].result, /LAB_WORKER_42/);
      assert(receipt.deliveries.some(item => /LAB_RESULT[\s\S]*(?:LAB_WORKER_42\b|\b42\b)/.test(item.text)));
      nativeId = store.getConversation(conversationId).nativeId; assert(nativeId);
    });
    await checkpoints('warm turn with a second input arriving during tool execution', async () => {
      gate = new Promise(accept => { releaseGate = accept; });
      await send('warm', prefix + '请调用 bridge_list_workers 核对刚才的任务，然后通过 bridge_send_user 回复 LAB_WARM。');
      await wait(() => gateReached || store.getMessage('warm')?.state === 'failed', 'worker-list gate'); assert(gateReached);
      await send('during', prefix + '这是执行中追加的真实输入，请在回复中包含 LAB_DURING，不要派新任务。');
      releaseGate(); await finished('warm'); await finished('during');
      assert(receipt.deliveries.some(item => item.text.includes('LAB_DURING'))); assert.equal(receipt.workerRuns.length, 1);
      assert.equal(store.getConversation(conversationId).nativeId, nativeId);
    });
    await checkpoints('restart and resume the same persisted native conversation', async () => {
      await manager.close(); manager = undefined; await runtime.close(); runtime = undefined;
      await open();
      await send('resumed', prefix + '不要调用助手或重复任务。请从本会话记忆回答刚才助手的算式结果，用 bridge_send_user 回复 LAB_RESUMED 和结果标记。');
      await finished('resumed'); assert.equal(store.getConversation(conversationId).nativeId, nativeId);
      assert(receipt.deliveries.some(item => /LAB_RESUMED[\s\S]*(42|LAB_WORKER_42)/.test(item.text))); assert.equal(receipt.workerRuns.length, 1);
    });
    assert(!receipt.deliveries.some(item => /仍在等待主控|正在恢复主控|正在补齐回复/.test(item.text)), 'Routine recovery notification returned');
  } catch (error) {
    receipt.failure = String(error.message).slice(0, 300);
    if (!evidence.cases.some(item => item.name.startsWith(agent + ': ') && item.status === 'failed')) {
      evidence.cases.push({ name: agent + ': setup or invariant', status: 'failed', error: receipt.failure });
    }
    // Failed/blocked cases stay visible; never manufacture a pass by rerunning or changing models.
  } finally {
    releaseGate();
    for (const [name, object] of [['manager', manager], ['native', native], ['runtime', runtime], ['executor', execution], ['metadata', metadata]]) {
      if (object) try { await object.close(); } catch (error) { cleanupOK = false; receipt.cleanupFailure ??= []; receipt.cleanupFailure.push(name + ': ' + String(error.message).slice(0, 200)); }
    }
    store?.close(); registry?.close();
    if (cleanupOK) { for (const path of [userHome, join(dir, 'data')]) if (existsSync(path)) removeCredentials(path); receipt.credentialsRemoved = true; }
    else receipt.credentialsRemoved = false;
    evidence.cases.push({ name: agent + ': isolated process cleanup', status: cleanupOK ? 'passed' : 'failed' }); save();
  }
}
