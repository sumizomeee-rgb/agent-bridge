import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { WorkerSessionAdapter, WorkerSessionRuntime } from '../src/agents/worker-session.js';
import { sessionHome } from '../src/agents/session-home.js';
import { PresetRuntime, PresetAgentAdapter } from '../src/presets/runtime.js';
import { AgentProcessStopError, completedResultFromError } from '../src/agents/process.js';
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
test('session storage belongs to the user, scopes bot registrations, and refuses unmigrated history', t => {
  const f = fixture(t);
  const first = sessionHome(f.data, f.user, 'worker', 'codex', 'worker-A');
  assert.ok(first.startsWith(join(f.user, '.codex', 'bridge') + sep));
  assert.notEqual(first, sessionHome(join(f.root, 'other-bot'), f.user, 'worker', 'codex', 'worker-A'));
  assert.notEqual(first, sessionHome(f.data, f.user, 'preset', 'codex', 'worker-A'));
  mkdirSync(join(f.data, 'worker-homes', 'codex', 'worker-A'), { recursive: true });
  assert.throws(() => f.runtime.prepare('codex', 'worker-A', 'old-native', 'hidden', {}), /旧目录尚未迁移/);
  assert.equal(existsSync(first), false);
});

test('ordinary hidden shares the native profile without copying credentials or history', t => {
  const f=fixture(t),env=f.runtime.prepare('codex','worker-A',null,'hidden',{});
  assert.equal(env.CODEX_HOME,join(f.user,'.codex'));assert.equal(env.CODEX_SQLITE_HOME,env.CODEX_HOME);
  assert.equal(env.BRIDGE_SESSION_SOURCE,'mcp');
  const binding=sessionHome(f.data,f.user,'worker','codex','worker-A');
  assert.equal(existsSync(join(binding,'auth.json')),false);assert.equal(existsSync(join(binding,'sessions')),false);
  writeFileSync(join(f.user,'.codex/auth.json'),'new native credentials');
  const next=f.runtime.prepare('codex','worker-A','native-A','hidden',{});
  assert.equal(next.CODEX_HOME,env.CODEX_HOME);assert.equal(readFileSync(join(next.CODEX_HOME!,'auth.json'),'utf8'),'new native credentials');
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
test('ordinary hidden Claude uses native projects and an SDK entrypoint without copying user settings', t => {
  const f=fixture(t),env=f.runtime.prepare('claude','worker-CC',null,'hidden',{});
  assert.equal(env.CLAUDE_CONFIG_DIR,join(f.user,'.claude'));assert.equal(env.CLAUDE_CODE_ENTRYPOINT,'sdk-cli');
  assert.equal(existsSync(join(sessionHome(f.data,f.user,'worker','claude','worker-CC'),'settings.json')),false);
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
    const privateConfig = readFileSync(join(first.env.CODEX_HOME!, 'config.toml'), 'utf8'), route = parse(privateConfig);
    assert.equal(route.model_provider, 'bridge_preset'); assert.equal(route.model, 'gpt-6-luna');
    assert.match(JSON.stringify(route.model_providers), /BRIDGE_PRESET_API_KEY/);
    assert.doesNotMatch(privateConfig, /preset-only-key|user-provider/);
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


for (const preset of [false, true]) for (const completedThroughError of [false, true]) {
  test(`${preset ? 'preset' : 'ordinary'} worker preserves a report across nested close failures (${completedThroughError})`, async t => {
    const f = fixture(t), report = { nativeId: 'completed-native', text: '已交报告；测试尚未完成' };
    let refuse = true, runs = 0;
    const factory = (): AgentAdapter => ({
      run: async () => { runs++; if (completedThroughError) throw new AgentProcessStopError(123, report); return report; },
      interrupt: async () => {}, close: async () => { if (refuse) throw new Error('nested close failed'); }, confirmStopped: async () => !refuse,
    });
    const runtime = new PresetRuntime(f.privateRoot, f.data, f.user);
    const binding = { id: 'test', targetId: 'local', ...await runtime.describe('test-codex', 1, 'codex', 'gpt-6-luna') };
    const adapter = preset ? new PresetAgentAdapter(runtime, binding, f.command, {}, factory, 'hidden')
      : new WorkerSessionAdapter(f.runtime, 'codex', 'hidden', f.command, {}, factory);
    const turn: AgentTurn = { conversation: { id: 'nested-worker', userId: 'owner', agent: 'codex', model: 'gpt-6-luna', nativeId: null,
      title: '', cwd: f.root, createdAt: '', updatedAt: '' }, text: 'hello', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
    try {
      if (completedThroughError) await assert.rejects(adapter.run(turn), error => { assert.deepEqual(completedResultFromError(error), report); return true; });
      else { const result = await adapter.run(turn); assert.equal(result.nativeId, report.nativeId); assert.equal(result.text, report.text); assert.equal(result.processStopped, false); }
      assert.equal(await adapter.confirmStopped('nested-worker'), false);
      await assert.rejects(adapter.run(turn), /仍在执行/); assert.equal(runs, 1);
      refuse = false; await adapter.interrupt('nested-worker');
      assert.equal(await adapter.confirmStopped('nested-worker'), true);
    } finally { refuse = false; await adapter.close(); }
  });
}

test('completed report reader validates serialized native results without trusting a forged error shape', () => {
  assert.deepEqual(completedResultFromError({ nativeResult: { nativeId: 'serialized-native', text: 'retained' } }),
    { nativeId: 'serialized-native', text: 'retained' });
  for (const value of [null, 'failure', { nativeResult: null }, { nativeResult: { nativeId: '', text: 'x' } },
    { nativeResult: { nativeId: 'native', text: 1 } }]) assert.equal(completedResultFromError(value), undefined);
});

for (const preset of [false, true]) for (const proof of [false, true]) test(`${preset ? 'preset' : 'ordinary'} wrapper recovers a shutdown-only completed report only with confirmed native exit (${proof})`, async t => {
  const f = fixture(t), report = { nativeId: 'shutdown-only-native', text: 'Complete native report, business work still needs review' };
  let closed = false, runs = 0;
  const factory = (): AgentAdapter => ({
    async run() { runs++; throw new AgentProcessStopError(123, report); },
    async close() { closed = true; }, async interrupt() {}, async confirmStopped() { return proof; },
  });
  const runtime = new PresetRuntime(f.privateRoot, f.data, f.user);
  const binding = { id: 'test', targetId: 'local', ...await runtime.describe('test-codex', 1, 'codex', 'gpt-6-luna') };
  const adapter = preset ? new PresetAgentAdapter(runtime, binding, f.command, {}, factory, 'hidden')
    : new WorkerSessionAdapter(f.runtime, 'codex', 'hidden', f.command, {}, factory);
  const turn: AgentTurn = { conversation: { id: 'shutdown-only-worker', userId: 'owner', agent: 'codex', model: 'gpt-6-luna', nativeId: null,
    title: '', cwd: f.root, createdAt: '', updatedAt: '' }, text: 'one task', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
  try {
    if (proof) { assert.deepEqual(await adapter.run(turn), report); assert.equal(await adapter.confirmStopped('shutdown-only-worker'), true); }
    else { await assert.rejects(adapter.run(turn), AgentProcessStopError); assert.equal(await adapter.confirmStopped('shutdown-only-worker'), false); }
    assert.equal(runs, 1);
  } finally { await adapter.close(); }
});
for (const preset of [false, true]) test(`${preset ? 'preset' : 'ordinary'} wrapper keeps genuine result uncertainty through cleanup failure and later stop proof`, async t => {
  const f = fixture(t), report = { nativeId: 'truly-uncertain-native', text: 'A saved report does not resolve this uncertainty' };
  let refuse = true;
  const factory = (): AgentAdapter => ({
    async run(current) { current.onReady?.(); throw Object.assign(new Error('effects must be reconciled'), { nativeResult: report, resultUncertain: true }); },
    async close() { if (refuse) throw new Error('secondary cleanup failed'); }, async interrupt() {}, async confirmStopped() { return !refuse; },
  });
  const runtime = new PresetRuntime(f.privateRoot, f.data, f.user);
  const binding = { id: 'test', targetId: 'local', ...await runtime.describe('test-codex', 1, 'codex', 'gpt-6-luna') };
  const adapter = preset ? new PresetAgentAdapter(runtime, binding, f.command, {}, factory, 'hidden')
    : new WorkerSessionAdapter(f.runtime, 'codex', 'hidden', f.command, {}, factory);
  const turn: AgentTurn = { conversation: { id: 'truly-uncertain-worker', userId: 'owner', agent: 'codex', model: 'gpt-6-luna', nativeId: null,
    title: '', cwd: f.root, createdAt: '', updatedAt: '' }, text: 'one task', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
  try {
    await assert.rejects(adapter.run(turn), error => {
      assert(error instanceof AgentProcessStopError); assert.equal((error as AgentProcessStopError & { resultUncertain?: boolean }).resultUncertain, true);
      assert.deepEqual(completedResultFromError(error), report); return true;
    });
    assert.equal(await adapter.confirmStopped('truly-uncertain-worker'), false);
    refuse = false; assert.equal(await adapter.confirmStopped('truly-uncertain-worker'), true);
  } finally { refuse = false; await adapter.close(); }
});
