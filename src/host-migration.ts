import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, lstatSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { readJson, selectProfile, profileScope, type BotProfile } from './profiles.js';
import { acquireInstanceLock } from './instance-lock.js';
import type { HostConfig, PrincipalMapping } from './config.js';
import { inspectStoppedExecution, verifyStoppedExecutions, type HostMigrationProofTestHooks, type StoppedExecutionProof } from './host-migration-proof.js';

const databaseNames = ['bridge.sqlite', 'ingress.sqlite', 'controller.sqlite', 'tasks.sqlite', 'native-session-leases.sqlite', 'restart.sqlite'];
export interface MigratedBot {
  botId: string; profile: string; ownerPrincipalId: string | null; ownerUserId: string | null;
  activeConversationId: string | null; dataDir: string; contextWorkspace: string; workingCwd: string;
  conversations: number; tasks: number; schedules: number;
  frozen: { taskIds: string[]; scheduleIds: string[] };
}
export interface HostSemanticMarker { version: 3; status: 'complete' | 'in-progress' | 'restored'; migrationId: string; migratedAt: string; bots: MigratedBot[]; backupDir?: string }
export interface HostMigrationOptions {
  dryRun?: boolean; startupProfiles?: string[];
  /** Explicitly migrate inactive bots, including other platforms, without starting them. */
  includeProfiles?: string[];
  /** 旧本机 uncertain job 的精确只读证明；不能通用跳过迁移阻断。 */
  stoppedExecutionProofs?: string[];
  /** Bot identity -> raw platform account. Multiple active users always require a choice. */
  owners?: Record<string, string>;
  /** Give accounts in different apps the same principal only after verifying their identity. */
  principalIds?: Record<string, string>;
}
export interface HostMigrationPlan { version: 3; dryRun: boolean; sourceDataDir: string; startupProfiles: string[]; registeredProfiles: string[]; bots: MigratedBot[]; warnings: string[]; blockers: string[]; stoppedExecutions: { jobId: string; botId: string; proofSha256: string }[]; backupDir?: string }
type Row = Record<string, string | number | bigint | Uint8Array | null>;
interface Legacy { raw: Record<string, unknown>; profiles: BotProfile[]; startupProfiles: string[]; configPath: string; project: string; dataDir: string; bytes: Buffer; bots: MigratedBot[] }
function local(project: string, value: unknown, fallback: string): string { return resolve(project, String(value ?? fallback)); }
function tableExists(db: DatabaseSync, name: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function databaseRows(dataDir: string, name: string, table: string): Row[] {
  const path = join(dataDir, name); if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try { return tableExists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() : []; } finally { db.close(); }
}
function legacy(configPath: string, options: HostMigrationOptions): Legacy {
  configPath = resolve(configPath); const bytes = readFileSync(configPath), raw = readJson(configPath);
  if (raw.version === 3) throw new Error('宿主配置已完成迁移。');
  if (raw.version !== 2) throw new Error('宿主迁移只接受 version:2；更早配置先完成 Profile 迁移。');
  const project = dirname(dirname(configPath)), dataDir = local(project, raw.dataDir, '.local/data');
  const selected = options.startupProfiles ?? (typeof raw.startupProfile === 'string' ? [raw.startupProfile] : []);
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('迁移启动集合不能为空或重复。');
  const starting = selected.map(name => selectProfile(raw, configPath, name));
  if (starting.some(profile => profile.platform !== starting[0]!.platform)) throw new Error('迁移启动集合必须是同一平台。');
  const included = options.includeProfiles ?? [];
  if (!Array.isArray(included) || included.some(name => typeof name !== 'string') || new Set(included).size !== included.length) throw new Error('includeProfiles 必须是明确且不重复的 Profile 清单。');
  const names = [...new Set([...selected, ...included])];
  const profiles = names.map(name => selectProfile(raw, configPath, name));
  const ids = profiles.map(profile => profileScope(profile).slice(0, -1));
  if (new Set(ids).size !== ids.length) throw new Error('迁移集合包含重复 Bot 身份。');
  const conversations = databaseRows(dataDir, 'bridge.sqlite', 'conversations');
  const active = databaseRows(dataDir, 'bridge.sqlite', 'active_conversations');
  const tasks = databaseRows(dataDir, 'tasks.sqlite', 'tasks');
  const schedules = databaseRows(dataDir, 'controller.sqlite', 'controller_schedules');
  const workspaceSet = new Set<string>();
  const bots = profiles.map((profile, index): MigratedBot => {
    const botId = ids[index]!, scope = profileScope(profile), owned = conversations.filter(row => String(row.user_id).startsWith(scope));
    const current = active.filter(row => String(row.user_id).startsWith(scope));
    const activeUsers = [...new Set(current.map(row => String(row.user_id).slice(scope.length)))];
    if (activeUsers.length > 1 && options.owners?.[botId] == null) throw new Error(`${botId} 有多个活动账号，必须明确指定 owner，不能自动选择最近会话。`);
    const ownerRaw = options.owners?.[botId] ?? activeUsers[0] ?? (profile.allowedUserIds.length === 1 ? profile.allowedUserIds[0] : undefined);
    if (ownerRaw != null && !profile.allowedUserIds.includes(ownerRaw)) throw new Error(`${botId} 的 owner 不在白名单。`);
    const ownerUserId = ownerRaw == null ? null : scope + ownerRaw;
    const principalId = ownerRaw == null ? null : options.principalIds?.[botId] ?? `owner-${index + 1}`;
    if (principalId != null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(principalId)) throw new Error('迁移 principal id 无效。');
    const original = raw.startupProfile === profile.name;
    const contextWorkspace = local(project, profile.workspace ?? (original ? raw.workspace : undefined), join('.local', 'workspaces', profile.platform, profile.applicationId!));
    const key = process.platform === 'win32' ? contextWorkspace.toLowerCase() : contextWorkspace;
    if (workspaceSet.has(key)) throw new Error('多个 Bot 的上下文工作区不能复用。'); workspaceSet.add(key);
    return { botId, profile: profile.name, ownerPrincipalId: principalId, ownerUserId,
      activeConversationId: current.find(row => row.user_id === ownerUserId)?.conversation_id as string | undefined ?? null,
      dataDir: join(dataDir, 'bots', profile.platform, profile.applicationId!), contextWorkspace,
      workingCwd: local(project, profile.workingCwd ?? (original ? raw.workspace : undefined), contextWorkspace),
      conversations: owned.length, tasks: tasks.filter(row => jsonOwner(row.origin_json, scope)).length,
      schedules: schedules.filter(row => jsonOwner(row.value_json, scope)).length,
      frozen: { taskIds: tasks.filter(row => jsonOwner(row.origin_json, scope) && !jsonOwner(row.origin_json, ownerUserId ?? 'no-owner', true)).map(row => String(row.id)),
        scheduleIds: schedules.filter(row => jsonOwner(row.value_json, scope) && !jsonOwner(row.value_json, ownerUserId ?? 'no-owner', true) && row.status === 'pending').map(row => String(row.id)) } };
  });
  const knownScopes = profiles.map(profileScope);
  const unknownUsers = conversations.filter(row => !knownScopes.some(scope => String(row.user_id).startsWith(scope)));
  if (unknownUsers.length) throw new Error('源数据含迁移集合外 Bot 的会话；请用 includeProfiles 明确纳入其 Profile，不能丢弃未归属数据或猜测其他平台身份。');
  return { raw, profiles, startupProfiles: selected, configPath, project, dataDir, bytes, bots };
}
function jsonOwner(value: unknown, scope: string, exact = false): boolean {
  const object = typeof value === 'string' ? JSON.parse(value) : value;
  if (!object || typeof object !== 'object') return false;
  if (Array.isArray(object)) return object.some(item => jsonOwner(item, scope, exact));
  return Object.entries(object).some(([key, item]) => key === 'userId' && typeof item === 'string' && (exact ? item === scope : item.startsWith(scope)) || item && typeof item === 'object' && jsonOwner(item, scope, exact));
}
function quiescenceBlockers(source: Legacy, stoppedJobIds = new Set<string>()): string[] {
  const blockers: string[] = [];
  for (const [database, table, states] of [['tasks.sqlite', 'tasks', ['running']], ['controller.sqlite', 'controller_jobs', ['running', 'uncertain']], ['controller.sqlite', 'controller_schedules', ['dispatching', 'running', 'uncertain']], ['bridge.sqlite', 'inbox', ['running', 'steering', 'uncertain']]] as const) {
    const rows = databaseRows(source.dataDir, database, table).filter(row => (states as readonly unknown[]).includes(row.status ?? row.state)
      && !(table === 'controller_jobs' && row.status === 'uncertain' && stoppedJobIds.has(String(row.id))));
    if (rows.length) blockers.push(`${database}/${table} 有 ${rows.length} 项执行中或结果未知，先核对停止状态。`);
  }
  return blockers;
}
function assertOffline(source: Legacy): void {
  if (!existsSync(join(source.dataDir, 'disabled'))) throw new Error('请先正常停止桥并停用监督进程，离线迁移需要 disabled 标记。');
  for (const name of ['bridge.pid.json', 'supervisor.pid.json']) {
    const path = join(source.dataDir, name); if (!existsSync(path)) continue;
    const pid = Number(readJson(path).pid); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('进程标识无效，先核实桥停止状态。');
    try { process.kill(pid, 0); throw new Error('桥或监督进程仍在运行，拒绝迁移。'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}
function inside(root: string, path: string): string | null {
  if (!isAbsolute(path)) return null;
  const suffix = relative(root, path); return suffix === '' || suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix) ? suffix : null;
}
const pathKeys = new Set(['cwd', 'rollout_path', 'registryDir', 'contextPath', 'ticketPath', 'ticket_path', 'completionFile', 'exitFile', 'resultFile', 'home', 'transcriptPath', 'imagePaths', 'images_json', 'attachmentPaths']);
/** Only path-valued fields move. User text, credentials, tokens and native session IDs are untouched. */
export function relocateHostValue(value: unknown, oldData: string, newData: string, key = ''): unknown {
  if (typeof value === 'string') { const suffix = pathKeys.has(key) ? inside(oldData, value) : null; return suffix == null ? value : join(newData, suffix); }
  if (Array.isArray(value)) return value.map(item => relocateHostValue(item, oldData, newData, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, relocateHostValue(item, oldData, newData, name)]));
  return value;
}
function copyTree(source: string, target: string): void {
  const stat = lstatSync(source); if (stat.isSymbolicLink()) throw new Error('迁移拒绝跟随符号链接或目录联接。');
  if (stat.isDirectory()) { mkdirSync(target, { recursive: true }); for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name)); }
  else if (stat.isFile()) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target); }
  else throw new Error('迁移遇到不支持的文件类型。');
}
async function snapshotDatabase(source: string, target: string): Promise<void> {
  mkdirSync(dirname(target), { recursive: true }); const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
}
function tableBelongs(table: string, row: Row, scope: string, conversations: Set<string>, allConversations: Set<string>): boolean {
  if ('user_id' in row) return String(row.user_id).startsWith(scope);
  if (table === 'controller_calls') return [...conversations].some(id => String(row.id).startsWith(id + ':') || row.id === 'workspace-context:' + id);
  if ('conversation_id' in row) return conversations.has(String(row.conversation_id));
  if ('parent_id' in row) return conversations.has(String(row.parent_id));
  for (const key of ['origin_json', 'value_json', 'result_json', 'origin']) if (row[key] != null) return jsonOwner(row[key], scope);
  // Host restart state and exit history are global and are kept in the host root, not per Bot.
  if (['restart_state', 'restart_history', 'supervisor_exits'].includes(table)) return false;
  throw new Error(`无法核实数据库表 ${table} 的记录归属，拒绝自动迁移。`);
}
async function partitionDatabase(source: string, target: string, bot: MigratedBot, oldData: string): Promise<{ contexts: Set<string>; tickets: Set<string>; conversations: Set<string>; filePaths: Set<string> }> {
  await snapshotDatabase(source, target); const db = new DatabaseSync(target), scope = bot.botId + '|';
  const contexts = new Set<string>(), tickets = new Set<string>(), filePaths = new Set<string>();
  const conversations = new Set(databaseRows(oldData, 'bridge.sqlite', 'conversations').filter(row => String(row.user_id).startsWith(scope)).map(row => String(row.id)));
  const allConversations = new Set(databaseRows(oldData, 'bridge.sqlite', 'conversations').map(row => String(row.id)));
  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    for (const entry of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const table = String(entry.name); if (!/^[a-z_]+$/.test(table)) throw new Error('数据库表名无效。');
      for (const row of db.prepare(`SELECT rowid AS migration_row_id,* FROM ${table}`).all()) {
        const belongs = tableBelongs(table, row, scope, conversations, allConversations);
        const active = table === 'active_conversations';
        if (!belongs || active && row.user_id !== bot.ownerUserId) { db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.migration_row_id!); continue; }
        const isOwner = typeof row.user_id === 'string' ? row.user_id === bot.ownerUserId : ['origin_json', 'value_json', 'result_json', 'origin'].some(key => row[key] != null && bot.ownerUserId != null && jsonOwner(row[key], bot.ownerUserId, true));
        if (!isOwner) {
          if ('wake_allowed' in row) { db.prepare(`UPDATE ${table} SET wake_allowed=0 WHERE rowid=?`).run(row.migration_row_id!); row.wake_allowed = 0; }
          if (table === 'task_contexts') { db.prepare('UPDATE task_contexts SET open=0 WHERE rowid=?').run(row.migration_row_id!); row.open = 0; }
          if (['task_events', 'task_observations'].includes(table) && ['queued', 'processing'].includes(String(row.state))) {
            db.prepare(`UPDATE ${table} SET state='cancelled',reason=? WHERE rowid=?`).run('宿主迁移：旧账号非当前 owner，冻结回唤。', row.migration_row_id!); row.state = 'cancelled';
          }
          if (['controller_schedules', 'controller_jobs', 'controller_workers'].includes(table) && row.value_json != null) {
            const value = JSON.parse(String(row.value_json));
            if (table === 'controller_workers') { value.wakeAllowed = false; value.blocked = true; }
            if (table === 'controller_schedules' && row.status === 'pending') { value.status = 'cancelled'; value.error = '宿主迁移：旧账号非当前 owner，冻结计划。'; db.prepare("UPDATE controller_schedules SET status='cancelled' WHERE rowid=?").run(row.migration_row_id!); row.status = 'cancelled'; }
            if (table === 'controller_jobs' && row.status === 'queued') { value.status = 'cancelled'; value.wakeAllowed = false; value.cancelReason = '宿主迁移：旧账号非当前 owner，冻结未启动工作。'; db.prepare("UPDATE controller_jobs SET status='cancelled',cancel_reason=? WHERE rowid=?").run(value.cancelReason, row.migration_row_id!); row.status = 'cancelled'; }
            row.value_json = JSON.stringify(value); db.prepare(`UPDATE ${table} SET value_json=? WHERE rowid=?`).run(row.value_json, row.migration_row_id!);
          }
        }        if (table === 'task_contexts') contexts.add(String(row.id));
        if (table === 'tasks') tickets.add(String(row.id));
        for (const [column, value] of Object.entries(row)) {
          if (column === 'migration_row_id' || value == null || typeof value !== 'string') continue;
          let updated: unknown = value;
          if (column.endsWith('_json') || table === 'restart_requests' && column === 'origin') updated = JSON.stringify(relocateHostValue(JSON.parse(value), oldData, bot.dataDir, column));
          else if (pathKeys.has(column)) updated = relocateHostValue(value, oldData, bot.dataDir, column);
          // Copy referenced attachments/results without scanning arbitrary external paths.
          const collect = (item: unknown, key = ''): void => {
            if (typeof item === 'string' && pathKeys.has(key) && inside(oldData, item) != null && existsSync(item) && lstatSync(item).isFile()) filePaths.add(item);
            else if (Array.isArray(item)) item.forEach(value => collect(value, key));
            else if (item && typeof item === 'object') Object.entries(item).forEach(([key, value]) => collect(value, key));
          };
          if (column.endsWith('_json')) collect(JSON.parse(value), column); else collect(value, column);
          if (updated !== value) db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(String(updated), row.migration_row_id!);
        }
      }
    }
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('分区迁移数据库完整性检查失败。');
    db.exec('COMMIT; PRAGMA journal_mode=DELETE');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
  return { contexts, tickets, conversations, filePaths };
}
function encodedJson(value: unknown, original?: Buffer): string {
  const text = JSON.stringify(value, null, 2) + '\n';
  return (original?.subarray(0, 3).equals(Buffer.from([239,187,191])) ? '\uFEFF' : '') + (original?.toString('utf8').includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
}
export function inspectHostStoppedExecution(configPath: string, jobId: string, nativePath: string, options: HostMigrationOptions = {}, testHooks: HostMigrationProofTestHooks = {}): StoppedExecutionProof {
  const source = legacy(configPath, options);
  return inspectStoppedExecution({ dataDir: source.dataDir, botIds: source.bots.map(bot => bot.botId) }, jobId, nativePath, testHooks);
}
export async function migrateHostConfig(configPath: string, options: HostMigrationOptions = {}, testHooks: HostMigrationProofTestHooks = {}): Promise<HostMigrationPlan> {
  const source = legacy(configPath, options);
  const proofPaths = options.stoppedExecutionProofs ?? [];
  if (!Array.isArray(proofPaths) || proofPaths.some(path => typeof path !== 'string' || !path)) throw new Error('stoppedExecutionProofs 必须是明确的证明文件清单。');
  const proofSource = { dataDir: source.dataDir, botIds: source.bots.map(bot => bot.botId) };
  let verified = verifyStoppedExecutions(proofSource, proofPaths, testHooks);
  const stoppedJobs = new Set(verified.map(item => item.proof.jobId));
  const plan: HostMigrationPlan = { version: 3, dryRun: options.dryRun !== false, sourceDataDir: source.dataDir, startupProfiles: source.startupProfiles, registeredProfiles: source.profiles.map(profile => profile.name), bots: source.bots, blockers: quiescenceBlockers(source, stoppedJobs), stoppedExecutions: verified.map(item => ({ jobId: item.proof.jobId, botId: item.proof.botId, proofSha256: item.proofSha256 })),
    warnings: ['历史保留；仅明确 owner 的活动会话继续生效。未被选中的账号不自动继承控制权。', '迁移不连接模型或平台；应用身份和跨应用操作者映射需要部署前核实。'] };
  if (plan.dryRun) return plan;
  if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
  assertOffline(source); const lock = await acquireInstanceLock(source.project, source.dataDir);
  const migrationId = randomUUID(), backupDir = join(dirname(source.configPath), 'backups', 'host-v3-' + migrationId), stage = join(backupDir, 'staged');
  const installed: string[] = [], profileChanges: { path: string; backup: string }[] = [];
  const markerPath = join(source.dataDir, 'host-semantic-version.json');
  let markerWritten = false, configWritten = false;
  try {
    // 确认桥已离线并取得锁后，重新核对配置字节与停止证据。
    assertOffline(source);
    if (!readFileSync(source.configPath).equals(source.bytes)) throw new Error('迁移准备期间配置变化，取消安装。');
    const checked = verifyStoppedExecutions(proofSource, proofPaths, testHooks);
    if (checked.some((item, index) => item.proofSha256 !== verified[index]?.proofSha256)) throw new Error('迁移准备期间停止证明变化。');
    verified = checked;
    const remaining = quiescenceBlockers(source, stoppedJobs); if (remaining.length) throw new Error(remaining.join('\n'));
    if (existsSync(markerPath)) throw new Error('存在宿主语义标记；若迁移中断请先按备份 manifest 恢复，不重复覆盖。');
    for (const bot of source.bots) if (existsSync(bot.dataDir)) throw new Error('目标 Bot 数据目录已存在，拒绝覆盖。');
    mkdirSync(stage, { recursive: true }); copyFileSync(source.configPath, join(backupDir, 'config.original.json'));
    // Offline SQLite backup plus an immutable source-data snapshot precede all installation writes.
    const savedData = join(backupDir, 'source-data'); mkdirSync(savedData);
    for (const name of readdirSync(source.dataDir)) {
      if (name === 'bots' || name === 'bridge.pid.json' || name === 'supervisor.pid.json' || /-(?:wal|shm)$/.test(name)) continue;
      const path = join(source.dataDir, name);
      if (name.endsWith('.sqlite')) await snapshotDatabase(path, join(savedData, name)); else copyTree(path, join(savedData, name));
    }
    for (const [index, bot] of source.bots.entries()) {
      const botStage = join(stage, 'bots', String(index)); mkdirSync(botStage, { recursive: true });
      const contexts = new Set<string>(), tickets = new Set<string>(), conversations = new Set<string>(), paths = new Set<string>();
      for (const name of databaseNames.filter(name => name !== 'restart.sqlite')) {
        const path = join(source.dataDir, name); if (!existsSync(path)) continue;
        const result = await partitionDatabase(path, join(botStage, name), bot, source.dataDir);
        result.contexts.forEach(id => contexts.add(id)); result.tickets.forEach(id => tickets.add(id)); result.conversations.forEach(id => conversations.add(id)); result.filePaths.forEach(path => paths.add(path));
      }
      for (const [folder, ids] of [['contexts', contexts], ['tickets', tickets]] as const) for (const id of ids) {
        const path = join(source.dataDir, folder, id + '.json'); if (!existsSync(path)) throw new Error('登记的任务凭据文件缺失，拒绝迁移。');
        const target = join(botStage, folder, id + '.json'); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, encodedJson(relocateHostValue(readJson(path), source.dataDir, bot.dataDir)), { mode: 0o600 });
      }
      for (const agent of ['codex', 'claude']) for (const id of conversations) {
        const path = join(source.dataDir, 'controller-homes', agent, id); if (!existsSync(path)) continue;
        const target = join(botStage, 'controller-homes', agent, id); copyTree(path, target);
        // Native Codex state paths refer to the controller home; preserve native IDs while moving paths.
        for (const entry of readdirSync(target)) if (/^state_\d+\.sqlite$/.test(entry)) {
          const native = new DatabaseSync(join(target, entry));
          try { if (tableExists(native, 'threads')) for (const row of native.prepare('SELECT rowid AS migration_row_id,* FROM threads').all()) {
            for (const key of ['rollout_path', 'cwd']) if (typeof row[key] === 'string') native.prepare(`UPDATE threads SET ${key}=? WHERE rowid=?`).run(relocateHostValue(row[key], source.dataDir, bot.dataDir, key) as string, row.migration_row_id!);
          } native.exec('PRAGMA journal_mode=DELETE'); } finally { native.close(); }
        }
      }
      // Immutable continuation snapshots are part of this bot's context history. Preserve their byte hashes.
      for (const id of conversations) {
        const path = join(source.dataDir, 'session-handoffs', id);
        if (existsSync(path)) copyTree(path, join(botStage, 'session-handoffs', id));
      }
      for (const path of paths) { const suffix = inside(source.dataDir, path)!; const target = join(botStage, suffix); if (!existsSync(target)) copyTree(path, target); }
      // Single-profile semantics stay unchanged inside the isolated database partition.
      writeFileSync(join(botStage, 'semantic-version.json'), encodedJson({ version: 2, hostVersion: 3, botId: bot.botId }));
      const profilePath = join(dirname(source.configPath), 'bots', bot.profile + '.json');
      const original = readFileSync(profilePath), saved = join(backupDir, `profile-${index}.original.json`); writeFileSync(saved, original);
      profileChanges.push({ path: profilePath, backup: saved });
      const updated = { ...readJson(profilePath), workspace: bot.contextWorkspace, workingCwd: bot.workingCwd, ...(bot.ownerPrincipalId ? { ownerPrincipalId: bot.ownerPrincipalId } : {}) };
      writeFileSync(join(stage, `profile-${index}.json`), encodedJson(updated, original), { mode: 0o600 });
    }
    if (!readFileSync(source.configPath).equals(source.bytes)) throw new Error('迁移准备期间配置变化，取消安装。');
    const principals: PrincipalMapping[] = [];
    for (const bot of source.bots) if (bot.ownerPrincipalId && bot.ownerUserId) {
      let principal = principals.find(item => item.id === bot.ownerPrincipalId); if (!principal) { principal = { id: bot.ownerPrincipalId, accounts: {} }; principals.push(principal); }
      principal.accounts[bot.botId] = bot.ownerUserId.slice(bot.botId.length + 1);
    }
    const common = { ...source.raw, version: 3, startupProfiles: source.startupProfiles, registeredProfiles: source.profiles.map(profile => profile.name), principals, spaces: [] };
    for (const key of ['startupProfile', 'platformProfiles', 'workspace', 'logsDir', 'attachmentsDir']) delete (common as Record<string, unknown>)[key];
    const marker: HostSemanticMarker = { version: 3, status: 'in-progress', migrationId, migratedAt: new Date().toISOString(), bots: source.bots, backupDir };
    const stoppedExecutions = verified.map((item, index) => {
      const name = `stopped-execution-${index}.proof.json`; writeFileSync(join(backupDir, name), item.bytes, { flag: 'wx', mode: 0o600 });
      return { jobId: item.proof.jobId, workerId: item.proof.workerId, taskId: item.proof.taskId, botId: item.proof.botId, preservedStatus: 'uncertain', workerBlocked: true,
        proofFile: name, proofSha256: item.proofSha256, verification: item.verification };
    });
    const manifest = { ...marker, stoppedExecutions, configPath: source.configPath, dataDir: source.dataDir, sourceConfigSha256: createHash('sha256').update(source.bytes).digest('hex'),
      files: profileChanges, targetDirectories: source.bots.map(bot => bot.dataDir), savedData };
    writeFileSync(join(backupDir, 'manifest.json'), encodedJson(manifest), { mode: 0o600 });
    writeFileSync(markerPath, encodedJson(marker), { flag: 'wx', mode: 0o600 }); markerWritten = true;
    for (const [index, bot] of source.bots.entries()) { mkdirSync(dirname(bot.dataDir), { recursive: true }); renameSync(join(stage, 'bots', String(index)), bot.dataDir); installed.push(bot.dataDir); }
    for (const [index, item] of profileChanges.entries()) { const temp = item.path + '.host-migration-' + migrationId; copyFileSync(join(stage, `profile-${index}.json`), temp); renameSync(temp, item.path); }
    const tempConfig = source.configPath + '.host-migration-' + migrationId; writeFileSync(tempConfig, encodedJson(common, source.bytes), { mode: 0o600 }); renameSync(tempConfig, source.configPath); configWritten = true;
    marker.status = 'complete'; const markerTemp = markerPath + '.tmp'; writeFileSync(markerTemp, encodedJson(marker)); renameSync(markerTemp, markerPath);
    plan.backupDir = backupDir; return plan;
  } catch (error) {
    if (configWritten) copyFileSync(join(backupDir, 'config.original.json'), source.configPath);
    for (const item of profileChanges) if (existsSync(item.backup)) copyFileSync(item.backup, item.path);
    for (const [index, path] of installed.entries()) if (existsSync(path)) renameSync(path, join(backupDir, 'rolled-back-bot-' + index));
    if (markerWritten && existsSync(markerPath)) renameSync(markerPath, join(backupDir, 'failed-marker.json'));
    throw error;
  } finally { await new Promise<void>(done => lock.close(() => done())); }
}
/** Startup never guesses how to interpret shared version-2 databases or half-installed migration data. */
export function ensureHostSemanticData(host: HostConfig): HostSemanticMarker {
  mkdirSync(host.rootDataDir, { recursive: true }); const path = join(host.rootDataDir, 'host-semantic-version.json');
  if (existsSync(path)) {
    const value = readJson(path) as unknown as HostSemanticMarker;
    if (value.version !== 3 || value.status !== 'complete' || !Array.isArray(value.bots)) throw new Error('宿主迁移尚未完整提交，请先检查备份 manifest。');
    for (const config of host.configs) {
      const bot = value.bots.find(item => item.botId === config.botId);
      if (bot && resolve(bot.dataDir) !== resolve(config.dataDir)) throw new Error('宿主迁移数据目录与配置不一致。');
    }
    return value;
  }
  if (databaseNames.some(name => existsSync(join(host.rootDataDir, name))) || host.configs.some(config => databaseNames.some(name => existsSync(join(config.dataDir, name))))) throw new Error('现有数据尚未完成离线宿主迁移，拒绝启动。');
  const value: HostSemanticMarker = { version: 3, status: 'complete', migrationId: randomUUID(), migratedAt: new Date().toISOString(), bots: [] };
  writeFileSync(path, encodedJson(value), { flag: 'wx' }); return value;
}
/** Explicit recovery retains failed installed data in the backup rather than deleting it. Bridge must remain stopped. */
export function restoreHostMigration(backupDir: string): void {
  const manifest = readJson(join(resolve(backupDir), 'manifest.json'));
  if (manifest.version !== 3 || typeof manifest.configPath !== 'string' || typeof manifest.dataDir !== 'string' || !Array.isArray(manifest.files) || !Array.isArray(manifest.targetDirectories)) throw new Error('宿主备份 manifest 无效。');
  if (!existsSync(join(String(manifest.dataDir), 'disabled'))) throw new Error('恢复前必须停止桥。');
  for (const [index, target] of manifest.targetDirectories.entries()) {
    if (typeof target !== 'string' || inside(String(manifest.dataDir), target) == null) throw new Error('恢复目录超出宿主数据范围。');
    if (existsSync(target)) renameSync(target, join(backupDir, `recovered-bot-${index}-${randomUUID()}`));
  }
  for (const item of manifest.files as { path: string; backup: string }[]) copyFileSync(item.backup, item.path);
  copyFileSync(join(backupDir, 'config.original.json'), String(manifest.configPath));
  const marker = join(String(manifest.dataDir), 'host-semantic-version.json'); if (existsSync(marker)) renameSync(marker, join(backupDir, 'restored-marker-' + randomUUID() + '.json'));
}