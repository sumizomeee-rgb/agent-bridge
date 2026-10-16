import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHostConfig, projectRoot, safeError } from './config.js';
import { ensureHostSemanticData } from './host-migration.js';
import { acquireInstanceLock } from './instance-lock.js';
import { BotRuntime } from './bot-runtime.js';
import { HostRuntime } from './host-runtime.js';
import { RestartService } from './restart.js';

if (process.argv.includes('--help')) {
  console.log('启动宿主：start.ps1；配置检查：start.ps1 -Check；首次升级：host-migration-cli --config 配置路径（默认dry-run）。启动集合在version:3 startupProfiles配置，私聊/help，群/group start。');
  process.exit(0);
}
const config = loadHostConfig(undefined, false);
if (process.argv.includes('--check')) {
  console.log(`CONFIG_OK platform=${config.configs[0]!.platform} bots=${config.configs.length} profiles=${config.configs.map(c => c.profile).join(',')}`);
  process.exit(0);
}
mkdirSync(config.rootDataDir, { recursive: true });
const guard = await acquireInstanceLock(projectRoot, config.rootDataDir);
const secrets = config.configs.flatMap(c => [c.token, c.appSecret ?? '']);
const log = (text: string): void => {
  const line = `${new Date().toISOString()} ${safeError(text, secrets)}\n`;
  appendFileSync(join(config.rootDataDir, 'host.log'), line); process.stdout.write(line);
};
let restart: RestartService;
let host: HostRuntime;
let closing: Promise<void> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
const pidFile = join(config.rootDataDir, 'bridge.pid.json'), stopFile = join(config.rootDataDir, 'stop.request');
async function shutdown(planned = false): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    if (poll) clearInterval(poll);
    if (!planned) restart?.cancel();
    log(planned ? 'RESTART_STOPPING' : 'STOPPING');
    try { await host?.close(); log('STOPPED'); }
    finally {
      guard.close(); if (existsSync(pidFile)) unlinkSync(pidFile);
      if (existsSync(stopFile)) unlinkSync(stopFile);
      if (!planned) restart?.close();
    }
  })();
  return closing;
}
try {
  const marker = ensureHostSemanticData(config);
  host = new HostRuntime(config, marker, origin => Promise.resolve(restart.request(origin)), log);
  restart = new RestartService(config.rootDataDir, {
    supervised: process.env.BRIDGE_SUPERVISED === '1', beginDrain: () => host.beginDrain(), isIdle: () => host.isIdle(),
    shutdown: () => shutdown(true), onShutdownComplete: code => { process.exitCode = code; restart.close(); },
    onPhase: phase => { if (phase !== 'ready') for (const bot of host.bots.values()) void bot.transport.onBridgeLifecycle({ phase }).catch(error => log('LIFECYCLE_FAILED ' + safeError(error, secrets))); },
    onError: error => log('RESTART ' + safeError(error, secrets)),
  });
  restart.beginRecovery(); host.beginRecovery();
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), main: process.argv[1],
    platform: config.configs[0]!.platform, profiles: config.configs.map(c => c.profile), bots: config.configs.map(c => c.botId) }));
  if (existsSync(stopFile)) unlinkSync(stopFile);
  // Verify each actual app and reserve its own identity, while keeping a failed Bot isolated.
  for (const selected of config.configs) {
    try {
      const bot = new BotRuntime(selected, host.hooks(selected)); host.attach(bot);
      await bot.verify();
    }
    catch (error) { host.failures.set(selected.botId!, safeError(error, secrets)); log(`BOT_UNAVAILABLE ${selected.botId} ${safeError(error, secrets)}`); }
  }
  await host.prepareRecoveryBots();
  await Promise.all([...host.bots].filter(([id]) => !host.failures.has(id)).map(async ([id, bot]) => {
    try { await bot.start(); }
    catch (error) { host.failures.set(id, safeError(error, secrets)); log(`BOT_START_FAILED ${id} ${safeError(error, secrets)}`); }
  }));
  if (![...host.bots.keys()].some(id => !host.failures.has(id))) throw new Error('没有可用的 Bot，宿主未就绪。');
  await host.recover(); restart.ready();
  await Promise.all([...host.bots].filter(([id]) => !host.failures.has(id)).map(([, bot]) => bot.publishReadyLifecycle()));
  log(`HOST_READY bots=${config.configs.length - host.failures.size}/${config.configs.length}`);
  poll = setInterval(() => { if (existsSync(stopFile)) void shutdown().catch(error => { log('STOP_FAILED ' + safeError(error, secrets)); process.exitCode = 76; }); }, 1000);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => void shutdown().catch(error => { log('STOP_FAILED ' + safeError(error, secrets)); process.exitCode = 76; }));
  process.on('uncaughtException', error => { log('FATAL ' + safeError(error, secrets)); restart.failed(safeError(error, secrets)); void shutdown().finally(() => { process.exitCode = 76; }); });
  process.on('unhandledRejection', error => log('ERROR ' + safeError(error, secrets)));
} catch (error) {
  log('START_FAILED ' + safeError(error, secrets));
  try { await shutdown(); } catch (failure) { log('STOP_FAILED ' + safeError(failure, secrets)); }
  process.exitCode = 1;
}
