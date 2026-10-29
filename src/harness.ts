import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

export interface HarnessPrompt {
  purpose: string;
  audience: string;
  injection: string;
  activation: string;
  source: string;
  text: string;
}
export interface HarnessCatalog { version: 1; prompts: Readonly<Record<string, Readonly<HarnessPrompt>>> }

const fields = ['purpose', 'audience', 'injection', 'activation', 'source', 'text'] as const;
const placeholder = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

/** Both src/ execution and the normal dist/src/ build resolve the same versioned asset. */
export function harnessCatalogPath(moduleUrl: string | URL = import.meta.url): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  return resolve(directory, directory.endsWith('/dist/src') || directory.endsWith('\\dist\\src') ? '../..' : '..', 'harness', 'prompts.toml');
}

export function parseHarnessCatalog(source: string): HarnessCatalog {
  if (Buffer.byteLength(source, 'utf8') > 512 * 1024) throw new Error('提示词配置超过 512 KiB。');
  const value = parse(source.replace(/^\uFEFF/, '')) as Record<string, unknown>;
  if (value.version !== 1 || !value.prompts || typeof value.prompts !== 'object' || Array.isArray(value.prompts)) throw new Error('提示词配置须使用 version=1 与 prompts 表。');
  const prompts: Record<string, Readonly<HarnessPrompt>> = Object.create(null);
  for (const [id, input] of Object.entries(value.prompts)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,179}$/.test(id) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('提示词条目名称或结构无效。');
    const entry = input as Record<string, unknown>;
    if (Object.keys(entry).some(key => !(fields as readonly string[]).includes(key)) || fields.some(key => typeof entry[key] !== 'string' || !(entry[key] as string).trim() || (entry[key] as string).includes('\0'))) throw new Error(`提示词条目缺少有效说明或正文：${id}`);
    prompts[id] = Object.freeze(Object.fromEntries(fields.map(key => [key, entry[key]])) as unknown as HarnessPrompt);
  }
  if (!Object.keys(prompts).length) throw new Error('提示词配置不能为空。');
  return Object.freeze({ version: 1 as const, prompts: Object.freeze(prompts) });
}

export function renderHarnessPrompt(catalog: HarnessCatalog, id: string, variables: Readonly<Record<string, string>> = {}): string {
  const entry = catalog.prompts[id];
  if (!entry) throw new Error(`提示词条目不存在：${id}`);
  const used = new Set<string>();
  // One pass: source text supplied as a variable is data, never another template.
  const rendered = entry.text.replace(placeholder, (_match, key: string) => {
    if (!Object.hasOwn(variables, key) || typeof variables[key] !== 'string') throw new Error(`提示词动态参数缺失：${id}.${key}`);
    used.add(key); return variables[key]!;
  });
  if (Object.keys(variables).some(key => !used.has(key))) throw new Error(`提示词包含未使用的动态参数：${id}`);
  return rendered;
}

let cached: { fingerprint: string; catalog: HarnessCatalog } | undefined;
export function harnessCatalog(): HarnessCatalog {
  const file = harnessCatalogPath(), info = statSync(file);
  if (!info.isFile() || info.size > 512 * 1024) throw new Error('提示词配置须为不超过 512 KiB 的普通文件。');
  const fingerprint = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  if (!cached || cached.fingerprint !== fingerprint) cached = { fingerprint, catalog: parseHarnessCatalog(readFileSync(file, 'utf8')) };
  return cached.catalog;
}

export function harnessText(id: string, variables: Readonly<Record<string, string>> = {}): string {
  return renderHarnessPrompt(harnessCatalog(), id, variables);
}

/** Trusted project templates share prose with runtime prompts without copying its source. */
export function renderHarnessReferences(template: string): string {
  const newline = template.includes('\r\n') ? '\r\n' : '\n';
  return template.replace(/\{\{harness\.([A-Za-z][A-Za-z0-9_.-]*)\}\}/g, (_match, id: string) => harnessText(id).replace(/\r?\n/g, newline));
}
