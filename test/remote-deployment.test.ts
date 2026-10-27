import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { RemoteDeploymentService, type ExecutorRelease, type DeploymentResult } from '../src/remote/deployment.js';
import type { ExecutionTargetBinding } from '../src/remote/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const target: ExecutionTargetBinding = { id: 'test', label: 'test', transport: 'ssh', expectedHostname: 'host', sshConfig: 'ssh-config', alias: 'test',
  remoteRoot: 'G:\\Executor', nodePath: 'G:\\node.exe', agent: 'codex', agentCommand: { command: 'codex', args: [] }, cwd: 'G:\\Workspace' };
const release: ExecutorRelease = { id: 'a'.repeat(64), archive: '', sha256: '', helper: '', installer: '', launcher: '' };

test('启动即检查，多个 Bot 和派工共享一次更新；后续检查可重试，关闭停止检查', async () => {
  let now = 0, calls = 0, builds = 0, state: DeploymentResult['state'] = 'offline'; const logs: string[] = [];
  let finish!: (value: DeploymentResult) => void;
  const service = new RemoteDeploymentService(async () => [{ target, cwd: '.' }, { target: { ...target, agent: 'claude' }, cwd: '.' }], s => logs.push(s),
    async () => { calls++; return new Promise(done => { finish = done; }); }, async () => { builds++; return release; }, () => now);
  service.start(); await new Promise(done => setImmediate(done));
  assert.equal(calls, 1); const same = service.ensure(target, '.'); finish({ state }); await same;
  assert.equal(builds, 1); await service.check(); assert.equal(calls, 1);
  now += 11_000; state = 'busy'; const busy = service.check(); await new Promise(done => setImmediate(done)); finish({ state }); await busy;
  assert.equal(calls, 2);
  now += 11_000; state = 'ready'; const ready = service.check(); await new Promise(done => setImmediate(done)); finish({ state, release: release.id }); await ready;
  assert.equal(calls, 3); assert.equal((await service.ensure(target, '.')).state, 'ready');
  assert.equal(logs.length, 3); await service.close(); now += 60_000; await service.check(); assert.equal(calls, 3);
});

test('启动后空闲不轮询，离线电脑恢复后由下一次派工检查', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, calls = 0, scans = 0, online = false;
  const service = new RemoteDeploymentService(async () => { scans++; return [{ target, cwd: '.' }]; }, () => {},
    async () => { calls++; return { state: online ? 'ready' : 'offline' }; }, async () => release, () => now, async () => 0);
  try {
    service.start(); assert.equal((await service.ensure(target, '.')).state, 'offline');
    assert.equal(calls, 1); assert.equal(scans, 1);
    online = true; now = 60_000; t.mock.timers.tick(60_000);
    await new Promise(done => setImmediate(done));
    assert.equal(calls, 1); assert.equal(scans, 1);
    assert.equal((await service.ensure(target, '.')).state, 'ready'); assert.equal(calls, 2);
  } finally { await service.close(); }
});

test('更新失败只记状态，保留后续重试，不阻塞或伪造整个宿主启动失败', async () => {
  let now = 0, failed = true;
  const service = new RemoteDeploymentService(async () => [], () => {}, async () => { if (failed) throw Error('offline'); return { state: 'ready' }; }, async () => release, () => now);
  assert.equal((await service.ensure(target, '.')).state, 'offline'); failed = false; now = 11_000;
  assert.equal((await service.ensure(target, '.')).state, 'ready'); await service.close();
});

async function helper(mode: string, root: string, version = ''): Promise<Record<string, unknown>> {
  const script = resolve('scripts/remote-update-helper.mjs');
  return new Promise((done, fail) => execFile(process.execPath, [script, mode, root, hostname(), version], { env: { ...process.env, NODE_NO_WARNINGS: '1' } }, (error, stdout) => error ? fail(error) : done(JSON.parse(stdout))));
}
test('旧执行器缺日志、仍在运行、结果未知或有未退出进程均不作为空闲升级', async () => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'executor-update-')), 'executor-update-'), dir = join(root, '.local/remote'); mkdirSync(dir, { recursive: true });
  assert.equal((await helper('inspect', root)).idle, false);
  const db = new DatabaseSync(join(dir, 'controller.sqlite'));
  try {
    db.exec('CREATE TABLE jobs(data TEXT);CREATE TABLE processes(closed INTEGER)');
    for (const job of [{ status: 'running', stopped: true }, { status: 'uncertain' }, { status: 'completed' }, { status: 'completed', stopped: false }]) {
      db.prepare('INSERT INTO jobs VALUES(?)').run(JSON.stringify(job)); assert.equal((await helper('inspect', root)).idle, false); db.exec('DELETE FROM jobs');
    }
    db.prepare('INSERT INTO jobs VALUES(?)').run(JSON.stringify({ status: 'completed', stopped: true })); assert.equal((await helper('inspect', root)).idle, true);
    db.exec('INSERT INTO processes VALUES(0)'); assert.equal((await helper('inspect', root)).idle, false);
  } finally { db.close(); }
});
test('传输损坏时校验失败，原配置和历史不被改写', async () => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'executor-update-')), 'executor-update-'), dir = join(root, '.local/remote/releases', release.id); mkdirSync(dir, { recursive: true });
  const original = join(root, '.local/remote/config.json'); writeFileSync(original, 'original');
  writeFileSync(join(dir, 'program.js'), 'tampered');
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ id: release.id, files: { 'program.js': 'b'.repeat(64) } }));
  await assert.rejects(helper('verify', root, release.id), /checksum/);
  assert.equal(readFileSync(original, 'utf8'), 'original');
});
