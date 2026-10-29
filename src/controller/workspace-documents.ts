import { harnessText } from '../harness.js';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Owner-maintained rules are transported verbatim, independently of an LLM summary. */
export function workspaceDocuments(workspace: string): { text: string; files: string[]; errors: string[] } {
  const parts: string[] = [], files: string[] = [], errors: string[] = [];
  for (const name of ['README.md', 'MEMORY.md']) {
    const file = join(workspace, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('须为不超过 64 KiB 的文本文件');
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      if (text.includes('\0')) throw new Error('文件不是有效的 UTF-8 Markdown 文本');
      parts.push(harnessText('workspace.document', { file, text }));
      files.push(file);
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '文件不存在' : error instanceof Error ? error.message : String(error);
      errors.push(`${file}：${reason}`);
    }
  }
  return { files, errors, text: [
    harnessText('workspace.context_header'),
    ...parts, ...(errors.length ? [harnessText('workspace.incomplete', { errors: errors.join('\n') })] : []),
  ].join('\n') };
}
