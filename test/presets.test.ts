import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { parsePresetRegistry, listPresets } from '../src/presets/registry.js';
import { parseLaunchProfiles, PresetRuntime, PresetAgentAdapter, PresetResultUnknown } from '../src/presets/runtime.js';
import { startPresetConnect } from '../src/presets/connect.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';
import type { PresetBinding } from '../src/presets/types.js';
import { TargetCatalogService } from '../src/remote/catalog.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-preset-test-')), privateRoot = join(root, 'private'), data = join(root, 'data'), user = join(root, 'user');
  mkdirSync(privateRoot); mkdirSync(user);
  const raw = { id: 'kuro-sol', revision: 1, agent: 'codex', model: 'gpt-6.1-sol', baseUrl: 'https://gateway.example', credentialId: 'kuro', transport: { kind: 'direct' } };
  const profile = parseLaunchProfiles({ version: 1, profiles: [raw] })[0]!;
  writeFileSync(join(privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [profile] }));
  writeFileSync(join(privateRoot, 'credentials.json'), JSON.stringify({ version: 1, credentials: { kuro: { apiKey: 'private-test-key' } } }));
  const runtime = new PresetRuntime(privateRoot, data, user);
  const command = { command: process.execPath, args: ['entry.js'] };
  const entry = { id: 'office-sol', aliases: ['工位 sol', '工位 6.1sol'], targetId: 'local', agent: 'codex', model: 'gpt-6.1-sol', profileId: profile.id, revision: 1, enabled: true };
  return { root, privateRoot, data, user, profile, runtime, command, entry,
    async binding(): Promise<PresetBinding> { return { id: entry.id, targetId: entry.targetId, ...await runtime.describe(profile.id, 1, 'codex', profile.model) }; },
    close() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('bridge-preset-test-')); rmSync(root, { recursive: true, force: true }); } };
}
function turn(root: string, model: string, nativeId: string | null = null): AgentTurn {
  return { conversation: { id: 'worker-A', userId: 'owner', agent: 'codex', model, nativeId, title: '', cwd: root, createdAt: '', updatedAt: '' },
    text: 'authorized task', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
}

test('预设按需发现、不探测网络；口语别名只用于查询，派发使用稳定ID', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'agent-presets'));
    writeFileSync(join(f.root, 'agent-presets/registry.json'), JSON.stringify({ version: 1, presets: [f.entry, { ...f.entry, id: 'offline', aliases: ['台式 sol'], targetId: 'home', enabled: false }] }));
    assert.equal((await listPresets(f.root)).length, 2);
    assert.deepEqual((await listPresets(f.root, { query: '工位' })).map(x => x.id), ['office-sol']);
    assert.equal((await listPresets(f.root, { targetId: 'home' }))[0]!.enabled, false);
    assert.equal((await listPresets(f.root, { agent: 'claude' })).length, 0);
    assert.throws(() => parsePresetRegistry({ version: 1, presets: [f.entry, { ...f.entry, id: 'other' }] }), /歧义/);
    assert.throws(() => parsePresetRegistry({ version: 1, presets: [{ ...f.entry, profileId: '../escape' }] }), /标识/);
  } finally { f.close(); }
});

test('目录缺失保留普通派发；损坏的预设目录明确报错，禁用项不回退', async () => {
  const f = fixture();
  const local: AgentAdapter = { run: async () => ({ nativeId: 'normal', text: 'ok' }), interrupt: async () => {}, close: async () => {} };
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: f.root, proxyUrl: null,
    commands: { codex: f.command, claude: f.command }, dataDir: f.data, logsDir: f.root, attachmentsDir: f.root, maxImageBytes: 1 };
  const catalog = new TargetCatalogService(config, { codex: local, claude: local });
  try {
    assert.deepEqual(await catalog.listPresets(f.root), []);
    assert.equal((await catalog.listTargets(f.root))[0]!.id, 'local');
    mkdirSync(join(f.root, 'agent-presets'));
    writeFileSync(join(f.root, 'agent-presets/registry.json'), JSON.stringify({ version: 1, presets: [{ ...f.entry, enabled: false }] }));
    await assert.rejects(catalog.resolvePreset(f.root, f.entry.id), /未回退/);
    writeFileSync(join(f.root, 'agent-presets/registry.json'), '{');
    await assert.rejects(catalog.listPresets(f.root));
  } finally { await catalog.close(); f.close(); }
});

test('目标配置拒绝凭据URL、任意SSH参数与错误模型映射', async () => {
  const f = fixture();
  try {
    assert.throws(() => parseLaunchProfiles({ version: 1, profiles: [{ ...f.profile, baseUrl: 'https://user:password@gateway.example' }] }), /凭据/);
    assert.throws(() => parseLaunchProfiles({ version: 1, profiles: [{ ...f.profile, transport: { kind: 'ssh-connect', sshConfig: '/config', alias: '-oProxyCommand=calc' } }] }), /SSH/);
    await assert.rejects(f.runtime.describe(f.profile.id, 1, 'claude', f.profile.model), /不一致/);
    await assert.rejects(f.runtime.describe(f.profile.id, 2, 'codex', f.profile.model), /不一致/);
  } finally { f.close(); }
});

test('独立配置覆盖继承环境，凭据只在子进程环境，快照不写认证或用户配置', async () => {
  const f = fixture();
  try {
    const binding = await f.binding();
    const prepared = await f.runtime.prepare(binding, 'worker-A', null, f.command, { openai_api_key: 'wrong-lowercase', anthropic_auth_token: 'wrong-lowercase', CLAUDE_CODE_USE_BEDROCK: '1', OPENAI_API_KEY: 'wrong', ANTHROPIC_AUTH_TOKEN: 'wrong', HTTP_PROXY: 'http://wrong', CODEX_HOME: 'wrong-home' });
    try {
      assert.equal(prepared.env.OPENAI_API_KEY, undefined); assert.equal(prepared.env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(prepared.env.HTTP_PROXY, undefined);
      assert.equal(prepared.env.openai_api_key, undefined); assert.equal(prepared.env.anthropic_auth_token, undefined); assert.equal(prepared.env.CLAUDE_CODE_USE_BEDROCK, undefined);
      assert.equal(prepared.env.BRIDGE_PRESET_API_KEY, 'private-test-key');
      assert.ok(prepared.command.args.includes('model_provider="bridge_preset"'));
      assert.ok(!JSON.stringify(prepared.command).includes('private-test-key'));
      const path = join(prepared.env.CODEX_HOME!, 'preset-binding.json');
      assert.ok(!readFileSync(path, 'utf8').includes('private-test-key'));
      assert.deepEqual(readdirSync(prepared.env.CODEX_HOME!).sort(), ['preset-binding.json']);
      assert.deepEqual(readdirSync(f.user), []);
    } finally { await prepared.close(); }
  } finally { f.close(); }
});

test('已登记助手续聊使用原快照，预设编辑不改变旧线路，新助手拒绝旧指纹', async () => {
  const f = fixture();
  try {
    const binding = await f.binding();
    const first = await f.runtime.prepare(binding, 'worker-A', null, f.command, {}); const home = first.env.CODEX_HOME; await first.close();
    writeFileSync(join(f.privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [{ ...f.profile, baseUrl: 'https://other.example', revision: 2 }] }));
    const next = await f.runtime.prepare(binding, 'worker-A', 'same-native', f.command, {});
    assert.equal(next.env.CODEX_HOME, home); assert.ok(next.command.args.includes('model_providers.bridge_preset.base_url="https://gateway.example"')); await next.close();
    await assert.rejects(f.runtime.prepare(binding, 'worker-B', null, f.command, {}), /已改变/);
    await assert.rejects(f.runtime.prepare({ ...binding, id: 'changed-preset' }, 'worker-A', 'same-native', f.command, {}), /禁止切换/);
    await assert.rejects(f.runtime.prepare(binding, 'worker-lost', 'same-native', f.command, {}), /丢失/);
  } finally { f.close(); }
});

test('不同助手有独立会话目录；同一预设不共用可变进程环境', async () => {
  const f = fixture();
  try {
    const binding = await f.binding(), first = await f.runtime.prepare(binding, 'worker-A', null, f.command, {}), second = await f.runtime.prepare(binding, 'worker-B', null, f.command, {});
    assert.notEqual(first.env.CODEX_HOME, second.env.CODEX_HOME); assert.notEqual(first.env, second.env);
    first.env.BRIDGE_PRESET_API_KEY = 'changed'; assert.equal(second.env.BRIDGE_PRESET_API_KEY, 'private-test-key');
    await first.close(); await second.close();
  } finally { f.close(); }
});

test('适配器重建后保留原生ID，元数据和执行使用同一供应商配置', async () => {
  const f = fixture(); const calls: Array<{ home?: string; provider?: string; nativeId?: string | null }> = [];
  try {
    const binding = await f.binding();
    const factory = (command: typeof f.command, env: NodeJS.ProcessEnv): AgentAdapter => ({
      getModelInfo: async () => { assert.ok(command.args.includes('model_provider="bridge_preset"')); return { defaultModel: f.profile.model, models: [] }; },
      run: async t => { calls.push({ home: env.CODEX_HOME, provider: env.BRIDGE_PRESET_API_KEY, nativeId: t.conversation.nativeId }); return { nativeId: t.conversation.nativeId ?? 'same-native', text: 'ok' }; }, interrupt: async () => {}, close: async () => {},
    });
    const a = new PresetAgentAdapter(f.runtime, binding, f.command, {}, factory);
    await a.getModelInfo(f.root); const first = await a.run(turn(f.root, f.profile.model)); await a.close();
    const b = new PresetAgentAdapter(f.runtime, binding, f.command, { OPENAI_API_KEY: 'other-user-config' }, factory);
    await b.run(turn(f.root, f.profile.model, first.nativeId)); await b.close();
    assert.equal(calls[0]!.home, calls[1]!.home); assert.equal(calls[1]!.nativeId, 'same-native'); assert.equal(calls[1]!.provider, 'private-test-key');
  } finally { f.close(); }
});

test('已开始请求的失败保留未知结果，不把断线当成可自动重放的普通失败', async () => {
  const f = fixture();
  try {
    const adapter = new PresetAgentAdapter(f.runtime, await f.binding(), f.command, {}, () => ({ run: async t => { t.onReady?.(); throw new Error('lost response'); }, interrupt: async () => {}, close: async () => {} }));
    await assert.rejects(adapter.run(turn(f.root, f.profile.model)), PresetResultUnknown);
    assert.equal(await adapter.confirmStopped('worker-A'), true); await adapter.close();
  } finally { f.close(); }
});

test('透明CONNECT拒绝其他目的地，保留不透明字节并关闭受控SSH进程', async () => {
  let spawns = 0;
  const relay = await startPresetConnect({ kind: 'ssh-connect', sshConfig: join(tmpdir(), 'fixed-config'), alias: 'fixed-host' }, 'gateway.example:443', (command, args) => {
    spawns++; assert.equal(command, 'ssh'); assert.ok(args.some(value => value.endsWith(':gateway.example:443'))); assert.ok(!args.some(value => value.includes('Bearer')));
    const forward = args[args.indexOf('-L') + 1]!, port = Number(forward.split(':')[1]);
    return spawn(process.execPath, ['-e', "require('node:net').createServer(s => s.pipe(s)).listen(Number(process.argv[1]), '127.0.0.1')", String(port)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  });
  const port = Number(new URL(relay.proxyUrl).port);
  const request = (host: string, payload: string) => new Promise<string>((resolveValue, reject) => {
    const socket = connect(port, '127.0.0.1'); let result = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('fixture timeout'))); socket.on('error', reject);
    socket.on('connect', () => socket.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`));
    let sent = false;
    socket.on('data', part => { result += String(part); if (result.includes('403') || result.includes(payload)) { socket.destroy(); resolveValue(result); }
      else if (!sent && result.includes('200 Connection established')) { sent = true; socket.write(payload); } });
  });
  try {
    assert.match(await request('other.example:443', 'opaque-denied'), /403/); assert.equal(spawns, 1);
    assert.match(await request('gateway.example:443', 'opaque-model-and-auth-bytes'), /opaque-model-and-auth-bytes/); assert.equal(spawns, 1);
  } finally { await relay.close(); }
});
