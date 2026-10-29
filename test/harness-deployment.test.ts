import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { executorRelease } from '../src/remote/deployment.js';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../..', import.meta.url));
const catalog = (text: string) => `version = 1\n[prompts.fixture]\npurpose = "fixture"\naudience = "worker"\ninjection = "run"\nactivation = "next run"\nsource = "fixture"\ntext = ${JSON.stringify(text)}\n`;
function copyPackage(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  // Node 24.12 cpSync garbles Unicode destinations on this Windows runtime.
  // Match the production release writer's explicit directory/file operations.
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink());
    if (entry.isDirectory()) copyPackage(join(source, entry.name), join(destination, entry.name));
    else if (entry.isFile()) copyFileSync(join(source, entry.name), join(destination, entry.name));
  }
}

test('an executor release includes versioned prompts, loads them after extraction and changes identity with prose', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'bridge-harness-release-'));
  t.after(() => {
    assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
    rmSync(temporary, { recursive: true, force: true });
  });
  const root = join(temporary, '部署 工程'), unpacked = join(temporary, '执行器 已解压');
  for (const directory of ['dist/src', 'harness', 'scripts', 'node_modules']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"harness-fixture","type":"module"}');
  copyFileSync(join(project, 'dist/src/harness.js'), join(root, 'dist/src/harness.js'));
  writeFileSync(join(root, 'harness/prompts.toml'), catalog('迁移后仍可读取 {{value}}'));
  for (const name of ['start-remote-agent.ps1', 'remote-update-helper.mjs', 'update-remote-agent.ps1']) writeFileSync(join(root, 'scripts', name), 'fixture');
  copyPackage(realpathSync(join(project, 'node_modules/smol-toml')), join(root, 'node_modules/smol-toml'));
  for (const name of ['ws', 'https-proxy-agent', 'undici']) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.0.0', dependencies: {} }));
  }
  const release = await executorRelease(root);
  const manifest = JSON.parse(readFileSync(join(root, '.local/executor-releases', release.id, 'payload/release.json'), 'utf8'));
  assert.match(manifest.files['harness/prompts.toml'], /^[a-f0-9]{64}$/);
  mkdirSync(unpacked);
  await exec('tar', ['-xzf', release.archive, '-C', unpacked], { windowsHide: true });
  const entry = pathToFileURL(join(unpacked, 'dist/src/harness.js')).href;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e',
    `const {harnessText}=await import(${JSON.stringify(entry)});process.stdout.write(harnessText('fixture',{value:'成功'}));`], { windowsHide: true });
  assert.equal(stdout, '迁移后仍可读取 成功');
  writeFileSync(join(root, 'harness/prompts.toml'), catalog('更新后的正文 {{value}}'));
  assert.notEqual((await executorRelease(root)).id, release.id, 'Prompt assets must participate in release identity.');
});
