import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, readdirSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isObject } from '../agents/process.js';
import { readPrivateJson, presetId } from './registry.js';
import type { LaunchProfile } from './types.js';

export interface PresetMaterials {
  version: 1; owner: string; profiles: LaunchProfile[];
  credentials: Record<string, { apiKey?: string; authToken?: string }>;
}
export type ProfileParser = (raw: unknown) => LaunchProfile[];
export const materialsHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function parseMaterials(raw: unknown, profiles: ProfileParser): PresetMaterials {
  if (!isObject(raw) || raw.version !== 1 || typeof raw.owner !== 'string' || !/^[a-f0-9]{64}$/.test(raw.owner)
    || !isObject(raw.credentials)) throw new Error('自动预设配置格式无效。');
  const parsed = profiles(raw), credentials: PresetMaterials['credentials'] = {};
  for (const [id, value] of Object.entries(raw.credentials)) {
    presetId(id);
    if (!isObject(value) || Object.keys(value).some(key => !['apiKey', 'authToken'].includes(key))) throw new Error('自动预设凭据格式无效。');
    for (const key of ['apiKey', 'authToken'] as const) if (value[key] !== undefined
      && (typeof value[key] !== 'string' || !value[key] || /[\r\n\0]/.test(value[key] as string))) throw new Error('自动预设凭据无效。');
    if (!value.apiKey && !value.authToken) throw new Error('自动预设缺少凭据。');
    credentials[id] = { ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}), ...(typeof value.authToken === 'string' ? { authToken: value.authToken } : {}) };
  }
  if (parsed.some(profile => !credentials[profile.credentialId]
    || (profile.agent === 'codex' && !credentials[profile.credentialId]!.apiKey))) throw new Error('自动预设缺少对应后端的凭据。');
  return { version: 1, owner: raw.owner, profiles: parsed, credentials };
}

// 文件和上级目录都不允许通过链接跳出已登记的私有目录。
export function ordinaryPath(path: string): void {
  let cursor = resolve(path);
  while (cursor !== parse(cursor).root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('自动预设路径不能包含链接。');
    cursor = dirname(cursor);
  }
}
export function privateDirectory(path: string): void {
  ordinaryPath(path); mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error('自动预设私有目录无效。');
  if (process.platform !== 'win32') { chmodSync(path, 0o700); return; }
  const script = `$ErrorActionPreference='Stop';$p='${resolve(path).replaceAll("'", "''")}';`
    + `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);`
    + `foreach($s in @($sid.Value,'S-1-5-18')){$principal=New-Object Security.Principal.SecurityIdentifier($s);$rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};[IO.Directory]::SetAccessControl($p,$acl)`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
  if (result.status !== 0) throw new Error('无法限制自动预设目录权限。');
}

export async function readMaterials(privateRoot: string, parser: ProfileParser): Promise<PresetMaterials[]> {
  const directory = join(privateRoot, 'managed'); ordinaryPath(directory);
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  if (files.length > 100) throw new Error('自动预设配置数量超限。');
  return Promise.all(files.map(async file => {
    const value = parseMaterials(await readPrivateJson(join(directory, file)), parser);
    if (file !== value.owner + '.json') throw new Error('自动预设配置来源不一致。'); return value;
  }));
}

// 一次替换同一个文件，模型线路与凭据不会处于只更新一半的状态。
export async function installMaterials(privateRoot: string, raw: unknown, parser: ProfileParser): Promise<{ count: number; changed: boolean }> {
  const next = parseMaterials(raw, parser), directory = join(privateRoot, 'managed');
  privateDirectory(directory);
  const sources = await readMaterials(privateRoot, parser), previous = sources.find(source => source.owner === next.owner);
  for (const source of sources.filter(source => source.owner !== next.owner)) {
    if (source.profiles.some(profile => next.profiles.some(other => other.id === profile.id))) throw new Error('不同工作区的预设配置 ID 冲突，未覆盖。');
  }
  // 旧助手的线路快照仍可能引用旧凭据；移除清单条目不会删除这些运行资料。
  const profiles = new Map(previous?.profiles.map(profile => [profile.id, profile]) ?? []);
  for (const profile of next.profiles) profiles.set(profile.id, profile);
  const value = { ...next, profiles: [...profiles.values()], credentials: { ...previous?.credentials, ...next.credentials } };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error('自动预设配置大小超限。');
  if (previous && JSON.stringify(previous) === serialized) return { count: next.profiles.length, changed: false };
  const path = join(directory, next.owner + '.json'), temporary = join(directory, '.' + randomUUID() + '.tmp'); ordinaryPath(path);
  try { writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { count: next.profiles.length, changed: true };
}
