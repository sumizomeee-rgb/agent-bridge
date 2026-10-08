import { appendFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, agentEnvironment, safeError, redactText } from './config.js';
import { CodexAdapter } from './agents/codex.js';
import { ClaudeAdapter } from './agents/claude.js';
import { SessionManager } from './manager.js';
import { DiscordTransport } from './discord.js';
import { OrderedInbox } from './inbox.js';
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
const adapters = { codex: new CodexAdapter(config.commands.codex, env), claude: new ClaudeAdapter(config.commands.claude, env) };
let manager: SessionManager;
const taskService = new TaskService(tasks, {
  onCompletion: () => manager.completionAvailable(),
  onCountChanged: conversationId => manager.refreshTaskCounts(conversationId),
  onError: error => log(`TASKS ${safeError(error)}`),
});
let releaseStartup!: () => void;
const startupReady = new Promise<void>(resolve => { releaseStartup = resolve; });
const preparationEpochs = new Map<string, number>();
const inbox = new OrderedInbox<IncomingDM & { revision: number }>(message => message.userId, async message => {
  await startupReady;
  if (closing) return;
  if (manager.hasMessage(message.id)) {
    if (message.interaction) await discord.sendInteractionText(message.interaction, '这条命令已经处理，不会重复执行。');
    return;
  }
  const control = /^(?:\/(?:stop|new|agent|cwd)(?:\s|$)|new\s+chat$|新会话$|新聊天$)/i.test(message.text.trim());
  const imagePaths = control ? [] : await discord.downloadImages(message);
  const prepared = { id: message.id, userId: message.userId, channelId: message.channelId, text: message.text, imagePaths };
  if (!control && message.revision !== (preparationEpochs.get(message.userId) ?? 0)) {
    manager.discard(prepared);
    return;
  }
  const commandReply = message.interaction
    ? (text: string) => discord.sendInteractionText(message.interaction!, redactText(text, [config.token, message.interaction!.token]))
    : undefined;
  await manager.handle(prepared, commandReply);
});
const discord = new DiscordTransport(config, message => {
  const control = /^(?:\/(?:stop|new|agent|cwd)(?:\s|$)|new\s+chat$|新会话$|新聊天$)/i.test(message.text.trim());
  // 收件时同步推进 epoch；命令后的新消息不会带着旧准备版本被误取消。
  const revision = (preparationEpochs.get(message.userId) ?? 0) + (control ? 1 : 0);
  preparationEpochs.set(message.userId, revision);
  return inbox.handle({ ...message, revision }, control);
}, { logger: message => log(`DISCORD ${message}`) });
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
}, { taskRegistry: tasks });
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  releaseStartup();
  clearInterval(stopPoll);
  log('STOPPING');
  await taskService.close().catch(e => log(`tasks close: ${safeError(e)}`));
  await manager.close().catch(e => log(`close: ${safeError(e)}`));
  tasks.close();
  await discord.close().catch(e => log(`discord close: ${safeError(e)}`));
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
  if (!closing) taskService.start();
  releaseStartup();
} catch (error) {
  log(`START_FAILED ${safeError(error)}`);
  await shutdown();
  process.exitCode = 1;
}
