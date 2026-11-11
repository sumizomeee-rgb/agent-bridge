import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { sessionHomePath } from './session-home.js';

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function inside(root: string, path: string): boolean { const part = relative(root, path); return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); }
function same(a: unknown, b: unknown): boolean { return a instanceof Uint8Array && b instanceof Uint8Array ? Buffer.from(a).equals(Buffer.from(b)) : a === b; }
function normalPath(path: string): string {
  return process.platform === 'win32' ? path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '') : path;
}

/** Preserve byte offsets used by the paginated history projection. */
export function nativeRolloutBytes(bytes: Buffer, source: 'mcp' | 'cli'): Buffer {
  const end = bytes.indexOf(10), first = bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
  let value: { type?: string; payload?: { source?: unknown } };
  try { value = JSON.parse(first); } catch { throw new Error('原生会话头损坏，未迁移。'); }
  if (value.type !== 'session_meta' || typeof value.payload?.source !== 'string') return bytes;
  const replacement = JSON.stringify(source);
  const next = first.replace(/("source"\s*:\s*)("(?:[^"\\]|\\.)*")/, (_, key: string, old: string) => {
    if (old.length < replacement.length) throw new Error('会话来源字段无法保持原生字节偏移，未迁移。');
    return key + replacement + ' '.repeat(old.length - replacement.length);
  });
  const output = Buffer.concat([Buffer.from(next), bytes.subarray(end < 0 ? bytes.length : end)]);
  if (output.length !== bytes.length) throw new Error('会话来源转换改变了历史字节偏移。');
  return output;
}

function mergeFiles(source: string, destination: string, transform: (path: string, bytes: Buffer) => Buffer, evidence: Map<string, string>, path = source): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    if (resolve(realpathSync(path)).toLowerCase() !== resolve(destination).toLowerCase()) throw new Error('历史目录存在未知链接，未迁移。');
    return;
  }
  const target = path === source ? destination : join(destination, relative(source, path));
  if (stat.isDirectory()) { mkdirSync(target, { recursive: true }); for (const name of readdirSync(path)) mergeFiles(source, destination, transform, evidence, join(path, name)); return; }
  if (!stat.isFile()) throw new Error('历史包含未知文件类型。');
  mkdirSync(dirname(target), { recursive: true });
  const before = readFileSync(path), next = transform(path, before);
  if (existsSync(target)) { if (!readFileSync(target).equals(next)) throw new Error(`原生历史文件冲突，未覆盖：${target}`); }
  else { const temporary = target + '.bridge-migration'; writeFileSync(temporary, next, { flag: 'wx' }); renameSync(temporary, target); }
  if (!readFileSync(target).equals(next) || !readFileSync(path).equals(before)) throw new Error('历史复制校验失败。');
  evidence.set(path, hash(before));
}

const runtimeTables = new Set(['sqlite_sequence', 'backfill_state', 'rollout_migration_state', 'rollout_migration_skipped_rollouts', 'jobs', 'consolidation_progress', 'remote_control_enrollments', 'external_agent_config_imports']);
async function mergeDatabase(source: string, destination: string, oldHomes: string[], nativeHome: string, visibility: 'hidden' | 'visible', checked: Set<string>): Promise<number> {
  const old = new DatabaseSync(source, { readOnly: true });
  try {
    if (old.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('原生源数据库损坏。');
    const target = new DatabaseSync(destination);
    try {
      if (!checked.has(destination)) {
        if (target.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('原生目标数据库校验失败。');
        checked.add(destination);
      }
      target.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
      let threads = 0;
      try {
        const tables = old.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all() as { name: string; sql: string }[];
        const created = new Set<string>();
        for (const { name, sql } of tables) {
          if (name === 'sqlite_sequence') continue;
          if (!target.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) { target.exec(sql); created.add(name); }
        }
        for (const index of old.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL").all()) {
          if (created.has(String(index.tbl_name))) target.exec(String(index.sql));
        }
        for (const { name } of tables) {
          if (runtimeTables.has(name)) continue;
          const columns = old.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string; pk: number }[];
          const targetColumns = new Set((target.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map(c => c.name));
          if (columns.some(c => !targetColumns.has(c.name))) throw new Error(`原生数据库版本不兼容：${name}`);
          let keys = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
          if (!keys.length) throw new Error(`历史表缺少稳定主键：${name}`);
          let names = columns.map(c => c.name);
          if (name === 'queued_thread_revisions') { names = names.filter(n => n !== 'revision'); keys = ['thread_id']; }
          const get = target.prepare(`SELECT * FROM ${quote(name)} WHERE ${keys.map(k => quote(k) + '=?').join(' AND ')}`);
          const insert = target.prepare(`INSERT INTO ${quote(name)} (${names.map(quote).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
          for (const row of old.prepare(`SELECT * FROM ${quote(name)}`).all()) {
            if (name === 'threads') {
              const path = normalPath(String(row.rollout_path));
              const oldHome = oldHomes.find(home => inside(normalPath(home), path));
              row.rollout_path = oldHome ? join(nativeHome, relative(normalPath(oldHome), path)) : path;
              if (typeof row.source === 'string' && ['vscode', 'cli', 'exec', 'mcp', 'unknown'].includes(row.source)) row.source = visibility === 'hidden' ? 'mcp' : 'cli';
              if (!existsSync(String(row.rollout_path))) {
                const suffix = path.replaceAll('\\', '/').match(/\/(sessions|archived_sessions)\/(.+\.jsonl)$/);
                const safe = suffix && !suffix[2]!.split('/').some(p => p === '..' || p === '.' || !p);
                const currentSource = safe ? join(oldHomes[0]!, suffix[1]!, ...suffix[2]!.split('/')) : path;
                const recovered = safe ? join(nativeHome, suffix[1]!, ...suffix[2]!.split('/')) : null;
                if (recovered && existsSync(recovered) && basename(recovered).includes(String(row.id))) row.rollout_path = recovered;
                else if (existsSync(path) || existsSync(currentSource)) throw new Error(`原生正文复制后缺失：${row.id} ${row.rollout_path}`);
                // Failed starts, retired summaries and deleted test fixtures can
                // leave stale indexes. Preserve those existing records and their
                // projection data; do not invent a transcript that never survived.
              }
              threads++;
            }
            const found = get.get(...keys.map(k => row[k] as SQLInputValue));
            if (found) {
              // Migration timestamps are bookkeeping; migration definitions must agree.
              const compare = name === '_sqlx_migrations' ? ['version', 'checksum', 'success'] : names;
              if (compare.some(k => !same(found[k], row[k]))) throw new Error(`原生数据库主键冲突，未覆盖：${name}`);
            } else insert.run(...names.map(k => row[k] as SQLInputValue));
          }
        }
        target.exec('COMMIT');
        return threads;
      } catch (error) { if (target.isTransaction) target.exec('ROLLBACK'); throw error; }
    } finally { target.close(); }
  } finally { old.close(); }
}

/** Offline only: native applications and this data root's workers must be stopped. */
export async function migrateNativeSessionHomes(dataRoot: string, userHome: string, apply = false) {
  const report: { home: string; agent: string; files: number; threads: number; migrated: boolean }[] = [];
  const checked = new Set<string>();
  const pending: { home: string; marker: string; location: Record<string, unknown>; evidence: Map<string, string>; record: typeof report[number] }[] = [];
  const journal = join(dataRoot, 'native-session-migration.json');
  if (apply) { mkdirSync(dataRoot, { recursive: true }); writeFileSync(journal, JSON.stringify({ version: 2, complete: false, homes: report }), { mode: 0o600 }); }
  for (const agent of ['codex', 'claude'] as const) for (const kind of ['worker', 'preset'] as const) {
    const parent = dirname(sessionHomePath(dataRoot, userHome, kind, agent, 'probe'));
    if (!existsSync(parent)) continue;
    for (const id of readdirSync(parent)) {
      const home = join(parent, id), marker = join(home, 'session-location.json');
      // Old preset registrations predate explicit visibility; those were hidden.
      const profileHome = join(userHome, agent === 'codex' ? '.codex' : '.claude');
      const location = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8'))
        : { version: 1, visibility: 'hidden', profileHome, sqliteHome: profileHome };
      if (location.version === 2) continue;
      if (location.version !== 1 || !['hidden', 'visible'].includes(location.visibility) || !isAbsolute(location.profileHome) || !isAbsolute(location.sqliteHome)) throw new Error('助手历史目录登记无效。');
      if (!inside(resolve(userHome), home) || lstatSync(home).isSymbolicLink()) throw new Error('助手历史清理路径越界。');
      const disposableDirectories = new Set(['plugins', 'skills', 'agents', 'commands', 'hooks', 'rules', 'output-styles', 'tmp', '.tmp', 'thread-writer-locks', 'backups', 'cache', 'debug', 'state', 'sessions']);
      const nativeDirectories = new Set(['sessions', 'archived_sessions', 'shell_snapshots', 'projects', 'session-env', 'file-history', 'todos', 'tasks', 'plans', 'shell-snapshots']);
      const metadata = new Set(['session-location.json', 'preset-binding.json', 'migration-verified', 'migration-incomplete', 'profile-ready', 'auth.json', 'config.toml', 'AGENTS.md', 'instructions.md', 'models_cache.json', 'installation_id', '.sandbox_migration', '.sqlite-maintenance.lock', '.claude.json', '.credentials.json', 'settings.json', 'settings.local.json', '.last-cleanup']);
      for (const name of readdirSync(home)) {
        if (!metadata.has(name) && !nativeDirectories.has(name) && !disposableDirectories.has(name)
          && !/^(?:state|thread_history|goals|queue|memories|logs)_\d+\.sqlite(?:-wal|-shm)?$/.test(name) && !/^[A-Za-z0-9_.-]+\.config\.toml$/.test(name)) {
          throw new Error(`旧助手目录包含未分类文件，未清理：${join(home, name)}`);
        }
      }
      if (!apply) { report.push({ home, agent, files: 0, threads: 0, migrated: false }); continue; }
      const native = resolve(location.profileHome), sqlite = resolve(location.sqliteHome);
      if (native === resolve(home) || inside(home, native) || sqlite === resolve(home) || inside(home, sqlite)) throw new Error('原生目标目录指向旧助手目录。');
      mkdirSync(native, { recursive: true }); mkdirSync(sqlite, { recursive: true });
      const evidence = new Map<string, string>();
      const directories = agent === 'codex' ? ['sessions', 'archived_sessions', 'shell_snapshots']
        : ['session-env', 'file-history', 'todos', 'tasks', 'plans', 'shell-snapshots'];
      for (const name of directories) mergeFiles(join(home, name), join(native, name), (path, bytes) =>
        agent === 'codex' && path.endsWith('.jsonl') ? nativeRolloutBytes(bytes, location.visibility === 'hidden' ? 'mcp' : 'cli') : bytes, evidence);
      if (agent === 'claude' && existsSync(join(home, 'projects'))) {
        const projects = join(home, 'projects');
        if (lstatSync(projects).isSymbolicLink()) mergeFiles(projects, join(native, 'projects'), (_, bytes) => bytes, evidence);
        else for (const project of readdirSync(projects)) {
          const directory = join(projects, project);
          if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Claude 项目历史包含未知链接或文件。');
          for (const entry of readdirSync(directory)) {
            // Old workers had independent auto-memory. Preserve those files without
            // replacing or auto-loading them as the ordinary user's current memory.
            const destination = entry === 'memory' ? join(native, 'projects', project, 'memory', 'bridge-imports', basename(dirname(parent)), `${kind}-${id}`)
              : entry === 'sessions-index.json' ? join(native, 'projects', project, 'bridge-imports', basename(dirname(parent)), `${kind}-${id}`, entry)
              : join(native, 'projects', project, entry);
            mergeFiles(join(directory, entry), destination, (_, bytes) => bytes, evidence);
          }
        }
      }
      let threads = 0;
      const oldHomes = [home, join(dataRoot, `${kind}-homes`, agent, id)];
      const audit = join(home, 'migration-verified');
      if (existsSync(audit)) {
        const previous = readFileSync(audit, 'utf8');
        if (isAbsolute(previous) && previous.replaceAll('\\', '/').endsWith(`/${kind}-homes/${agent}/${id}`)) oldHomes.push(previous);
      }
      if (agent === 'codex') for (const name of readdirSync(home).filter(n => /^(?:state|thread_history|goals|queue|memories)_\d+\.sqlite$/.test(n))) {
        threads += await mergeDatabase(join(home, name), join(sqlite, name), oldHomes, native, location.visibility, checked);
      }
      const record = { home, agent, files: evidence.size, threads, migrated: false };
      report.push(record); pending.push({ home, marker, location, evidence, record });
      writeFileSync(journal, JSON.stringify({ version: 2, complete: false, homes: report }), { mode: 0o600 });
    }
  }
  // Check each shared database once per batch, not once for every old worker.
  // Keep all remaining sources until the entire batch passes verification.
  for (const path of checked) {
    const db = new DatabaseSync(path, { readOnly: true });
    try { if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('原生目标数据库校验失败，旧目录保留。'); }
    finally { db.close(); }
  }
  for (const { evidence } of pending) for (const [file, before] of evidence) if (hash(readFileSync(file)) !== before) throw new Error('迁移期间原会话发生变化，旧目录保留。');
  for (const { home, marker, location, record } of pending) {
      const retained = new Set(['session-location.json', 'preset-binding.json']);
      for (const name of readdirSync(home)) if (!retained.has(name)) {
        const path = join(home, name);
        if (!inside(home, path)) throw new Error('旧助手清理路径越界。');
        rmSync(path, { recursive: true, force: true });
      }
      const temporary = marker + '.native'; writeFileSync(temporary, JSON.stringify({ ...location, version: 2 }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, marker);
      record.migrated = true;
      writeFileSync(journal, JSON.stringify({ version: 2, complete: false, homes: report }), { mode: 0o600 });
  }
  if (apply) writeFileSync(journal, JSON.stringify({ version: 2, complete: true, homes: report }, null, 2), { mode: 0o600 });
  return report;
}
