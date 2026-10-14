import { createServer } from 'node:net';
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { remoteEndpoint } from './remote/daemon.js';
import { fingerprint } from './remote/store.js';
import { migrateValue } from './profile-migration.js';

/** Offline, one-time ownership migration for registered execution machines. */
export async function migrateRemoteData(root: string, applicationId: string): Promise<string> {
  root = resolve(root);
  if (!/^\d{15,22}$/.test(applicationId)) throw new Error('原 bot 的 applicationId 无效。');
  const guard = createServer(socket => socket.destroy());
  await new Promise<void>((done, fail) => { guard.once('error', fail); guard.listen(remoteEndpoint(root), done); }).catch(() => { throw new Error('远端执行器仍在运行，先停止再迁移。'); });
  const directory = join(root, '.local', 'remote'), target = join(directory, 'controller.sqlite');
  const saved: string[] = []; let installed = false;
  const backupDir = join(directory, 'backups', 'semantic-v2-' + randomUUID()), staged = join(backupDir, 'staged.sqlite');
  try {
    if (existsSync(join(directory, 'semantic-version.json'))) throw new Error('远端数据已完成语义迁移。');
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(target)) {
      const source = new DatabaseSync(target, { readOnly: true }); try { await backup(source, staged); } finally { source.close(); }
      const db = new DatabaseSync(staged);
      try {
        if (db.prepare("SELECT data FROM jobs").all().some(row => JSON.parse(String(row.data)).status === 'running')) throw new Error('远端还有运行状态的任务，未迁移。');
        db.exec('BEGIN IMMEDIATE');
        const prefix = 'discord:' + applicationId + '|';
        for (const table of ['jobs', 'native_session_adoptions']) {
          const column = table === 'jobs' ? 'request' : 'result_json';
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
          for (const row of db.prepare(`SELECT rowid AS migration_row_id,${column} value FROM ${table}`).all()) {
            const value = migrateValue(JSON.parse(String(row.value)), prefix, root, root);
            db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(JSON.stringify(value), row.migration_row_id!);
            if (table === 'jobs') db.prepare('UPDATE jobs SET fingerprint=? WHERE rowid=?').run(fingerprint(value), row.migration_row_id!);
          }
        }
        for (const table of ['sessions', 'native_session_leases']) {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            db.prepare(`UPDATE ${table} SET user_id=? || user_id WHERE user_id <> '' AND user_id NOT GLOB '*[^0-9]*'`).run(prefix);
        }
        if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('远端迁移完整性检查失败。');
        db.exec('COMMIT; PRAGMA journal_mode=DELETE');
      } finally { db.close(); }
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(target + suffix)) { renameSync(target + suffix, join(backupDir, 'original.sqlite' + suffix)); saved.push(suffix); }
      renameSync(staged, target); installed = true;
    }
    writeFileSync(join(directory, 'semantic-version.json'), JSON.stringify({ version: 2, applicationId, migratedAt: new Date().toISOString(), backupDir }), { flag: 'wx' });
    return backupDir;
  } catch (error) {
    if (installed) renameSync(target, staged);
    for (const suffix of saved.reverse()) renameSync(join(backupDir, 'original.sqlite' + suffix), target + suffix);
    throw error;
  } finally { guard.close(); }
}
export function ensureRemoteSemanticData(root: string): void {
  const directory = join(resolve(root), '.local', 'remote'), marker = join(directory, 'semantic-version.json');
  if (existsSync(marker)) {
    const value = JSON.parse(readFileSync(marker, 'utf8'));
    if (value.version !== 2) throw new Error('远端数据语义版本无效。'); return;
  }
  if (existsSync(join(directory, 'controller.sqlite'))) throw new Error('远端旧归属尚未完成离线迁移，拒绝启动。');
  mkdirSync(directory, { recursive: true }); writeFileSync(marker, JSON.stringify({ version: 2, createdAt: new Date().toISOString() }), { flag: 'wx' });
}
