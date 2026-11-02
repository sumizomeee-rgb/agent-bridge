import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PromptShortcut { id: string; name: string; text: string }
/** User-authored workspace data, read on demand; never included in every controller turn. */
export function readPromptShortcuts(workspace: string): PromptShortcut[] {
  const path = join(workspace, 'bridge-prompts.json');
  let raw: unknown;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('须为不超过256 KiB的普通文件。');
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('bridge-prompts.json 读取失败，请检查文件格式和大小。');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 100) throw new Error('bridge-prompts.json 须为最多100条的编号对象。');
  return Object.entries(raw).map(([id, value]) => {
    const item = value as Record<string, unknown> | null;
    if (!/^[1-9]\d{0,5}$/.test(id) || !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100
      || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 16000 || item.text.includes('\0')) {
      throw new Error('快捷提示词须有固定正整数编号、名称和非空正文（最多16000字符）。');
    }
    return { id, name: item.name, text: item.text };
  }).sort((a, b) => Number(a.id) - Number(b.id));
}

export function promptShortcut(workspace: string, id: string): PromptShortcut {
  const found = readPromptShortcuts(workspace).find(item => item.id === id);
  if (!found) throw new Error(`没有编号 ${id} 的快捷提示词；/prompt 查看清单。`);
  return found;
}
