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
