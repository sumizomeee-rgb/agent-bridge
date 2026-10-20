import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WorkerSessionAdapter, WorkerSessionRuntime } from '../src/agents/worker-session.js';
import { PresetRuntime } from '../src/presets/runtime.js';
import type { AgentAdapter, AgentCommand, AgentTurn } from '../src/types.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-session-visibility-')), user = join(root, 'user'), data = join(root, 'data'), privateRoot = join(root, 'private');
  mkdirSync(privateRoot); mkdirSync(join(user, '.codex', 'sessions'), { recursive: true }); mkdirSync(join(user, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(user, '.codex/config.toml'), 'model_provider="user-provider"\n'); writeFileSync(join(user, '.codex/auth.json'), '{"key":"native-file-credential"}');
  writeFileSync(join(user, '.codex/sessions/user-history'), 'never copy this');
  writeFileSync(join(user, '.claude/settings.json'), '{"env":{"ANTHROPIC_MODEL":"user-model"}}');
  writeFileSync(join(user, '.claude/.credentials.json'), '{"token":"native-file-token"}'); writeFileSync(join(user, '.claude.json'), '{"hasCompletedOnboarding":true}');
  const profiles = [
    { id: 'test-codex', revision: 1, agent: 'codex', model: 'gpt-6-luna', baseUrl: 'https://fixed.example', credentialId: 'private', transport: { kind: 'direct' } },
    { id: 'test-claude', revision: 1, agent: 'claude', model: 'glm-5.3-flash', baseUrl: 'https://fixed.example', credentialId: 'private', transport: { kind: 'direct' } },
  ];
  writeFileSync(join(privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles }));
  writeFileSync(join(privateRoot, 'credentials.json'), JSON.stringify({ version: 1, credentials: { private: { apiKey: 'preset-only-key' } } }));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  return { root, user, data, privateRoot, runtime: new WorkerSessionRuntime(data, user), command: { command: process.execPath, args: [] } };
}
test('ordinary hidden sessions retain credentials and history across runtime reconstruction without touching native history', t => {
  const f = fixture(t), env = f.runtime.prepare('codex', 'worker-A', null, 'hidden', {}), home = env.CODEX_HOME!;
  assert.notEqual(home, join(f.user, '.codex')); assert.equal(env.CODEX_SQLITE_HOME, home);
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"key":"native-file-credential"}');
  assert.equal(existsSync(join(home, 'sessions/user-history')), false);
  mkdirSync(join(home, 'sessions')); writeFileSync(join(home, 'sessions/worker-history'), 'same native history');
  writeFileSync(join(home, 'auth.json'), '{"key":"cli-refreshed"}');
  const next = new WorkerSessionRuntime(f.data, f.user).prepare('codex', 'worker-A', 'native-A', 'hidden', {});
  assert.equal(next.CODEX_HOME, home); assert.equal(readFileSync(join(home, 'sessions/worker-history'), 'utf8'), 'same native history');
  assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), '{"key":"cli-refreshed"}');
  assert.equal(readFileSync(join(f.user, '.codex/auth.json'), 'utf8'), '{"key":"native-file-credential"}');
  assert.equal(existsSync(join(f.user, '.codex/sessions/worker-history')), false);
});
test('ordinary visible uses the target native profile, not another worker home; visibility and location cannot drift', t => {
  const f = fixture(t), env = f.runtime.prepare('claude', 'visible-A', null, 'visible', {});
  assert.equal(env.CLAUDE_CONFIG_DIR, join(f.user, '.claude')); assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'local-agent');
  const next = f.runtime.prepare('claude', 'visible-A', 'same-native', 'visible', { CLAUDE_CONFIG_DIR: join(f.root, 'changed-profile') });
  assert.equal(next.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
  assert.throws(() => f.runtime.prepare('claude', 'visible-A', 'same-native', 'hidden', {}), /禁止切换/);
  assert.throws(() => f.runtime.prepare('codex', 'lost', 'native-missing', 'hidden', {}), /绑定丢失/);
  assert.throws(() => f.runtime.prepare('claude', '../escape', null, 'hidden', {}), /编号无效/);
});
test('ordinary hidden Claude keeps settings/auth but does not copy native projects or history', t => {
  const f = fixture(t); writeFileSync(join(f.user, '.claude/projects/original'), 'history');
  const env = f.runtime.prepare('claude', 'worker-CC', null, 'hidden', {});
  assert.equal(readFileSync(join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'), readFileSync(join(f.user, '.claude/settings.json'), 'utf8'));
  assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR!, 'projects')), false);
  assert.equal(JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8')).hasCompletedOnboarding, true);
});
test('visible Codex preset shares one transcript and native index while retaining private configuration and credentials', async t => {
  const f = fixture(t), runtime = new PresetRuntime(f.privateRoot, f.data, f.user);
  const binding = { id: 'test', targetId: 'local', ...await runtime.describe('test-codex', 1, 'codex', 'gpt-6-luna') };
  const first = await runtime.prepare(binding, 'preset-A', null, f.command, {}, 'visible');
  try {
    const publicHome = join(f.user, '.codex');
    assert.notEqual(first.env.CODEX_HOME, publicHome); assert.equal(first.env.CODEX_SQLITE_HOME, publicHome);
    assert.equal(realpathSync(join(first.env.CODEX_HOME!, 'sessions')), realpathSync(join(publicHome, 'sessions')));
    writeFileSync(join(first.env.CODEX_HOME!, 'sessions/same-log'), 'append once');
    assert.equal(readFileSync(join(publicHome, 'sessions/same-log'), 'utf8'), 'append once');
    assert.equal(existsSync(join(first.env.CODEX_HOME!, 'config.toml')), false);
    assert.ok(first.command.args.includes('model_provider="bridge_preset"')); assert.equal(first.env.BRIDGE_PRESET_API_KEY, 'preset-only-key');
    assert.equal(readFileSync(join(publicHome, 'auth.json'), 'utf8'), '{"key":"native-file-credential"}');
    const second = await new PresetRuntime(f.privateRoot, f.data, f.user).prepare(binding, 'preset-A', 'same-native', f.command, {}, 'visible');
    assert.equal(second.env.CODEX_HOME, first.env.CODEX_HOME); await second.close();
    await assert.rejects(runtime.prepare(binding, 'preset-A', 'same-native', f.command, {}, 'hidden'), /禁止切换/);
  } finally { await first.close(); }
});
test('visible Claude preset is discoverable without reading user provider configuration or leaking preset credentials', async t => {
  const f = fixture(t), runtime = new PresetRuntime(f.privateRoot, f.data, f.user);
  const binding = { id: 'test', targetId: 'local', ...await runtime.describe('test-claude', 1, 'claude', 'glm-5.3-flash') };
  const first = await runtime.prepare(binding, 'preset-CC', null, f.command, { ANTHROPIC_BASE_URL: 'https://wrong.example' }, 'visible');
  try {
    assert.equal(first.env.CLAUDE_CONFIG_DIR, join(f.user, '.claude')); assert.equal(first.env.CLAUDE_CODE_ENTRYPOINT, 'local-agent');
    assert.equal(first.env.ANTHROPIC_BASE_URL, 'https://fixed.example'); assert.equal(first.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
    assert.equal(first.env.ANTHROPIC_API_KEY, 'preset-only-key'); assert.ok(first.command.args.includes('--setting-sources'));
    assert.equal(readFileSync(join(f.user, '.claude/settings.json'), 'utf8'), '{"env":{"ANTHROPIC_MODEL":"user-model"}}');
  } finally { await first.close(); }
});
test('worker metadata and execution share the same persistent home; unconfirmed exits never claim stopped', async t => {
  const f = fixture(t), homes: string[] = [];
  const factory = (_command: AgentCommand, env: NodeJS.ProcessEnv): AgentAdapter => {
    homes.push(env.CODEX_HOME!);
    return { getModelInfo: async () => ({ defaultModel: 'gpt-6-luna', models: [] }),
      run: async () => { throw Object.assign(new Error('not stopped'), { processStillRunning: true }); }, interrupt: async () => {}, close: async () => {} };
  };
  const adapter = new WorkerSessionAdapter(f.runtime, 'codex', 'hidden', f.command, {}, factory);
  const turn: AgentTurn = { conversation: { id: 'worker-A', userId: 'owner', agent: 'codex', nativeId: null, title: '', cwd: f.root, createdAt: '', updatedAt: '' }, text: 'hello', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
  try {
    assert.equal(await adapter.confirmStopped('worker-A'), false, 'a fresh adapter has no exit proof for an earlier process');
    await adapter.getModelInfo(f.root, turn.conversation);
    await assert.rejects(adapter.run(turn), /not stopped/);
    assert.equal(homes[0], homes[1]); assert.equal(await adapter.confirmStopped('worker-A'), false);
  } finally { await adapter.close(); }
});
