import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sessionHomePath } from './session-home.js';

function inside(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
function digest(file: string): string {
  const fd = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  try { for (let count; (count = readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, count)); return hash.digest('hex'); }
  finally { closeSync(fd); }
}
function files(root: string, directory = root, output = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), info = lstatSync(path), key = relative(root, path);
    if (info.isSymbolicLink()) output.set(key, 'link:' + readlinkSync(path));
    else if (info.isDirectory()) files(root, path, output);
    else if (info.isFile()) output.set(key, digest(path));
    else throw new Error('助手目录包含不支持的文件类型。');
  }
  return output;
}
function copy(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name), to = join(destination, name), info = lstatSync(from);
    if (info.isSymbolicLink()) symlinkSync(readlinkSync(from), to, process.platform === 'win32' ? 'junction' : 'dir');
    else if (info.isDirectory()) copy(from, to);
    else if (info.isFile()) { copyFileSync(from, to); utimesSync(to, info.atime, info.mtime); }
    else throw new Error('助手目录包含不支持的文件类型。');
  }
}
function remap(path: string, source: string, destination: string): string {
  return inside(source, path) ? join(destination, relative(source, path)) : path;
}
function remapIndex(home: string, source: string, destination: string): void {
  for (const name of readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))) {
    const db = new DatabaseSync(join(home, name));
    try {
      if ((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') throw new Error('助手原生索引完整性检查失败。');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of ['threads', 'rollout_migration_skipped_rollouts']) {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
          const rows = db.prepare(`SELECT rowid AS rid, rollout_path AS path FROM ${table}`).all() as { rid: number; path: string }[];
          const update = db.prepare(`UPDATE ${table} SET rollout_path=? WHERE rowid=?`);
          for (const row of rows) {
            const next = remap(row.path, source, destination);
            if (next !== row.path) {
              if (existsSync(row.path) && !existsSync(next)) throw new Error('索引指向的助手历史文件缺失。');
              update.run(next, row.rid);
            }
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
  }
}
function pruneDiagnosticLogs(home: string): number {
  let removed = 0;
  for (const name of readdirSync(home).filter(name => /^logs_\d+\.sqlite$/.test(name))) {
    const file = join(home, name), db = new DatabaseSync(file, { readOnly: true });
    let diagnostic = false;
    try {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      diagnostic = names.some(row => row.name === 'logs') && names.every(row => ['logs', 'sqlite_sequence', '_sqlx_migrations'].includes(row.name));
    } finally { db.close(); }
    if (!diagnostic) continue;
    for (const suffix of ['', '-wal', '-shm']) {
      const path = file + suffix;
      if (existsSync(path)) { removed += lstatSync(path).size; unlinkSync(path); }
    }
  }
  return removed;
}

/** Caller must drain/stop this data root's bridge or executor before applying. */
export function migrateSessionHomes(dataRoot: string, userHome: string, apply = false): { source: string; destination: string; migrated: boolean; diagnosticBytesRemoved: number }[] {
  const root = resolve(dataRoot), report = [];
  for (const kind of ['worker', 'preset'] as const) for (const agent of ['codex', 'claude'] as const) {
    const legacy = join(root, `${kind}-homes`, agent);
    if (!existsSync(legacy)) continue;
    if (lstatSync(legacy).isSymbolicLink()) throw new Error('旧助手目录不能是链接。');
    for (const id of readdirSync(legacy)) {
      const source = join(legacy, id);
      if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error('旧助手目录包含非普通目录。');
      const destination = sessionHomePath(root, userHome, kind, agent, id);
      if (!apply) { report.push({ source, destination, migrated: false, diagnosticBytesRemoved: 0 }); continue; }
      const marker = join(destination, 'migration-incomplete');
      if (existsSync(destination)) {
        if (!existsSync(marker) || readFileSync(marker, 'utf8') !== source) throw new Error('用户目录已存在，未覆盖。');
        // A failed copy can be rebuilt only while the exact original still exists.
        if (!inside(userHome, destination) || lstatSync(destination).isSymbolicLink()) throw new Error('迁移目标越界。');
        rmSync(destination, { recursive: true });
      }
      mkdirSync(destination, { recursive: true });
      writeFileSync(marker, source, { flag: 'wx', mode: 0o600 });
      const before = files(source);
      copy(source, destination);
      const copied = files(destination); copied.delete('migration-incomplete');
      const unchanged = files(source);
      if (before.size !== copied.size || before.size !== unchanged.size
        || [...before].some(([name, hash]) => copied.get(name) !== hash || unchanged.get(name) !== hash)) throw new Error('助手文件校验不一致，旧目录仍保留。');
      remapIndex(destination, source, destination);
      const diagnosticBytesRemoved = pruneDiagnosticLogs(destination);
      writeFileSync(join(destination, 'migration-verified'), source, { mode: 0o600 });
      // The copy is verified before retiring the source, and credentials/configs are never interpreted or rewritten.
      if (!inside(root, source) || lstatSync(source).isSymbolicLink() || realpathSync(source) !== resolve(source)) throw new Error('旧目录清理目标越界。');
      rmSync(source, { recursive: true });
      unlinkSync(marker);
      report.push({ source, destination, migrated: true, diagnosticBytesRemoved });
      writeFileSync(join(root, 'session-home-migration.json'), JSON.stringify({ version: 1, homes: report }, null, 2), { mode: 0o600 });
    }
    if (apply && !readdirSync(legacy).length) {
      rmSync(legacy, { recursive: true });
      const parent = dirname(legacy);
      if (!readdirSync(parent).length) rmSync(parent, { recursive: true });
    }
  }
  return report;
}
