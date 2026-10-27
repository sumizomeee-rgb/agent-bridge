import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Faults } from './faults.mjs';

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
  const { DeliveryPreparationError } = await load('delivery-errors.js');
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
  receipt.faults = [];
  const faults = new Faults(event => { receipt.faults.push(event); save(); });
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
  let reportSource;
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
            assert.equal(args.agent, undefined, 'Inheritance test must omit agent');
            assert.equal(args.model, undefined, 'Inheritance test must omit model');
            assert.equal(args.effort, undefined, 'Inheritance test must omit effort');
            const result = await runtime.invoke(turn, name, args, callId);
            receipt.inheritedDispatch = result; save();
            return result;
          }
          if (gate) { gateReached = true; await gate; gate = undefined; }
          return runtime.invoke(turn, name, args, callId);
        }, createTransport: (cmd, args, workdir, processEnv) => {
          return faults.wrap(trace(new JsonLineProcess(cmd, args, workdir, processEnv), 'controller', instance), agent);
        } });
      const adapter = { getModelInfo: (...args) => native.getModelInfo(...args), interrupt: (...args) => native.interrupt(...args), close: () => native.close(),
        run: turn => {
          if (turn.event?.kind === 'worker-result') reportSource = turn.source;
          return native.run({ ...turn, onModel: value => { receipt.models.push(value); turn.onModel?.(value); },
          onEffortMetadata: value => { receipt.efforts.push(value); turn.onEffortMetadata?.(value); },
          onControllerState: state => { receipt.lifecycle.push({ ...state, at: new Date().toISOString() }); save(); turn.onControllerState?.(state); } }); } };
      manager = new SessionManager(config, { [agent]: adapter, [other]: deny }, sink, { mergeDelayMs: 0, taskRegistry: registry,
        onWorkerDefaults: args => runtime.workerDefaultCommand(args), onListWorkers: (conversation, scope) => Promise.resolve(runtime.queryWorkerOverview(conversation, scope)) });
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
      await send('dispatch', prefix + '调用 bridge_start_worker 一次，必须省略 agent、model、effort 参数，使用主控默认继承；任务是“禁止使用任何工具；仅计算 17+25，输出 LAB_WORKER_42”，然后通过 bridge_send_user 回复 LAB_DISPATCHED。收到后续助手结果时，只回复包含真实结果的 LAB_RESULT，不要再次派工。');
      await finished('dispatch');
      await wait(() => receipt.workerRuns[0]?.finishedAt && runtime.isIdle() && manager.isIdle() && receipt.deliveries.some(item => item.text.includes('LAB_RESULT')), 'worker result returned to controller');
      assert.equal(receipt.workerRuns.length, 1); assert.match(receipt.workerRuns[0].result, /LAB_WORKER_42/);
      assert(receipt.deliveries.some(item => /LAB_RESULT[\s\S]*(?:LAB_WORKER_42\b|\b42\b)/.test(item.text)));
      nativeId = store.getConversation(conversationId).nativeId; assert(nativeId);
      assert.equal(receipt.inheritedDispatch.agent, agent);
      assert.equal(receipt.inheritedDispatch.model, model);
      assert.equal(receipt.inheritedDispatch.effort, 'xhigh');
    });
    await checkpoints('warm turn with a second input arriving during tool execution', async () => {
      gate = new Promise(accept => { releaseGate = accept; });
      await send('warm', prefix + '请调用 bridge_list_workers 核对刚才的任务，然后通过 bridge_send_user 回复 LAB_WARM。');
      await wait(() => gateReached || store.getMessage('warm')?.state === 'failed', 'worker-list gate'); assert(gateReached);
      await send('during', prefix + '这是执行中追加的真实输入，请在回复中包含 LAB_DURING，不要派新任务。');
      const beforeWaiting = receipt.deliveries.length;
      await delay(3000);
      assert.equal(receipt.deliveries.length, beforeWaiting, 'Waiting for a tool must not publish a warning');
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
    await checkpoints('duplicate platform message does not execute or reply twice', async () => {
      const before = receipt.lifecycle.length, replies = receipt.deliveries.length;
      await send('resumed', prefix + '重复投递，不应该执行。');
      await delay(500);
      assert.equal(receipt.lifecycle.length, before); assert.equal(receipt.deliveries.length, replies);
    });
    await checkpoints('authorize independent fault reports in the real owner conversation', async () => {
      await send('fault-authorization', prefix + '接下来会对刚才保存的助手结果进行多个独立故障演练。每次新的 LAB_CASE 标记都需要单独汇报一次已保存的结果，即使算式相同；不是再次派工授权。请先通过 bridge_send_user 回复 LAB_FAULT_READY。');
      await finished('fault-authorization');
    });

    // Adapter-boundary fault cases reuse the genuinely completed worker receipt.
    // They do not pretend to replay a production task/event database or Feishu HTTP.
    const savedResult = receipt.workerRuns[0].result;
    const decision = async ({ report = false, delivery, marker = 'LAB_FAULT_OK' } = {}) => {
      const states = [], replies = [], start = receipt.tools.length;
      const text = report
        ? `LAB_CASE_${(receipt.decisions?.length ?? 0) + 1}: 主人已授权的独立故障演练汇报，本次尚未发送。Saved completed worker result: ${savedResult}. 不要派工，只通过 bridge_send_user 汇报 ${marker} 和已保存结果。`
        : `不要派工或调用其他工具，只通过 bridge_send_user 回复 ${marker}。`;
      const entry = { report, marker, states, replies, boundary: 'real-native-adapter/local-delivery' };
      (receipt.decisions ??= []).push(entry); save();
      let calls = 0;
      const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 240000);
      try {
        await native.run({ conversation: store.getConversation(conversationId), text, imagePaths: [],
          source: report ? reportSource : { messageId: `lab-fault-${receipt.decisions.length}`, userId: 'lab-owner', channelId: 'lab-private' },
          signal: abort.signal, effort: 'xhigh', controllerRecovery: true,
          ...(report ? { event: { kind: 'worker-result', text } } : {}),
          onProgress() {}, onNativeId: id => assert.equal(id, nativeId),
          onControllerState: state => { states.push(state); save(); },
          onPublicMessage: async value => {
            calls++; entry.deliveryAttempts = calls;
            if (delivery === 'pre-send' && calls === 1) {
              receipt.faults.push({ kind: delivery, source: 'lab-injection' }); save();
              throw new DeliveryPreparationError('LAB invalid destination before sending; correct and retry');
            }
            if (delivery === 'unknown') {
              receipt.faults.push({ kind: delivery, source: 'lab-injection' }); save();
              throw Object.assign(new Error('LAB delivery acknowledgement lost'), { deliveryUncertain: true });
            }
            replies.push(value); save();
          },
        });
        entry.outcome = 'completed';
      } catch (error) { entry.outcome = 'failed'; entry.error = String(error.message).slice(0, 300); }
      finally { clearTimeout(deadline); entry.executionTools = receipt.tools.slice(start).filter(item => item.name === 'bridge_start_worker').length; save(); }
      assert.equal(entry.executionTools, 0, 'Fault recovery must not dispatch work');
      assert.equal(receipt.workerRuns.length, 1);
      return entry;
    };
    const boundaryCase = async (name, work) => {
      // Independent faults all get a result even if another case failed. Never rerun a failed case implicitly.
      try { await checkpoints(name, work); } catch { faults.pending = null; }
    };
    await boundaryCase('saved worker report: accepted failure recovers once with real model', async () => {
      const fault = faults.arm('accepted-failure');
      const result = await decision({ report: true });
      assert.equal(fault.hits, 1); assert.equal(result.outcome, 'completed'); assert.equal(result.replies.length, 1);
      assert.match(result.replies[0], /42/);
      assert.equal(result.states.filter(s => s.phase === 'reply-recovery').length, 1);
    });
    await boundaryCase('saved worker report: second failure stops at the recovery bound', async () => {
      const fault = faults.arm('accepted-failure', 2);
      const result = await decision({ report: true });
      assert.equal(fault.hits, 2); assert.equal(result.outcome, 'failed'); assert.equal(result.replies.length, 0);
      assert.equal(result.states.filter(s => s.phase === 'reply-recovery').length, 1);
      assert.equal(result.states.at(-1).phase, 'failed');
    });
    await boundaryCase('explicit failure of user input is not automatically replayed; next input works', async () => {
      const fault = faults.arm('accepted-failure');
      const result = await decision();
      assert.equal(fault.hits, 1); assert.equal(result.outcome, 'failed'); assert.equal(result.replies.length, 0);
      assert.equal(result.states.filter(s => s.phase === 'reply-recovery' || s.phase === 'retrying').length, 0);
      const next = await decision({ marker: 'LAB_NEXT_INPUT_OK' });
      assert.equal(next.outcome, 'completed'); assert.equal(next.replies.length, 1);
    });
    await boundaryCase('pre-send rejection is corrected by real model without new worker', async () => {
      const result = await decision({ delivery: 'pre-send' });
      assert.equal(result.outcome, 'completed'); assert.equal(result.deliveryAttempts, 2); assert.equal(result.replies.length, 1);
    });
    await boundaryCase('unknown delivery acknowledgement never resends a report', async () => {
      const result = await decision({ report: true, delivery: 'unknown' });
      assert.equal(result.outcome, 'failed'); assert.equal(result.deliveryAttempts, 1); assert.equal(result.replies.length, 0);
      assert.equal(result.states.filter(s => s.phase === 'reply-recovery').length, 0);
    });
    await boundaryCase('transport loss does not replay a report; next input works', async () => {
      const fault = faults.arm('transport-lost');
      const result = await decision({ report: true });
      assert.equal(fault.hits, 1); assert.equal(result.outcome, 'failed'); assert.equal(result.replies.length, 0);
      assert.equal(result.states.filter(s => s.phase === 'reply-recovery').length, 0);
      const next = await decision({ marker: 'LAB_AFTER_DISCONNECT' });
      assert.equal(next.outcome, 'completed'); assert.equal(next.replies.length, 1);
    });
    if (agent === 'codex') await boundaryCase('real CLI initialization timeout retries once before submitting saved report', async () => {
      await manager.close(); manager = undefined; await runtime.close(); runtime = undefined; await open();
      const fault = faults.arm('initialize-timeout');
      const result = await decision({ report: true });
      assert.equal(fault.hits, 1); assert.equal(result.outcome, 'completed'); assert.equal(result.replies.length, 1);
      assert.equal(result.states.filter(s => s.phase === 'retrying').length, 1);
      assert.equal(result.states.filter(s => s.phase === 'accepted').length, 1);
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
