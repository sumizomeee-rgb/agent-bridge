import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { sessionHome, sessionHomePath } from '../src/agents/session-home.js';
import { migrateSessionHomes } from '../src/agents/session-home-migration.js';
import { WorkerSessionRuntime } from '../src/agents/worker-session.js';
import { RemoteDaemon } from '../src/remote/daemon.js';

test('offline migration preserves hidden resume, routing bytes and native index; only diagnostic logs are removed', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-home-migrate-')), data = join(root, 'data'), user = join(root, 'user');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(data, 'worker-homes', 'codex', 'worker-A'), transcript = join(old, 'sessions', 'native.jsonl');
  mkdirSync(join(old, 'sessions'), { recursive: true });
  const config = Buffer.from('model_provider="independent"\n'), auth = Buffer.from('{"private":"test-key"}');
  writeFileSync(join(old, 'config.toml'), config); writeFileSync(join(old, 'auth.json'), auth);
  writeFileSync(join(old, 'profile-ready'), '1'); writeFileSync(transcript, 'original-context\n');
  writeFileSync(join(old, 'session-location.json'), JSON.stringify({ version: 1, visibility: 'hidden', profileHome: join(user, '.codex'), sqliteHome: join(user, '.codex') }));
  const db = new DatabaseSync(join(old, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
  db.prepare('INSERT INTO threads VALUES(?,?)').run('same-native', transcript); db.close();
  const logs = new DatabaseSync(join(old, 'logs_2.sqlite')); logs.exec('CREATE TABLE logs(message TEXT); INSERT INTO logs VALUES(\'diagnostic\')'); logs.close();
  assert.equal(migrateSessionHomes(data, user).length, 1); assert.equal(existsSync(transcript), true);
  const result = migrateSessionHomes(data, user, true); assert.equal(result[0]!.migrated, true); assert.ok(result[0]!.diagnosticBytesRemoved > 0);
  assert.equal(existsSync(join(data, 'worker-homes')), false);
  const env = new WorkerSessionRuntime(data, user).prepare('codex', 'worker-A', 'same-native', 'hidden', {}), home = env.CODEX_HOME!;
  assert.equal(env.CODEX_SQLITE_HOME, home); assert.deepEqual(readFileSync(join(home, 'config.toml')), config); assert.deepEqual(readFileSync(join(home, 'auth.json')), auth);
  assert.equal(readFileSync(join(home, 'sessions', 'native.jsonl'), 'utf8'), 'original-context\n');
  const index = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  assert.equal((index.prepare('SELECT rollout_path FROM threads WHERE id=?').get('same-native') as { rollout_path: string }).rollout_path, join(home, 'sessions', 'native.jsonl')); index.close();
  assert.equal(existsSync(join(user, '.codex', 'sessions')), false, 'hidden transcript is not added to the public history');
  assert.deepEqual(migrateSessionHomes(data, user, true), []);
  const moved = join(root, 'moved-data'); renameSync(data, moved);
  assert.equal(sessionHome(moved, user, 'worker', 'codex', 'worker-A'), home, 'moving the bridge data root does not change user profile identity');
});

test('migration does not overwrite an existing user directory or retire history on collision', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-home-collision-')), data = join(root, 'data'), user = join(root, 'user');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(data, 'preset-homes', 'claude', 'worker-A'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'history'), 'original');
  const destination = sessionHomePath(data, user, 'preset', 'claude', 'worker-A'); mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'history'), 'user-change');
  assert.throws(() => migrateSessionHomes(data, user, true), /未覆盖/);
  assert.equal(readFileSync(join(old, 'history'), 'utf8'), 'original'); assert.equal(readFileSync(join(destination, 'history'), 'utf8'), 'user-change');
});

test('an idle executor migrates on owned startup; a duplicate launch cannot touch profiles', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-home-startup-')), user = join(root, 'user'), data = join(root, '.local', 'remote');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { version: 1 as const, expectedHostname: hostname(), engines: { codex: { agentCommand: { command: process.execPath, args: [] }, defaultCwd: root } } };
  const old = join(data, 'worker-homes', 'codex', 'old-worker'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'history'), 'preserved');
  const daemon = new RemoteDaemon(root, config, { nativeSessionOptions: { userHome: user } });
  await daemon.listen();
  try {
    assert.equal(existsSync(old), false);
    assert.equal(readFileSync(join(sessionHome(data, user, 'worker', 'codex', 'old-worker'), 'history'), 'utf8'), 'preserved');
    const pending = join(data, 'worker-homes', 'codex', 'pending'); mkdirSync(pending, { recursive: true }); writeFileSync(join(pending, 'history'), 'untouched');
    const duplicate = new RemoteDaemon(root, config, { nativeSessionOptions: { userHome: user } });
    await assert.rejects(duplicate.listen()); await duplicate.close();
    assert.equal(readFileSync(join(pending, 'history'), 'utf8'), 'untouched');
  } finally { await daemon.close(); }
});
