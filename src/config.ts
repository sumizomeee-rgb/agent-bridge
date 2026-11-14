import { configuredFileLimit } from './attachment-limits.js';
import { incomingFileLimits } from './incoming-files.js';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommand, AgentName, BridgeConfig } from './types.js';
import { readJson, profileScope, type BotProfile } from './profiles.js';
import { readWorkspaceRegistry, type WorkspaceRegistry } from './registry.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function isModelId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*(?:\[[A-Za-z0-9]+\])?$/.test(value);
}
function buildConfig(raw: Record<string, unknown>, profile: BotProfile | undefined, portOverride?: number): BridgeConfig {
  const token = profile?.token ?? '';
  if (profile?.platform === 'discord' && !token) throw new Error('配置缺少机器人 token');
  if (profile?.platform === 'feishu' && !profile?.appSecret) throw new Error('飞书 Profile 缺少 appSecret。');
  const userPattern = profile?.platform === 'discord' ? /^\d{15,22}$/ : /^ou_[a-zA-Z0-9_-]+$/;
  if (profile && (!profile.allowedUserIds.length || profile.allowedUserIds.some(id => !userPattern.test(id)))) throw new Error(`allowedUserIds 必须包含明确的 ${profile?.platform} 用户 ID。`);
  const localPath = (value: unknown, fallback: string): string => {
    const p = String(value ?? fallback);
    return isAbsolute(p) ? p : resolve(projectRoot, p);
  };
  const commands = raw.commands as Record<string, unknown> | undefined;
  const command = (name: AgentName): AgentCommand => {
    const value = commands?.[name] as AgentCommand | undefined;
    if (!value || typeof value.command !== 'string' || !Array.isArray(value.args) || value.args.some(a => typeof a !== 'string')) {
      throw new Error(`缺少 ${name} 启动命令配置`);
    }
    const executable = localPath(value.command, '');
    if (!existsSync(executable)) throw new Error(`${name} 运行时不存在：${executable}`);
    return { command: executable, args: value.args.map(a => a.replaceAll('{project}', projectRoot)) };
  };
  const proxyPort = portOverride ?? profile?.network?.proxyPort ?? null;
  const proxyUrl = proxyPort == null ? null : `http://127.0.0.1:${proxyPort}`;
  const defaultAgent = profile?.defaultAgent ?? raw.defaultAgent ?? 'codex';
  if (defaultAgent !== 'codex' && defaultAgent !== 'claude') throw new Error('defaultAgent 只能是 codex 或 claude');
  const defaultModels: Partial<Record<AgentName, string>> = {};
  const modelOptions: Partial<Record<AgentName, string[]>> = {};
  for (const [key, target] of [['defaultModels', defaultModels], ['modelOptions', modelOptions]] as const) {
    const input = raw[key];
    if (input == null) continue;
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`${key} 必须按 Agent 配置`);
    for (const [name, value] of Object.entries(input)) {
      if (name !== 'codex' && name !== 'claude') throw new Error(`${key} 的 Agent 只能是 codex 或 claude`);
      if (key === 'defaultModels') {
        if (typeof value !== 'string' || !isModelId(value)) throw new Error(`${key}.${name} 需要有效模型 ID`);
        (target as Partial<Record<AgentName, string>>)[name] = value;
      } else {
        if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !isModelId(item))) {
          throw new Error(`${key}.${name} 需要有效模型 ID 数组`);
        }
        (target as Partial<Record<AgentName, string[]>>)[name] = [...new Set(value as string[])];
      }
    }
  }
  const platformLimits = raw.maxFileBytesByPlatform;
  if (platformLimits != null && (typeof platformLimits !== 'object' || Array.isArray(platformLimits))) {
    throw new Error('maxFileBytesByPlatform 必须按平台配置。');
  }
  for (const [platform, value] of Object.entries(platformLimits ?? {})) {
    if (platform !== 'discord' && platform !== 'feishu') throw new Error('maxFileBytesByPlatform 含未知平台。');
    configuredFileLimit(platform, value);
  }
  const maxFileBytes = configuredFileLimit(profile?.platform ?? 'discord',
    (platformLimits as Record<string, unknown> | undefined)?.[profile?.platform ?? 'discord'] ?? raw.maxFileBytes);
  if (raw.controllerMode != null && typeof raw.controllerMode !== 'boolean') throw new Error('controllerMode 必须是布尔值');
  if (raw.internalBotCommunicationEnabled !== undefined && typeof raw.internalBotCommunicationEnabled !== 'boolean') throw new Error('internalBotCommunicationEnabled 必须是布尔值');
  const incomingRaw = raw.incomingAttachmentLimitsByPlatform;
  if (incomingRaw != null && (typeof incomingRaw !== 'object' || Array.isArray(incomingRaw) || Object.keys(incomingRaw).some(key => key !== 'discord' && key !== 'feishu'))) throw new Error('incomingAttachmentLimitsByPlatform 含未知平台或格式无效。');
  const incomingLimits = Object.fromEntries(['discord', 'feishu'].map(platform => [platform, incomingFileLimits((incomingRaw as Record<string, unknown> | undefined)?.[platform])]));
  const dataDir = localPath(raw.dataDir, '.local/data');
  const scopePrefix = profile ? profileScope(profile) : undefined;
  const config: BridgeConfig = {
    token, allowedUserIds: profile?.allowedUserIds.map(id => scopePrefix! + id) ?? [], defaultAgent,
    platform: profile?.platform, profile: profile?.name, applicationId: profile?.applicationId, appSecret: profile?.appSecret,
    externalAllowedUserIds: profile?.allowedUserIds, scopePrefix, features: profile?.features, aliases: [...(profile?.aliases ?? [])],
    workspace: localPath(raw.workspace, '.local/workspace'), proxyUrl,
    commands: { codex: command('codex'), claude: command('claude') },
    dataDir,
    attachmentsDir: localPath(raw.attachmentsDir, `.local/data/attachments/${profile?.name}`),
    logsDir: localPath(raw.logsDir, `.local/logs/${profile?.name}`), maxImageBytes: 20 * 1024 * 1024,
    defaultModels, modelOptions, maxFileBytes: maxFileBytes as number,
    incomingAttachmentLimits: profile ? incomingLimits[profile.platform] : undefined,
    controllerMode: raw.controllerMode === true,
    internalBotCommunicationEnabled: raw.internalBotCommunicationEnabled !== false,
  };
  return config;
}
export interface PrincipalMapping { id: string; accounts: Record<string, string> }
export interface SpaceMapping { id: string; accounts: Record<string, string> }
export interface HostConfig {
  version: 4; workspaceRoot: string; registry: WorkspaceRegistry; rootDataDir: string;
  internalBotCommunicationEnabled?: boolean; configs: BridgeConfig[]; controllerConfigs: BridgeConfig[];
  principals: PrincipalMapping[]; spaces: SpaceMapping[];
}
/** Only the controller registry is a runtime input. Previous deployments migrate offline. */
export function loadHostConfig(argv = process.argv.slice(2), createDirectories = true): HostConfig {
  let configPath=resolve(projectRoot,'.local/config.json'),portOverride:number|undefined,selection:string|undefined,platformOverride:string|undefined;
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(key==='--config'){const value=argv[++i];if(!value)throw new Error('--config缺少路径');configPath=resolve(value);}
    else if(key==='--proxy-port')portOverride=parsePort(argv[++i]);
    else if(key==='--profile'||key==='--controller'){selection=argv[++i];if(!selection)throw new Error('缺少主控选择');}
    else if(key==='--platform'){platformOverride=argv[++i];if(!['discord','feishu'].includes(platformOverride??''))throw new Error('平台选择无效');}
    else if(!['--check','--help'].includes(key??''))throw new Error('未知参数：'+key);
  }
  const raw=readJson(configPath);
  if(raw.version!==4)throw new Error('仅支持version:4独立主控登记；请先执行离线工作区迁移');
  if(typeof raw.workspaceRoot!=='string'||!raw.workspaceRoot.trim())throw new Error('bootstrap必须明确指定workspaceRoot');
  if(['startupProfiles','registeredProfiles','startupProfile','bots','token','appSecret','applicationId','dataDir','workspace'].some(key=>key in raw))throw new Error('bootstrap不能夹带旧Bot配置或运行数据归属');
  const workspaceRoot=resolve(dirname(configPath),raw.workspaceRoot),registry=readWorkspaceRegistry(workspaceRoot);
  const controllerConfigs=registry.startupControllers.map(id=>{
    const registration=registry.controllers.find(item=>item.id===id)!;
    const channel=registration.channelId?registry.channels.find(item=>item.id===registration.channelId):undefined;
    const nativeAgent=registration.backend.kind==='native'?registration.backend.agent:raw.defaultAgent??'codex';
    const profile=channel?{...channel,aliases:registration.aliases,defaultAgent:nativeAgent as AgentName}:undefined;
    const base=buildConfig({...raw,defaultAgent:nativeAgent,workspace:registration.workspace,dataDir:registration.dataDir,
      attachmentsDir:join(channel?.dataDir??registration.dataDir,'attachments'),logsDir:join(registration.dataDir,'logs')},profile,portOverride);
    const ownerUserId='principal:'+registration.ownerPrincipalId;
    const account=channel?registry.principals.find(item=>item.id===registration.ownerPrincipalId)?.accounts[channel.id]:undefined;
    if(channel&&!account)throw new Error('主控owner缺少已绑定渠道账号映射：'+id);
    const corePort=portOverride??registration.network?.proxyPort??null;
    return {...base,controllerId:id,controllerBackend:registration.backend,controllerUserId:ownerUserId,
      responseWaitMs:registration.wait.responseMs,ownerPrincipalId:registration.ownerPrincipalId,ownerUserId,
      channelOwnerUserId:channel?profileScope(channel)+account:undefined,channelProxyUrl:base.proxyUrl,
      proxyUrl:corePort===null?null:'http://127.0.0.1:'+corePort,
      botId:channel?.id,channelDataDir:channel?.dataDir,contextWorkspace:registration.workspace,workingCwd:registration.workingCwd,
      aliases:registration.aliases,groupMode:raw.groupMode===true,controllerMode:true,
      ...(!channel?{allowedUserIds:[ownerUserId]}:{})};
  });
  const configs=controllerConfigs.filter(config=>config.botId!==undefined);
  if(selection&&!controllerConfigs.some(config=>config.controllerId===selection||config.profile===selection))throw new Error('所选主控不在启动集合中');
  if(platformOverride&&configs.some(config=>config.platform!==platformOverride))throw new Error('平台参数与渠道集合不符');
  const host:HostConfig={version:4,workspaceRoot,registry,rootDataDir:registry.hostDataDir,controllerConfigs,configs,
    principals:registry.principals,spaces:registry.spaces,internalBotCommunicationEnabled:raw.internalBotCommunicationEnabled!==false};
  if(createDirectories){mkdirSync(host.rootDataDir,{recursive:true});controllerConfigs.forEach(prepareConfigPaths);}
  return host;
}export function prepareConfigPaths(config: BridgeConfig): void {
  for (const p of [config.workspace, config.dataDir, config.attachmentsDir, config.logsDir]) mkdirSync(p, { recursive: true });
}
function parsePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('代理端口需要是 1–65535 的整数');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('代理端口需要是 1–65535 的整数');
  return port;
}
export function agentEnvironment(config: BridgeConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.proxyUrl) {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = config.proxyUrl;
  }
  const bypass = new Set((env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(s => s.trim()).filter(Boolean));
  for (const host of ['localhost', '127.0.0.1', '::1', '10.101.0.8']) bypass.add(host);
  env.NO_PROXY = env.no_proxy = [...bypass].join(',');
  return env;
}
export function safeError(error: unknown, secrets: string[] = []): string {
  return redactText(error instanceof Error ? error.message : String(error), secrets).slice(0, 1500);
}
export function redactText(text: string, secrets: string[] = []): string {
  let message = text;
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/\b(Bearer|Bot)\s+[\w.\-]+/gi, '$1 [redacted]');
}
