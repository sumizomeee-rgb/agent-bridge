import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, loadHostConfig } from '../src/config.js';
import { ensureHostSemanticData, migrateHostConfig, restoreHostMigration, relocateHostValue } from '../src/host-migration.js';
import { SessionStore } from '../src/store.js';
import { SessionManager } from '../src/manager.js';
import type { AgentAdapter, AgentTurn } from '../src/types.js';
import { SessionHandoffs } from '../src/controller/handoff.js';
import { TaskRegistry, type TaskContextFile } from '../src/tasks.js';

const appA = 'cli_hostA', appB = 'cli_hostB', botA = `feishu:${appA}`, botB = `feishu:${appB}`, userA = 'ou_ownerA', userB = 'ou_ownerB';
function fixture(t: TestContext, version = 3) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-host-migration-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, '.local'), data = join(local, 'data'), config = join(local, 'config.json'); mkdirSync(data, { recursive: true }); mkdirSync(join(local, 'bots', 'feishu'), { recursive: true });
  const profile = (id: string, user: string) => ({ applicationId: id, appSecret: 'fixture-secret-never-output', allowedUserIds: [user], network: { proxyPort: null } });
  writeFileSync(join(local, 'bots', 'feishu', 'a.json'), JSON.stringify(profile(appA, userA))); writeFileSync(join(local, 'bots', 'feishu', 'b.json'), JSON.stringify(profile(appB, userB)));
  const raw: Record<string, unknown> = { version, ...(version === 3 ? { startupProfiles: ['feishu/a', 'feishu/b'] } : { startupProfile: 'feishu/a', workspace: join(root, 'existing-workspace') }),
    workspaceRoot: join(root, 'workspaces'), dataDir: data, defaultAgent: 'codex', controllerMode: true,
    commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } };
  writeFileSync(config, JSON.stringify(raw)); return { root, local, data, config, raw };
}
function writeConfig(f: ReturnType<typeof fixture>, updates: Record<string, unknown>) { writeFileSync(f.config, JSON.stringify({ ...f.raw, ...updates })); }

test('v3 host loads one complete same-platform set with stable identity paths and separate context/cwd', t => {
  const f = fixture(t); writeConfig(f, { workingCwd: join(f.root, 'execution'), principals: [{ id: 'me', accounts: { [botA]: userA, [botB]: userB } }] });
  const profile = join(f.local, 'bots', 'feishu', 'a.json'), raw = JSON.parse(readFileSync(profile, 'utf8')); writeFileSync(profile, JSON.stringify({ ...raw, ownerPrincipalId: 'me' }));
  const host = loadHostConfig(['--config', f.config, '--profile', 'feishu/a'], false);
  assert.equal(host.configs.length, 2); assert.equal(host.configs[0]?.botId, botA); assert.equal(host.configs[0]?.ownerUserId, botA + '|' + userA);
  assert.equal(host.configs[0]?.contextWorkspace, join(f.root, 'workspaces', 'feishu', appA)); assert.equal(host.configs[0]?.workingCwd, join(f.root, 'execution'));
  assert.equal(host.configs[0]?.dataDir, join(f.data, 'bots', 'feishu', appA)); assert.notEqual(host.configs[0]?.workspace, host.configs[1]?.workspace);
  assert.equal(existsSync(host.configs[0]!.workspace), false);
  renameSync(profile, join(f.local, 'bots', 'feishu', 'renamed.json')); writeConfig(f, { startupProfiles: ['feishu/renamed', 'feishu/b'], principals: host.principals });
  assert.equal(loadHostConfig(['--config', f.config], false).configs[0]?.workspace, host.configs[0]?.workspace);
  assert.throws(() => loadConfig(['--config', f.config], false), /语义迁移/);
});

test('host rejects old semantics, duplicate real bots, mixed platforms, shared workspace and ambiguous principals', t => {
  const f = fixture(t); writeConfig(f, { version: 2 }); assert.throws(() => loadHostConfig(['--config', f.config], false), /离线宿主迁移/);
  const a = join(f.local, 'bots', 'feishu', 'a.json'), b = join(f.local, 'bots', 'feishu', 'b.json'), rawA = JSON.parse(readFileSync(a, 'utf8')), rawB = JSON.parse(readFileSync(b, 'utf8'));
  writeFileSync(b, JSON.stringify(rawA)); writeConfig(f, {}); assert.throws(() => loadHostConfig(['--config', f.config], false), /同一个真实 Bot/);
  writeFileSync(b, JSON.stringify({ ...rawB, workspace: join(f.root, 'shared') })); writeFileSync(a, JSON.stringify({ ...rawA, workspace: join(f.root, 'shared') })); assert.throws(() => loadHostConfig(['--config', f.config], false), /不能复用/);
  writeFileSync(a, JSON.stringify(rawA)); writeFileSync(b, JSON.stringify(rawB));
  writeConfig(f, { principals: [{ id: 'one', accounts: { [botA]: userA } }, { id: 'two', accounts: { [botA]: userA } }] }); assert.throws(() => loadHostConfig(['--config', f.config], false), /多个 principal/);
  mkdirSync(join(f.local, 'bots', 'discord')); writeFileSync(join(f.local, 'bots', 'discord', 'd.json'), JSON.stringify({ applicationId: '123456789012345678', token: 'private', allowedUserIds: ['234567890123456789'] }));
  writeConfig(f, { startupProfiles: ['feishu/a', 'discord/d'] }); assert.throws(() => loadHostConfig(['--config', f.config], false), /同一平台/);
});

test('dry run is read-only and multiple active owners require an explicit choice', async t => {
  const f = fixture(t, 2), scope = botA + '|'; const profile = join(f.local, 'bots', 'feishu', 'a.json'), raw = JSON.parse(readFileSync(profile, 'utf8')); writeFileSync(profile, JSON.stringify({ ...raw, allowedUserIds: [userA, 'ou_second'] }));
  const store = new SessionStore(f.data); const first = store.createConversation(scope + userA, 'codex', f.root), second = store.createConversation(scope + 'ou_second', 'claude', f.root); store.setActive(scope + userA, first.id); store.setActive(scope + 'ou_second', second.id); store.close();
  const bytes = readFileSync(f.config); await assert.rejects(migrateHostConfig(f.config), /多个活动账号/);
  const plan = await migrateHostConfig(f.config, { owners: { [botA]: userA } }); assert.equal(plan.dryRun, true); assert.equal(plan.bots[0]?.activeConversationId, first.id); assert.equal(plan.bots[0]?.conversations, 2);
  assert.deepEqual(readFileSync(f.config), bytes); assert.equal(existsSync(join(f.local, 'backups')), false); assert.equal(existsSync(plan.bots[0]!.dataDir), false);
});

test('offline migration partitions bot sessions, tasks and plans, preserves native IDs/tokens and relocates attachments', async t => {
  const f = fixture(t, 2); writeFileSync(join(f.data, 'disabled'), ''); const store = new SessionStore(f.data), tasks = new TaskRegistry(f.data);
  const a = store.createConversation(botA + '|' + userA, 'codex', f.root, { controllerMode: true }), b = store.createConversation(botB + '|' + userB, 'claude', f.root);
  store.saveNativeId(a.id, 'native-A-keep'); store.saveNativeId(b.id, 'native-B-keep'); store.setActive(a.userId, a.id); store.setActive(b.userId, b.id);
  const image = join(f.data, 'attachments', 'a', 'image.png'); mkdirSync(join(f.data, 'attachments', 'a'), { recursive: true }); writeFileSync(image, 'fake image');
  store.addMessage({ id: botA + '|om_a', userId: a.userId, channelId: botA + '|oc_a', text: 'keep ' + image, imagePaths: [image] }, a.id, 'completed');
  const context = tasks.createContext({ conversationId: a.id, userId: a.userId, channelId: botA + '|oc_a', originMessageId: botA + '|om_a', nativeId: a.nativeId, agent: 'codex', cwd: f.root });
  const taskContext = JSON.parse(readFileSync(context.contextPath, 'utf8')) as TaskContextFile, task = tasks.register(taskContext, 'preserved-task');
  tasks.acceptObservedResult(task.taskId, 'completed', 'preserved result'); tasks.close(); store.close();
  const controller = new DatabaseSync(join(f.data, 'controller.sqlite')); controller.exec('CREATE TABLE controller_schedules(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,status TEXT NOT NULL,due_at TEXT NOT NULL,task_id TEXT,value_json TEXT NOT NULL)');
  const origin = { conversationId: a.id, userId: a.userId, channelId: botA + '|oc_a', originMessageId: botA + '|om_a', agent: 'codex', nativeId: 'native-A-keep', cwd: f.root };
  controller.prepare('INSERT INTO controller_schedules VALUES(?,?,?,?,?,?)').run('plan-A', a.id, 'pending', '2099-01-01T00:00:00Z', null, JSON.stringify({ id: 'plan-A', origin, kind: 'controller' })); controller.close();
  const home = join(f.data, 'controller-homes', 'codex', a.id); mkdirSync(home, { recursive: true }); const native = new DatabaseSync(join(home, 'state_5.sqlite')); native.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT)'); native.prepare('INSERT INTO threads VALUES(?,?,?)').run('native-A-keep', join(home, 'sessions', 'rollout.jsonl'), f.root); native.close();
  const result = await migrateHostConfig(f.config, { dryRun: false, startupProfiles: ['feishu/a', 'feishu/b'], principalIds: { [botA]: 'me', [botB]: 'me' } });
  assert.ok(result.backupDir); const host = loadHostConfig(['--config', f.config], false), marker = ensureHostSemanticData(host); assert.equal(marker.status, 'complete'); assert.equal(marker.bots.length, 2); assert.equal(host.principals.length, 1);
  assert.equal(host.configs[0]?.workspace, join(f.root, 'existing-workspace')); assert.notEqual(host.configs[0]?.workspace, host.configs[1]?.workspace);
  const migratedA = new SessionStore(host.configs[0]!.dataDir), migratedB = new SessionStore(host.configs[1]!.dataDir);
  try {
    assert.equal(migratedA.getActive(a.userId)?.nativeId, 'native-A-keep'); assert.equal(migratedA.getConversation(b.id), null); assert.equal(migratedB.getActive(b.userId)?.nativeId, 'native-B-keep');
    const message = migratedA.getMessage(botA + '|om_a')!; assert.equal(message.text, 'keep ' + image); assert.deepEqual(message.imagePaths, [join(host.configs[0]!.dataDir, 'attachments', 'a', 'image.png')]); assert.ok(existsSync(message.imagePaths[0]!));
  } finally { migratedA.close(); migratedB.close(); }
  const migratedTaskContext = JSON.parse(readFileSync(join(host.configs[0]!.dataDir, 'contexts', context.contextId + '.json'), 'utf8')) as TaskContextFile; assert.equal(migratedTaskContext.token, taskContext.token); assert.equal(migratedTaskContext.registryDir, host.configs[0]?.dataDir);
  const migratedTasks = new TaskRegistry(host.configs[0]!.dataDir); assert.equal(migratedTasks.queuedEvents()[0]?.taskId, task.taskId); migratedTasks.close();
  const planDb = new DatabaseSync(join(host.configs[0]!.dataDir, 'controller.sqlite')); assert.equal(planDb.prepare('SELECT id FROM controller_schedules').get()?.id, 'plan-A'); planDb.close();
  const nativeDb = new DatabaseSync(join(host.configs[0]!.dataDir, 'controller-homes', 'codex', a.id, 'state_5.sqlite')); assert.equal(nativeDb.prepare('SELECT id FROM threads').get()?.id, 'native-A-keep'); assert.equal(nativeDb.prepare('SELECT rollout_path FROM threads').get()?.rollout_path, join(host.configs[0]!.dataDir, 'controller-homes', 'codex', a.id, 'sessions', 'rollout.jsonl')); nativeDb.close();
  assert.ok(existsSync(join(result.backupDir!, 'manifest.json'))); assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  restoreHostMigration(result.backupDir!); assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).version, 2); assert.equal(existsSync(join(f.data, 'host-semantic-version.json')), false); assert.equal(existsSync(host.configs[0]!.dataDir), false);
});

test('migration refuses running processes and unknown table ownership before installing config', async t => {
  const f = fixture(t, 2); writeFileSync(join(f.data, 'disabled'), ''); writeFileSync(join(f.data, 'bridge.pid.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(migrateHostConfig(f.config, { dryRun: false }), /仍在运行/); rmSync(join(f.data, 'bridge.pid.json'));
  const db = new DatabaseSync(join(f.data, 'controller.sqlite')); db.exec("CREATE TABLE mystery(id TEXT); INSERT INTO mystery VALUES('unknown')"); db.close();
  const before = readFileSync(f.config); await assert.rejects(migrateHostConfig(f.config, { dryRun: false }), /无法核实数据库表/); assert.deepEqual(readFileSync(f.config), before); assert.equal(existsSync(join(f.data, 'host-semantic-version.json')), false);
});

test('startup rejects incomplete data markers and fresh hosts get a complete empty marker', t => {
  const f = fixture(t), host = loadHostConfig(['--config', f.config], false); const marker = ensureHostSemanticData(host); assert.equal(marker.status, 'complete');
  writeFileSync(join(f.data, 'host-semantic-version.json'), JSON.stringify({ version: 3, status: 'in-progress', bots: [] })); assert.throws(() => ensureHostSemanticData(host), /尚未完整提交/);
});

test('host path relocation does not rewrite prompts or external directories', () => {
  const old = join(tmpdir(), 'old-data'), next = join(tmpdir(), 'new-data'); const result = relocateHostValue({ text: join(old, 'x'), registryDir: old, imagePaths: [join(old, 'a.png'), join(tmpdir(), 'other.png')], nativeId: 'keep' }, old, next);
  assert.deepEqual(result, { text: join(old, 'x'), registryDir: next, imagePaths: [join(next, 'a.png'), join(tmpdir(), 'other.png')], nativeId: 'keep' });
});
test('space mappings are explicit per-app addresses and reject duplicate or foreign addresses', t => {
  const f = fixture(t);
  writeConfig(f, { spaces: [{ id: 'test-room', accounts: { [botA]: 'oc_botA', [botB]: 'oc_botB' } }] });
  assert.deepEqual(loadHostConfig(['--config', f.config], false).spaces, [{ id: 'test-room', accounts: { [botA]: 'oc_botA', [botB]: 'oc_botB' } }]);
  writeConfig(f, { spaces: [{ id: 'test-room', accounts: { [botA]: 'oc_botA' } }, { id: 'other', accounts: { [botA]: 'oc_botA' } }] });
  assert.throws(() => loadHostConfig(['--config', f.config], false), /多个 space/);
  writeConfig(f, { spaces: [{ id: 'test-room', accounts: { 'feishu:cli_unknown': 'oc_botA' } }] });
  assert.throws(() => loadHostConfig(['--config', f.config], false), /已启动 Bot/);
  writeConfig(f, { spaces: [{ id: 'test-room', accounts: { [botA]: 'pretty-name-is-not-a-chat-id' } }] });
  assert.throws(() => loadHostConfig(['--config', f.config], false), /有效平台地址/);
});
test('explicit owner migration keeps other history but freezes its task wakeups and pending schedules', async t => {
  const f = fixture(t, 2), otherUser = 'ou_other', scope = botA + '|'; writeFileSync(join(f.data, 'disabled'), '');
  const profilePath = join(f.local, 'bots', 'feishu', 'a.json'); const profile = JSON.parse(readFileSync(profilePath, 'utf8')); writeFileSync(profilePath, JSON.stringify({ ...profile, allowedUserIds: [userA, otherUser] }));
  const store = new SessionStore(f.data), tasks = new TaskRegistry(f.data);
  const own = store.createConversation(scope + userA, 'codex', f.root), other = store.createConversation(scope + otherUser, 'claude', f.root); store.setActive(own.userId, own.id); store.setActive(other.userId, other.id);
  const origin = { conversationId: other.id, userId: other.userId, channelId: scope + 'oc_other', originMessageId: scope + 'om_other', nativeId: null, agent: 'claude' as const, cwd: f.root };
  const context = tasks.createContext(origin), ticket = tasks.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'other task'); tasks.acceptObservedResult(ticket.taskId, 'completed', 'old result'); tasks.close(); store.close();
  const controller = new DatabaseSync(join(f.data, 'controller.sqlite')); controller.exec('CREATE TABLE controller_schedules(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,status TEXT NOT NULL,due_at TEXT NOT NULL,task_id TEXT,value_json TEXT NOT NULL)'); controller.prepare('INSERT INTO controller_schedules VALUES(?,?,?,?,?,?)').run('other-plan', other.id, 'pending', '2099-01-01T00:00:00Z', null, JSON.stringify({ id: 'other-plan', origin, status: 'pending', kind: 'controller' })); controller.close();
  const result = await migrateHostConfig(f.config, { dryRun: false, owners: { [botA]: userA } }); assert.deepEqual(result.bots[0]?.frozen, { taskIds: [ticket.taskId], scheduleIds: ['other-plan'] });
  const host = loadHostConfig(['--config', f.config], false), data = host.configs[0]!.dataDir; const migrated = new SessionStore(data); assert.ok(migrated.getConversation(other.id)); assert.equal(migrated.getActive(other.userId), null); migrated.close();
  const taskDb = new DatabaseSync(join(data, 'tasks.sqlite')); assert.equal(taskDb.prepare('SELECT wake_allowed FROM tasks WHERE id=?').get(ticket.taskId)?.wake_allowed, 0); assert.equal(taskDb.prepare('SELECT state FROM task_events WHERE task_id=?').get(ticket.taskId)?.state, 'cancelled'); taskDb.close();
  const planDb = new DatabaseSync(join(data, 'controller.sqlite')); assert.equal(planDb.prepare('SELECT status FROM controller_schedules').get()?.status, 'cancelled'); assert.equal(JSON.parse(String(planDb.prepare('SELECT value_json FROM controller_schedules').get()?.value_json)).status, 'cancelled'); planDb.close();
});

test('dry run reports unresolved live work and apply refuses to pretend that migration stopped it', async t => {
  const f = fixture(t, 2); writeFileSync(join(f.data, 'disabled'), ''); const store = new SessionStore(f.data), conversation = store.createConversation(botA + '|' + userA, 'codex', f.root); store.setActive(conversation.userId, conversation.id);
  store.addMessage({ id: botA + '|om_busy', userId: conversation.userId, channelId: botA + '|oc_busy', text: 'busy', imagePaths: [] }, conversation.id, 'uncertain'); store.close();
  assert.equal((await migrateHostConfig(f.config)).blockers.length, 1); await assert.rejects(migrateHostConfig(f.config, { dryRun: false }), /执行中或结果未知/); assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).version, 2);
});
test('migration preserves immutable continuation snapshots and their verified summary hashes', async t => {
  const f = fixture(t, 2); writeFileSync(join(f.data, 'disabled'), ''); const store = new SessionStore(f.data), user = botA + '|' + userA;
  const source = store.createConversation(user, 'codex', f.root), current = store.createConversation(user, 'codex', f.root); store.setActive(user, current.id); store.saveNativeId(current.id, 'native-current'); store.close();
  const handoffs = new SessionHandoffs(f.data); handoffs.prepare(source, current, botA + '|oc_private', [{ role: 'user', text: 'original goal and correction', at: new Date().toISOString() }], []); handoffs.finish(current, botA + '|oc_private', JSON.stringify({ workspaceContext: 'workspace rules', continuation: 'verified prior continuation' }));
  const oldSnapshot = readFileSync(join(f.data, 'session-handoffs', current.id, 'source.json')), oldSummary = readFileSync(join(f.data, 'session-handoffs', current.id, 'context.md'));
  await migrateHostConfig(f.config, { dryRun: false }); const config = loadHostConfig(['--config', f.config], false).configs[0]!;
  const migrated = new SessionHandoffs(config.dataDir); assert.equal(migrated.get(current)?.status, 'ready'); assert.deepEqual(readFileSync(join(config.dataDir, 'session-handoffs', current.id, 'source.json')), oldSnapshot); assert.deepEqual(readFileSync(join(config.dataDir, 'session-handoffs', current.id, 'context.md')), oldSummary); assert.match(migrated.prompt(current, botA + '|oc_private'), /只读桥提供的旧会话材料/);
});
test('migration explicitly includes inactive other-platform history while starting only one same-platform bot group', async t => {
  const f = fixture(t, 2), discordApp = '123456789012345678', discordUser = '234567890123456789', discordBot = 'discord:' + discordApp;
  mkdirSync(join(f.local, 'bots', 'discord'), { recursive: true }); const discordWorkspace = join(f.root, 'legacy-discord-workspace');
  writeFileSync(join(f.local, 'bots', 'discord', 'legacy.json'), JSON.stringify({ applicationId: discordApp, token: 'inactive-secret', allowedUserIds: [discordUser], workspace: discordWorkspace }));
  writeFileSync(join(f.data, 'disabled'), ''); const store = new SessionStore(f.data); const nativeIds = new Map<string, string>();
  for (const [botId, userId] of [[botA, userA], [botB, userB], [discordBot, discordUser]]) {
    const conversation = store.createConversation(botId + '|' + userId, 'codex', f.root); store.saveNativeId(conversation.id, 'native-' + botId); store.setActive(conversation.userId, conversation.id); nativeIds.set(botId!, conversation.id);
  } store.close();
  const options = { startupProfiles: ['feishu/a', 'feishu/b'], includeProfiles: ['discord/legacy'], principalIds: { [botA]: 'owner', [botB]: 'owner', [discordBot]: 'owner' } };
  await assert.rejects(migrateHostConfig(f.config, { startupProfiles: options.startupProfiles }), /includeProfiles/);
  const preview = await migrateHostConfig(f.config, options); assert.equal(preview.bots.length, 3); assert.deepEqual(preview.startupProfiles, ['feishu/a', 'feishu/b']); assert.deepEqual(preview.registeredProfiles, ['feishu/a', 'feishu/b', 'discord/legacy']);
  await migrateHostConfig(f.config, { ...options, dryRun: false }); const host = loadHostConfig(['--config', f.config], false); assert.deepEqual(host.configs.map(config => config.botId), [botA, botB]); assert.equal(host.principals.length, 1); assert.equal(Object.keys(host.principals[0]!.accounts).length, 3);
  const marker = ensureHostSemanticData(host); assert.equal(marker.bots.length, 3); const discord = marker.bots.find(bot => bot.botId === discordBot)!; assert.equal(discord.contextWorkspace, discordWorkspace);
  const inactive = new SessionStore(discord.dataDir); assert.equal(inactive.getConversation(nativeIds.get(discordBot)!)?.nativeId, 'native-' + discordBot); assert.equal(inactive.getConversation(nativeIds.get(botA)!), null); inactive.close();
  const raw = JSON.parse(readFileSync(f.config, 'utf8')); writeFileSync(f.config, JSON.stringify({ ...raw, startupProfiles: ['discord/legacy'] })); const later = loadHostConfig(['--config', f.config], false); assert.equal(later.configs.length, 1); assert.equal(later.configs[0]?.botId, discordBot); assert.equal(later.configs[0]?.workspace, discordWorkspace); assert.equal(later.configs[0]?.dataDir, discord.dataDir);
});
test('host resolves each bot default Agent independently with profile, common and Codex fallbacks', t => {
  const f = fixture(t), b = join(f.local, 'bots', 'feishu', 'b.json'), rawB = JSON.parse(readFileSync(b, 'utf8'));
  writeFileSync(b, JSON.stringify({ ...rawB, defaultAgent: 'claude' })); writeConfig(f, { defaultModels: { codex: 'config-sol', claude: 'config-haiku' } });
  const host = loadHostConfig(['--config', f.config], false); assert.deepEqual(host.configs.map(config => config.defaultAgent), ['codex', 'claude']);
  for (const config of host.configs) assert.deepEqual(config.defaultModels, { codex: 'config-sol', claude: 'config-haiku' });
  writeFileSync(b, JSON.stringify(rawB)); writeConfig(f, { defaultAgent: 'claude' }); assert.deepEqual(loadHostConfig(['--config', f.config], false).configs.map(config => config.defaultAgent), ['claude', 'claude']);
  writeConfig(f, { defaultAgent: undefined }); assert.deepEqual(loadHostConfig(['--config', f.config], false).configs.map(config => config.defaultAgent), ['codex', 'codex']);
});

test('changing a bot initialization default preserves its active controller and saved backend preferences', async t => {
  const f = fixture(t), a = join(f.local, 'bots', 'feishu', 'a.json'), rawA = JSON.parse(readFileSync(a, 'utf8'));
  const initial = loadHostConfig(['--config', f.config], false).configs[0]!, user = initial.allowedUserIds[0]!, local = new SessionStore(initial.dataDir);
  const active = local.createConversation(user, 'codex', initial.workspace, { controllerMode: true }); local.saveNativeId(active.id, 'preserved-native-sol'); local.setModel(active.id, 'saved-sol'); local.setEffort(active.id, 'high'); local.savePreferences(local.getConversation(active.id)!); local.setActive(user, active.id); local.close();
  writeFileSync(a, JSON.stringify({ ...rawA, defaultAgent: 'claude' })); const config = loadHostConfig(['--config', f.config], false).configs[0]!; assert.equal(config.defaultAgent, 'claude');
  const turns: AgentTurn[] = [], adapter: AgentAdapter = { async run(turn) { turns.push(turn); return { nativeId: turn.conversation.nativeId!, text: '', controlledOutput: true }; }, async interrupt() {}, async close() {} };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText() {} }, { mergeDelayMs: 0 });
  try {
    await manager.handle({ id: initial.scopePrefix + 'first-after-reload', userId: user, channelId: initial.scopePrefix + 'private', text: 'continue', imagePaths: [] });
    const deadline = Date.now() + 3000; while (!manager.isIdle()) { assert(Date.now() < deadline, 'manager must settle'); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
    assert.equal(turns.length, 1); assert.equal(turns[0]?.conversation.id, active.id); assert.equal(turns[0]?.conversation.agent, 'codex'); assert.equal(turns[0]?.conversation.nativeId, 'preserved-native-sol'); assert.equal(turns[0]?.conversation.model, 'saved-sol'); assert.equal(turns[0]?.conversation.effort, 'high');
    assert.equal(manager.currentConversation(user)?.id, active.id);
  } finally { await manager.close(); }
  const after = new SessionStore(config.dataDir); try { assert.deepEqual(after.preferences('codex'), { model: 'saved-sol', effort: 'high' }); } finally { after.close(); }
});
