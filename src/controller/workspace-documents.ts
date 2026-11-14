import { harnessCatalog, harnessCatalogPath } from '../harness.js';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ControllerAgentName } from '../types.js';
import { renderHarnessPrompt } from '../harness.js';
import { controllerToolIndexText } from './tools/entry.js';

export interface WorkspaceDocumentOptions { agent?: ControllerAgentName; internalBotCommunicationEnabled?: boolean }
export const bridgeProjectRoot = () => resolve(dirname(harnessCatalogPath()), '..');

/** README is the only fixed-context entry. Included owner data is never re-templated. */
export function workspaceDocuments(workspace?: string, options: WorkspaceDocumentOptions = {}): { text: string; files: string[]; errors: string[] } {
  const files: string[] = [], errors: string[] = [];
  const read = (file: string): string => {
    const info = statSync(file);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('须为不超过 64 KiB 的文本文件');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)).replace(/^\uFEFF/, '');
    if (text.includes('\0')) throw new Error('文件不是有效的 UTF-8 Markdown 文本');
    files.push(file); return text;
  };
  const reason = (file: string, error: unknown): string => {
    const detail = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '文件不存在' : error instanceof Error ? error.message : String(error);
    const message = `${file}：${detail}`; errors.push(message); return `[未完整载入：${message}]`;
  };
  const root = bridgeProjectRoot();
  const readme = workspace ? join(workspace, 'README.md') : join(root, 'workspace-template', 'README.md');
  let source: string;
  try { source = read(readme); } catch (error) { return { text: reason(readme, error), files, errors }; }
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const match of source.matchAll(/\{\{include:([^}]+)\}\}/g)) {
    if (seen.has(match[1]!)) duplicates.add(match[1]!); seen.add(match[1]!);
  }
  if (workspace) for (const key of ['bridge/controller-protocol', 'bridge/tool-index', 'workspace/MEMORY.md']) {
    if (!seen.has(key)) errors.push(`README.md 未声明 {{include:${key}}}，请迁移初始化入口；未另行追加未声明内容。`);
  }
  const prepared = source.replace(/\{\{(bridge_root|workspace_root)\}\}/g, (_, key: string) => key === 'bridge_root' ? root : workspace ?? '[工作区未配置]');
  const catalog = harnessCatalog();
  const text = prepared.replace(/\{\{include:([^}]+)\}\}/g, (_marker, key: string) => {
    try {
      if (duplicates.has(key)) throw new Error(`重复引用 ${key}`);
      switch (key) {
        case 'bridge/controller-protocol': return renderHarnessPrompt(catalog, 'controller.protocol');
        case 'bridge/agent-instructions': {
          const id = `controller.${options.agent ?? 'codex'}_developer`;
          return catalog.prompts[id] ? renderHarnessPrompt(catalog, id) : '';
        }
        case 'bridge/tool-index': return controllerToolIndexText(options.internalBotCommunicationEnabled);
        case 'workspace/MEMORY.md': return workspace ? read(join(workspace, 'MEMORY.md')) : '[工作区未配置，无用户 MEMORY]';
        default: throw new Error(`未登记的初始化引用 ${key}`);
      }
    } catch (error) { return reason(key === 'workspace/MEMORY.md' && workspace ? join(workspace, 'MEMORY.md') : key, error); }
  });
  return { text: errors.length ? text + '\n[工作区未完整载入]\n' + errors.join('\n') : text, files, errors };
}
