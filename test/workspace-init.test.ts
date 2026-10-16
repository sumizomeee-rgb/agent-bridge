import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseTargetRegistry } from '../src/remote/catalog.js';
import { parseCapabilityRegistry } from '../src/capabilities.js';

const project = fileURLToPath(new URL('../..', import.meta.url));
const script = join(project, 'init-workspace.ps1');
const templates = ['MEMORY.md', 'README.md', 'agents.json', 'agents.example.json', 'capabilities.json', 'capabilities.example.json', 'chat-platforms/lark.md', 'chat-platforms/discord.md'];
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsOnly = { skip: process.platform !== 'win32' };

test('workspace capability skeleton and inactive example use the current registry schema', () => {
  const skeleton = parseCapabilityRegistry(JSON.parse(readFileSync(join(project, 'workspace-template', 'capabilities.json'), 'utf8')));
  assert.deepEqual(skeleton, []);
  const example = parseCapabilityRegistry(JSON.parse(readFileSync(join(project, 'workspace-template', 'capabilities.example.json'), 'utf8')));
  assert.equal(example.length, 3);
  assert.ok(example.every(item => !item.acceptance), 'An untested example must not claim an accepted capability.');
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-workspace-init-'));
  return { root, cleanup() {
    const absolute = realpathSync(root), temporaryRoot = realpathSync(tmpdir());
    assert.ok(absolute.startsWith(temporaryRoot + sep), 'Cleanup remains inside the temporary test directory.');
    rmSync(absolute, { recursive: true });
  } };
}
function run(path: string, cwd: string, entry = script) {
  // The script must work before a project runtime is restored, with no Node on PATH.
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path';
  const env = { ...process.env, [pathKey]: dirname(powershell) };
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', entry, '-Path', path],
    { cwd, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
}
function requireSuccess(result: ReturnType<typeof run>) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('workspace initializer generates usable templates from another working directory without a Node runtime', windowsOnly, () => {
  const { root, cleanup } = fixture();
  try {
    const workspace = join(root, '上下文 空间', '新工作区[原样]');
    requireSuccess(run(workspace, root));
    assert.deepEqual(readdirSync(workspace).sort(), [...new Set([...templates.map(file => file.split('/')[0]!), '.local'])].sort());
    for (const file of templates) assert.deepEqual(readFileSync(join(workspace, file)), readFileSync(join(project, 'workspace-template', file)));
    assert.deepEqual(parseTargetRegistry(JSON.parse(readFileSync(join(workspace, 'agents.json'), 'utf8').replace(/^\uFEFF/, ''))), []);
    assert.deepEqual(parseCapabilityRegistry(JSON.parse(readFileSync(join(workspace, 'capabilities.json'), 'utf8'))), []);
    assert.deepEqual(readdirSync(join(workspace, '.local')).sort(), ['deliveries', 'tmp']);
    assert.deepEqual(readdirSync(join(workspace, '.local', 'tmp')), []);
    assert.ok(readFileSync(join(workspace, 'README.md'), 'utf8').trim());
    assert.equal(existsSync(join(workspace, 'AGENTS.md')), false, 'New skeleton has only README, MEMORY and platform Markdown.');
    assert.match(readFileSync(join(workspace, 'MEMORY.md'), 'utf8'), /README\.md/);
  } finally { cleanup(); }
});

test('workspace initializer preserves edited files byte for byte and adds only missing templates on repeated runs', windowsOnly, () => {
  const { root, cleanup } = fixture();
  try {
    const workspace = join(root, '已有 工作区');
    mkdirSync(workspace);
    const custom = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('用户工作习惯\r\n保留原样\r\n')]);
    writeFileSync(join(workspace, 'README.md'), custom);
    const capabilities = Buffer.from('{\r\n  \"version\": 1, \"capabilities\": [], \"note\": \"用户维护\"\r\n}\r\n');
    writeFileSync(join(workspace, 'capabilities.json'), capabilities);
    writeFileSync(join(workspace, 'private.txt'), 'existing unrelated context');
    mkdirSync(join(workspace, '.local', 'tmp'), { recursive: true });
    writeFileSync(join(workspace, '.local', 'tmp', 'keep.txt'), 'unfinished task evidence');
    mkdirSync(join(workspace, 'chat-platforms'));
    writeFileSync(join(workspace, 'chat-platforms', 'lark.md'), custom);
    requireSuccess(run(workspace, root));
    const before = new Map([...templates, 'private.txt'].map(file => [file, readFileSync(join(workspace, file))]));
    requireSuccess(run(workspace, root));
    assert.deepEqual(readFileSync(join(workspace, 'README.md')), custom);
    assert.deepEqual(readFileSync(join(workspace, 'capabilities.json')), capabilities);
    assert.deepEqual(readFileSync(join(workspace, 'chat-platforms', 'lark.md')), custom);
    assert.equal(readFileSync(join(workspace, '.local', 'tmp', 'keep.txt'), 'utf8'), 'unfinished task evidence');
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(workspace, file)), bytes);
  } finally { cleanup(); }
});

test('workspace initializer relocates with its templates to a project path containing Chinese characters and spaces', windowsOnly, () => {
  const { root, cleanup } = fixture();
  try {
    const relocated = join(root, '迁移项目 空格');
    mkdirSync(join(relocated, 'workspace-template'), { recursive: true });
    copyFileSync(script, join(relocated, 'init-workspace.ps1'));
    for (const file of templates) {
      const destination = join(relocated, 'workspace-template', file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(project, 'workspace-template', file), destination);
    }
    assert.ok(!existsSync(join(relocated, '.local')));
    assert.ok(!existsSync(join(relocated, 'node_modules')));
    const workspace = join(root, '目标 工作区');
    requireSuccess(run(workspace, root, join(relocated, 'init-workspace.ps1')));
    assert.deepEqual(parseTargetRegistry(JSON.parse(readFileSync(join(workspace, 'agents.json'), 'utf8').replace(/^\uFEFF/, ''))), []);
  } finally { cleanup(); }
});

test('workspace initializer rejects relative paths, drive/share roots and a file used as the workspace', windowsOnly, () => {
  const { root, cleanup } = fixture();
  try {
    const file = join(root, 'existing-file.txt'); writeFileSync(file, 'keep');
    const rootPath = resolve(root).slice(0, 3);
    for (const path of ['relative-workspace', '\\root-relative-workspace', 'C:drive-relative-workspace', rootPath,
      rootPath + '.', rootPath + 'never-created\\..', '\\\\server\\share', '\\\\server\\share\\never-created\\..', file]) {
      const result = run(path, root);
      assert.equal(result.error, undefined, result.error?.message);
      assert.notEqual(result.status, 0, `Expected rejection: ${path}\n${result.stdout}${result.stderr}`);
    }
    assert.deepEqual(readdirSync(root), ['existing-file.txt']);
    assert.equal(readFileSync(file, 'utf8'), 'keep');
  } finally { cleanup(); }
});

test('workspace initializer fails before copying templates when a destination filename is already a directory', windowsOnly, () => {
  const { root, cleanup } = fixture();
  try {
    const workspace = join(root, 'collision'); mkdirSync(join(workspace, 'agents.json'), { recursive: true });
    const result = run(workspace, root);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(workspace), ['agents.json']);
  } finally { cleanup(); }
});


test('平台文档父路径被文件占用时，在复制任何模板前失败', windowsOnly, () => {
  const { root, cleanup } = fixture();
  try {
    const workspace = join(root, '平台目录碰撞'); mkdirSync(workspace);
    writeFileSync(join(workspace, 'chat-platforms'), '用户已有文件');
    const result = run(workspace, root);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(workspace), ['chat-platforms']);
    assert.equal(readFileSync(join(workspace, 'chat-platforms'), 'utf8'), '用户已有文件');
  } finally { cleanup(); }
});

test('平台文档目标被目录占用时，不生成其他模板', windowsOnly, () => {
  const { root, cleanup } = fixture();
  try {
    const workspace = join(root, '平台文件碰撞');
    mkdirSync(join(workspace, 'chat-platforms', 'lark.md'), { recursive: true });
    const result = run(workspace, root);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(workspace), ['chat-platforms']);
    assert.deepEqual(readdirSync(join(workspace, 'chat-platforms')), ['lark.md']);
  } finally { cleanup(); }
});


test('临时及交付目录路径被文件占用时提前失败，不生成部分骨架', windowsOnly, () => {
  for (const collision of ['.local', '.local/tmp', '.local/deliveries']) {
    const { root, cleanup } = fixture();
    try {
      const workspace = join(root, '运行目录碰撞');
      mkdirSync(dirname(join(workspace, collision)), { recursive: true });
      writeFileSync(join(workspace, collision), '用户文件');
      const result = run(workspace, root);
      assert.equal(result.error, undefined, result.error?.message);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(readdirSync(workspace), ['.local']);
      assert.equal(readFileSync(join(workspace, collision), 'utf8'), '用户文件');
      if (collision !== '.local') assert.deepEqual(readdirSync(join(workspace, '.local')), [collision.split('/')[1]!]);
    } finally { cleanup(); }
  }
});
