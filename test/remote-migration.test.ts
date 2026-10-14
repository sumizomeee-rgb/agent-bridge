import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteStore } from '../src/remote/store.js';
import { migrateRemoteData, ensureRemoteSemanticData } from '../src/remote-migration.js';
import type { RemoteDispatch } from '../src/remote/types.js';
test('remote offline migration preserves dispatch and native session identity with scoped ownership and request fingerprint', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-remote-migration-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.local', 'remote'), scope = 'discord:123456789012345678|';
  const request: RemoteDispatch = { dispatchId: 'dispatch-fixed', workerId: 'worker-fixed', userId: '234567890123456789',
    agent: 'codex', agentCommand: { command: process.execPath, args: [] }, nativeId: 'native-fixed', cwd: root, text: 'keep original text',
    imagePaths: [], model: 'selected', effort: 'medium', acceptSupplements: true };
  const before = new RemoteStore(directory); before.create(request); before.update(request.dispatchId, { status: 'completed', nativeId: 'native-fixed', stopped: true });
  before.bindSession('native-fixed', request.workerId, 'codex', root, request.userId); before.close();
  assert.throws(() => ensureRemoteSemanticData(root), /尚未完成/);
  await migrateRemoteData(root, '123456789012345678'); ensureRemoteSemanticData(root);
  const after = new RemoteStore(directory);
  try {
    assert.equal(after.session('native-fixed')?.userId, scope + request.userId);
    assert.equal(after.job(request.dispatchId)?.nativeId, 'native-fixed');
    assert.equal(after.request(request.dispatchId)?.text, request.text);
    assert.equal(after.create({ ...request, userId: scope + request.userId }).created, false);
    assert.equal(after.nativeLeases.get({ agent: 'codex', profile: 'default', nativeId: 'native-fixed' })?.userId, scope + request.userId);
  } finally { after.close(); }
});
