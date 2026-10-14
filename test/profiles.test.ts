import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { acquireInstanceLock } from '../src/instance-lock.js';
import { ensureSemanticData, migrateProject } from '../src/profile-migration.js';
import { profileScope } from '../src/profiles.js';
import { externalId } from '../src/routing.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry, type TaskContextFile } from '../src/tasks.js';
import { DurableIngress } from '../src/ingress.js';

const app = '123456789012345678', user = '234567890123456789', channel = '345678901234567890';
const scope = 'discord:' + app + '|';
function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-profile-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function common(root: string) { return { version: 2, startupProfile: 'discord/default', platformProfiles: { feishu: 'feishu/personal' },
  workspace: join(root, 'workspace'), dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'images'),
  commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } }; }
function writeProfile(root: string, name: string, bot: unknown): void { const [platform, alias] = name.split('/'); mkdirSync(join(root, 'bots', platform!), { recursive: true }); writeFileSync(join(root, 'bots', platform!, alias + '.json'), JSON.stringify(bot)); }
test('only version 2 common config and a named bot Profile are accepted; secrets stay local', t => {
  const root = directory(t), path = join(root, 'config.json');
  const bot = { applicationId: app, token: 'secret', allowedUserIds: [user], features: { presence: false } };
  writeProfile(root, 'discord/default', bot); writeFileSync(path, JSON.stringify(common(root)));
  const config = loadConfig(['--config', path], false);
  assert.deepEqual(config.allowedUserIds, [scope + user]); assert.deepEqual(config.externalAllowedUserIds, [user]);
  assert.equal(config.features?.presence, false); assert.equal(existsSync(config.dataDir), false);
  assert.equal(config.scopePrefix, profileScope({ ...bot, platform: 'discord', name: 'discord/alias' }));
  assert.equal(externalId(scope, scope + channel), channel);
  assert.throws(() => externalId(scope, 'discord:987654321098765432|' + channel), /不属于/);
  writeFileSync(path, JSON.stringify({ ...common(root), version: 1, token: 'secret' }));
  assert.throws(() => loadConfig(['--config', path], false), /语义迁移/);
});
test('platform convenience chooses its configured Profile; profile traversal and unsupported features fail', t => {
  const root = directory(t), path = join(root, 'config.json'); writeFileSync(path, JSON.stringify(common(root)));
  writeProfile(root, 'feishu/personal', { applicationId: 'cli_testApp', appSecret: 'private', allowedUserIds: ['ou_owner'], features: { reactions: true } });
  assert.equal(loadConfig(['--config', path, '--platform', 'feishu'], false).profile, 'feishu/personal');
  assert.throws(() => loadConfig(['--config', path, '--profile', 'feishu/../../config'], false), /Profile 必须/);
  writeProfile(root, 'feishu/personal', { applicationId: 'cli_testApp', appSecret: 'private', allowedUserIds: ['ou_owner'], features: { presence: true } });
  assert.throws(() => loadConfig(['--config', path, '--platform', 'feishu'], false), /暂不支持/);
});
test('project lock excludes every other Profile in the same checkout', async t => {
  const root = directory(t); const first = await acquireInstanceLock(root, root);
  try { await assert.rejects(acquireInstanceLock(root, root), /已有桥实例/); } finally { await new Promise<void>(done => first.close(() => done())); }
});
test('offline migration scopes routes and preserves native IDs, text, credentials and recoverable task tickets', async t => {
  const root = directory(t), local = join(root, '.local'), data = join(local, 'data'), path = join(local, 'config.json'), next = join(root, 'renamed');
  mkdirSync(data, { recursive: true }); writeFileSync(join(data, 'disabled'), '');
  const original = '\uFEFF' + JSON.stringify({ token: 'private', applicationId: '999999999999999999', allowedUserIds: [user], defaultAgent: 'codex',
    workspace: join(tmpdir(), 'outside-project'), commands: { codex: { command: join(root, 'node.exe'), args: [] }, claude: { command: join(root, 'node.exe'), args: [] } } }, null, 2).replace(/\n/g, '\r\n');
  writeFileSync(path, original);
  const store = new SessionStore(data), registry = new TaskRegistry(data), ingress = new DurableIngress(data, { allowedUserIds: [user], handle: async () => {}, hasMessage: () => false });
  const conversation = store.createConversation(user, 'codex', join(root, 'working')); store.saveNativeId(conversation.id, 'native-unchanged'); store.setActive(user, conversation.id);
  store.addMessage({ id: '456789012345678901', userId: user, channelId: channel, text: 'keep ' + user, imagePaths: [join(root, 'image.png')] }, conversation.id, 'queued');
  ingress.capture({ id: '456789012345678901', userId: user, channelId: channel, text: 'keep text', attachments: [{ id: '777', filename: 'image.png', url: 'https://cdn.test/x', size: 10 }] });
  const created = registry.createContext({ conversationId: conversation.id, userId: user, channelId: channel, originMessageId: '456789012345678901', agent: 'codex', nativeId: 'native-unchanged', cwd: join(root, 'working') });
  const context = JSON.parse(readFileSync(created.contextPath, 'utf8')) as TaskContextFile;
  const task = registry.register(context, 'preserved'); registry.acceptObservedResult(task.taskId, 'completed', 'kept');
  await ingress.close(); registry.close(); store.close();
  const home = join(data, 'controller-homes', 'codex', conversation.id); mkdirSync(home, { recursive: true });
  const native = new DatabaseSync(join(home, 'state_5.sqlite')); native.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT)'); native.prepare('INSERT INTO threads VALUES(?,?,?)').run('native-unchanged', join(home, 'sessions', 'rollout.jsonl'), join(root, 'working')); native.close();
  await assert.rejects(async () => ensureSemanticData(data), /尚未完成/);
  const migrated = await migrateProject(path, { newRoot: next, resolveIdentity: async () => app });
  const config = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(config.version, 2); assert.equal(config.token, undefined); assert.equal(config.commands.codex.command, join(next, 'node.exe'));
  assert.equal(readFileSync(path).subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(JSON.parse(readFileSync(join(local, 'bots', 'discord', 'default.json'), 'utf8')).applicationId, app);
  assert.ok(existsSync(join(migrated.backupDir, 'manifest.json')));
  const migratedStore = new SessionStore(data); assert.equal(migratedStore.getActive(scope + user)?.nativeId, 'native-unchanged'); assert.equal(migratedStore.getActive(user), null);
  const message = migratedStore.getMessage(scope + '456789012345678901')!; assert.equal(message.text, 'keep ' + user); assert.deepEqual(message.imagePaths, [join(next, 'image.png')]); migratedStore.close();
  const migratedRegistry = new TaskRegistry(data); assert.equal(migratedRegistry.queuedEvents()[0]?.channelId, scope + channel); migratedRegistry.close();
  const newContext = JSON.parse(readFileSync(created.contextPath, 'utf8')); assert.equal(newContext.token, context.token); assert.equal(newContext.registryDir, join(next, '.local', 'data'));
  const nativeAfter = new DatabaseSync(join(home, 'state_5.sqlite')); assert.equal(nativeAfter.prepare('SELECT rollout_path FROM threads').get()?.rollout_path, join(next, '.local', 'data', 'controller-homes', 'codex', conversation.id, 'sessions', 'rollout.jsonl')); nativeAfter.close();
  ensureSemanticData(data); await assert.rejects(migrateProject(path, { resolveIdentity: async () => app }), /已完成/);
});
test('migration refuses live bridge processes and leaves old files unchanged after invalid staging', async t => {
  const root = directory(t), local = join(root, '.local'), data = join(local, 'data'), path = join(local, 'config.json'); mkdirSync(data, { recursive: true });
  const raw = JSON.stringify({ token: 'private', allowedUserIds: [user] }); writeFileSync(path, raw); writeFileSync(join(data, 'disabled'), '');
  writeFileSync(join(data, 'bridge.pid.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(migrateProject(path, { resolveIdentity: async () => app }), /仍在运行/);
  const fs = await import('node:fs'); fs.unlinkSync(join(data, 'bridge.pid.json'));
  const db = new DatabaseSync(join(data, 'controller.sqlite')); db.exec("CREATE TABLE controller_workers(id TEXT, value_json TEXT); INSERT INTO controller_workers VALUES('w','invalid')"); db.close();
  await assert.rejects(migrateProject(path, { resolveIdentity: async () => app }));
  assert.equal(readFileSync(path, 'utf8'), raw); const after = new DatabaseSync(join(data, 'controller.sqlite')); assert.equal(after.prepare('SELECT value_json FROM controller_workers').get()?.value_json, 'invalid'); after.close();
  assert.equal(existsSync(join(data, 'semantic-version.json')), false);
});
test('inactive bot running messages and task receipts stay pending during another bot recovery', t => {
  const root = directory(t), a = scope + user, b = 'feishu:cli_second|ou_user';
  const store = new SessionStore(root), registry = new TaskRegistry(root);
  try {
    const ca = store.createConversation(a, 'codex', root), cb = store.createConversation(b, 'codex', root);
    store.addMessage({ id: scope + '1', userId: a, channelId: scope + channel, text: 'a', imagePaths: [] }, ca.id, 'running');
    store.addMessage({ id: 'feishu:cli_second|1700000000000|om_b', userId: b, channelId: 'feishu:cli_second|oc_b', text: 'b', imagePaths: [] }, cb.id, 'running');
    assert.equal(store.interruptRunning([a]).length, 1); assert.equal(store.getMessage('feishu:cli_second|1700000000000|om_b')?.state, 'running');
    for (const [userId, conversationId, channelId, originMessageId] of [[a, ca.id, scope + channel, scope + '1'], [b, cb.id, 'feishu:cli_second|oc_b', 'feishu:cli_second|1700000000000|om_b']]) {
      const context = registry.createContext({ userId: userId!, conversationId: conversationId!, channelId: channelId!, originMessageId: originMessageId!, agent: 'codex', nativeId: null, cwd: root });
      const ticket = registry.register(JSON.parse(readFileSync(context.contextPath, 'utf8')), 'task'); registry.acceptObservedResult(ticket.taskId, 'completed', 'done');
    }
    const events = registry.queuedEvents(); events.forEach(event => registry.claimEvent(event.id));
    assert.equal(registry.recoverProcessingEvents([a]).length, 1); assert.equal(registry.eventState(events.find(event => event.userId === b)!.id), 'processing');
  } finally { registry.close(); store.close(); }
});
