import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

function tree(root) {
  const result = {};
  const visit = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assert(!entry.isSymbolicLink(), 'Source/runtime tree must not contain symlinks');
      const key = prefix + entry.name, path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, key + '/');
      else if (entry.isFile()) result[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  visit(root); return result;
}
function sourceSnapshot(root) {
  const result = { src: tree(join(root, 'src')), test: tree(join(root, 'test')),
    harness: existsSync(join(root, 'harness')) ? tree(join(root, 'harness')) : null };
  for (const name of ['tsconfig.json', 'package.json', 'package-lock.json']) {
    result[name] = existsSync(join(root, name)) ? createHash('sha256').update(readFileSync(join(root, name))).digest('hex') : null;
  }
  return result;
}
function runtimeSnapshot(root, includeTests) {
  return { src: tree(join(root, 'dist/src')), ...(includeTests ? { test: tree(join(root, 'dist/test')) } : {}),
    harness: existsSync(join(root, 'harness')) ? tree(join(root, 'harness')) : null };
}
function same(actual, expected, description) {
  // Do not dump whole source hashes or compiler diagnostics into chat errors.
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(description);
}
export async function verifyParity({ root, sourceRoot = root, runDir, includeTests = false,
  compiler = join(sourceRoot, 'node_modules/typescript/bin/tsc') }) {
  root = resolve(root); sourceRoot = resolve(sourceRoot);
  const source = sourceSnapshot(sourceRoot), runtime = runtimeSnapshot(root, includeTests);
  const reference = join(runDir, 'reference-build');
  assert(existsSync(compiler), 'TypeScript compiler required to verify current source; no stale-build bypass');
  const child = spawn(process.execPath, [compiler, '-p', join(sourceRoot, 'tsconfig.json'), '--outDir', reference,
    '--incremental', 'false', '--noEmit', 'false'], { cwd: sourceRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Diagnostics may contain local paths. Keep only exit status in the shared report.
  child.stdout.resume(); child.stderr.resume();
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  assert.equal(code, 0, 'Fresh reference build failed; run the normal build for diagnostics');
  const expected = { src: tree(join(reference, 'src')), ...(includeTests ? { test: tree(join(reference, 'test')) } : {}), harness: source.harness };
  same(runtime, expected, 'Runtime differs from a fresh source build (missing, stale or modified files); rebuild before testing');
  const assertUnchanged = () => {
    same(sourceSnapshot(sourceRoot), source, 'Source changed during the lab run; result invalid');
    same(runtimeSnapshot(root, includeTests), runtime, 'Runtime changed during the lab run; result invalid');
  };
  assertUnchanged();
  return { evidence: { status: 'verified', sourceRoot, runtimeRoot: root, source, runtime, includeTests,
    method: 'fresh compile into isolated reference-build, exact file-set and SHA256 equality' }, assertUnchanged };
}
