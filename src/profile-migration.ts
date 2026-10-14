import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { fetch, ProxyAgent } from 'undici';
import { readJson } from './profiles.js';
import { acquireInstanceLock } from './instance-lock.js';

const databases = ['bridge.sqlite', 'ingress.sqlite', 'controller.sqlite', 'tasks.sqlite', 'native-session-leases.sqlite'];
const scalarRoutes = new Set(['user_id', 'channel_id', 'source_message_id', 'userId', 'channelId', 'sourceMessageId', 'originMessageId']);
const pathKeys = new Set(['cwd', 'rollout_path', 'registryDir', 'helperPath', 'nodePath', 'contextPath', 'ticketPath', 'ticket_path', 'completionFile', 'exitFile', 'resultFile', 'sshConfig', 'home', 'transcriptPath', 'imagePaths', 'images_json', 'attachmentPaths', 'command', 'workspace', 'dataDir', 'logsDir', 'attachmentsDir']);
/** Change structural routes and owned paths, preserving text, native IDs and receipt tokens. */
export function migrateValue(value: unknown, prefix: string, oldRoot: string, newRoot: string, key = ''): unknown {
  if (typeof value === 'string') {
    if (scalarRoutes.has(key) || key === 'messageIds') return /^\d+$/.test(value) ? prefix + value : value;
    if (pathKeys.has(key) || key === 'args') return relocate(value, oldRoot, newRoot);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => migrateValue(item, prefix, oldRoot, newRoot, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, migrateValue(item, prefix, oldRoot, newRoot, name)]));
  return value;
}
function relocate(path: string, oldRoot: string, newRoot: string): string {
  if (!isAbsolute(path)) return path;
  const suffix = relative(oldRoot, path);
  return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix) ? join(newRoot, suffix) : path;
}
function migrateDatabase(path: string, prefix: string, oldRoot: string, newRoot: string, routes = true): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    for (const entry of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const table = String(entry.name); if (!/^[a-z_]+$/.test(table)) throw new Error('迁移遇到未知表名。');
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(item => String(item.name));
      for (const column of columns) {
        const messageId = ['inbox', 'messages'].includes(table) && column === 'id' || table === 'channels' && column === 'cursor';
        if (routes && (scalarRoutes.has(column) || messageId)) {
          db.prepare(`UPDATE ${table} SET ${column}=? || ${column} WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT GLOB '*[^0-9]*'`).run(prefix);
        } else if (routes && column.endsWith('_json') && column !== 'attachments_json') {
          for (const row of db.prepare(`SELECT rowid AS migration_row_id,${column} value FROM ${table} WHERE ${column} IS NOT NULL`).all()) {
            const migrated = migrateValue(JSON.parse(String(row.value)), prefix, oldRoot, newRoot, column);
            db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(JSON.stringify(migrated), row.migration_row_id!);
          }
        } else if (pathKeys.has(column)) {
          for (const row of db.prepare(`SELECT rowid AS migration_row_id,${column} value FROM ${table} WHERE ${column} IS NOT NULL`).all()) {
            db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(relocate(String(row.value), oldRoot, newRoot), row.migration_row_id!);
          }
        }
      }
    }
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('迁移后数据库完整性检查失败。');
    db.exec('COMMIT'); db.exec('PRAGMA journal_mode=DELETE');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
async function discordIdentity(raw: Record<string, unknown>): Promise<string> {
  const proxy = raw.proxyPort == null ? undefined : new ProxyAgent(`http://127.0.0.1:${raw.proxyPort}`);
  try {
    const response = await fetch('https://discord.com/api/v10/applications/@me', {
      headers: { Authorization: `Bot ${raw.token}` }, signal: AbortSignal.timeout(15_000), ...(proxy ? { dispatcher: proxy } : {}),
    });
    const result = await response.json() as { id?: string };
    if (!response.ok || !/^\d{15,22}$/.test(result.id ?? '')) throw new Error('无法验证原 Discord 机器人的真实身份，未迁移数据。');
    return result.id!;
  } finally { await proxy?.close(); }
}
export interface MigrationOptions { newRoot?: string; resolveIdentity?: (raw: Record<string, unknown>) => Promise<string> }
export async function migrateProject(configPath: string, options: MigrationOptions = {}): Promise<{ backupDir: string; applicationId: string }> {
  configPath = resolve(configPath);
  const local = dirname(configPath), oldRoot = dirname(local), newRoot = resolve(options.newRoot ?? oldRoot);
  const bytes = readFileSync(configPath), raw = readJson(configPath);
  if (raw.version === 2) throw new Error('配置已完成语义迁移，无需再次迁移。');
  if (typeof raw.token !== 'string' || !raw.token || !Array.isArray(raw.allowedUserIds) || !raw.allowedUserIds.length || raw.allowedUserIds.some(id => typeof id !== 'string' || !/^\d{15,22}$/.test(id))) throw new Error('原 Discord 配置无效。');
  const dataDir = raw.dataDir == null ? join(local, 'data') : resolve(oldRoot, String(raw.dataDir));
  const pidPath = join(dataDir, 'bridge.pid.json');
  if (existsSync(pidPath)) {
    const pid = Number(readJson(pidPath).pid); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('桥进程标识无效，先核实停止状态。');
    try { process.kill(pid, 0); throw new Error('桥仍在运行，请先正常停止，再进行离线迁移。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  if (!existsSync(join(dataDir, 'disabled'))) throw new Error('先用 stop.ps1 停用监督进程，再进行离线迁移。');
  const lock = await acquireInstanceLock(oldRoot, dataDir);
  const changes: { target: string; staged: string; saved: string; installed?: boolean; moved?: boolean }[] = [];
  try {
    const applicationId = await (options.resolveIdentity ?? discordIdentity)(raw);
    if (!/^\d{15,22}$/.test(applicationId)) throw new Error('机器人身份无效。');
    const prefix = `discord:${applicationId}|`, backupDir = join(local, 'backups', `semantic-v2-${randomUUID()}`);
    mkdirSync(backupDir, { recursive: true });
    const stage = join(backupDir, 'staged'); mkdirSync(stage);
    const stageFile = (target: string, content: string | Buffer) => {
      const id = String(changes.length), staged = join(stage, id), saved = join(backupDir, id);
      writeFileSync(staged, content, { flag: 'wx', mode: 0o600 }); changes.push({ target, staged, saved });
    };
    const targets = databases.map(name => ({ target: join(dataDir, name), routes: true }));
    const homes = join(dataDir, 'controller-homes', 'codex');
    if (existsSync(homes)) for (const id of readdirSync(homes).filter(name => /^[a-f0-9-]{36}$/i.test(name))) {
      const home = join(homes, id);
      for (const name of readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))) targets.push({ target: join(home, name), routes: false });
    }
    for (const { target, routes } of targets) {
      if (!existsSync(target)) continue;
      const name = `database-${changes.length}`, staged = join(stage, name), source = new DatabaseSync(target, { readOnly: true });
      try { await backup(source, staged); } finally { source.close(); }
      migrateDatabase(staged, prefix, oldRoot, newRoot, routes);
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(target + suffix)) changes.push({ target: target + suffix, staged: suffix ? '' : staged, saved: join(backupDir, name + suffix) });
    }
    for (const folder of ['contexts', 'tickets']) {
      const directory = join(dataDir, folder); if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory).filter(name => /^[a-f0-9-]+\.json$/i.test(name))) {
        const target = join(directory, file); stageFile(target, JSON.stringify(migrateValue(readJson(target), prefix, oldRoot, newRoot)) + '\n');
      }
    }
    const botPath = join(local, 'bots', 'discord', 'default.json');
    if (existsSync(botPath)) throw new Error('discord/default 已存在，未覆盖配置。');
    const common = migrateValue(raw, prefix, oldRoot, newRoot) as Record<string, unknown>;
    for (const key of ['token', 'applicationId', 'allowedUserIds', 'appSecret', 'appId']) delete common[key];
    Object.assign(common, { version: 2, startupProfile: 'discord/default', platformProfiles: { discord: 'discord/default', feishu: 'feishu/default' } });
    stageFile(botPath, JSON.stringify({ platform: 'discord', applicationId, token: raw.token, allowedUserIds: raw.allowedUserIds,
      features: { reactions: true, nativeCommands: true, presence: true } }, null, 2) + '\n');
    const eol = bytes.toString('utf8').includes('\r\n') ? '\r\n' : '\n', bom = bytes.subarray(0, 3).equals(Buffer.from([239,187,191])) ? '\uFEFF' : '';
    stageFile(configPath, bom + (JSON.stringify(common, null, 2) + '\n').replace(/\n/g, eol));
    stageFile(join(dataDir, 'semantic-version.json'), JSON.stringify({ version: 2, migratedAt: new Date().toISOString(), applicationId, oldRoot, newRoot }) + '\n');
    if (!readFileSync(configPath).equals(bytes)) throw new Error('原配置在迁移准备期间被修改，已取消。');
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({ version: 2, oldRoot, newRoot, files: changes.map(({ target, saved }) => ({ target, saved })) }, null, 2));
    for (const change of changes) {
      mkdirSync(dirname(change.target), { recursive: true });
      if (existsSync(change.target)) { renameSync(change.target, change.saved); change.moved = true; }
      if (change.staged) { renameSync(change.staged, change.target); change.installed = true; }
    }
    return { backupDir, applicationId };
  } catch (error) {
    for (const change of [...changes].reverse()) {
      if (change.installed && existsSync(change.target)) unlinkSync(change.target);
      if (change.moved) renameSync(change.saved, change.target);
    }
    throw error;
  } finally { lock.close(); }
}
/** Old data is never interpreted at startup; fresh projects use the same semantic version. */
export function ensureSemanticData(dataDir: string): void {
  const path = join(dataDir, 'semantic-version.json');
  if (existsSync(path)) { if (readJson(path).version !== 2) throw new Error('数据语义版本无效。'); return; }
  if (databases.some(name => existsSync(join(dataDir, name)))) throw new Error('现有数据尚未完成离线语义迁移，拒绝启动。');
  writeFileSync(path, JSON.stringify({ version: 2, createdAt: new Date().toISOString() }), { flag: 'wx' });
}
