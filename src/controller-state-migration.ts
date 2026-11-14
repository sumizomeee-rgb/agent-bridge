import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

interface Scope { userId: string; channelId: string; spaceId?: string }
export interface ControllerStateMigrationReport { knowledgeScopes: number; dispatchScopes: number; feedbackRows: number }
export interface ControllerStateMigrationPlan { apply(): ControllerStateMigrationReport }
const knowledgeTables = ['controller_checklist', 'controller_checklist_revisions', 'controller_knowledge_calls'] as const;
const hashScope = (scope: Scope) => createHash('sha256').update(JSON.stringify([scope.userId, scope.channelId, scope.spaceId ?? null])).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function jsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  if (!object(parsed)) throw new Error('迁移状态不是有效对象：' + label);
  return parsed;
}

/** Capture old hashed ownership before the staged database's ordinary owner/path rewrite. */
export function prepareControllerStateMigration(db: DatabaseSync, users: Record<string, string>): ControllerStateMigrationPlan {
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const columns = (table: string) => new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => String(row.name)));
  const scopes = new Map<string, string>();
  const routes = new Map<string, Scope>();
  const spaces = new Set<string>();
  const remember = (userId: unknown, channelId: unknown, spaceId?: unknown) => {
    if (typeof userId !== 'string' || typeof channelId !== 'string' || !userId || !channelId) return;
    if (spaceId !== undefined && (typeof spaceId !== 'string' || !spaceId)) throw new Error('迁移群范围缺少可验证的 spaceId');
    const nextUser = users[userId] ?? (userId.startsWith('principal:') ? userId : undefined);
    if (!nextUser) return;
    const scope: Scope = { userId, channelId, ...(spaceId !== undefined ? { spaceId: spaceId as string } : {}) };
    routes.set(JSON.stringify(scope), scope);
    if (scope.spaceId) spaces.add(scope.spaceId);
  };
  // Inbox is the authoritative persisted source of private and canonical group routes.
  if (has('inbox')) {
    const grouped = columns('inbox').has('group_json');
    for (const row of db.prepare('SELECT user_id,channel_id' + (grouped ? ',group_json' : '') + ' FROM inbox').all()) {
      remember(row.user_id, row.channel_id);
      if (row.group_json != null) {
        const group = jsonObject(row.group_json, 'inbox.group_json');
        remember(row.user_id, row.channel_id, group.spaceId);
      }
    }
  }
  for (const table of ['delivered_replies', 'workspace_initialization_notices', 'private_input_arrivals']) if (has(table)) {
    for (const row of db.prepare('SELECT DISTINCT user_id,channel_id FROM ' + table).all()) remember(row.user_id, row.channel_id);
  }
  if (has('controller_feedback')) for (const row of db.prepare('SELECT payload_json FROM controller_feedback').all()) {
    const value = jsonObject(row.payload_json, 'controller_feedback');
    remember(value.userId, value.channelId, object(value.group) ? value.group.spaceId : undefined);
  }
  if (has('dispatch_failures')) for (const row of db.prepare('SELECT value_json FROM dispatch_failures').all()) {
    const value = jsonObject(row.value_json, 'dispatch_failures');
    const origin = object(value.origin) ? value.origin : undefined;
    const group = origin && object(origin.groupContext) ? origin.groupContext : undefined;
    remember(value.userId, value.channelId, group?.spaceId);
  }
  for (const route of routes.values()) {
    // Known channel plus a recorded canonical group is enough to explain the hash;
    // matching it does not grant any new authorization or replay an old message.
    for (const spaceId of [undefined, ...spaces]) {
      const old = { ...route, spaceId }, next = { ...old, userId: users[route.userId] ?? route.userId };
      const key = hashScope(old), target = hashScope(next), previous = scopes.get(key);
      if (previous && previous !== target) throw new Error('任务清单范围的负责人映射不唯一');
      scopes.set(key, target); scopes.set(target, target);
    }
  }
  const referenced = new Map<string, string>();
  for (const table of knowledgeTables) if (has(table)) {
    const keys = db.prepare('PRAGMA table_info(' + table + ')').all().filter(row => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => String(row.name));
    const targets = new Set<string>();
    for (const row of db.prepare('SELECT * FROM ' + table).all()) {
      const old = String(row.scope), target = scopes.get(old);
      if (!target) throw new Error('无法解释旧任务清单范围，已阻止迁移：' + table + ':' + old);
      referenced.set(old, target);
      const key = JSON.stringify(keys.map(name => name === 'scope' ? target : row[name]));
      if (targets.has(key)) throw new Error('任务清单范围迁移发生主键冲突，已阻止合并：' + table);
      targets.add(key);
    }
  }
  return { apply() {
    db.exec('SAVEPOINT controller_state_scopes');
    try {
      const report: ControllerStateMigrationReport = { knowledgeScopes: 0, dispatchScopes: 0, feedbackRows: 0 };
      for (const [old, next] of referenced) if (old !== next) {
        for (const table of knowledgeTables) if (has(table)) db.prepare('UPDATE ' + table + ' SET scope=? WHERE scope=?').run(next, old);
        report.knowledgeScopes++;
      }
      if (has('dispatch_failures')) for (const row of db.prepare('SELECT id,scope_key,conversation_id,value_json FROM dispatch_failures').all()) {
        const value = jsonObject(row.value_json, 'dispatch_failures');
        if (typeof value.userId !== 'string' || users[value.userId] && users[value.userId] !== value.userId) throw new Error('派工失败范围必须在负责人字段迁移后重建');
        if (value.id !== row.id || value.conversationId !== row.conversation_id || typeof value.botId !== 'string' || typeof value.channelId !== 'string' || typeof value.groupKey !== 'string' || value.nativeId !== null && typeof value.nativeId !== 'string') throw new Error('派工失败范围与持久记录身份不一致');
        const key = JSON.stringify([value.botId, value.conversationId, value.userId, value.channelId, value.nativeId, value.groupKey]);
        if (key !== row.scope_key) { db.prepare('UPDATE dispatch_failures SET scope_key=? WHERE id=?').run(key, row.id!); report.dispatchScopes++; }
      }
      // Feedback IDs hash conversation/channel/source only; its user index is rewritten
      // normally. Keeping IDs and call receipts intact preserves notification dedupe.
      if (has('controller_feedback')) for (const row of db.prepare('SELECT * FROM controller_feedback').all()) {
        const value = jsonObject(row.payload_json, 'controller_feedback');
        const groupKey = object(value.group) ? JSON.stringify([value.group.spaceId, value.group.generation, value.group.bindingEpoch]) : '';
        if (value.id !== row.id || value.userId !== row.user_id || value.conversationId !== row.conversation_id || value.channelId !== row.channel_id || groupKey !== row.group_key) throw new Error('主控反馈范围与已迁移的负责人索引不一致');
        report.feedbackRows++;
      }
      db.exec('RELEASE controller_state_scopes'); return report;
    } catch (error) { db.exec('ROLLBACK TO controller_state_scopes; RELEASE controller_state_scopes'); throw error; }
  } };
}
