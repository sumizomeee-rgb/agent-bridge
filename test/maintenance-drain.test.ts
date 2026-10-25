import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DrainStop } from '../src/shutdown.js';

test('maintenance pauses new work, waits for live summaries, and shuts down exactly once', async () => {
  let busy = true, drains = 0, shutdowns = 0, finish!: () => void;
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const stop = new DrainStop({ beginDrain: () => { drains++; }, isIdle: () => !busy,
    shutdown: async () => { shutdowns++; await closing; } });
  await stop.check(false); assert.equal(drains, 0);
  await stop.check(true); await stop.check(true); await stop.check(false);
  assert.equal(drains, 1); assert.equal(shutdowns, 0);
  busy = false;
  const first = stop.check(true); assert.equal(stop.check(true), first);
  await Promise.resolve(); assert.equal(shutdowns, 1);
  finish(); await first; await stop.check(false); assert.equal(shutdowns, 1);
});

test('maintenance preserves shutdown failure and never restarts or retries a failed close', async () => {
  let shutdowns = 0;
  const stop = new DrainStop({ beginDrain() {}, isIdle: () => true, shutdown: async () => { shutdowns++; throw new Error('exit unknown'); } });
  await assert.rejects(stop.check(true), /exit unknown/);
  await assert.rejects(stop.check(true), /exit unknown/);
  assert.equal(shutdowns, 1);
});

test('maintenance script refuses a legacy host before changing its flags and never falls back to immediate stop', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-maintenance-script-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-maintenance-script-'));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, '.local', 'data'), { recursive: true });
  copyFileSync(resolve('stop.ps1'), join(root, 'stop.ps1'));
  copyFileSync(resolve('scripts/paths.ps1'), join(root, 'scripts/paths.ps1'));
  writeFileSync(join(root, '.local/config.json'), JSON.stringify({ version: 3 }));
  const data = join(root, '.local/data'), proof = join(data, 'bridge.pid.json');
  writeFileSync(proof, JSON.stringify({ pid: 123 }));
  const legacy = spawnSync('pwsh', ['-NoProfile', '-File', join(root, 'stop.ps1'), '-Drain', '-WaitSeconds', '1'], { encoding: 'utf8', windowsHide: true });
  assert.equal(legacy.error, undefined); assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /does not support maintenance drain/);
  for (const name of ['disabled', 'stop.request', 'drain-stop.request']) assert.equal(existsSync(join(data, name)), false);
  writeFileSync(proof, JSON.stringify({ pid: 123, drainStopVersion: 1 }));
  const supported = spawnSync('pwsh', ['-NoProfile', '-File', join(root, 'stop.ps1'), '-Drain', '-WaitSeconds', '1'], { encoding: 'utf8', windowsHide: true });
  assert.equal(supported.error, undefined); assert.notEqual(supported.status, 0);
  assert.match(supported.stderr, /Stop remains pending/);
  assert.equal(existsSync(join(data, 'disabled')), true);
  assert.equal(existsSync(join(data, 'drain-stop.request')), true);
  assert.equal(existsSync(join(data, 'stop.request')), false);
});
