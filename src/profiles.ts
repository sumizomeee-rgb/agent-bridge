import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentName, BridgePlatform } from './types.js';

export interface BotProfile {
  platform: BridgePlatform; name: string; applicationId?: string; token?: string; appSecret?: string;
  network?: { proxyPort: number | null };
  workspace?: string; workingCwd?: string; ownerPrincipalId?: string; defaultAgent?: AgentName;
  aliases?: string[];
  allowedUserIds: string[]; features?: { reactions?: boolean; nativeCommands?: boolean; presence?: boolean };
}
export function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象。');
  return value as Record<string, unknown>;
}
/** Comparison only: aliases never establish an application or account identity. */
export function profileAliasKey(alias: string): string { return alias.trim().normalize('NFKC').toLowerCase(); }
function profileAliases(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32) throw new Error('Profile aliases 必须是至多 32 项的字符串数组。');
  const seen = new Set<string>();
  return raw.map(value => {
    if (typeof value !== 'string') throw new Error('Profile aliases 仅接受字符串。');
    const alias = value.trim();
    if (!alias || Array.from(alias).length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(alias)) throw new Error('Profile aliases 每项须为 1–64 字符且不含控制字符。');
    const key = profileAliasKey(alias);
    if (seen.has(key)) throw new Error('Profile aliases 规范化后不能重复。');
    seen.add(key); return alias;
  });
}
export function selectProfile(common: Record<string, unknown>, configPath: string, selection?: string): BotProfile {
  const name = selection ?? (typeof common.startupProfile === 'string' ? common.startupProfile : undefined);
  if (!name) throw new Error('请配置 startupProfile 或在启动前指定 --profile。');
  if (!/^(discord|feishu)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Profile 必须是 discord/名称 或 feishu/名称。');
  const [platform, alias] = name.split('/') as [BridgePlatform, string];
  const raw = readJson(resolve(dirname(configPath), 'bots', platform, `${alias}.json`));
  if (raw.platform != null && raw.platform !== platform) throw new Error('Profile 平台与所在目录不一致。');
  const applicationId = String(raw.applicationId ?? '').trim();
  if (!(platform === 'discord' ? /^\d{15,22}$/ : /^cli_[a-zA-Z0-9]+$/).test(applicationId)) throw new Error('Profile 缺少有效 applicationId。');
  if (!Array.isArray(raw.allowedUserIds) || !raw.allowedUserIds.length) throw new Error('Profile 必须配置 allowedUserIds。');
  const aliases = profileAliases(raw.aliases);
  const network = raw.network as Record<string, unknown> | undefined;
  if (network != null && (typeof network !== 'object' || Array.isArray(network) || Object.keys(network).some(key => key !== 'proxyPort'))) throw new Error('network 仅支持 proxyPort。');
  const proxyPort = network?.proxyPort ?? null;
  if (proxyPort !== null && (typeof proxyPort !== 'number' || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) throw new Error('Profile 代理端口需要是 1–65535 的整数或 null。');
  if (raw.defaultAgent !== undefined && raw.defaultAgent !== 'codex' && raw.defaultAgent !== 'claude') throw new Error('Profile defaultAgent 只能是 codex 或 claude。');
  const features = raw.features;
  if (features != null && (typeof features !== 'object' || Array.isArray(features))) throw new Error('features 必须是对象。');
  for (const [key, enabled] of Object.entries(features ?? {})) {
    if (!['reactions', 'nativeCommands', 'presence'].includes(key) || typeof enabled !== 'boolean') throw new Error('未知或无效的可选功能。');
    if (platform === 'feishu' && enabled && key !== 'reactions') throw new Error(`飞书暂不支持可选功能 ${key}。`);
  }
  for (const key of ['workspace', 'workingCwd', 'ownerPrincipalId']) if (raw[key] != null && (typeof raw[key] !== 'string' || !String(raw[key]).trim())) throw new Error(`Profile ${key} 必须是非空字符串。`);
  return { platform, name, applicationId, aliases, defaultAgent: raw.defaultAgent as AgentName | undefined, workspace: raw.workspace as string | undefined, workingCwd: raw.workingCwd as string | undefined, ownerPrincipalId: raw.ownerPrincipalId as string | undefined, token: String(raw.token ?? '').trim(), appSecret: String(raw.appSecret ?? '').trim(),
    allowedUserIds: raw.allowedUserIds.map(String), network: { proxyPort: proxyPort as number | null }, features: features as BotProfile['features'] };
}
/** A credential rotation or profile alias change retains the bot's actual identity. */
export function profileScope(profile: BotProfile): string {
  return `${profile.platform}:${profile.applicationId}|`;
}
