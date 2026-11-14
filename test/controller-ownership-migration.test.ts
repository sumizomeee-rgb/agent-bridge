import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateControllerOwnership } from '../src/controller-ownership-migration.js';
import { HostRuntime } from '../src/host-runtime.js';
import { SessionStore } from '../src/store.js';
import type { ControllerCore } from '../src/controller/core.js';
import type { HostConfig } from '../src/config.js';
import type { RegistryMigrationContext } from '../src/registry-migration.js';
import type { BridgeConfig } from '../src/types.js';

function staging() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-ownership-')), targetHostDir = join(root, 'stage');
  mkdirSync(targetHostDir);
  const path = join(targetHostDir, 'host.sqlite'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE host_principals(id TEXT PRIMARY KEY);
    INSERT INTO host_principals VALUES ('owner');
    CREATE TABLE host_bots(bot_id TEXT PRIMARY KEY,platform TEXT NOT NULL,application_id TEXT NOT NULL,
      owner_id TEXT REFERENCES host_principals(id),controller_json TEXT,ready INTEGER NOT NULL DEFAULT 0,UNIQUE(platform,application_id));
    CREATE TABLE host_principal_maps(bot_id TEXT REFERENCES host_bots(bot_id),platform_user_id TEXT,principal_id TEXT REFERENCES host_principals(id));`);
  const state = JSON.stringify({ conversationId: 'same-conversation', generation: 7, agent: 'codex', nativeId: 'same-native' });
  db.prepare('INSERT INTO host_bots VALUES (?,?,?,?,?,?)').run('feishu:app', 'feishu', 'app', 'owner', state, 1);
  db.exec(`INSERT INTO host_principal_maps VALUES ('feishu:app','account','owner');
    CREATE TABLE host_routed_outbox(id TEXT PRIMARY KEY,source_json TEXT);
    CREATE TABLE host_roots(id TEXT PRIMARY KEY,reply_json TEXT)`);
  db.prepare('INSERT INTO host_routed_outbox VALUES (?,?)').run('delivery', JSON.stringify({ botId: 'feishu:app', principalId: 'owner', userId: 'feishu:app|account',
    original: { userId: 'feishu:app|account' } }));
  db.prepare('INSERT INTO host_roots VALUES (?,?)').run('root', JSON.stringify({ initiatorBotId: 'feishu:app', sourceUserId: 'feishu:app|account' }));
  db.close();
  const context: RegistryMigrationContext = { sourceHostDir: join(root, 'source'), targetHostDir, finalHostDir: join(root, 'final'),
    bindings: [{ botId: 'feishu:app', controllerId: 'stable-teto', ownerPrincipalId: 'owner', ownerUserId: 'feishu:app|account',
      profile: 'profile', sourceDataDir: '', controllerDataDir: '', channelDataDir: '' }] };
  return { root, path, state, context };
}

test('offline ownership migration preserves current state and foreign keys under the registered stable identity', () => {
  const f = staging();
  try {
    migrateControllerOwnership(f.context);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.deepEqual({ ...db.prepare('SELECT * FROM host_controllers').get() }, { id: 'stable-teto', owner_id: 'owner', state_json: f.state });
      assert.equal(db.prepare('SELECT controller_id FROM host_bots').get()!.controller_id, 'stable-teto');
      assert.equal(db.prepare('SELECT ready FROM host_bots').get()!.ready, 1);
      assert(!db.prepare('PRAGMA table_info(host_bots)').all().some(column => column.name === 'controller_json'));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM host_principal_maps').get()!.count, 1);
      const source = JSON.parse(String(db.prepare('SELECT source_json FROM host_routed_outbox').get()!.source_json));
      assert.equal(source.userId, 'principal:owner'); assert.equal(source.original.userId, 'feishu:app|account');
      assert.equal(JSON.parse(String(db.prepare('SELECT reply_json FROM host_roots').get()!.reply_json)).sourceUserId, 'principal:owner');
    } finally { db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('offline ownership migration rejects unknown ownership atomically and refuses a production target', () => {
  const f = staging();
  try {
    assert.throws(() => migrateControllerOwnership({ ...f.context, targetHostDir: f.context.sourceHostDir }));
    assert.throws(() => migrateControllerOwnership({ ...f.context, bindings: [] }));
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT controller_json FROM host_bots').get()!.controller_json, f.state);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='host_controllers'").get(), undefined);
    } finally { db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('headless controllers retain canonical binding and participate in host drain idle and close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-ownership-'));
  const coreConfig: BridgeConfig = { controllerId: 'headless', controllerUserId: 'principal:owner', ownerUserId: 'principal:owner', ownerPrincipalId: 'owner',
    token: '', allowedUserIds: ['principal:owner'], defaultAgent: 'codex', workspace: root, dataDir: join(root, 'core'), attachmentsDir: root, logsDir: root,
    proxyUrl: null, maxImageBytes: 1024, commands: { codex: { command: 'offline', args: [] }, claude: { command: 'offline', args: [] } } };
  const config: HostConfig = { version: 4, workspaceRoot: root, rootDataDir: join(root, 'host'), configs: [], controllerConfigs: [coreConfig],
    principals: [{ id: 'owner', accounts: {} }], spaces: [], registry: { version: 4, workspaceRoot: root, registryRoot: root, hostDataDir: join(root, 'host'),
      startupControllers: ['headless'], controllers: [], channels: [], principals: [], spaces: [] } };
  const host = new HostRuntime(config, async () => ({}), () => {});
  let idle = false, drained = 0, closed = 0;
  const hooks = host.controllerHooks(coreConfig), sessions = new SessionStore(coreConfig.dataDir, hooks.manager.binding);
  const conversation = sessions.createConversation('principal:owner', 'external', root, { controllerMode: true });
  const core = { config: coreConfig, manager: { conversationById: (id: string) => sessions.getConversation(id), currentConversation: (user: string) => sessions.getActive(user) }, isReady: () => true,
    beginDrain() { drained++; }, isIdle() { return idle; }, async close() { closed++; } } as unknown as ControllerCore;
  try {
    host.attachCore(core);
    assert.equal(hooks.authorize('principal:owner', ''), true); assert.equal(hooks.authorize('feishu:app|owner', ''), false);
    hooks.manager.binding.setActive('principal:owner', conversation.id, 'reset');
    assert.equal(hooks.manager.binding.getActive('principal:owner'), conversation.id);
    assert.equal(hooks.manager.binding.getActive('someone-else'), null);
    assert.throws(() => hooks.manager.binding.setActive('someone-else', conversation.id, 'reset'));
    sessions.saveNativeId(conversation.id, 'external-native');
    assert.equal(host.store.getController('headless')!.nativeId, 'external-native');
    const next = sessions.createConversation('principal:owner', 'external', root, { controllerMode: true });
    sessions.setActive('principal:owner', next.id);
    sessions.saveNativeId(conversation.id, 'late-old-id');
    hooks.manager.binding.saveNativeId?.(conversation.id, 'late-old-direct-id');
    assert.equal(host.store.getController('headless')!.conversationId, next.id);
    assert.equal(host.store.getController('headless')!.nativeId, null);
    sessions.saveNativeId(next.id, 'external-final-id');
    assert.equal(host.store.getController('headless')!.nativeId, 'external-final-id');
    const directory = hooks.executorDirectory!();
    assert.equal(directory.recipients.length, 1);
    assert.equal(directory.recipients[0]!.controllerId, 'headless');
    assert.equal(directory.recipients[0]!.userId, 'principal:owner');
    assert.equal(directory.recipients[0]!.botId, undefined);
    assert.equal(host.isIdle(), false); idle = true; assert.equal(host.isIdle(), true);
    host.beginDrain(); assert.equal(drained, 1);
    await host.close(); assert.equal(closed, 1);
  } finally { if (!closed) await host.close(); sessions.close(); rmSync(root, { recursive: true, force: true }); }
});
