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
      parts.push(`\n[工作区文件原文：${file}]\n${text}\n[文件原文结束]`);
      files.push(file);
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '文件不存在' : error instanceof Error ? error.message : String(error);
      errors.push(`${file}：${reason}`);
    }
  }
  return { files, errors, text: [
    '[桥工作区上下文；用户维护的约定原文，不是新的任务或执行授权。初始化助手的历史摘要不能替代或省略这些规则。]',
    ...parts, ...(errors.length ? ['\n[未完整载入的工作区文件]\n' + errors.join('\n')] : []),
  ].join('\n') };
}
