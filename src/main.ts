import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, prepareConfigPaths, projectRoot, agentEnvironment, safeError, redactText } from './config.js';
import { CodexAdapter } from './agents/codex.js';
import { ClaudeAdapter } from './agents/claude.js';
import { SessionManager } from './manager.js';
import { PlatformTransport } from './platform.js';
import { acquireInstanceLock } from './instance-lock.js';
import { ensureSemanticData } from './profile-migration.js';
import { DurableIngress } from './ingress.js';
import { NativeControllerAdapter } from './controller/native.js';
import { ControllerRuntime } from './controller/runtime.js';
import { TaskRegistry, TaskService } from './tasks.js';
import type { IncomingDM } from './types.js';
import { RestartService } from './restart.js';
import { closeResources } from './shutdown.js';
import { TargetCatalogService } from './remote/catalog.js';
import { CapabilityHealthService } from './capabilities.js';

if (process.argv.includes('--help')) {
  console.log('启动：start.ps1 [-Profile discord/default] [-ProxyPort 7898]\n配置检查：start.ps1 -Check\n私聊：/help、new chat、/chats、/agent、/stop');
  process.exit(0);
}
const config = loadConfig(undefined, false);
const secrets = [config.token, config.appSecret ?? ''];
const log = (message: string): void => {
  const line = `${new Date().toISOString()} ${safeError(message, secrets)}\n`;
  appendFileSync(join(config.logsDir, 'bridge.log'), line);
  process.stdout.write(line);
};
async function checkProxy(): Promise<void> {
  if (!config.proxyUrl) return;
  const proxy = new URL(config.proxyUrl);
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });
    socket.setTimeout(3000);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('代理端口没有响应，请先启动笔记本网络项目')); });
    socket.once('error', reject);
  });
}
await checkProxy();
if (process.argv.includes('--check')) {
  console.log(`CONFIG_OK platform=${config.platform} profile=${config.profile} agent=${config.defaultAgent} allowedUsers=${config.allowedUserIds.length} workspace=${config.workspace}`);
  process.exit(0);
}
const projectGuard = await acquireInstanceLock(projectRoot, config.dataDir);
prepareConfigPaths(config);
ensureSemanticData(config.dataDir);
let manager: SessionManager;
let restart: RestartService;
let ingress: DurableIngress;
let closing = false;
const transport: PlatformTransport = new PlatformTransport(config, message => {
  if (restart.isDraining()) {
    if (!message.interaction) ingress.capture(message);
    return Promise.resolve();
  }
  return ingress.receive(message);
}, {
  logger: message => log(config.platform?.toUpperCase() + ' ' + message),
  onReceive: message => { ingress.capture(message); },
  onReady: () => restart.isDraining() ? Promise.resolve() : ingress.recover((channelId, options) => transport.readDMHistory(channelId, options)),
});
const applicationIdentity = await transport.verifyIdentity().catch(async error => {
  await transport.close(); projectGuard.close(); throw new Error(safeError(error, secrets));
});
// Project selection is exclusive; the actual bot identity is also exclusive across relocated copies.
const guard = createServer(socket => socket.destroy());
const identity = createHash('sha256').update(`${config.platform}:${applicationIdentity}`).digest('hex').slice(0, 24);
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\agent-bridge-bot-${identity}` : join(config.dataDir, `bridge-${identity}.sock`);
await new Promise<void>((resolve, reject) => { guard.once('error', reject); guard.listen(pipe, resolve); }).catch(async error => {
  await transport.close(); projectGuard.close(); throw new Error('当前机器人已有桥实例运行。');
});
const pidFile = join(config.dataDir, 'bridge.pid.json');
const stopFile = join(config.dataDir, 'stop.request');
if (existsSync(stopFile)) unlinkSync(stopFile);
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), main: process.argv[1], platform: config.platform, profile: config.profile }));
const capabilityHealth = new CapabilityHealthService(config);
try { log(capabilityHealth.startupSummary(await capabilityHealth.refresh(config.workspace))); }
catch (error) { log('CAPABILITY_HEALTH_FAILED ' + safeError(error, secrets)); }
const env = agentEnvironment(config);
const tasks = new TaskRegistry(config.dataDir);
// Executing children retain the user's ordinary CLI, skills, approvals and provider routing.
const executionAdapters = { codex: new CodexAdapter(config.commands.codex, env), claude: new ClaudeAdapter(config.commands.claude, env) };
const targetCatalog = new TargetCatalogService(config, executionAdapters);
const runtime = config.controllerMode ? new ControllerRuntime(config, executionAdapters, tasks, {
  targetCatalog,
  onCheckCapabilities: (workspace, args) => capabilityHealth.query(workspace, args),
  onStall: event => {
    if (!event.taskId) return;
    const text = `观察时间：${event.observedAt}\n目标：${event.targetId}；workerId：${event.workerId}；jobId：${event.jobId}\n工具：${event.tool.toolName ?? '未知'}；已等待约 ${Math.floor(event.waitingMs / 1000)} 秒。任务仍在执行，未自动停止或重做。`;
    if (tasks.observeTask(event.taskId, event.observationKey, text)) manager.completionAvailable();
  },
  onCompletion: () => manager.completionAvailable(),
  onCountChanged: conversationId => manager.refreshTaskCounts(conversationId),
  onWorkCountsChanged: counts => transport.setWorkCounts(counts),
  onError: error => log('CONTROLLER_WORKER ' + safeError(error)),
  isDraining: () => restart?.isDraining() ?? false,
  onRequestRestart: origin => restart.request(origin),
}) : undefined;
const adapters = runtime ? {
  codex: new NativeControllerAdapter(config.commands.codex, env, {
    agent: 'codex', dataDir: config.dataDir, metadataAdapter: executionAdapters.codex,
    invokeTool: (turn, name, args, id) => runtime.invoke(turn, name, args, id),
  }),
  claude: new NativeControllerAdapter(config.commands.claude, env, {
    agent: 'claude', dataDir: config.dataDir, metadataAdapter: executionAdapters.claude,
    invokeTool: (turn, name, args, id) => runtime.invoke(turn, name, args, id),
  }),
} : executionAdapters;
const taskService = new TaskService(tasks, {
  onCompletion: () => manager.completionAvailable(),
  onCountChanged: conversationId => manager.refreshTaskCounts(conversationId),
  onError: error => log('TASKS ' + safeError(error)),
});
const migrationSeeds = new Map<string, string>();
const migrationPath = join(config.dataDir, 'controller-migration.json');
if (config.controllerMode && existsSync(migrationPath)) {
  try {
    if (statSync(migrationPath).size > 2 * 1024 * 1024) throw new Error('迁移上下文文件超过上限');
    const raw: unknown = JSON.parse(readFileSync(migrationPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('迁移上下文文件格式无效');
    for (const [id, text] of Object.entries(raw)) if (typeof text === 'string') migrationSeeds.set(id, text.slice(0, 64 * 1024));
  } catch (error) { log('MIGRATION_CONTEXT_IGNORED ' + safeError(error)); }
}
let releaseStartup!: () => void;
const startupReady = new Promise<void>(resolve => { releaseStartup = resolve; });
const preparationEpochs = new Map<string, number>();
const messageRevisions = new Map<string, number>();
const isControl = (message: IncomingDM): boolean =>
  /^(?:\/(?:stop|new|cwd)(?:\s|$)|\/agent\s+\S|new\s+chat$|新会话$|新聊天$)/i.test(message.text.trim());
ingress = new DurableIngress(config.dataDir, {
  allowedUserIds: config.allowedUserIds,
  hasMessage: id => manager.hasMessage(id),
  isImmediate: isControl,
  // Stamp before queuing: a later /new cannot reclassify old, still-unprepared input.
  onQueued: (message, replayOnly) => {
    const revision = (preparationEpochs.get(message.userId) ?? 0) + (isControl(message) ? 1 : 0);
    preparationEpochs.set(message.userId, revision);
    if (!replayOnly) messageRevisions.set(message.id, revision);
  },
  handle: async message => {
    try {
      await startupReady;
      if (closing || restart.isDraining()) return;
      if (manager.hasMessage(message.id)) {
        if (message.interaction) await transport.sendInteractionText(message.interaction, '这条命令已经处理，不会重复执行。');
        return;
      }
      const control = isControl(message);
      if (!control && messageRevisions.get(message.id) !== (preparationEpochs.get(message.userId) ?? 0)) {
        manager.discard({ id: message.id, userId: message.userId, channelId: message.channelId, text: message.text, imagePaths: [] });
        return;
      }
      const imagePaths = control ? [] : await transport.downloadImages(message);
      if (closing || restart.isDraining()) return;
      const prepared = { id: message.id, userId: message.userId, channelId: message.channelId, text: message.text, imagePaths };
      if (!control && messageRevisions.get(message.id) !== (preparationEpochs.get(message.userId) ?? 0)) {
        manager.discard(prepared);
        return;
      }
      const commandReply = message.interaction
        ? (text: string) => transport.sendInteractionText(message.interaction!, redactText(text, [...secrets, message.interaction!.token]))
        : undefined;
      await manager.handle(prepared, commandReply);
    } finally { messageRevisions.delete(message.id); }
  },
  onError: (message, error) => {
    if (closing || restart.isDraining()) return;
    log('INGRESS_PREPARATION_FAILED ' + safeError(error));
    void transport.sendText(message.channelId, transport.failureText(error)).catch(() => log('收件错误反馈发送失败。'));
  },
});

manager = new SessionManager(config, adapters, {
  markReplyDelivered: messages => transport.markReplyDelivered(messages),
  setTaskCount: (message, count) => transport.setTaskCount(message, count),
  sendText: (channelId, text, options) => transport.sendText(channelId, redactText(text, secrets),
    options ? {
      ...options,
      ...(options.repeatHeader ? { repeatHeader: redactText(options.repeatHeader, secrets) } : {}),
      ...(options.images ? { images: options.images.map(image => ({ ...image,
        ...(image.description ? { description: redactText(image.description, secrets) } : {}),
      })) } : {}),
      ...(options.files ? { files: options.files.map(file => ({ ...file,
        ...(file.description ? { description: redactText(file.description, secrets) } : {}),
      })) } : {}),
    } : undefined),
}, { taskRegistry: tasks,
  onListComputers: (conversation, refresh) => targetCatalog.computerOverview(conversation.cwd, refresh),
  onListWorkers: (conversation, scope) => Promise.resolve(runtime?.queryWorkerOverview(conversation, scope) ?? []),
  ...(config.controllerMode ? { mergeDelayMs: 0 } : {}),
  ...(runtime ? { onStop: id => runtime.cancelConversation(id), onDetach: id => runtime.detachConversation(id),
    onInitializeWorkspace: turn => runtime.initializeWorkspace(turn),
    onInitializationError: (_conversation, error) => log('workspace initialization: ' + safeError(error)),
    controllerSeed: conversation => migrationSeeds.get(conversation.id) ?? '' } : {}),
});
restart = new RestartService(config.dataDir, {
  supervised: process.env.BRIDGE_SUPERVISED === '1',
  beginDrain: () => { ingress.pause(); manager.beginDrain(); runtime?.beginDrain(); },
  isIdle: () => manager.isIdle() && (runtime?.isIdle() ?? true) && transport.isIdle(),
  shutdown: () => shutdown(true),
  onShutdownComplete: exitCode => { process.exitCode = exitCode; restart.close(); },
  presence: phase => transport.setPresence(phase),
  onError: error => log('RESTART ' + safeError(error)),
});
restart.beginRecovery();
for (const channel of manager.knownChannels()) if (config.allowedUserIds.includes(channel.userId)) ingress.seedChannel(channel);
async function shutdown(plannedRestart = false): Promise<void> {
  if (closing) return;
  closing = true;
  releaseStartup();
  clearInterval(stopPoll);
  if (!plannedRestart) restart.cancel();
  log(plannedRestart ? 'RESTART_STOPPING' : 'STOPPING');
  // Abort REST/backfill and stop fresh Gateway input before closing either journal.
  try {
    await closeResources([
      { name: '通信平台', close: () => transport.close() },
      { name: '收件', close: () => ingress.close() },
      { name: '任务回执', close: () => taskService.close() },
      { name: '主控', close: () => manager.close() },
      { name: '执行任务', close: async () => { await runtime?.close(); } },
      { name: '远程目录', close: () => targetCatalog.close() },
      ...Object.entries(executionAdapters).map(([agent, adapter]) => ({ name: `${agent} 执行器`, close: () => adapter.close() })),
      { name: '任务数据库', close: () => tasks.close() },
      { name: '进程标识', close: () => {
        guard.close(); projectGuard.close();
        if (existsSync(pidFile)) unlinkSync(pidFile);
        if (existsSync(stopFile)) unlinkSync(stopFile);
      } },
    ]);
    log('STOPPED');
  } catch (error) {
    log('STOP_FAILED ' + safeError(error));
    if (plannedRestart) throw error;
  } finally {
    // RestartService records a planned failure before it releases the journal.
    if (!plannedRestart) restart.close();
  }
}
const stopPoll = setInterval(() => { if (existsSync(stopFile)) void shutdown(); }, 1000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => void shutdown());
process.on('uncaughtException', e => { log(`FATAL ${safeError(e)}`); restart.failed(safeError(e)); void shutdown().finally(() => { if (process.exitCode !== 76) process.exitCode = 1; }); });
process.on('unhandledRejection', e => log(`ERROR ${safeError(e)}`));
try {
  await transport.start();
  log(`READY bot=${transport.botUser?.username ?? 'unknown'} agent=${config.defaultAgent} proxy=${config.proxyUrl ?? 'inherit'}`);
  void transport.syncSlashCommands().then(() => log('SLASH_COMMANDS_SYNCED')).catch(error => log(`SLASH_COMMANDS_FAILED ${safeError(error, secrets)}`));
  await manager.recover();
  if (!closing) await runtime?.start();
  if (!closing) taskService.start();
  if (!closing && runtime) transport.setWorkCounts(runtime.getGlobalWorkCounts());
  releaseStartup();
  if (!closing) { ingress.start(); restart.ready(); }
} catch (error) {
  log(`START_FAILED ${safeError(error)}`);
  restart.failed(safeError(error));
  await shutdown();
  if (process.exitCode !== 76) process.exitCode = 1;
}
