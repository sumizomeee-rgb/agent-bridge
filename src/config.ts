import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommand, AgentName, BridgeConfig } from './types.js';
import { readJson, selectProfile, profileScope, profileAliasKey, type BotProfile } from './profiles.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function isModelId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*(?:\[[A-Za-z0-9]+\])?$/.test(value);
}
export function loadConfig(argv = process.argv.slice(2), createDirectories = true): BridgeConfig {
  let configPath = resolve(projectRoot, '.local', 'config.json');
  let portOverride: number | undefined;
  let profileOverride: string | undefined;
  let platformOverride: 'discord' | 'feishu' | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configPath = resolve(argv[++i] ?? '');
    else if (argv[i] === '--proxy-port') portOverride = parsePort(argv[++i]);
    else if (argv[i] === '--profile') { profileOverride = argv[++i]; if (!profileOverride) throw new Error('--profile 缺少预设名称。'); }
    else if (argv[i] === '--platform') { const platform = argv[++i]; if (platform !== 'discord' && platform !== 'feishu') throw new Error('--platform 必须是 discord 或 feishu。'); platformOverride = platform; }
    else if (!['--check', '--help'].includes(argv[i] ?? '')) throw new Error(`未知参数：${argv[i]}`);
  }
  const raw = readJson(configPath);
  if (raw.version !== 2 || ['token', 'applicationId', 'appId', 'appSecret', 'allowedUserIds'].some(key => key in raw)) throw new Error('请先执行一次性 Profile 语义迁移，运行配置仅支持 version:2。');
  if (platformOverride && !profileOverride) {
    const defaults = raw.platformProfiles as Record<string, unknown> | undefined;
    const candidate = defaults?.[platformOverride] ?? (typeof raw.startupProfile === 'string' && raw.startupProfile.startsWith(platformOverride + '/') ? raw.startupProfile : undefined);
    if (typeof candidate !== 'string') throw new Error('未配置该平台的默认 Profile。');
    profileOverride = candidate;
  }
  if ('proxyPort' in raw) throw new Error('proxyPort 已移至启动 Profile 的 network.proxyPort；公共配置不接受此字段。');
  const profile = selectProfile(raw, configPath, profileOverride);
  if (platformOverride && profile.platform !== platformOverride) throw new Error('Profile 与选择的平台不一致。');
  const config = buildConfig(raw, profile, portOverride);
  if (createDirectories) prepareConfigPaths(config);
  return config;
}
function buildConfig(raw: Record<string, unknown>, profile: BotProfile, portOverride?: number): BridgeConfig {
  const token = profile.token ?? '';
  if (profile.platform === 'discord' && !token) throw new Error('配置缺少机器人 token');
  if (profile.platform === 'feishu' && !profile.appSecret) throw new Error('飞书 Profile 缺少 appSecret。');
  const userPattern = profile.platform === 'discord' ? /^\d{15,22}$/ : /^ou_[a-zA-Z0-9_-]+$/;
  if (!profile.allowedUserIds.length || profile.allowedUserIds.some(id => !userPattern.test(id))) throw new Error(`allowedUserIds 必须包含明确的 ${profile.platform} 用户 ID。`);
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
  const proxyPort = portOverride ?? profile.network?.proxyPort ?? null;
  const proxyUrl = proxyPort == null ? null : `http://127.0.0.1:${proxyPort}`;
  const defaultAgent = profile.defaultAgent ?? raw.defaultAgent ?? 'codex';
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
  const maxFileBytes = raw.maxFileBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFileBytes) || (maxFileBytes as number) <= 0 || (maxFileBytes as number) > 24 * 1024 * 1024) {
    throw new Error('maxFileBytes 必须是 1–25165824 的整数（单个回传文件大小上限）。');
  }
  if (raw.controllerMode != null && typeof raw.controllerMode !== 'boolean') throw new Error('controllerMode 必须是布尔值');
  if (raw.internalBotCommunicationEnabled !== undefined && typeof raw.internalBotCommunicationEnabled !== 'boolean') throw new Error('internalBotCommunicationEnabled 必须是布尔值');
  const dataDir = localPath(raw.dataDir, '.local/data');
  const scopePrefix = profileScope(profile);
  const config: BridgeConfig = {
    token, allowedUserIds: profile.allowedUserIds.map(id => scopePrefix + id), defaultAgent,
    platform: profile.platform, profile: profile.name, applicationId: profile.applicationId, appSecret: profile.appSecret,
    externalAllowedUserIds: profile.allowedUserIds, scopePrefix, features: profile.features, aliases: [...(profile.aliases ?? [])],
    workspace: localPath(raw.workspace, '.local/workspace'), proxyUrl,
    commands: { codex: command('codex'), claude: command('claude') },
    dataDir,
    attachmentsDir: localPath(raw.attachmentsDir, `.local/data/attachments/${profile.name}`),
    logsDir: localPath(raw.logsDir, `.local/logs/${profile.name}`), maxImageBytes: 20 * 1024 * 1024,
    defaultModels, modelOptions, maxFileBytes: maxFileBytes as number,
    controllerMode: raw.controllerMode === true,
    internalBotCommunicationEnabled: raw.internalBotCommunicationEnabled !== false,
  };
  return config;
}
export interface PrincipalMapping { id: string; accounts: Record<string, string> }
export interface SpaceMapping { id: string; accounts: Record<string, string> }
export interface HostConfig { version: 3; rootDataDir: string; internalBotCommunicationEnabled?: boolean; configs: BridgeConfig[]; principals: PrincipalMapping[]; spaces: SpaceMapping[] }
/** Runtime entry point. Version 2 must be migrated offline; it is never reinterpreted here. */
export function loadHostConfig(argv = process.argv.slice(2), createDirectories = true): HostConfig {
  let configPath = resolve(projectRoot, '.local', 'config.json');
  let portOverride: number | undefined;
  let requestedProfile: string | undefined;
  let platformOverride: 'discord' | 'feishu' | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { const path = argv[++i]; if (!path) throw new Error('--config 缺少路径。'); configPath = resolve(path); }
    else if (argv[i] === '--proxy-port') portOverride = parsePort(argv[++i]);
    else if (argv[i] === '--profile') { requestedProfile = argv[++i]; if (!requestedProfile) throw new Error('--profile 缺少预设名称。'); }
    else if (argv[i] === '--platform') { const value = argv[++i]; if (value !== 'discord' && value !== 'feishu') throw new Error('--platform 必须是 discord 或 feishu。'); platformOverride = value; }
    else if (!['--check', '--help'].includes(argv[i] ?? '')) throw new Error(`未知参数：${argv[i]}`);
  }
  const raw = readJson(configPath);
  if (raw.version !== 3) throw new Error('运行配置仅支持 version:3；请先执行离线宿主迁移。');
  if (['token', 'applicationId', 'appId', 'appSecret', 'allowedUserIds', 'startupProfile', 'platformProfiles', 'proxyPort', 'attachmentsDir', 'logsDir', 'workspace'].some(key => key in raw)) throw new Error('version:3 不接受旧的单 Bot 字段；凭据、工作区放在各 Profile。');
  if (!Array.isArray(raw.startupProfiles) || !raw.startupProfiles.length || raw.startupProfiles.some(value => typeof value !== 'string')) throw new Error('startupProfiles 必须是非空 Profile 数组。');
  const names = raw.startupProfiles as string[];
  if (new Set(names).size !== names.length) throw new Error('startupProfiles 含重复 Profile。');
  // --profile checks membership; it never silently leaves sibling bots behind.
  if (requestedProfile && !names.includes(requestedProfile)) throw new Error('--profile 不在已配置的宿主启动集合中。');
  if (raw.registeredProfiles != null && (!Array.isArray(raw.registeredProfiles) || raw.registeredProfiles.some(name => typeof name !== 'string') || new Set(raw.registeredProfiles).size !== raw.registeredProfiles.length)) throw new Error('registeredProfiles 必须是明确且不重复的 Profile 清单。');
  const inventory = [...new Set([...names, ...((raw.registeredProfiles ?? []) as string[])])].map(name => selectProfile(raw, configPath, name));
  const inventoryIds = inventory.map(profile => profileScope(profile).slice(0, -1));
  if (new Set(inventoryIds).size !== inventoryIds.length) throw new Error('不同 Profile 指向同一个真实 Bot，拒绝重复登记。');
  // Include registered offline members: aliases must remain unambiguous when the startup set changes.
  const identifiers = new Map(inventory.flatMap(profile => [profile.name, profileScope(profile).slice(0, -1)]
    .map(identifier => [profileAliasKey(identifier), profileScope(profile)] as const)));
  const aliasOwners = new Map<string, string>();
  for (const profile of inventory) for (const alias of profile.aliases ?? []) {
    const key = profileAliasKey(alias), owner = profileScope(profile);
    if (aliasOwners.has(key) && aliasOwners.get(key) !== owner || identifiers.has(key) && identifiers.get(key) !== owner) {
      throw new Error('同一宿主不同 Bot 的 aliases 不能重复或遮蔽其他 Bot 的真实 ID／Profile。');
    }
    aliasOwners.set(key, owner);
  }
  const profiles = names.map(name => inventory.find(profile => profile.name === name)!);
  const platform = profiles[0]!.platform;
  if (profiles.some(profile => profile.platform !== platform)) throw new Error('同一宿主的 startupProfiles 必须属于同一平台。');
  if (platformOverride && platformOverride !== platform) throw new Error('宿主启动集合与选择的平台不一致。');
  const identities = profiles.map(profile => profileScope(profile).slice(0, -1));
  if (new Set(identities).size !== identities.length) throw new Error('不同 Profile 指向同一个真实 Bot，拒绝重复登录。');
  const rootDataDir = resolve(projectRoot, String(raw.dataDir ?? '.local/data'));
  const workspaceRoot = resolve(projectRoot, String(raw.workspaceRoot ?? '.local/workspaces'));
  const principals: PrincipalMapping[] = [];
  if (raw.principals != null) {
    if (!Array.isArray(raw.principals)) throw new Error('principals 必须是操作者映射数组。');
    const accounts = new Set<string>();
    for (const input of raw.principals) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('principal 必须是对象。');
      const record = input as Record<string, unknown>;
      if (typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(record.id) || principals.some(p => p.id === record.id)) throw new Error('principal id 必须有效且唯一。');
      if (!record.accounts || typeof record.accounts !== 'object' || Array.isArray(record.accounts)) throw new Error('principal accounts 必须按真实 botId 映射。');
      const map: Record<string, string> = {};
      for (const [botId, userId] of Object.entries(record.accounts)) {
        const profile = inventory[inventoryIds.indexOf(botId)];
        if (!profile || typeof userId !== 'string' || !profile.allowedUserIds.includes(userId)) throw new Error('principal 的账号必须对应已登记 Bot 的白名单账号。');
        const key = `${botId}|${userId}`;
        if (accounts.has(key)) throw new Error('同一 Bot 账号不能映射到多个 principal。');
        accounts.add(key); map[botId] = userId;
      }
      principals.push({ id: record.id, accounts: map });
    }
  }
  const configs = profiles.map((profile, index) => {
    const botId = identities[index]!;
    const key = join(profile.platform, profile.applicationId!);
    const workspace = resolve(projectRoot, profile.workspace ?? resolve(workspaceRoot, key));
    const dataDir = resolve(rootDataDir, 'bots', key);
    const config = buildConfig({ ...raw, workspace, dataDir, attachmentsDir: resolve(dataDir, 'attachments'), logsDir: resolve(rootDataDir, '..', 'logs', key) }, profile, portOverride);
    const owner = profile.ownerPrincipalId == null ? undefined : principals.find(principal => principal.id === profile.ownerPrincipalId);
    if (profile.ownerPrincipalId != null && !owner?.accounts[botId]) throw new Error('Profile ownerPrincipalId 缺少对应账号映射。');
    return { ...config, botId, contextWorkspace: workspace, workingCwd: resolve(projectRoot, profile.workingCwd ?? String(raw.workingCwd ?? workspace)),
      ownerPrincipalId: owner?.id, ownerUserId: owner ? config.scopePrefix! + owner.accounts[botId] : undefined, groupMode: raw.groupMode === true };
  });
  const spaces: SpaceMapping[] = [];
  const spaceAccounts = new Set<string>();
  if (raw.spaces != null) {
    if (!Array.isArray(raw.spaces)) throw new Error('spaces 必须是显式群地址映射数组。');
    for (const input of raw.spaces) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('space 必须是对象。');
      const record = input as Record<string, unknown>;
      if (typeof record.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(record.id) || spaces.some(space => space.id === record.id)) throw new Error('space id 必须有效且唯一。');
      if (!record.accounts || typeof record.accounts !== 'object' || Array.isArray(record.accounts) || !Object.keys(record.accounts).length) throw new Error('space accounts 必须按真实 botId 映射非空群地址。');
      const accounts: Record<string, string> = {};
      for (const [botId, address] of Object.entries(record.accounts)) {
        if (!identities.includes(botId) || typeof address !== 'string' || !(platform === 'discord' ? /^\d{15,22}$/ : /^oc_[A-Za-z0-9_-]+$/).test(address)) throw new Error('space 群地址必须对应已启动 Bot 和有效平台地址。');
        const key = `${botId}|${address}`; if (spaceAccounts.has(key)) throw new Error('同一 Bot 群地址不能映射到多个 space。');
        spaceAccounts.add(key); accounts[botId] = address;
      }
      spaces.push({ id: record.id, accounts });
    }
  }
  const host: HostConfig = { version: 3, rootDataDir, configs, principals, spaces, internalBotCommunicationEnabled: raw.internalBotCommunicationEnabled !== false };
  if (createDirectories) { mkdirSync(rootDataDir, { recursive: true }); configs.forEach(prepareConfigPaths); }
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
