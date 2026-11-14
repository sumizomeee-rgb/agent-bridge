import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RegistryMigrationContext } from './registry-migration.js';

/** Offline staging only. Runtime never guesses ownership from legacy channel rows. */
export function migrateControllerOwnership(context: RegistryMigrationContext): void {
  const target = resolve(context.targetHostDir);
  if (target === resolve(context.sourceHostDir) || target === resolve(context.finalHostDir))
    throw new Error('Controller ownership migration requires a separate staging directory.');
  const path = join(target, 'host.sqlite');
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_bots'").get()) return;
    const columns = db.prepare('PRAGMA table_info(host_bots)').all().map(column => String(column.name));
    const expected = ['bot_id', 'platform', 'application_id', 'owner_id', 'controller_json', 'ready'];
    if (columns.length !== expected.length || expected.some(column => !columns.includes(column)))
      throw new Error('Unexpected legacy host_bots schema; ownership migration did not run.');
    const bindings = new Map(context.bindings.map(binding => [binding.botId, binding]));
    if (bindings.size !== context.bindings.length) throw new Error('Duplicate migration channel bindings.');
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    db.exec(`CREATE TABLE host_controllers(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES host_principals(id),state_json TEXT);
      CREATE TABLE host_bots_v4(
        bot_id TEXT PRIMARY KEY,platform TEXT NOT NULL,application_id TEXT NOT NULL,
        owner_id TEXT REFERENCES host_principals(id),controller_id TEXT NOT NULL REFERENCES host_controllers(id),
        ready INTEGER NOT NULL DEFAULT 0,UNIQUE(platform,application_id))`);
    for (const row of db.prepare('SELECT * FROM host_bots').all()) {
      const binding = bindings.get(String(row.bot_id));
      if (!binding || row.owner_id != null && row.owner_id !== binding.ownerPrincipalId)
        throw new Error('Legacy channel owner or binding cannot be confirmed: ' + row.bot_id);
      const state = row.controller_json == null ? null : String(row.controller_json);
      if (state !== null) {
        const value: unknown = JSON.parse(state);
        if (!value || typeof value !== 'object' || !('conversationId' in value) || typeof value.conversationId !== 'string'
          || !('generation' in value) || !Number.isSafeInteger(value.generation)) throw new Error('Invalid legacy controller state.');
      }
      db.prepare('INSERT OR IGNORE INTO host_principals(id) VALUES (?)').run(binding.ownerPrincipalId);
      const previous = db.prepare('SELECT owner_id,state_json FROM host_controllers WHERE id=?').get(binding.controllerId);
      if (previous && (previous.owner_id !== binding.ownerPrincipalId || previous.state_json !== state))
        throw new Error('Different legacy controllers cannot be merged: ' + binding.controllerId);
      db.prepare('INSERT OR IGNORE INTO host_controllers(id,owner_id,state_json) VALUES (?,?,?)')
        .run(binding.controllerId, binding.ownerPrincipalId, state);
      db.prepare('INSERT INTO host_bots_v4(bot_id,platform,application_id,owner_id,controller_id,ready) VALUES (?,?,?,?,?,?)')
        .run(row.bot_id!, row.platform!, row.application_id!, binding.ownerPrincipalId, binding.controllerId, row.ready!);
    }
    db.exec('DROP TABLE host_bots; ALTER TABLE host_bots_v4 RENAME TO host_bots');
    const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    // These fields are durable program owners, unlike raw group/chat source evidence.
    if (hasTable('host_routed_outbox')) for (const row of db.prepare('SELECT id,source_json FROM host_routed_outbox').all()) {
      const source = JSON.parse(String(row.source_json)) as Record<string, unknown>;
      const binding = bindings.get(String(source.botId));
      if (!binding || source.principalId !== binding.ownerPrincipalId || source.userId !== binding.ownerUserId)
        throw new Error('Routed delivery owner cannot be confirmed: ' + row.id);
      source.userId = 'principal:' + binding.ownerPrincipalId;
      db.prepare('UPDATE host_routed_outbox SET source_json=? WHERE id=?').run(JSON.stringify(source), row.id!);
    }
    if (hasTable('host_roots')) for (const row of db.prepare('SELECT id,reply_json FROM host_roots').all()) {
      const reply = JSON.parse(String(row.reply_json)) as Record<string, unknown>;
      if (reply.sourceUserId === undefined) continue;
      const binding = bindings.get(String(reply.initiatorBotId));
      if (!binding || reply.sourceUserId !== binding.ownerUserId) throw new Error('Collaboration owner cannot be confirmed: ' + row.id);
      reply.sourceUserId = 'principal:' + binding.ownerPrincipalId;
      db.prepare('UPDATE host_roots SET reply_json=? WHERE id=?').run(JSON.stringify(reply), row.id!);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migrated controller ownership failed foreign-key validation.');
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
