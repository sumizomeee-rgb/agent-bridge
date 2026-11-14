import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RemoteStore } from '../src/remote/store.js';
import type { RemoteDispatch } from '../src/remote/types.js';
import type { NativeSessionSummary, NativeSessionAdoptArgs } from '../src/native-sessions.js';
import { RemoteDaemon } from '../src/remote/daemon.js';

const oldUser = 'feishu:cli_app|ou_account', user = 'principal:owner';
function request(root: string, suffix: string, preset = false): RemoteDispatch {
  return { dispatchId: 'dispatch-' + suffix, workerId: 'worker-' + suffix, userId: oldUser, agent: 'codex',
    agentCommand: { command: 'offline', args: [] }, nativeId: 'native-' + suffix, cwd: root, text: 'original task', imagePaths: [],
    model: preset ? 'preset-model' : 'ordinary-model', effort: 'low', acceptSupplements: false,
    ...(preset ? { preset: { id: 'sol', profileId: 'route', revision: 1, fingerprint: 'a'.repeat(64), targetId: 'local', agent: 'codex' as const, model: 'preset-model' } } : {}) };
}
function stopped(store: RemoteStore, value: RemoteDispatch): void {
  store.create(value); store.update(value.dispatchId, { status: 'completed', stopped: true });
  store.bindSession(value.nativeId!, value.workerId, value.agent, value.cwd, value.userId);
}

test('explicit remote owner migration preserves ordinary preset continuation and user handback with dispatch dedupe', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-owner-')), store = new RemoteStore(root);
  try {
    const ordinary = request(root, 'ordinary'), preset = request(root, 'preset', true), handed = request(root, 'handed');
    for (const value of [ordinary, preset, handed]) stopped(store, value);
    store.handoff(handed.nativeId!);
    const lease = store.nativeLeases.get({ agent: 'codex', profile: 'default', nativeId: handed.nativeId! })!;
    assert.equal(store.migrateControllerOwners({ [oldUser]: user }).migrated, 3);
    assert.equal(store.migrateControllerOwners({ [oldUser]: user }).migrated, 0);
    for (const value of [ordinary, preset]) {
      assert.equal(store.session(value.nativeId!)!.userId, user);
      store.bindSession(value.nativeId!, value.workerId, value.agent, value.cwd, user);
      assert.equal(store.create({ ...value, userId: user }).created, false);
      assert.throws(() => store.create(value), /冲突/);
    }
    assert.deepEqual(store.request(preset.dispatchId)!.preset, preset.preset);
    assert.equal(store.session(handed.nativeId!)!.ownership, 'user');
    assert.deepEqual(store.nativeLeases.get({ agent: 'codex', profile: 'default', nativeId: handed.nativeId! }), { ...lease, userId: user });
    assert.throws(() => store.bindSession(handed.nativeId!, handed.workerId, handed.agent, handed.cwd, user));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('remote adoption replay is rekeyed only with exact original JSON fingerprint evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-owner-')), store = new RemoteStore(root);
  try {
    const info: NativeSessionSummary = { ref: { agent: 'codex', profile: 'default', nativeId: 'adopt-native' }, nativeId: 'adopt-native',
      profile: 'default', cwd: root, title: 'native', model: 'ordinary-model', effort: 'low', provider: null, revision: 'source-revision', health: 'healthy', busyEvidence: [] };
    const args: NativeSessionAdoptArgs = { ref: info.ref, workerId: 'adopt-worker', adoptionId: 'adoption', expectedRevision: info.revision };
    const result = store.nativeLeases.claim(info, oldUser, args, null);
    store.db.prepare('INSERT INTO native_session_adoptions VALUES(?,?,?)').run('unproven', 'cannot-reconstruct-original-args', JSON.stringify({ ...result, adoptionId: 'unproven' }));
    assert.equal(store.migrateControllerOwners({ [oldUser]: user }).retiredAdoptions, 1);
    const hash = createHash('sha256').update(JSON.stringify({ userId: user, ...args })).digest('hex');
    const replay = store.nativeLeases.previous(args.adoptionId, hash)!;
    assert.equal(replay.userId, user); assert.equal(replay.ownership!.userId, user); assert.equal(replay.leaseRevision, result.leaseRevision);
    assert.throws(() => store.nativeLeases.previous('unproven', hash));
    const retired = store.db.prepare('SELECT fingerprint,result_json FROM native_session_adoptions WHERE id=?').get('unproven')!;
    assert.match(String(retired.fingerprint), /^owner-migration-unreplayable:/);
    assert.equal(JSON.parse(String(retired.result_json)).ownerMigration.status, 'unreplayable');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('remote owner mapping conflicts and live executions abort atomically without changing historical data', () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-owner-')), store = new RemoteStore(root);
  try {
    const value = request(root, 'fixed'); stopped(store, value);
    store.migrateControllerOwners({ [oldUser]: user });
    const before = store.db.prepare('SELECT * FROM jobs').all();
    assert.throws(() => store.migrateControllerOwners({ [oldUser]: 'principal:another' }), /冲突/);
    assert.deepEqual(store.db.prepare('SELECT * FROM jobs').all(), before);
    assert.equal(store.session(value.nativeId!)!.userId, user);
    const active = { ...request(root, 'active'), userId: 'feishu:other|account' }; store.create(active);
    assert.throws(() => store.migrateControllerOwners({ [active.userId]: user }), /未确认退出/);
    assert.equal(store.request(active.dispatchId)!.userId, active.userId);
    assert.equal(store.db.prepare('SELECT * FROM controller_owner_migrations WHERE old_user_id=?').get(active.userId), undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('explicit owner RPC needs no old recipient and a saved mapping retries safely after a cross-database failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-owner-'));
  const daemon = new RemoteDaemon(root, { version: 1, expectedHostname: hostname(), engines: { codex: { agentCommand: { command: 'offline', args: [] }, defaultCwd: root } } },
    { nativeSessionOptions: { userHome: join(root, 'user-home') } });
  try {
    const value = request(root, 'rpc'); daemon.store.create(value);
    const owners = [{ controllerId: 'teto', botId: 'feishu:cli_app', principalId: 'owner', oldUserId: oldUser, userId: user }];
    await assert.rejects(daemon.handle('owners/migrate', { version: 2, owners }), /协议/);
    await assert.rejects(daemon.handle('owners/migrate', { version: 1, owners }), /未确认退出/);
    assert.equal(daemon.store.request(value.dispatchId)!.userId, oldUser);
    daemon.store.update(value.dispatchId, { status: 'completed', stopped: true });
    // The first RPC persisted authoritative tuples before RemoteStore rejected its live job.
    await daemon.handle('messages/directory', { directoryId: 'd'.repeat(64), recipients: [] });
    assert.equal(daemon.store.request(value.dispatchId)!.userId, user);
    assert.equal(daemon.store.create({ ...value, userId: user }).created, false);
    assert.equal((await daemon.handle('owners/migrate', { version: 1, owners }) as { migrated: number }).migrated, 0);
    await assert.rejects(daemon.handle('owners/migrate', { version: 1, owners: [{ ...owners[0], principalId: 'other', userId: 'principal:other' }] }), /冲突/);
  } finally { await daemon.close(); rmSync(root, { recursive: true, force: true }); }
});
