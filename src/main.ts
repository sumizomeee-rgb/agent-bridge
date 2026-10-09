import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, agentEnvironment, safeError, redactText } from './config.js';
import { CodexAdapter } from './agents/codex.js';
import { ClaudeAdapter } from './agents/claude.js';
import { SessionManager } from './manager.js';
import { DiscordTransport } from './discord.js';
import { DurableIngress } from './ingress.js';
import { NativeControllerAdapter } from './controller/native.js';
import { ControllerRuntime } from './controller/runtime.js';
import { TaskRegistry, TaskService } from './tasks.js';
import type { IncomingDM } from './types.js';

if (process.argv.includes('--help')) {
  console.log('启动：start.ps1 [-ProxyPort 7898]\n配置检查：start.ps1 -Check\n私聊：/help、new chat、/chats、/agent、/stop');
  process.exit(0);
}
const config = loadConfig();
const log = (message: string): void => {
  const line = `${new Date().toISOString()} ${safeError(message, [config.token])}\n`;
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
  log(`CONFIG_OK agent=${config.defaultAgent} proxy=${config.proxyUrl ?? 'inherit'} allowedUsers=${config.allowedUserIds.length} workspace=${config.workspace}`);
  process.exit(0);
}
// One bot identity, one worker on this computer, including relocated copies.
const guard = createServer(socket => socket.destroy());
const identity = createHash('sha256').update(config.token).digest('hex').slice(0, 24);
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\discord-agent-bridge-${identity}` : join(config.dataDir, `bridge-${identity}.sock`);
await new Promise<void>((resolve, reject) => {
  guard.once('error', reject);
  guard.listen(pipe, resolve);
});
const pidFile = join(config.dataDir, 'bridge.pid.json');
const stopFile = join(config.dataDir, 'stop.request');
if (existsSync(stopFile)) unlinkSync(stopFile);
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), main: process.argv[1] }));
const env = agentEnvironment(config);
const tasks = new TaskRegistry(config.dataDir);
// Executing children retain the user's ordinary CLI, skills, approvals and provider routing.
const executionAdapters = { codex: new CodexAdapter(config.commands.codex, env), claude: new ClaudeAdapter(config.commands.claude, env) };
let manager: SessionManager;
const runtime = config.controllerMode ? new ControllerRuntime(config, executionAdapters, tasks, {
  onCompletion: () => manager.completionAvailable(),
  onCountChanged: conversationId => manager.refreshTaskCounts(conversationId),
  onError: error => log('CONTROLLER_WORKER ' + safeError(error)),
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
const ingress = new DurableIngress(config.dataDir, {
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
      if (closing) return;
      if (manager.hasMessage(message.id)) {
        if (message.interaction) await discord.sendInteractionText(message.interaction, '这条命令已经处理，不会重复执行。');
        return;
      }
      const control = isControl(message);
      if (!control && messageRevisions.get(message.id) !== (preparationEpochs.get(message.userId) ?? 0)) {
        manager.discard({ id: message.id, userId: message.userId, channelId: message.channelId, text: message.text, imagePaths: [] });
        return;
      }
      const imagePaths = control ? [] : await discord.downloadImages(message);
      if (closing) return;
      const prepared = { id: message.id, userId: message.userId, channelId: message.channelId, text: message.text, imagePaths };
      if (!control && messageRevisions.get(message.id) !== (preparationEpochs.get(message.userId) ?? 0)) {
        manager.discard(prepared);
        return;
      }
      const commandReply = message.interaction
        ? (text: string) => discord.sendInteractionText(message.interaction!, redactText(text, [config.token, message.interaction!.token]))
        : undefined;
      await manager.handle(prepared, commandReply);
    } finally { messageRevisions.delete(message.id); }
  },
  onError: (message, error) => {
    if (closing) return;
    log('INGRESS_PREPARATION_FAILED ' + safeError(error));
    void discord.sendText(message.channelId, '这条消息处理失败，请稍后再试。').catch(() => log('收件错误反馈发送失败。'));
  },
});
const discord: DiscordTransport = new DiscordTransport(config, message => ingress.receive(message), {
  logger: message => log('DISCORD ' + message),
  onReceive: message => { ingress.capture(message); },
  onReady: () => ingress.recover((channelId, options) => discord.readDMHistory(channelId, options)),
});
manager = new SessionManager(config, adapters, {
  markReplyDelivered: messages => discord.markReplyDelivered(messages),
  setTaskCount: (message, count) => discord.setTaskCount(message, count),
  sendText: (channelId, text, options) => discord.sendText(channelId, redactText(text, [config.token]),
    options ? {
      ...options,
      ...(options.repeatHeader ? { repeatHeader: redactText(options.repeatHeader, [config.token]) } : {}),
      ...(options.images ? { images: options.images.map(image => ({ ...image,
        ...(image.description ? { description: redactText(image.description, [config.token]) } : {}),
      })) } : {}),
      ...(options.files ? { files: options.files.map(file => ({ ...file,
        ...(file.description ? { description: redactText(file.description, [config.token]) } : {}),
      })) } : {}),
    } : undefined),
}, { taskRegistry: tasks, ...(config.controllerMode ? { mergeDelayMs: 0 } : {}),
  ...(runtime ? { onStop: id => runtime.cancelConversation(id), onDetach: id => runtime.detachConversation(id),
    controllerSeed: conversation => migrationSeeds.get(conversation.id) ?? '' } : {}),
});
for (const channel of manager.knownChannels()) if (config.allowedUserIds.includes(channel.userId)) ingress.seedChannel(channel);
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  releaseStartup();
  clearInterval(stopPoll);
  log('STOPPING');
  // Abort REST/backfill and stop fresh Gateway input before closing either journal.
  await discord.close().catch(e => log('discord close: ' + safeError(e)));
  await ingress.close().catch(e => log('ingress close: ' + safeError(e)));
  await taskService.close().catch(e => log('tasks close: ' + safeError(e)));
  await manager.close().catch(e => log('close: ' + safeError(e)));
  await runtime?.close().catch(e => log('controller close: ' + safeError(e)));
  await Promise.allSettled(Object.values(executionAdapters).map(adapter => adapter.close()));
  tasks.close();
  guard.close();
  if (existsSync(pidFile)) unlinkSync(pidFile);
  if (existsSync(stopFile)) unlinkSync(stopFile);
  log('STOPPED');
}
const stopPoll = setInterval(() => { if (existsSync(stopFile)) void shutdown(); }, 1000);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => void shutdown());
process.on('uncaughtException', e => { log(`FATAL ${safeError(e)}`); void shutdown().finally(() => { process.exitCode = 1; }); });
process.on('unhandledRejection', e => log(`ERROR ${safeError(e)}`));
try {
  await discord.start();
  log(`READY bot=${discord.botUser?.username ?? 'unknown'} agent=${config.defaultAgent} proxy=${config.proxyUrl ?? 'inherit'}`);
  void discord.syncSlashCommands().then(() => log('SLASH_COMMANDS_SYNCED')).catch(error => log(`SLASH_COMMANDS_FAILED ${safeError(error, [config.token])}`));
  await manager.recover();
  if (!closing) await runtime?.start();
  if (!closing) taskService.start();
  releaseStartup();
  if (!closing) ingress.start();
} catch (error) {
  log(`START_FAILED ${safeError(error)}`);
  await shutdown();
  process.exitCode = 1;
}
