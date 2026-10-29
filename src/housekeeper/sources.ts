import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface TransactionSourceLimits {
  maxSources: number; maxRecords: number; maxRecordsPerSource: number; maxChars: number; maxRecordChars: number;
  maxIndexBytes: number; maxManifestBytes: number; maxBatchBytes: number; maxTotalBytes: number; maxFiles: number;
  maxBatchRefs: number; maxRecordsPerBatch: number; maxCursorEntries: number; timeoutMs: number;
}
export const transactionSourceLimits: TransactionSourceLimits = {
  maxSources: 16, maxRecords: 180, maxRecordsPerSource: 80, maxChars: 90000, maxRecordChars: 8000,
  maxIndexBytes: 256 * 1024, maxManifestBytes: 8 * 1024 * 1024, maxBatchBytes: 32 * 1024 * 1024,
  maxTotalBytes: 96 * 1024 * 1024, maxFiles: 128, maxBatchRefs: 30000, maxRecordsPerBatch: 100000,
  maxCursorEntries: 100000, timeoutMs: 15000,
};
export interface TransactionBatchPosition { next: number; textOffset?: number }
export interface TransactionSourcePosition {
  batches: Record<string, TransactionBatchPosition>;
  revisions: Record<string, string>;
  publications?: Record<string, number>;
}
export interface TransactionSourceCursor {
  version: 1; enabledAt: string; sources: Record<string, TransactionSourcePosition>;
}
export interface TransactionSourceOptions {
  enabledAt: string; cutoff?: string; cursor?: TransactionSourceCursor;
  limits?: Partial<TransactionSourceLimits>; signal?: AbortSignal;
}
export interface TransactionRecord {
  identity: string; scope: string; revision: string; operation: 'upsert' | 'retract';
  occurredAt: string | null; publishedAt: string; text: string;
  conversation?: string; actor?: string; role?: string; kind?: string;
  metadata?: Record<string, string | number | boolean | null>;
  warnings?: string[];
  fragment?: { offset: number; totalChars: number; more: boolean };
  source: { file: string; recordIndex: number; itemId: string };
}
export interface TransactionSourceCoverage {
  filesRead: number; rawRecords: number; selectedRecords: number; filteredRecords: number; duplicateRecords: number;
  skippedBeforeWindow: number; pendingBatches: number; unreadRecords: number | null; knownUnreadRecords: number;
  latestPublishedAt: string | null; warnings: string[];
}
export interface TransactionSourceSnapshot {
  id: string; site: string; label: string; status: 'ok' | 'empty' | 'partial' | 'error';
  records: TransactionRecord[]; coverage: TransactionSourceCoverage; error?: string;
  health?: { status: 'ok' | 'failed' | 'disabled' | 'unknown'; code: string | null; checkedAt: string | null; observedAt: string | null; lastSuccess: string | null };
}
export interface TransactionSourceScan {
  version: 1; trust: 'source_material'; window: { start: string; end: string };
  sources: TransactionSourceSnapshot[]; nextCursor: TransactionSourceCursor; hasMore: boolean;
  recordCount: number; text: string;
}
export type TransactionCursor = TransactionSourceCursor;
export type TransactionSnapshot = TransactionSourceScan;
type ObjectValue = Record<string, unknown>;
interface Descriptor { id: string; site: string; label: string; manifest: string; timezone?: string; health?: string }
interface BatchRef { key: string; file: string; sha256: string; itemId: string; hint: number | null; order: number }
interface LoadedBatch { ref: BatchRef; records: Array<{ value: ObjectValue; index: number }>; published: number }
interface Candidate { record: TransactionRecord; fullText: string; offset: number; commit: (length: number) => void }
class ScanBudget extends Error {}
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a: string, b: string) => comparable(a) === comparable(b);
function short(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, maximum) : undefined;
}
function instant(value: unknown): number | null {
  const result = typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? Math.round(result) : null;
}
function publicationEnd(value: unknown, published: number): number {
  // CookieSync publishes integer epoch seconds. A millisecond enable time cannot
  // distinguish records on either side within that second, so retain the overlap.
  const wholeSecond = typeof value === 'number' && value < 1e12 && Number.isInteger(value)
    || typeof value === 'string' && /T\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(value);
  return published + (wholeSecond ? 999 : 0);
}
function timestamp(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}须为带时区的 ISO 时间。`);
  return Date.parse(value);
}
function take(value: string, length: number): string {
  let end = Math.min(value.length, length);
  if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1] ?? '')) end--;
  return value.slice(0, end);
}
function localFolderTime(folder: string, timezone: string | undefined): number | null {
  if (!timezone) return null;
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(?:-|$)/.exec(folder);
  if (!m) return null;
  try {
    const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    let result = naive;
    for (let i = 0; i < 2; i++) {
      const p = Object.fromEntries(format.formatToParts(result).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
      const shown = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
      result -= shown - naive;
    }
    return result;
  } catch { return null; }
}
function limits(input: Partial<TransactionSourceLimits> | undefined): TransactionSourceLimits {
  const result = { ...transactionSourceLimits, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > transactionSourceLimits[key as keyof TransactionSourceLimits] * 4) throw new Error(`事务读取上限 ${key} 无效。`);
  }
  if (result.maxChars < 4000 || result.maxRecordChars < 128) throw new Error('事务正文上限过小。');
  return result;
}
function position(value: unknown): TransactionSourcePosition {
  if (!object(value) || !object(value.batches) || !object(value.revisions)) throw new Error('事务来源游标无效。');
  for (const [key, entry] of Object.entries(value.batches)) {
    if (key.length > 512 || !object(entry) || !Number.isSafeInteger(entry.next) || Number(entry.next) < -1
      || entry.textOffset !== undefined && (!Number.isSafeInteger(entry.textOffset) || Number(entry.textOffset) < 0)) throw new Error('事务批次游标无效。');
  }
  for (const [key, revision] of Object.entries(value.revisions)) if (!/^[a-f0-9]{64}$/.test(key) || typeof revision !== 'string' || revision.length > 256) throw new Error('事务修订游标无效。');
  if (value.publications !== undefined && (!object(value.publications) || Object.entries(value.publications).some(([key, time]) => !/^[a-f0-9]{64}$/.test(key) || typeof time !== 'number' || !Number.isFinite(time)))) throw new Error('事务发布时间游标无效。');
  return structuredClone(value) as unknown as TransactionSourcePosition;
}

class InputFiles {
  bytes = 0; files = 0;
  constructor(readonly root: string, readonly bounds: TransactionSourceLimits, readonly signal: AbortSignal, private readonly deadline: number) {}
  check(): void { this.signal.throwIfAborted(); if (Date.now() > this.deadline) throw new ScanBudget('本轮读取达到时间上限，保留进度下轮续读。'); }
  async path(relativePath: string, kind: 'file' | 'directory'): Promise<string> {
    this.check();
    if (!relativePath || relativePath.includes('\0') || relativePath.includes(':') || isAbsolute(relativePath)) throw new Error('来源路径必须是事务根内相对路径。');
    const parts = relativePath.replaceAll('\\', '/').split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('来源路径包含越界或空路径段。');
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = resolve(current, parts[i]!); const info = await lstat(current); this.check();
      if (info.isSymbolicLink() || (i < parts.length - 1 || kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw new Error('来源路径须为普通文件或目录，不得经过链接。');
    }
    const actual = await realpath(current); this.check();
    const inside = relative(this.root, actual);
    if (!inside || inside.startsWith('..' + sep) || isAbsolute(inside) || !samePath(actual, current)) throw new Error('来源路径越过事务根目录或发生重定向。');
    return current;
  }
  async json(relativePath: string, maximum: number, expectedHash?: string): Promise<unknown> {
    const file = await this.path(relativePath, 'file');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      this.check(); const before = await handle.stat({ bigint: true }); this.check();
      if (!before.isFile() || before.size > BigInt(maximum)) throw new Error('来源 JSON 不是普通文件或超过单文件上限。');
      const size = Number(before.size);
      if (this.files >= this.bounds.maxFiles || this.bytes + size > this.bounds.maxTotalBytes) throw new ScanBudget('本轮读取达到文件或字节上限，保留进度下轮续读。');
      this.files++; this.bytes += size;
      const bytes = Buffer.alloc(size); let offset = 0;
      while (offset < bytes.length) {
        this.check(); const chunk = await handle.read(bytes, offset, Math.min(65536, bytes.length - offset), null);
        if (!chunk.bytesRead) throw new Error('来源读取时被截短。'); offset += chunk.bytesRead;
      }
      this.check(); const after = await handle.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !samePath(await realpath(file), file)) throw new Error('来源读取期间发生变化，未消费本文件。');
      if (expectedHash && sha(bytes) !== expectedHash) throw new Error('来源批次 SHA256 不匹配，未消费。');
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
      catch { throw new Error('来源不是有效 UTF-8 JSON。'); }
      return parsed;
    } finally { await handle.close(); }
  }
}

async function descriptors(files: InputFiles): Promise<Descriptor[]> {
  let index: ObjectValue = {};
  try {
    const value = await files.json('index.json', files.bounds.maxIndexBytes);
    if (!object(value)) throw new Error('事务总索引须为对象。'); index = value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const result = new Map<string, Descriptor>();
  const add = (value: unknown) => {
    if (!object(value) || typeof value.manifest !== 'string') return;
    const manifest = value.manifest.replaceAll('\\', '/');
    const site = short(value.site ?? value.source ?? value.id, 100) ?? manifest.split('/')[1] ?? 'unknown';
    const id = short(value.id, 100) ?? site;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new Error('事务来源 ID 无效。');
    result.set(manifest, { id, site, label: short(value.label ?? value.name, 100) ?? site, manifest, timezone: short(value.timezone ?? index.timezone, 100), health: short(value.health, 4096) });
  };
  if (Array.isArray(index.sources)) index.sources.forEach(add);
  if (object(index.consumer) && Array.isArray(index.consumer.batch_sources)) for (const entry of index.consumer.batch_sources) {
    if (!object(entry) || typeof entry.manifest !== 'string' || result.has(entry.manifest.replaceAll('\\', '/'))) continue; add(entry);
  }
  // New platforms use the same envelope: one ordinary sources/<platform>/data.json.
  try {
    const directory = await opendir(await files.path('sources', 'directory')); let count = 0;
    try {
      for await (const entry of directory) {
        files.check(); if (++count > files.bounds.maxSources * 4) throw new Error('事务来源目录项过多。');
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(entry.name)) continue;
        const manifest = `sources/${entry.name}/data.json`;
        if (!result.has(manifest)) add({ site: entry.name, manifest });
      }
    } finally { /* for-await closes the directory on completion or error. */ }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (result.size > files.bounds.maxSources) throw new Error('事务来源数量超过上限。');
  if (!result.size) throw new Error('事务入口尚未登记任何可读取的来源。');
  const ids = new Set<string>();
  return [...result.values()].map(d => {
    if (ids.has(d.id)) d.id = `${d.id.slice(0,80)}-${sha(d.manifest).slice(0,12)}`;
    ids.add(d.id); return d;
  });
}

function metadata(record: ObjectValue): Pick<TransactionRecord, 'conversation' | 'actor' | 'role' | 'kind' | 'metadata' | 'warnings'> {
  const data = object(record.data) ? record.data : {};
  const sender = object(data.sender) ? data.sender : object(data.author) ? data.author : {};
  const details: NonNullable<TransactionRecord['metadata']> = {};
  for (const key of ['title', 'show_title', 'long_title', 'bvid', 'uri', 'duration', 'progress', 'progress_semantics', 'source_is_finish', 'subtitle_fetched', 'video_content_fetched', 'text_status']) {
    const value = data[key]; if (typeof value === 'string') details[key] = value.slice(0, 500); else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') details[key] = value as number | boolean;
  }
  if (typeof data.author === 'string') details.author = data.author.slice(0, 200);
  if (Array.isArray(data.attachments)) details.attachmentReferences = data.attachments.length;
  if (object(data.reply)) {
    const reply = short(data.reply.id ?? data.reply.parent_id ?? data.reply.root_id, 200);
    if (reply) details.replyTo = reply;
  }
  const warnings = Array.isArray(data.parse_warnings) ? data.parse_warnings.filter((v): v is string => typeof v === 'string').slice(0, 8).map(v => v.slice(0, 200)) : [];
  return {
    ...(short(data.chat_name ?? data.conversation_title, 200) ? { conversation: short(data.chat_name ?? data.conversation_title, 200) } : {}),
    ...(short(sender.name ?? sender.id, 200) ? { actor: short(sender.name ?? sender.id, 200) } : {}),
    ...(short(data.role ?? sender.role, 40) ? { role: short(data.role ?? sender.role, 40) } : {}),
    ...(short(data.record_kind, 100) ? { kind: short(data.record_kind, 100) } : {}),
    ...(Object.keys(details).length ? { metadata: details } : {}), ...(warnings.length ? { warnings } : {}),
  };
}
function isInternal(record: ObjectValue, site: string): boolean {
  if (!/^(?:chatgpt|gpt|openai)$/i.test(site)) return false;
  const d = object(record.data) ? record.data : {}, a = object(d.author) ? d.author : {};
  const role = String(d.role ?? a.role ?? '');
  if (role && !['user', 'assistant'].includes(role)) return true;
  if (typeof d.channel === 'string' && ['analysis', 'justify', 'confidence', 'summary'].includes(d.channel)) return true;
  return /(?:tool|internal|empty|reasoning|progress|event)/i.test(String(d.record_kind ?? ''))
    || /^(?:thoughts|reasoning_recap|computer_output|execution_output|system_error)$/i.test(String(d.content_type ?? ''));
}

class SourceReader {
  readonly snapshot: TransactionSourceSnapshot;
  readonly original: TransactionSourcePosition;
  readonly current: TransactionSourcePosition;
  refs: BatchRef[] = []; index = 0; batch?: LoadedBatch; more = false; stopped = false;
  failed = false;
  private revisionCount: number;
  constructor(readonly descriptor: Descriptor, readonly files: InputFiles, saved: unknown, readonly start: number, readonly end: number) {
    this.original = saved === undefined ? { batches: {}, revisions: {} } : position(saved);
    this.current = structuredClone(this.original);
    this.current.publications ??= {};
    this.revisionCount = Object.keys(this.current.revisions).length;
    if (this.revisionCount > files.bounds.maxCursorEntries) throw new Error('事务修订游标超过上限。');
    this.snapshot = { id: descriptor.id, site: descriptor.site, label: descriptor.label, status: 'empty', records: [], coverage: {
      filesRead: 0, rawRecords: 0, selectedRecords: 0, filteredRecords: 0, duplicateRecords: 0, skippedBeforeWindow: 0,
      pendingBatches: 0, unreadRecords: 0, knownUnreadRecords: 0, latestPublishedAt: null, warnings: [],
    } };
  }
  fail(error: unknown): void {
    this.snapshot.status = 'error'; this.snapshot.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.snapshot.records = []; this.snapshot.coverage.selectedRecords = 0; this.stopped = true; this.failed = true;
  }
  async prepare(): Promise<void> {
    const before = this.files.files;
    const value = await this.files.json(this.descriptor.manifest, this.files.bounds.maxManifestBytes);
    this.snapshot.coverage.filesRead += this.files.files - before;
    if (!object(value) || value.schema !== 'cookiesync-delivery-state' || value.version !== 2 || !object(value.items)) throw new Error('不支持的事务来源清单格式。');
    if (this.descriptor.health) {
      const beforeHealth = this.files.files, health = await this.files.json(this.descriptor.health, 16 * 1024);
      this.snapshot.coverage.filesRead += this.files.files - beforeHealth;
      if (!object(health) || health.schema !== 'cookiesync-source-health-v1' || health.version !== 1 || health.source !== this.descriptor.site
        || !['ok','failed','disabled','unknown'].includes(String(health.status))) throw new Error('事务来源健康状态格式或站点不一致。');
      const date = (v: unknown) => { const time = instant(v); return time === null ? null : new Date(time).toISOString(); };
      const code = typeof health.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(health.code) ? health.code : null;
      this.snapshot.health = { status: health.status as NonNullable<TransactionSourceSnapshot['health']>['status'], code,
        checkedAt: date(health.checked_at), observedAt: date(health.observed_at), lastSuccess: date(health.last_success) };
      if (health.status !== 'ok') { this.snapshot.status = 'error'; this.snapshot.error = `来源采集状态 ${String(health.status)}${code ? `（${code}）` : ''}；已有批次仍保留，不能据此判断没有新增。`; }
    }
    const dir = this.descriptor.manifest.replace(/\/[^/]*$/, '');
    const seenRefs = new Set<string>();
    for (const [itemKey, item] of Object.entries(value.items)) {
      if (!object(item) || !Array.isArray(item.batches)) throw new Error('事务来源批次清单无效。');
      if (typeof item.source !== 'string' || item.source !== this.descriptor.site) throw new Error('事务来源站点与登记不一致。');
      const itemId = short(item.item_id, 200) ?? itemKey;
      for (const ref of item.batches) {
        if (!object(ref) || typeof ref.folder !== 'string' || !/^[a-f0-9]{64}$/i.test(String(ref.sha256))) throw new Error('事务批次引用或 SHA256 无效。');
        const folder = ref.folder.replaceAll('\\', '/');
        if (!folder || folder.includes('/') || folder === '.' || folder === '..') throw new Error('事务批次目录须为站内单层相对路径。');
        const hash = String(ref.sha256).toLowerCase(), key = `${sha(itemId).slice(0,16)}:${hash}`;
        if (seenRefs.has(key)) continue; seenRefs.add(key);
        this.refs.push({ key, file: `${dir}/${folder}/records.json`, sha256: hash, itemId, hint: localFolderTime(folder, this.descriptor.timezone), order: this.refs.length });
        if (this.refs.length > this.files.bounds.maxBatchRefs) throw new Error('事务批次引用超过上限。');
      }
    }
    const keys = new Set(this.refs.map(ref => ref.key));
    for (const [key, saved] of Object.entries(this.current.batches)) if (!keys.has(key)) {
      if (saved.next !== -1) throw new Error('尚未消费完成的事务批次已从来源移除。');
      delete this.current.batches[key];
    }
    // Publication-folder timestamps are supplied by the producer in the declared timezone.
    // The exact boundary is always checked against batch.created_at after loading.
    for (const ref of this.refs) if (ref.hint !== null && ref.hint < this.start - 24 * 60 * 60 * 1000) {
      if (!this.current.batches[ref.key]) this.current.batches[ref.key] = { next: -1 };
    }
    this.refs.sort((a, b) => (b.hint ?? 0) - (a.hint ?? 0) || b.order - a.order);
  }
  async next(): Promise<Candidate | null> {
    while (!this.stopped && this.index < this.refs.length) {
      this.files.check(); const ref = this.refs[this.index]!;
      const saved = this.current.batches[ref.key] ??= { next: 0 };
      if (saved.next === -1) { this.index++; this.batch = undefined; continue; }
      if (ref.hint !== null && ref.hint > this.end + 24 * 60 * 60 * 1000) { this.index++; this.batch = undefined; continue; }
      if (!this.batch || this.batch.ref.key !== ref.key) {
        const before = this.files.files, value = await this.files.json(ref.file, this.files.bounds.maxBatchBytes, ref.sha256);
        this.snapshot.coverage.filesRead += this.files.files - before;
        if (!object(value) || !Array.isArray(value.records) || value.records.length > this.files.bounds.maxRecordsPerBatch) throw new Error('事务批次记录格式或数量无效。');
        if (value.source !== this.descriptor.site || value.item_id !== ref.itemId) throw new Error('事务批次来源与清单不一致。');
        const published = instant(value.created_at); if (published === null) throw new Error('事务批次缺少有效发布时间。');
        this.snapshot.coverage.rawRecords += value.records.length;
        if (publicationEnd(value.created_at,published) < this.start) { this.snapshot.coverage.skippedBeforeWindow += value.records.length; saved.next = -1; this.index++; continue; }
        if (published > this.end) { this.index++; continue; }
        if (!this.snapshot.coverage.latestPublishedAt || published > Date.parse(this.snapshot.coverage.latestPublishedAt)) this.snapshot.coverage.latestPublishedAt = new Date(published).toISOString();
        const distinct = new Map<string, { value: ObjectValue; index: number }>();
        value.records.forEach((record, index) => {
          if (!object(record)) throw new Error('事务记录须为对象。');
          if (typeof record.identity !== 'string' || !record.identity || record.identity.length > 1024) throw new Error('事务记录缺少有效稳定 identity。');
          distinct.set(JSON.stringify([record.scope ?? '',record.identity]), { value: record, index });
        });
        this.snapshot.coverage.duplicateRecords += value.records.length - distinct.size;
        const records = [...distinct.values()];
        records.sort((a,b) => (instant(b.value.occurred_at) ?? 0) - (instant(a.value.occurred_at) ?? 0) || a.index - b.index);
        if (saved.next > records.length) throw new Error('事务批次游标越过记录边界。');
        this.batch = { ref, records, published };
      }
      const entry = this.batch.records[saved.next];
      if (!entry) { saved.next = -1; delete saved.textOffset; this.batch = undefined; this.index++; continue; }
      const record = entry.value, identity = short(record.identity, 1024), scope = short(record.scope, 1024) ?? '';
      if (!identity) throw new Error('事务记录缺少稳定 identity。');
      const key = sha(`${ref.itemId}\0${scope}\0${identity}`), revision = short(record.revision,256) ?? sha(JSON.stringify(record));
      const advance = () => {
        if (!(key in this.current.revisions) && ++this.revisionCount > this.files.bounds.maxCursorEntries) throw new Error('事务修订游标超过上限。');
        this.current.revisions[key] = revision; this.current.publications![key] = this.batch!.published; saved.next++; delete saved.textOffset;
        if (saved.next >= this.batch!.records.length) saved.next = -1;
      };
      if (this.current.revisions[key] === revision || (this.current.publications![key] ?? -Infinity) >= this.batch.published) {
        saved.next++; delete saved.textOffset; this.snapshot.coverage.duplicateRecords++; continue;
      }
      const deleted = record.deleted === true || ['retract','delete','deleted'].includes(String(record.operation));
      if (isInternal(record, this.descriptor.site) && !deleted) { advance(); this.snapshot.coverage.filteredRecords++; continue; }
      const data = object(record.data) ? record.data : {};
      let text = typeof record.text === 'string' ? record.text : typeof data.text === 'string' ? data.text : '';
      if (!text && Array.isArray(data.attachments) && data.attachments.length) text = `[无可读正文；${data.attachments.length} 个附件引用]`;
      if (!text && !deleted) { advance(); this.snapshot.coverage.filteredRecords++; continue; }
      if (!text && deleted) text = '[该来源记录已撤回或删除]';
      const offset = saved.textOffset ?? 0;
      if (offset > text.length) throw new Error('事务正文分片游标无效。');
      const occurred = instant(record.occurred_at);
      const output: TransactionRecord = { identity, scope, revision, operation: deleted ? 'retract' : 'upsert',
        occurredAt: occurred === null ? null : new Date(occurred).toISOString(), publishedAt: new Date(this.batch.published).toISOString(), text: '',
        ...metadata(record), source: { file: ref.file, recordIndex: entry.index + 1, itemId: ref.itemId } };
      return { record: output, fullText: text, offset, commit: length => {
        if (offset + length >= text.length) advance(); else saved.textOffset = offset + length;
      } };
    }
    return null;
  }
  finish(): void {
    const pending = this.refs.slice(this.index).filter(ref => this.current.batches[ref.key]?.next !== -1
      && (ref.hint === null || ref.hint <= this.end + 24*60*60*1000));
    const next = this.batch ? this.current.batches[this.batch.ref.key]?.next ?? 0 : 0;
    const known = this.batch && next !== -1 ? Math.max(0, this.batch.records.length - next) : 0;
    const coverage = this.snapshot.coverage;
    coverage.selectedRecords = this.snapshot.records.length; coverage.pendingBatches = pending.length;
    coverage.knownUnreadRecords = known; coverage.unreadRecords = pending.length > (this.batch ? 1 : 0) ? null : known;
    if (!pending.length && !coverage.warnings.length) this.more = false;
    if (this.snapshot.status !== 'error') this.snapshot.status = this.more ? 'partial' : this.snapshot.records.length ? 'ok' : 'empty';
  }
}

/** Freeze bounded source text and a candidate acknowledgement. This function never persists consumption. */
export async function scanTransactionSources(root: string, options: TransactionSourceOptions): Promise<TransactionSourceScan> {
  if (!isAbsolute(root)) throw new Error('事务根目录须为绝对路径。');
  const start = timestamp(options.enabledAt, 'enabledAt'), cutoff = options.cutoff ?? new Date().toISOString(), end = timestamp(cutoff, 'cutoff');
  if (end < start) throw new Error('事务截止时间早于开启时间。');
  const bounds = limits(options.limits), signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted(); const requested = resolve(root), info = await lstat(requested), actual = await realpath(requested);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(requested, actual)) throw new Error('事务根须为普通目录，不得经过链接。');
  const files = new InputFiles(actual, bounds, signal, Date.now() + bounds.timeoutMs);
  const sourceList = await descriptors(files);
  const previous = options.cursor;
  if (previous && (previous.version !== 1 || previous.enabledAt !== options.enabledAt || !object(previous.sources))) throw new Error('事务游标不属于当前开启窗口。');
  const nextCursor: TransactionSourceCursor = previous ? structuredClone(previous) : { version: 1, enabledAt: options.enabledAt, sources: {} };
  const readers = sourceList.map(source => new SourceReader(source, files, previous && Object.hasOwn(previous.sources,source.id) ? previous.sources[source.id] : undefined, start, end));
  for (const reader of readers) {
    try { await reader.prepare(); }
    catch (error) { signal.throwIfAborted(); if (error instanceof ScanBudget) { reader.more = true; reader.stopped = true; reader.snapshot.coverage.warnings.push(error.message); } else reader.fail(error); }
  }
  let count = 0, used = 0;
  const reserve = Math.min(bounds.maxChars / 2, 2000 + readers.length * 1500);
  const available = bounds.maxChars - reserve;
  while (readers.some(reader => !reader.stopped)) {
    let selected = false;
    for (const reader of readers) {
      if (reader.stopped) continue;
      if (count >= bounds.maxRecords || reader.snapshot.records.length >= bounds.maxRecordsPerSource) { reader.more = true; reader.stopped = true; continue; }
      try {
        const candidate = await reader.next();
        if (!candidate) { reader.stopped = true; continue; }
        const rest = candidate.fullText.slice(candidate.offset), remaining = available - used;
        let length = Math.min(rest.length, bounds.maxRecordChars, remaining - JSON.stringify(candidate.record).length - 180);
        if (length < Math.min(128, rest.length)) { reader.more = true; reader.stopped = true; continue; }
        let text = take(rest, Math.max(0, length));
        const output: TransactionRecord = { ...candidate.record, text };
        if (candidate.offset > 0 || text.length < rest.length) output.fragment = { offset: candidate.offset, totalChars: candidate.fullText.length, more: text.length < rest.length };
        // JSON escaping can expand a body; keep the frozen package bounded, without discarding the remainder.
        while (JSON.stringify(output).length > remaining && text.length >= 128) {
          text = take(text, Math.floor(text.length * .8)); output.text = text;
          output.fragment = { offset: candidate.offset, totalChars: candidate.fullText.length, more: true };
        }
        if (!text.length || JSON.stringify(output).length > remaining) { reader.more = true; reader.stopped = true; continue; }
        candidate.commit(text.length); reader.snapshot.records.push(output); used += JSON.stringify(output).length; count++; selected = true;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ScanBudget) { reader.more = true; reader.stopped = true; reader.snapshot.coverage.warnings.push(error.message); }
        else { count -= reader.snapshot.records.length; reader.fail(error); }
      }
    }
    if (!selected && readers.every(reader => reader.stopped)) break;
  }
  for (const reader of readers) {
    reader.finish(); Object.defineProperty(nextCursor.sources,reader.descriptor.id,{value:reader.failed?reader.original:reader.current,enumerable:true,writable:true,configurable:true});
  }
  const body = { version: 1 as const, trust: 'source_material' as const, window: { start: options.enabledAt, end: cutoff }, sources: readers.map(reader => reader.snapshot) };
  const text = JSON.stringify(body);
  if (text.length > bounds.maxChars) throw new Error('事务冻结正文包超过输出上限，未确认任何消费。');
  return { ...body, nextCursor, hasMore: readers.some(reader => reader.more), recordCount: readers.reduce((n,r)=>n+r.snapshot.records.length,0), text };
}
