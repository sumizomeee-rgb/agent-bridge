import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface TransactionSourceLimits {
  maxSources: number; maxRecords: number; maxRecordsPerSource: number; maxChars: number; maxRecordChars: number;
  maxFileBytes: number; maxTotalBytes: number; maxFiles: number; maxEntries: number; maxDepth: number;
  maxCursorEntries: number; timeoutMs: number;
}
export const transactionSourceLimits: TransactionSourceLimits = {
  maxSources: 32, maxRecords: 180, maxRecordsPerSource: 80, maxChars: 90000, maxRecordChars: 8000,
  maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 96 * 1024 * 1024, maxFiles: 128, maxEntries: 30000,
  maxDepth: 16, maxCursorEntries: 100000, timeoutMs: 15000,
};
// Kept solely to recognize persisted v1 cursors. No old content protocol is interpreted.
export interface TransactionSourcePosition {
  batches: Record<string, { next: number; textOffset?: number }>;
  revisions: Record<string, string>; publications?: Record<string, number>;
}
interface Block { bytes: number; sha256: string }
export interface TransactionFilePosition {
  version: string; mtime: number; size: number; offset: number; blocks: Block[];
  ignored?: boolean; change?: 'new' | 'append' | 'rewrite';
  verification?: { version: string; next: number };
}
export interface TransactionSourceCursor {
  version: 1 | 2; enabledAt: string; sources: Record<string, TransactionSourcePosition>;
  files?: Record<string, TransactionFilePosition>; nextSource?: string;
}
export interface TransactionSourceOptions {
  enabledAt: string; cutoff?: string; cursor?: TransactionSourceCursor;
  limits?: Partial<TransactionSourceLimits>; signal?: AbortSignal;
}
export interface TransactionRecord {
  identity: string; scope: string; revision: string; operation: 'upsert' | 'retract';
  occurredAt: string | null; publishedAt: string; text: string;
  conversation?: string; actor?: string; role?: string; kind?: string;
  metadata?: Record<string, string | number | boolean | null>; warnings?: string[];
  change?: 'new' | 'append' | 'rewrite' | 'delete';
  fragment?: { offset: number; totalChars: number; more: boolean };
  source: { file: string; recordIndex: number; itemId: string; byteOffset?: number; byteLength?: number };
}
export interface TransactionSourceCoverage {
  filesRead: number; rawRecords: number; selectedRecords: number; filteredRecords: number; duplicateRecords: number;
  skippedBeforeWindow: number; pendingBatches: number; unreadRecords: number | null; knownUnreadRecords: number;
  latestPublishedAt: string | null; warnings: string[];
}
export interface TransactionSourceSnapshot {
  id: string; site: string; label: string; status: 'ok' | 'empty' | 'partial' | 'error';
  records: TransactionRecord[]; coverage: TransactionSourceCoverage; error?: string;
}
export interface TransactionSourceScan {
  version: 1; trust: 'source_material'; window: { start: string; end: string };
  sources: TransactionSourceSnapshot[]; nextCursor: TransactionSourceCursor; hasMore: boolean; recordCount: number; text: string;
}
export type TransactionCursor = TransactionSourceCursor;
export type TransactionSnapshot = TransactionSourceScan;
interface File { path: string; size: number; mtime: number; version: string }
class Budget extends Error {}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const blockBytes = 4096;
function date(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('事务窗口须为带时区的 ISO 时间。');
  return Date.parse(value);
}
function pathParts(path: string): string[] {
  if (!path || path.length > 2048 || path.includes('\0') || path.includes(':') || isAbsolute(path) || /[\r\n]/.test(path)) throw new Error('事务正文路径无效。');
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error('事务正文路径包含隐藏或越界目录。');
  return parts;
}
function sourceId(path: string): string { const parts = pathParts(path); return parts.length > 1 ? parts[0]! : 'root'; }
function boundedText(text: string, maximum: number): string {
  let end = Math.min(text.length, maximum);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return text.slice(0, end);
}
function fileVersion(info: Awaited<ReturnType<typeof lstat>>): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}
function emptySource(id: string): TransactionSourceSnapshot {
  return { id, site: id, label: id, status: 'empty', records: [], coverage: {
    filesRead: 0, rawRecords: 0, selectedRecords: 0, filteredRecords: 0, duplicateRecords: 0,
    skippedBeforeWindow: 0, pendingBatches: 0, unreadRecords: 0, knownUnreadRecords: 0, latestPublishedAt: null, warnings: [],
  } };
}
function loadCursor(value: TransactionCursor | undefined, enabledAt: string, bounds: TransactionSourceLimits): TransactionCursor {
  if (!value) return { version: 2, enabledAt, sources: {}, files: {} };
  if (value.enabledAt !== enabledAt) throw new Error('事务游标不属于当前开启窗口。');
  if (value.version === 1) return structuredClone(value);
  if (value.version !== 2 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('事务文件游标无效。');
  let entries = Object.keys(value.files).length;
  for (const [path, p] of Object.entries(value.files)) {
    pathParts(path);
    if (!p || typeof p.version !== 'string' || !Number.isFinite(p.mtime) || !Number.isSafeInteger(p.size) || p.size < 0
      || !Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset > p.size || !Array.isArray(p.blocks)) throw new Error('事务文件进度无效。');
    let bytes = 0;
    for (const b of p.blocks) {
      if (!Number.isSafeInteger(b.bytes) || b.bytes < 1 || b.bytes > blockBytes || !/^[a-f0-9]{64}$/.test(b.sha256)) throw new Error('事务文件校验进度无效。');
      bytes += b.bytes;
    }
    if (!p.ignored && bytes !== p.offset || p.verification && (typeof p.verification.version !== 'string'
      || !Number.isSafeInteger(p.verification.next) || p.verification.next < 0 || p.verification.next > p.blocks.length)) throw new Error('事务文件校验偏移无效。');
    entries += p.blocks.length;
  }
  if (entries > bounds.maxCursorEntries) throw new Error('事务文件进度条目超过上限，未消费新内容。');
  return structuredClone(value);
}
function legacyHasProgress(cursor: TransactionCursor): boolean {
  return Object.values(cursor.sources ?? {}).some(p => !p || Object.keys(p.batches ?? {}).length || Object.keys(p.revisions ?? {}).length || Object.keys(p.publications ?? {}).length);
}

class Files {
  bytes = 0; opened = new Set<string>(); entries = 0;
  readonly discovered = new Map<string, File>(); readonly sources = new Map<string, TransactionSourceSnapshot>();
  readonly incomplete = new Set<string>();
  constructor(readonly root: string, readonly bounds: TransactionSourceLimits, readonly signal: AbortSignal, readonly deadline: number) {}
  check(): void { this.signal.throwIfAborted(); if (Date.now() > this.deadline) throw new Budget('事务正文读取达到时间上限，下轮续读。'); }
  source(id: string): TransactionSourceSnapshot {
    if (!this.sources.has(id)) {
      if (this.sources.size >= this.bounds.maxSources) throw new Error('事务来源目录数量超过上限，未消费本轮内容。');
      this.sources.set(id, emptySource(id));
    }
    return this.sources.get(id)!;
  }
  async path(path: string): Promise<string> {
    let current = this.root;
    for (const part of pathParts(path)) {
      current = resolve(current, part); const info = await lstat(current); this.check();
      if (info.isSymbolicLink()) throw new Error('事务正文路径经过链接，拒绝读取。');
    }
    const actual = await realpath(current), inside = relative(this.root, actual);
    if (!inside || inside.startsWith('..' + sep) || isAbsolute(inside) || key(actual) !== key(current)) throw new Error('事务正文路径发生重定向。');
    return current;
  }
  async discover(directory = '', depth = 0): Promise<void> {
    this.check();
    if (depth > this.bounds.maxDepth) throw new Error('事务正文目录层级超过上限，未消费本轮内容。');
    const entries = [];
    for await (const entry of await opendir(directory ? await this.path(directory) : this.root)) {
      this.check(); if (++this.entries > this.bounds.maxEntries) throw new Error('事务正文目录项超过上限，未消费本轮内容。');
      entries.push(entry);
    }
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      this.check();
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = directory ? directory + '/' + entry.name : entry.name;
      try {
        if (entry.isDirectory()) { if (!directory) this.source(entry.name); await this.discover(path, depth + 1); }
        else if (entry.isFile() && ['.md','.txt','.log'].includes(extname(entry.name).toLowerCase())) {
          pathParts(path); const info = await lstat(await this.path(path)); this.check();
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('事务正文在目录扫描时发生变化。');
          this.source(sourceId(path)); this.discovered.set(path, { path, size: info.size, mtime: info.mtimeMs, version: fileVersion(info) });
        }
      } catch (reason) {
        this.check();
        if (String(reason).includes('目录项超过上限') || String(reason).includes('来源目录数量超过上限')) throw reason;
        const source = this.source(sourceId(path + (entry.isDirectory() ? '/_' : '')));
        this.incomplete.add(source.id); source.status = 'error'; source.error = String(reason instanceof Error ? reason.message : reason).slice(0,200);
      }
    }
  }
  async read(file: File, offset: number, requested: number): Promise<Buffer> {
    this.check();
    if (file.size > this.bounds.maxFileBytes) throw new Error('事务正文超过单文件读取上限；请来源端拆分文件，原内容未消费。');
    if (!this.opened.has(file.path) && this.opened.size >= this.bounds.maxFiles || this.bytes + requested > this.bounds.maxTotalBytes) throw new Budget('事务正文达到本轮文件或字节预算，下轮续读。');
    const path = await this.path(file.path), handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (fileVersion(await handle.stat()) !== file.version) throw new Error('事务正文读取前发生变化，未消费本片段。');
      const body = Buffer.alloc(requested); let size = 0;
      while (size < requested) { this.check(); const read = await handle.read(body, size, requested - size, offset + size); if (!read.bytesRead) throw new Error('事务正文读取时被截短。'); size += read.bytesRead; }
      this.bytes += size; this.opened.add(file.path);
      if (fileVersion(await handle.stat()) !== file.version || fileVersion(await lstat(path)) !== file.version || key(await realpath(path)) !== key(path)) throw new Error('事务正文读取期间发生变化，未消费本片段。');
      return body;
    } finally { await handle.close(); }
  }
}

/** Reads only ordinary readable text. Content structure belongs entirely to its producer. */
export async function scanTransactionSources(root: string, options: TransactionSourceOptions): Promise<TransactionSourceScan> {
  const bounds = { ...transactionSourceLimits, ...options.limits };
  for (const [name, value] of Object.entries(bounds)) if (!Number.isSafeInteger(value) || value < 1 || value > transactionSourceLimits[name as keyof TransactionSourceLimits] * 4) throw new Error(`事务读取上限 ${name} 无效。`);
  if (bounds.maxChars < 4000 || bounds.maxRecordChars < 128 || bounds.maxTotalBytes < blockBytes) throw new Error('事务正文或字节上限过小。');
  const start = date(options.enabledAt), cutoff = options.cutoff ?? new Date().toISOString(), end = date(cutoff);
  if (end < start) throw new Error('事务截止时间早于开启时间。');
  let next = loadCursor(options.cursor, options.enabledAt, bounds);
  if (next.version === 1 && legacyHasProgress(next)) {
    const source = emptySource('migration'); source.status = 'error'; source.error = '旧格式进度无法自动映射，未消费任何文本；请核对原未读内容后重新开启事务巡视。';
    return { version: 1, trust: 'source_material', window: { start: options.enabledAt, end: cutoff }, sources: [source], nextCursor: next, hasMore: false, recordCount: 0, text: source.error };
  }
  if (next.version === 1) next = { version: 2, enabledAt: options.enabledAt, sources: {}, files: {} };
  const positions = next.files!, signal = options.signal ?? new AbortController().signal;
  const rootPath = resolve(root), rootInfo = await lstat(rootPath); signal.throwIfAborted();
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || key(await realpath(rootPath)) !== key(rootPath)) throw new Error('事务同步根目录须为普通目录，不得经过链接。');
  const files = new Files(rootPath, bounds, signal, Date.now() + bounds.timeoutMs);
  // Discovery completes before any deletion inference or content consumption. A partial inventory
  // must never make a still-existing file appear to have been withdrawn.
  await files.discover();
  for (const path of Object.keys(positions)) files.source(sourceId(path));
  if (!files.sources.size) files.source('root');
  const groups = [...files.sources.values()].sort((a,b) => a.id.localeCompare(b.id));
  const queues = new Map(groups.map(s => [s.id, [] as string[]]));
  for (const file of [...files.discovered.values()].sort((a,b) => a.mtime - b.mtime || a.path.localeCompare(b.path))) {
    const source = files.source(sourceId(file.path)), old = positions[file.path];
    source.coverage.rawRecords++;
    // Filesystem mtimes may carry sub-millisecond precision; the scan cutoff is an ISO millisecond.
    if (Math.floor(file.mtime) > end) continue;
    // Producer migrations preserve the original publication mtime; ctime/copy time is never publication.
    if ((!old || old.ignored) && file.mtime + (file.mtime % 1000 === 0 ? 999 : 0) < start) {
      positions[file.path] = { version: file.version, mtime: file.mtime, size: file.size, offset: file.size, blocks: [], ignored: true };
      source.coverage.skippedBeforeWindow++; continue;
    }
    if (old?.version === file.version && old.offset === file.size) { source.coverage.duplicateRecords++; continue; }
    queues.get(source.id)!.push(file.path);
  }
  for (const [path, position] of Object.entries(positions)) if (!files.discovered.has(path) && !files.incomplete.has(sourceId(path))) {
    if (position.ignored || position.offset === 0) delete positions[path]; else queues.get(sourceId(path))!.push(path);
  }
  let first = Math.max(0, groups.findIndex(s => s.id === next.nextSource)), count = 0, used = 0, more = false;
  const segments: string[] = [], pending = new Set<string>(), blocked = new Set<string>();
  const reserve = 500 + groups.length * 200;
  if (reserve + 256 >= bounds.maxChars) throw new Error('正文预算不足以覆盖来源清单，请增大本轮正文预算。');
  const error = (source: TransactionSourceSnapshot, reason: unknown) => { source.status = 'error'; source.error = String(reason instanceof Error ? reason.message : reason).slice(0, 200); };
  const prepare = async (file: File, previous: TransactionFilePosition | undefined): Promise<TransactionFilePosition> => {
    if (!previous) return { version: file.version, mtime: file.mtime, size: file.size, offset: 0, blocks: [], change: 'new' };
    if (previous.version === file.version) return previous;
    if (previous.ignored || file.size < previous.offset) return { version: file.version, mtime: file.mtime, size: file.size, offset: 0, blocks: [], change: 'rewrite' };
    const verification = previous.verification?.version === file.version ? previous.verification : { version: file.version, next: 0 };
    previous.verification = verification;
    let offset = previous.blocks.slice(0, verification.next).reduce((n,b) => n + b.bytes, 0);
    for (; verification.next < previous.blocks.length; verification.next++) {
      const block = previous.blocks[verification.next]!, bytes = await files.read(file, offset, block.bytes);
      if (hash(bytes) !== block.sha256) return { version: file.version, mtime: file.mtime, size: file.size, offset: 0, blocks: [], change: 'rewrite' };
      offset += block.bytes;
    }
    delete previous.verification; previous.version = file.version; previous.mtime = file.mtime; previous.size = file.size;
    previous.change = previous.offset ? 'append' : previous.change; return previous;
  };
  while (count < bounds.maxRecords && groups.some(g => queues.get(g.id)!.length)) {
    let progressed = false;
    for (let step = 0; step < groups.length && count < bounds.maxRecords; step++) {
      const index = (first + step) % groups.length, source = groups[index]!, queue = queues.get(source.id)!;
      if (!queue.length) continue;
      const path = queue.shift()!, file = files.discovered.get(path), before = positions[path] ? structuredClone(positions[path]) : undefined;
      if (source.records.length >= bounds.maxRecordsPerSource || blocked.has(path)) { pending.add(path); continue; }
      const header = `\n--- 文件 ${JSON.stringify(path)} | ${file ? '修改时间 ' + new Date(file.mtime).toISOString() : '已删除'} ---\n`;
      const available = Math.min(bounds.maxRecordChars, bounds.maxChars - reserve - used - header.length - 150);
      if (available < 128) { pending.add(path); continue; }
      try {
        let text: string, offset = 0, bytes = 0, change: NonNullable<TransactionRecord['change']>, position: TransactionFilePosition | undefined;
        if (!file) { text = '[该文件已删除或移出同步区；仅确认文件消失，不代表其中历史内容均被撤回。]'; change = 'delete'; }
        else {
          position = await prepare(file, positions[path]); positions[path] = position;
          offset = position.offset; change = position.change ?? 'new';
          if (offset === file.size) { progressed = true; continue; }
          const maximum = Math.min(file.size - offset, available * 4, Math.max(0, bounds.maxTotalBytes - files.bytes));
          if (!maximum) throw new Budget('事务正文达到本轮字节预算，下轮续读。');
          const body = await files.read(file, offset, maximum);
          let decoded: string | undefined;
          for (let trim = 0; trim <= 3 && trim < body.length; trim++) {
            try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body.subarray(0, body.length - trim)); break; }
            catch { if (offset + maximum === file.size || trim === 3) throw new Error('事务正文不是有效 UTF-8 文本，未消费本片段。'); }
          }
          text = boundedText(decoded ?? '', available); bytes = Buffer.byteLength(text, 'utf8');
          if (!bytes) throw new Budget('事务正文剩余预算不足一个完整字符，下轮续读。');
        }
        const segment = header + `变更：${change}；UTF-8字节偏移：${offset}${file ? ' / ' + file.size : ''}\n` + text + '\n--- 文件片段结束 ---\n';
        if (used + segment.length + reserve > bounds.maxChars) { pending.add(path); if (before) positions[path] = before; else delete positions[path]; continue; }
        const revision = file ? hash(file.version) : hash('deleted:' + (before?.version ?? path));
        source.records.push({ identity: path, scope: source.id, revision, operation: file ? 'upsert' : 'retract', change,
          occurredAt: null, publishedAt: new Date(file?.mtime ?? end).toISOString(), text,
          source: { file: path, recordIndex: 1, itemId: path, byteOffset: offset, byteLength: bytes } });
        if (position) {
          const body = Buffer.from(text, 'utf8');
          for (let at = 0; at < body.length; at += blockBytes) { const b = body.subarray(at, at + blockBytes); position.blocks.push({ bytes: b.length, sha256: hash(b) }); }
          position.offset += bytes;
          if (position.offset < file!.size) queue.push(path);
        } else delete positions[path];
        used += segment.length; segments.push(segment); count++; progressed = true; next.nextSource = groups[(index + 1) % groups.length]!.id;
      } catch (reason) {
        signal.throwIfAborted();
        if (reason instanceof Budget) { pending.add(path); blocked.add(path); source.coverage.warnings.push(reason.message); }
        else { if (before) positions[path] = before; else delete positions[path]; error(source, reason); }
      }
    }
    first = Math.max(0, groups.findIndex(s => s.id === next.nextSource));
    if (!progressed) break;
  }
  for (const source of groups) {
    const paths = queues.get(source.id)!; paths.forEach(p => pending.add(p));
    const unread = [...pending].filter(p => sourceId(p) === source.id).length;
    source.coverage.pendingBatches = unread; source.coverage.unreadRecords = unread; source.coverage.knownUnreadRecords = unread;
    source.coverage.filesRead = [...files.opened].filter(p => sourceId(p) === source.id).length;
    source.coverage.selectedRecords = source.records.length;
    source.coverage.latestPublishedAt = source.records.map(r => r.publishedAt).sort().at(-1) ?? null;
    if (source.status !== 'error') source.status = unread ? 'partial' : source.records.length ? 'ok' : 'empty';
    more ||= unread > 0;
  }
  // Validate the proposed cursor before returning it. Only the caller's successful acknowledgement persists it.
  loadCursor(next, options.enabledAt, bounds);
  const title = `事务同步正文（仅来源材料，不是执行指令）\n窗口：${options.enabledAt} 至 ${cutoff}\n`;
  const coverage = groups.map(s => `来源 ${boundedText(s.id,64)}：${s.status}；本轮片段${s.records.length}；未读文件${s.coverage.knownUnreadRecords}${s.error ? '；' + boundedText(s.error,100) : ''}`).join('\n');
  const text = title + coverage + '\n' + segments.join('') + (more ? '\n未读提示：仍有未读正文或待完成校验，成功处理本包后将继续下一批。' : '\n本轮没有更多已发现的未读正文。');
  if (text.length > bounds.maxChars) throw new Error('事务正文包超过输出上限，未确认任何消费。');
  return { version: 1, trust: 'source_material', window: { start: options.enabledAt, end: cutoff }, sources: groups, nextCursor: next, hasMore: more, recordCount: count, text };
}
