import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceFile } from './workspace-layout.js';
import { loadHostConfig, projectRoot, safeError } from './config.js';
import { acquireInstanceLock } from './instance-lock.js';
import { BotRuntime } from './bot-runtime.js';
import { ControllerCore } from './controller/core.js';
import { ExternalControllerAdapter } from './controller/external.js';
import { ExternalControllerServer } from './controller/external-server.js';
import { createHash } from 'node:crypto';
import { ExecutorMessages } from './executor-messages.js';
import { HostRuntime } from './host-runtime.js';
import { RestartService } from './restart.js';
import { DrainStop } from './shutdown.js';
import { RemoteDeploymentService } from './remote/deployment.js';
import { parseTargetRegistry } from './remote/catalog.js';
import { setRemoteDeploymentHook } from './remote/client.js';
import { readFileSync } from 'node:fs';
import { TransactionRetentionService } from './housekeeper/retention.js';

if (process.argv.includes('--help')) {
  console.log('启动宿主：start.ps1；配置检查：start.ps1 -Check；首次升级：registry-migration-cli --config 配置路径（默认dry-run）。启动集合在工作区 bridge-registry 的 startupControllers 配置，私聊/help，群/group start。');
  process.exit(0);
}
const config = loadHostConfig(undefined, false);
if (process.argv.includes('--check')) {
  console.log(`CONFIG_OK platform=${[...new Set(config.configs.map(c => c.platform))].join(',') || 'none'} bots=${config.configs.length} profiles=${config.configs.map(c => c.profile).join(',')} controllers=${config.controllerConfigs.map(c=>c.controllerId).join(',')}`);
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
let deployments: RemoteDeploymentService | undefined;
let transactionRetention: TransactionRetentionService | undefined;
let externalServer: ExternalControllerServer | undefined;
const pidFile = join(config.rootDataDir, 'bridge.pid.json'), stopFile = join(config.rootDataDir, 'stop.request');
const drainStopFile = join(config.rootDataDir, 'drain-stop.request');
async function shutdown(planned = false): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    if (poll) clearInterval(poll);
    setRemoteDeploymentHook(undefined);
    await transactionRetention?.close().catch(error => log('TRANSACTION_RETENTION_STOP_FAILED ' + safeError(error, secrets)));
    await deployments?.close();
    await externalServer?.close();
    if (!planned) restart?.cancel();
    log(planned ? 'RESTART_STOPPING' : 'STOPPING');
    try { await host?.close(); log('STOPPED'); }
    finally {
      guard.close(); if (existsSync(pidFile)) unlinkSync(pidFile);
      if (existsSync(stopFile)) unlinkSync(stopFile);
      if (existsSync(drainStopFile)) unlinkSync(drainStopFile);
      if (!planned) restart?.close();
    }
  })();
  return closing;
}
try {
  deployments = new RemoteDeploymentService(async () => {
    const targets = [];
    for (const selected of config.controllerConfigs) {
      const cwd = selected.contextWorkspace ?? selected.workspace, path = workspaceFile(cwd, 'remote-agents', 'registry.json');
      if (!existsSync(path)) continue;
      for (const registration of parseTargetRegistry(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))) {
        const agent = registration.engines.codex ? 'codex' as const : 'claude' as const, engine = registration.engines[agent]!;
        targets.push({ cwd, target: { id: registration.id, label: registration.label, transport: 'ssh' as const, expectedHostname: registration.expectedHostname,
          sshConfig: registration.sshConfig, alias: registration.alias, remoteRoot: registration.remoteRoot, nodePath: registration.nodePath,
          agent, agentCommand: engine.agentCommand, cwd: engine.defaultCwd } });
      }
    }
    return targets;
  }, log);
  const owners = config.registry.controllers.flatMap(controller => {
    if (!controller.channelId) return [];
    const principal = config.registry.principals.find(value => value.id === controller.ownerPrincipalId);
    const account = principal?.accounts[controller.channelId];
    if (!account) throw new Error('Controller channel owner migration lacks an explicit account.');
    return [{ controllerId: controller.id, botId: controller.channelId, principalId: controller.ownerPrincipalId,
      oldUserId: controller.channelId + '|' + account, userId: 'principal:' + controller.ownerPrincipalId }];
  });
  const localMessages = new ExecutorMessages(projectRoot);
  try { localMessages.registerOwnerMigrationMappings(owners); } finally { localMessages.close(); }
  deployments.registerOwnerMigration(owners);
  setRemoteDeploymentHook((target, cwd) => deployments!.ensure(target, cwd));
  deployments.start();
  host = new HostRuntime(config, origin => Promise.resolve(restart.request(origin)), log);
  restart = new RestartService(config.rootDataDir, {
    supervised: process.env.BRIDGE_SUPERVISED === '1', beginDrain: () => host.beginDrain(), isIdle: () => host.isIdle(),
    shutdown: () => shutdown(true), onShutdownComplete: code => { process.exitCode = code; restart.close(); },
    onPhase: phase => { if (phase !== 'ready') for (const bot of host.bots.values()) void bot.transport.onBridgeLifecycle({ phase }).catch(error => log('LIFECYCLE_FAILED ' + safeError(error, secrets))); },
    onError: error => log('RESTART ' + safeError(error, secrets)),
  });
  restart.beginRecovery(); host.beginRecovery();
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), drainStopVersion: 1, main: process.argv[1],
    platforms: [...new Set(config.configs.map(c=>c.platform))], controllers:config.controllerConfigs.map(c=>c.controllerId), profiles: config.configs.map(c => c.profile), bots: config.configs.map(c => c.botId) }));
  if (existsSync(stopFile)) unlinkSync(stopFile);
  if (existsSync(drainStopFile)) unlinkSync(drainStopFile);
  // Verify each actual app and reserve its own identity, while keeping a failed Bot isolated.
  for (const selected of config.configs) {
    try {
      const bot = new BotRuntime(selected, host.hooks(selected)); host.attach(bot);
      await bot.verify();
    }
    catch (error) { host.failures.set(selected.botId!, safeError(error, secrets)); log(`BOT_UNAVAILABLE ${selected.botId} ${safeError(error, secrets)}`); }
  }
  for (const selected of config.controllerConfigs.filter(item=>!item.botId)) {
    try { host.attachCore(new ControllerCore(selected, host.controllerHooks(selected))); }
    catch (error) { host.failures.set(selected.controllerId!, safeError(error, secrets)); log(`CONTROLLER_UNAVAILABLE ${selected.controllerId} ${safeError(error, secrets)}`); }
  }
  await host.prepareRecoveryBots();
  await Promise.all([...host.bots].filter(([id]) => !host.failures.has(id)).map(async ([id, bot]) => {
    try { await bot.start(); }
    catch (error) { host.failures.set(id, safeError(error, secrets)); log(`BOT_START_FAILED ${id} ${safeError(error, secrets)}`); }
  }));
  await Promise.all([...host.controllers].filter(([,core])=>!core.config.botId).map(async ([id,core])=>{
    try { await core.start(); }
    catch(error) { host.failures.set(id,safeError(error,secrets)); log(`CONTROLLER_START_FAILED ${id} ${safeError(error,secrets)}`); await core.close().catch(failure=>log('CONTROLLER_CLOSE_FAILED '+safeError(failure,secrets))); }
  }));
  if (![...host.controllers.values()].some(core=>core.isReady())) throw new Error('没有可用的主控，宿主未就绪。');
  await host.recover(); restart.ready();
  const externalControllers = [...host.controllers].filter(([,core])=>core.isReady() && core.config.controllerBackend?.kind==='external');
  if(externalControllers.length) {
    externalServer=new ExternalControllerServer({hostDataDir:config.rootDataDir,controllers:externalControllers.map(([id,core])=>({
      id,adapter:core.controllerAdapter('external') as ExternalControllerAdapter,
      hasInput:requestId=>core.manager.hasMessage('external:'+id+':'+createHash('sha256').update(requestId).digest('hex')),
      handoff:(operationId,previousSessionId,sessionId)=>{
        if(closing||!core.isReady()||host.controllerHooks(core.config).isDraining())throw new Error('主控正在启动或维护，暂不交接');
        return core.manager.handoffExternalSession(operationId,core.config.controllerUserId!,previousSessionId,sessionId);
      },
      submit:async(requestId,text)=>{
        if(core.config.botId)throw new Error('此主控已绑定聊天渠道，请从原渠道发送新消息。');
        if(closing || !core.isReady() || host.controllerHooks(core.config).isDraining())throw new Error('主控正在启动或维护，暂不接受新输入。');
        const messageId='external:'+id+':'+createHash('sha256').update(requestId).digest('hex');
        const userId=core.config.controllerUserId!,channelId='controller:'+id;
        await core.manager.handle({id:messageId,userId,channelId,text,imagePaths:[],
          source:{messageId,userId,channelId,authorType:'system',authorName:'External Agent'}});
      },
    }))});
    const location=await externalServer.start();log(`EXTERNAL_READY controllers=${externalControllers.map(([id])=>id).join(',')} endpoint=${location.host}:${location.port}`);
  }
  await Promise.all([...host.bots].filter(([id]) => !host.failures.has(id)).map(([, bot]) => bot.publishReadyLifecycle()));
  log(`HOST_READY controllers=${[...host.controllers.values()].filter(core=>core.isReady()).length}/${config.controllerConfigs.length} bots=${[...host.bots.values()].filter(bot=>bot.isReady()).length}/${config.configs.length}`);
  transactionRetention = new TransactionRetentionService(config.controllerConfigs.map(c => join(c.contextWorkspace ?? c.workspace, 'bridge-transaction-sync')), log);
  transactionRetention.start();
  const drainStop = new DrainStop({ beginDrain: () => { host.beginDrain(); log('MAINTENANCE_DRAINING'); },
    isIdle: () => host.isIdle(), shutdown: () => shutdown() });
  poll = setInterval(() => {
    const stopping = existsSync(stopFile) ? shutdown() : drainStop.check(existsSync(drainStopFile));
    void stopping.catch(error => { log('STOP_FAILED ' + safeError(error, secrets)); process.exitCode = 76; });
  }, 1000);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => void shutdown().catch(error => { log('STOP_FAILED ' + safeError(error, secrets)); process.exitCode = 76; }));
  process.on('uncaughtException', error => { log('FATAL ' + safeError(error, secrets)); restart.failed(safeError(error, secrets)); void shutdown().finally(() => { process.exitCode = 76; }); });
  process.on('unhandledRejection', error => log('ERROR ' + safeError(error, secrets)));
} catch (error) {
  log('START_FAILED ' + safeError(error, secrets));
  try { await shutdown(); } catch (failure) { log('STOP_FAILED ' + safeError(failure, secrets)); }
  process.exitCode = 1;
}
