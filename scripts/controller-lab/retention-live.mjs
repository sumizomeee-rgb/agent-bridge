import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Real native recycle-bin acceptance; all input files belong to one new isolated run directory.
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]?.replace(/^--/, ''), value = args[index + 1];
  assert(['runtime-root', 'run-dir'].includes(name) && value && isAbsolute(value) && !options[name], 'Expected unique absolute --runtime-root and --run-dir');
  options[name] = resolve(value);
}
assert(options['runtime-root'] && options['run-dir'] && process.platform === 'win32', 'A Windows candidate and new run directory are required');
assert(!existsSync(options['run-dir']), 'Existing lab material must not be overwritten');
mkdirSync(options['run-dir'], { recursive: true });
const root = join(options['run-dir'], 'sync'), internal = join(options['run-dir'], 'producer-internal');
mkdirSync(root); mkdirSync(internal);
const now = Math.floor(Date.now() / 1000) * 1000, day = 86400000;
const publish = (path, content, age) => {
  writeFileSync(path, content); const date = new Date(now - age * day); utimesSync(path, date, date); return path;
};
const old = [publish(join(root, 'old.md'), 'old readable text\n', 11), publish(join(root, '旧正文 with space.log'), '旧正文 😀\n', 12)];
const retained = publish(join(root, 'recent.txt'), 'recent readable text\n', 9);
const boundary = publish(join(root, 'boundary.md'), 'exact ten-day boundary\n', 10);
const producer = publish(join(internal, 'raw.json'), '{"internal":"must remain"}', 30);
const report = { startedAt: new Date().toISOString(), status: 'running', platform: process.platform, isolatedRoot: root, cases: [] };
try {
  const { sweepTransactionFiles, retentionDays } = await import(pathToFileURL(join(options['runtime-root'], 'dist/src/housekeeper/retention.js')));
  const { scanTransactionSources } = await import(pathToFileURL(join(options['runtime-root'], 'dist/src/housekeeper/sources.js')));
  assert.equal(retentionDays, 10);
  const enabledAt = new Date(now - 13 * day).toISOString();
  const before = await scanTransactionSources(root, { enabledAt, cutoff: new Date(now - 2 * day).toISOString() });
  assert(before.recordCount >= 2, 'The old files must previously be visible for the cursor-expiry assertion');
  report.sweep = await sweepTransactionFiles(root, { now: () => now });
  assert.equal(report.sweep.failed, 0, JSON.stringify(report.sweep.errors));
  assert.equal(report.sweep.unsupported, false);
  assert.equal(report.sweep.recycled, 2, 'Both expired files must be recycled by the real native adapter');
  assert(old.every(path => !existsSync(path)));
  assert(existsSync(retained) && existsSync(boundary) && existsSync(producer));
  report.cases.push('native recycle handles Unicode and spaces', 'exact ten-day boundary retained', 'producer originals untouched');
  const after = await scanTransactionSources(root, { enabledAt, cutoff: new Date(now).toISOString(), cursor: before.nextCursor });
  assert(!after.sources.some(source => source.records.some(record => record.change === 'delete')), 'Retention must not fabricate a withdrawal');
  report.cases.push('expiration prunes the old cursor without a withdrawal event');
  const repeated = await sweepTransactionFiles(root, { now: () => now });
  assert.equal(repeated.recycled, 0); assert.equal(repeated.failed, 0);
  report.cases.push('repeat check is idempotent'); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error?.message ?? String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(options['run-dir'], 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
