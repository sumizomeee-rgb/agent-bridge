import { readFile, lstat } from 'node:fs/promises';
import { workspaceFile } from '../workspace-layout.js';
import { isObject } from '../agents/process.js';
import { isModelId } from '../config.js';
import type { DispatchPreset, PresetFilter } from './types.js';

export function presetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) throw new Error('预设标识无效。');
  return value;
}
export async function readPrivateJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('预设登记必须是小型普通 JSON 文件。');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}
export function parsePresetRegistry(raw: unknown): DispatchPreset[] {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.presets) || raw.presets.length > 100) throw new Error('bridge-agent-presets/registry.json 格式无效。');
  const ids = new Set<string>(), aliases = new Set<string>();
  return raw.presets.map(item => {
    if (!isObject(item)) throw new Error('预设条目无效。');
    const id = presetId(item.id), targetId = presetId(item.targetId), profileId = presetId(item.profileId);
    if (ids.has(id)) throw new Error('预设 ID 重复。'); ids.add(id);
    if (!['codex', 'claude'].includes(String(item.agent)) || typeof item.model !== 'string' || !isModelId(item.model)
      || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1 || typeof item.enabled !== 'boolean') throw new Error('预设引擎、模型或版本无效。');
    if (!Array.isArray(item.aliases) || !item.aliases.length || item.aliases.length > 20) throw new Error('预设需要口语别名。');
    const names = item.aliases.map(value => {
      if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)) throw new Error('预设别名无效。');
      const name = value.trim(), key = name.toLocaleLowerCase();
      if (aliases.has(key)) throw new Error('预设口语别名有歧义。'); aliases.add(key); return name;
    });
    return { id, targetId, profileId, aliases: names, revision: Number(item.revision), agent: item.agent as DispatchPreset['agent'], model: item.model,
      enabled: item.enabled, ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 240) } : {}) };
  });
}
export async function listPresets(workspace: string, filter: PresetFilter = {}): Promise<DispatchPreset[]> {
  let entries: DispatchPreset[];
  try { entries = parsePresetRegistry(await readPrivateJson(workspaceFile(workspace, 'agent-presets', 'registry.json'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const query = filter.query?.trim().toLocaleLowerCase();
  return entries.filter(item => (!filter.targetId || item.targetId === filter.targetId) && (!filter.agent || item.agent === filter.agent)
    && (!query || [item.id, item.model, ...item.aliases].some(value => value.toLocaleLowerCase().includes(query))));
}
