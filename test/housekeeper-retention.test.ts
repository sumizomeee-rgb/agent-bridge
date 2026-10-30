import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { retentionDays, retentionIntervalMs, sweepTransactionFiles, TransactionRetentionService, type RetentionCandidate } from '../src/housekeeper/retention.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const now = Date.parse('2026-10-30T00:00:00Z'), cutoff = now - 10 * 24 * 60 * 60 * 1000;
const realTimeout = setTimeout;
async function until(check: () => boolean) {
  const end = Date.now() + 15000;
  while (!check()) { assert(Date.now() < end, 'retention fixture did not reach the expected state'); await new Promise(resolve => realTimeout(resolve, 5)); }
}
function fixture() {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-retention-')), 'bridge-retention-');
  const publicRoot = join(root, 'public'), recycled = join(root, 'simulated-recycle'); mkdirSync(publicRoot); mkdirSync(recycled);
  const calls: RetentionCandidate[] = [];
  const recycle = async (candidate: RetentionCandidate) => {
    calls.push(candidate); renameSync(candidate.path, join(recycled, calls.length + '-' + basename(candidate.path)));
  };
  const file = (name: string, age = cutoff - 1000, content: string | Buffer = '原始正文；保留纠正。') => {
    const path = join(publicRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
    utimesSync(path, age / 1000, age / 1000); return path;
  };
  return { root, publicRoot, recycled, calls, recycle, file, options: { now: () => now, recycle } };
}

test('ten-day retention uses strict original mtime and only recycles ordinary UTF-8 public text', async () => {
  const f = fixture();
  const old = ['old.md', 'old.txt', 'old.LOG'].map(name => f.file(name));
  const preserved = [f.file('at-boundary.md', cutoff), f.file('new.txt', cutoff + 1000), f.file('raw.json'),
    f.file('binary.md', cutoff - 1000, Buffer.from([0xff, 0xfe])), f.file('nul.log', cutoff - 1000, Buffer.from([0, 1])),
    f.file('publish.md.tmp'), f.file('.hidden.md'), f.file('.hidden/nested.md')];
  mkdirSync(join(f.publicRoot, 'directory.md'));
  const result = await sweepTransactionFiles(f.publicRoot, f.options);
  assert.equal(retentionDays, 10); assert.equal(retentionIntervalMs, 86400000);
  assert.equal(result.recycled, 3); assert.equal(result.failed, 0);
  assert.deepEqual(f.calls.map(item => basename(item.path)).sort(), ['old.LOG', 'old.md', 'old.txt']);
  assert(old.every(path => !existsSync(path))); assert(preserved.every(path => existsSync(path)));
  assert(existsSync(join(f.publicRoot, 'directory.md')));
  const again = await sweepTransactionFiles(f.publicRoot, f.options);
  assert.equal(again.recycled, 0); assert.equal(f.calls.length, 3, 'already recycled files are never acted on twice');
});

test('retention skips junctions/symlinks and refuses a root reached through an ancestor link', async t => {
  const f = fixture(), outside = join(f.root, 'producer-original'); mkdirSync(outside);
  const original = join(outside, 'original.md'); writeFileSync(original, 'producer copy'); utimesSync(original, 0, 0);
  try { symlinkSync(outside, join(f.publicRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('OS does not allow test directory links'); return; } throw error; }
  const local = f.file('ordinary.md');
  const result = await sweepTransactionFiles(f.publicRoot, f.options);
  assert.equal(result.recycled, 1); assert(!existsSync(local)); assert.equal(readFileSync(original, 'utf8'), 'producer copy');
  const rootAlias = join(f.root, 'root-alias'); symlinkSync(f.publicRoot, rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const nested = f.file('nested/untouched.md');
  const throughAlias = await sweepTransactionFiles(join(rootAlias, 'nested'), f.options);
  assert.equal(throughAlias.recycled, 0); assert(throughAlias.failed > 0); assert(existsSync(nested));
});

test('Windows real Hidden directory attributes are excluded before traversing files', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), hidden = f.file('windows-hidden/private.md');
  const attrib = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'attrib.exe');
  const changed = spawnSync(attrib, ['+H', dirname(hidden)], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
  assert.equal(changed.status, 0, changed.stderr);
  const result = await sweepTransactionFiles(f.publicRoot, f.options);
  assert.equal(result.recycled, 0); assert(existsSync(hidden)); assert.equal(f.calls.length, 0);
});

test('a producer replacement after scan is preserved even when its old publication mtime is retained', async () => {
  const f = fixture(), first = f.file('a.md'), second = f.file('b.md');
  const result = await sweepTransactionFiles(f.publicRoot, { now: () => now, recycle: async candidate => {
    await f.recycle(candidate);
    if (candidate.path === first) {
      const replacement = second + '.tmp'; writeFileSync(replacement, 'new producer body'); utimesSync(replacement, (cutoff - 1000) / 1000, (cutoff - 1000) / 1000);
      renameSync(replacement, second);
    }
  } });
  assert.equal(result.recycled, 1); assert(result.skipped > 0); assert.equal(readFileSync(second, 'utf8'), 'new producer body');
  assert.equal(f.calls.some(candidate => candidate.path === second), false);
});

test('one recycle failure keeps that file and never falls back to permanent deletion or blocks the next file', async () => {
  const f = fixture(), failed = f.file('a-fails.md'), good = f.file('b-ok.md');
  const result = await sweepTransactionFiles(f.publicRoot, { now: () => now, recycle: async candidate => {
    if (candidate.path === failed) throw new Error('native recycle unavailable'); await f.recycle(candidate);
  } });
  assert.equal(result.failed, 1); assert.equal(result.recycled, 1); assert(existsSync(failed)); assert(!existsSync(good));
  assert.match(result.errors[0]!.reason, /recycle unavailable/);
});

test('large valid text above two MiB is streamed, and over-limit input stays visibly pending', async () => {
  const f = fixture(), large = f.file('large.md', cutoff - 1000, 'a'.repeat(3 * 1024 * 1024));
  const overLimit = f.file('oversize.md'); truncateSync(overLimit, 65 * 1024 * 1024); utimesSync(overLimit, 0, 0);
  const result = await sweepTransactionFiles(f.publicRoot, f.options);
  assert.equal(result.recycled, 1); assert(!existsSync(large)); assert(existsSync(overLimit)); assert.equal(result.truncated, true);
  assert(result.errors.some(item => item.path === overLimit && item.reason.includes('64MiB')));
});

test('the service deduplicates roots, starts once, runs daily and cancels later checks on close', async t => {
  const f = fixture(); f.file('old.md'); const logs: string[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = new TransactionRetentionService([f.publicRoot, f.publicRoot + sep, resolve(f.publicRoot, '.')], message => logs.push(message), f.options);
  t.after(() => service.close()); service.start(); service.start();
  await until(() => logs.length === 1); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(retentionIntervalMs - 1); assert.equal(logs.length, 1);
  t.mock.timers.tick(1); await until(() => logs.length === 2); assert.equal(f.calls.length, 1);
  await service.close(); service.start(); t.mock.timers.tick(retentionIntervalMs); await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.length, 2);
});

test('truncated batches continue only while recycling makes progress, never a zero-progress hot loop', async t => {
  const f = fixture(); for (let index = 0; index < 65; index++) f.file(String(index).padStart(3, '0') + '.md');
  const logs: string[] = []; t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = new TransactionRetentionService([f.publicRoot], message => logs.push(message), f.options); t.after(() => service.close()); service.start();
  await until(() => logs.length === 1); assert.equal(f.calls.length, 64); assert.equal(JSON.parse(logs[0]!.slice('TRANSACTION_RETENTION '.length)).truncated, true);
  t.mock.timers.tick(1000); await until(() => logs.length === 2); assert.equal(f.calls.length, 65);
  await service.close();
  const blocked = fixture(); for (let index = 0; index < 65; index++) blocked.file(String(index) + '.md', cutoff - 1000, Buffer.from([0xff]));
  const blockedLogs: string[] = [];
  const noProgress = new TransactionRetentionService([blocked.publicRoot], message => blockedLogs.push(message), blocked.options); t.after(() => noProgress.close()); noProgress.start();
  await until(() => blockedLogs.length === 1); assert.equal(blocked.calls.length, 0);
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); assert.equal(blockedLogs.length, 1);
  await noProgress.close(); t.mock.timers.tick(retentionIntervalMs); assert.equal(blockedLogs.length, 1);
});

test('close interrupts only cleanup and does not wait forever for a failing injected recycle function', async t => {
  const f = fixture(), source = f.file('old.md'); let entered = false;
  let release!: () => void; const gate = new Promise<void>(accept => { release = accept; });
  const service = new TransactionRetentionService([f.publicRoot], () => {}, { now: () => now, recycle: async () => { entered = true; await gate; } });
  t.after(async () => { release(); await service.close(); }); service.start(); await until(() => entered);
  await service.close(); assert(existsSync(source), 'closing cleanup must not remove the live source or invoke a fallback');
});

test('unsupported native recycle platforms preserve files and report the skipped check', { skip: process.platform === 'win32' }, async () => {
  const f = fixture(), source = f.file('old.md');
  const result = await sweepTransactionFiles(f.publicRoot, { now: () => now });
  assert.equal(result.unsupported, true); assert.equal(result.recycled, 0); assert(existsSync(source));
});
