import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyParity } from './parity.mjs';

test('parity rejects stale source builds and edits during a run, including extra runtime files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const compiler = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/typescript/bin/tsc');
  for (const folder of ['src', 'test', 'check']) mkdirSync(join(root, folder));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { rootDir: '.', outDir: 'dist', types: [], skipLibCheck: true }, include: ['src/**/*.ts'] }));
  const file = join(root, 'src/main.ts');
  writeFileSync(file, 'export const value = 1;\n');
  assert.equal(spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')], { windowsHide: true }).status, 0);
  const check = await verifyParity({ root, runDir: join(root, 'check'), compiler });
  check.assertUnchanged();
  writeFileSync(file, 'export const value = 2;\n');
  assert.throws(check.assertUnchanged, /Source changed/);
  await assert.rejects(verifyParity({ root, runDir: join(root, 'changed'), compiler }), /Runtime differs/);
  writeFileSync(file, 'export const value = 1;\n');
  writeFileSync(join(root, 'dist/src/orphan.js'), 'stale output');
  assert.throws(check.assertUnchanged, /Runtime changed/);
  await assert.rejects(verifyParity({ root, runDir: join(root, 'orphan'), compiler }), /Runtime differs/);
});

test('parity verifies runtime prompt assets against source and rejects prompt drift during a run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-parity-prompts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), runtime = join(root, 'runtime');
  const compiler = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/typescript/bin/tsc');
  for (const folder of [join(source, 'src'), join(source, 'test'), join(source, 'harness'), join(runtime, 'harness')]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(source, 'src/main.ts'), 'export const value = 1;\n');
  writeFileSync(join(source, 'tsconfig.json'), JSON.stringify({ compilerOptions: { rootDir: '.', outDir: join(runtime, 'dist'), types: [], skipLibCheck: true }, include: ['src/**/*.ts'] }));
  for (const directory of [source, runtime]) writeFileSync(join(directory, 'harness/prompts.toml'), 'version = 1\n');
  assert.equal(spawnSync(process.execPath, [compiler, '-p', join(source, 'tsconfig.json')], { windowsHide: true }).status, 0);
  const check = await verifyParity({ root: runtime, sourceRoot: source, runDir: join(root, 'check'), compiler });
  writeFileSync(join(runtime, 'harness/prompts.toml'), 'version = 2\n');
  assert.throws(check.assertUnchanged, /Runtime changed/);
  await assert.rejects(verifyParity({ root: runtime, sourceRoot: source, runDir: join(root, 'wrong-assets'), compiler }), /Runtime differs/);
  writeFileSync(join(runtime, 'harness/prompts.toml'), 'version = 1\n');
  writeFileSync(join(source, 'harness/prompts.toml'), 'version = 3\n');
  assert.throws(check.assertUnchanged, /Source changed/);
});
