import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { presetMaterials } from '../src/presets/deployment.js';
import { installMaterials, readMaterials, materialsHash } from '../src/presets/materials.js';
import { parseLaunchProfiles, PresetRuntime } from '../src/presets/runtime.js';
import { RemoteDeploymentService, type ExecutorRelease } from '../src/remote/deployment.js';
import { SshRemoteClient, setRemoteDeploymentHook, requestRemoteHttp } from '../src/remote/client.js';
import { RemoteDaemon } from '../src/remote/daemon.js';
import { TargetCatalogService } from '../src/remote/catalog.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { TaskRegistry } from '../src/tasks.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';
import type { ExecutionTargetBinding } from '../src/remote/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

function fixture() {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'preset-deploy-')), 'preset-deploy-');
  const workspace = join(root, 'workspace'), privateRoot = join(root, 'executor', '.local', 'agent-presets');
  const central = join(workspace, 'agent-presets', 'private'); mkdirSync(central, { recursive: true });
  const profile = { id: 'gateway-sol', revision: 1, agent: 'codex', model: 'gpt-6.1-sol', credentialId: 'codex-key', baseUrl: 'https://gateway.example', transport: { kind: 'direct' } };
  const entry = { id: 'home-sol', aliases: ['家用 sol'], targetId: 'home', agent: 'codex', model: profile.model, profileId: profile.id, revision: 1, enabled: true };
  const target: ExecutionTargetBinding = { id: 'home', label: 'home', transport: 'ssh', expectedHostname: hostname(), sshConfig: 'ssh-config', alias: 'test', remoteRoot: join(root, 'executor'), nodePath: process.execPath, agent: 'codex', agentCommand: { command: process.execPath, args: [] }, cwd: root };
  function source(profiles: unknown[] = [profile], presets: unknown[] = [entry], credentials: unknown = { 'codex-key': { apiKey: 'isolated-test-key' }, unused: { apiKey: 'never-transfer-this' } }) {
    writeFileSync(join(workspace, 'agent-presets', 'registry.json'), JSON.stringify({ version: 1, presets }));
    writeFileSync(join(central, 'profiles.json'), JSON.stringify({ version: 1, profiles }));
    writeFileSync(join(central, 'credentials.json'), JSON.stringify({ version: 1, credentials }));
  }
  source();
  return { root, workspace, central, privateRoot, target, profile, entry, source };
}

test('工作区一次配置即可准备全新远端，只传目标已启用预设和需要的凭据', async () => {
  const f = fixture();
  f.source([f.profile, { ...f.profile, id: 'other-profile', model: 'gpt-6-luna', credentialId: 'unused' }], [f.entry,
    { ...f.entry, id: 'disabled', aliases: ['禁用'], profileId: 'other-profile', model: 'gpt-6-luna', enabled: false },
    { ...f.entry, id: 'other', aliases: ['其他电脑'], targetId: 'office', profileId: 'other-profile', model: 'gpt-6-luna' }]);
  const material = (await presetMaterials(f.workspace, f.target))!;
  assert.equal(material.profiles.length, 1); assert.equal(Object.keys(material.credentials).length, 1);
  assert.ok(!JSON.stringify(material).includes('never-transfer-this')); assert.ok(!JSON.stringify(material).includes('aliases'));
  assert.equal(existsSync(f.privateRoot), false);
  assert.deepEqual(await installMaterials(f.privateRoot, material, parseLaunchProfiles), { count: 1, changed: true });
  const runtime = new PresetRuntime(f.privateRoot, join(f.root, 'data'), join(f.root, 'user'));
  const binding = { id: f.entry.id, targetId: f.target.id, ...await runtime.describe(f.profile.id, 1, 'codex', f.profile.model) };
  const prepared = await runtime.prepare(binding, 'new-worker', null, f.target.agentCommand, {});
  try { assert.equal(prepared.env.BRIDGE_PRESET_API_KEY, 'isolated-test-key'); assert.equal(existsSync(join(f.privateRoot, 'profiles.json')), false); }
  finally { await prepared.close(); }
  assert.deepEqual(await installMaterials(f.privateRoot, material, parseLaunchProfiles), { count: 1, changed: false });
});

test('目标电脑线路差异只在工作区维护，保持本机默认线路不变', async () => {
  const f = fixture();
  const route = { kind: 'ssh-connect', sshConfig: resolve(f.root, 'home-ssh-config'), alias: 'office' };
  f.source([{ ...f.profile, targets: { home: { transport: route } } }]);
  const material = (await presetMaterials(f.workspace, f.target))!;
  assert.deepEqual(material.profiles[0]!.transport, route);
  const defaults = parseLaunchProfiles(JSON.parse(readFileSync(join(f.central, 'profiles.json'), 'utf8')));
  assert.deepEqual(defaults[0]!.transport, { kind: 'direct' });
  f.source([{ ...f.profile, targets: { home: { model: 'wrong-model' } } }]);
  await assert.rejects(presetMaterials(f.workspace, f.target), /只能覆盖传输/);
});

test('配置更换不改旧助手的线路和旧认证引用，旧手工配置也继续兼容', async () => {
  const f = fixture(), original = (await presetMaterials(f.workspace, f.target))!;
  await installMaterials(f.privateRoot, original, parseLaunchProfiles);
  writeFileSync(join(f.privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [{ ...f.profile, id: 'legacy-sol' }] }));
  writeFileSync(join(f.privateRoot, 'credentials.json'), JSON.stringify({ version: 1, credentials: { 'codex-key': { apiKey: 'legacy-key' } } }));
  const runtime = new PresetRuntime(f.privateRoot, join(f.root, 'data'), join(f.root, 'user'));
  const binding = { id: f.entry.id, targetId: 'home', ...await runtime.describe(f.profile.id, 1, 'codex', f.profile.model) };
  const first = await runtime.prepare(binding, 'old-worker', null, f.target.agentCommand, {}); await first.close();
  f.source([{ ...f.profile, revision: 2, baseUrl: 'https://next.example', credentialId: 'new-key' }], [{ ...f.entry, revision: 2 }], { 'new-key': { apiKey: 'new-test-key' } });
  await installMaterials(f.privateRoot, (await presetMaterials(f.workspace, f.target))!, parseLaunchProfiles);
  const resumed = await runtime.prepare(binding, 'old-worker', 'old-native', f.target.agentCommand, {});
  try { assert.equal(resumed.env.BRIDGE_PRESET_API_KEY, 'isolated-test-key'); assert.ok(resumed.command.args.some(arg => arg.includes('https://gateway.example'))); }
  finally { await resumed.close(); }
  const legacy = { id: 'legacy', targetId: 'home', ...await runtime.describe('legacy-sol', 1, 'codex', f.profile.model) };
  const prepared = await runtime.prepare(legacy, 'legacy-worker', null, f.target.agentCommand, {});
  try { assert.equal(prepared.env.BRIDGE_PRESET_API_KEY, 'legacy-key'); } finally { await prepared.close(); }
  await assert.rejects(runtime.prepare(binding, 'other-worker', null, f.target.agentCommand, {}), /已改变/);
});

test('损坏配置、缺凭据和跨工作区冲突不能覆盖已正常工作的资料', async () => {
  const f = fixture(), material = (await presetMaterials(f.workspace, f.target))!;
  await installMaterials(f.privateRoot, material, parseLaunchProfiles);
  const file = join(f.privateRoot, 'managed', material.owner + '.json'), before = readFileSync(file, 'utf8');
  await assert.rejects(installMaterials(f.privateRoot, { ...material, credentials: {} }, parseLaunchProfiles), /缺少/);
  await assert.rejects(installMaterials(f.privateRoot, { ...material, owner: 'b'.repeat(64) }, parseLaunchProfiles), /冲突/);
  assert.equal(readFileSync(file, 'utf8'), before);
  f.source([f.profile], [f.entry], {}); await assert.rejects(presetMaterials(f.workspace, f.target));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('明确停用的预设保持停用；没有预设的电脑继续普通派工', async () => {
  const f = fixture(); f.source([f.profile], [{ ...f.entry, enabled: false }]);
  assert.equal(await presetMaterials(f.workspace, f.target), null);
  const empty = join(f.root, 'empty-workspace'); mkdirSync(empty);
  assert.equal(await presetMaterials(empty, f.target), null);
});

test('启动扫描、离线恢复与配置失败重试走同一服务，不能只报程序已就绪', async () => {
  const f = fixture(); let now = 0, online = false, invalid = true, attempts = 0; const logs: string[] = [];
  const release = { id: 'a'.repeat(64) } as ExecutorRelease;
  const service = new RemoteDeploymentService(async () => [{ target: f.target, cwd: f.workspace }], line => logs.push(line),
    async () => ({ state: online ? 'ready' : 'offline', release: release.id }), async () => release, () => now,
    async (target, workspace) => { attempts++; if (invalid) throw new Error('this-secret-must-not-be-logged'); const material = (await presetMaterials(workspace, target))!; await installMaterials(f.privateRoot, material, parseLaunchProfiles); return material.profiles.length; });
  try {
    service.start(); assert.equal((await service.ensure(f.target, f.workspace)).state, 'offline'); assert.equal(attempts, 0);
    online = true; now += 11_000; assert.equal((await service.ensure(f.target, f.workspace)).state, 'configuration-error');
    invalid = false; now += 11_000; await service.check();
    const ready = await service.ensure(f.target, f.workspace); assert.equal(ready.state, 'ready'); assert.equal(ready.presetCount, 1);
    assert.ok(logs.every(line => !line.includes('this-secret'))); assert.equal((await readMaterials(f.privateRoot, parseLaunchProfiles)).length, 1);
  } finally { await service.close(); }
});

test('真实安装入口校验主机、校验和、Agent 入口及目标线路，不启动模型、不重启进程', async () => {
  const f = fixture(), material = (await presetMaterials(f.workspace, f.target))!, script = resolve('dist/src/presets/install.js');
  const configRoot = join(f.target.remoteRoot!, '.local', 'remote'); mkdirSync(configRoot, { recursive: true });
  writeFileSync(join(configRoot, 'config.json'), JSON.stringify({ engines: { codex: { agentCommand: f.target.agentCommand } } }));
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(run('prepare', f.target.remoteRoot!, hostname()).prepared, true);
  const file = join(f.privateRoot, 'inbox', 'payload.json'), payload = JSON.stringify(material), digest = materialsHash(payload);
  writeFileSync(file, payload); assert.equal(run('install', f.target.remoteRoot!, hostname(), file, digest).count, 1); assert.equal(existsSync(file), false);
  assert.equal(run('verify', f.target.remoteRoot!, hostname(), material.owner, digest).ready, true);
  const invalid = JSON.stringify({ ...material, profiles: [{ ...material.profiles[0], transport: { kind: 'ssh-connect', sshConfig: resolve(f.root, 'missing-ssh'), alias: 'office' } }] });
  writeFileSync(file, invalid);
  assert.throws(() => run('install', f.target.remoteRoot!, hostname(), file, materialsHash(invalid)), error => {
    assert.ok(!String(error).includes('isolated-test-key')); return true;
  });
  assert.equal(existsSync(file), false); assert.equal(run('verify', f.target.remoteRoot!, hostname(), material.owner, digest).ready, true);
  writeFileSync(file, payload); assert.throws(() => run('install', f.target.remoteRoot!, hostname(), file, '0'.repeat(64))); assert.equal(existsSync(file), false);
});

test('自动资料目录拒绝通过链接写入其他目录', async () => {
  const f = fixture(), material = (await presetMaterials(f.workspace, f.target))!, outside = join(f.root, 'outside'); mkdirSync(outside);
  mkdirSync(f.privateRoot, { recursive: true }); symlinkSync(outside, join(f.privateRoot, 'managed'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installMaterials(f.privateRoot, material, parseLaunchProfiles), /链接/);
  assert.equal(existsSync(join(outside, material.owner + '.json')), false);
});

test('中央配置失败只拒绝新预设发现，既有预设助手的健康连接继续可用', async () => {
  const f = fixture(), binding = { ...f.target, preset: { id: f.entry.id, targetId: f.target.id, profileId: f.profile.id, revision: 1, agent: 'codex' as const, model: f.profile.model, fingerprint: 'a'.repeat(64) } };
  const client = new SshRemoteClient(binding, f.workspace, 100, { requestHttp: async <T>(_port: number, _token: string, method: string) => ({ method }) as T });
  // 使用已经建立的连接，核验生产握手入口；不会调用 SSH 或访问真实执行器。
  const connected = client as unknown as { startup: Promise<void>; endpoint: { token: string } };
  connected.startup = Promise.resolve(); connected.endpoint = { token: 'fixture' };
  setRemoteDeploymentHook(async () => ({ state: 'configuration-error' }));
  try {
    assert.deepEqual(await client.request('hello', {}), { method: 'hello' });
    assert.deepEqual(await client.request('query', { dispatchId: 'old' }), { method: 'query' });
    await assert.rejects(client.request('preset/describe', {}), /预设自动配置尚未完成/);
  } finally { setRemoteDeploymentHook(undefined); await client.close(); }
});

test('先前用手工配置启动的同名 Sol 助手，在自动配置接管后仍沿旧认证续聊', async () => {
  const f = fixture(); mkdirSync(f.privateRoot, { recursive: true });
  writeFileSync(join(f.privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [f.profile] }));
  writeFileSync(join(f.privateRoot, 'credentials.json'), JSON.stringify({ version: 1, credentials: { 'codex-key': { apiKey: 'legacy-key' } } }));
  const runtime = new PresetRuntime(f.privateRoot, join(f.root, 'data'), join(f.root, 'user'));
  const binding = { id: f.entry.id, targetId: f.target.id, ...await runtime.describe(f.profile.id, 1, 'codex', f.profile.model) };
  const previous = await runtime.prepare(binding, 'legacy-worker', null, f.target.agentCommand, {}); await previous.close();
  await installMaterials(f.privateRoot, (await presetMaterials(f.workspace, f.target))!, parseLaunchProfiles);
  const resumed = await runtime.prepare(binding, 'legacy-worker', 'legacy-native', f.target.agentCommand, {});
  try { assert.equal(resumed.env.BRIDGE_PRESET_API_KEY, 'legacy-key'); } finally { await resumed.close(); }
  const fresh = { id: f.entry.id, targetId: f.target.id, ...await runtime.describe(f.profile.id, 1, 'codex', f.profile.model) };
  const next = await runtime.prepare(fresh, 'new-worker', null, f.target.agentCommand, {});
  try { assert.equal(next.env.BRIDGE_PRESET_API_KEY, 'isolated-test-key'); } finally { await next.close(); }
});

test('隔离主控复用生产派工路径：工作区自动准备、真实执行器和 CLI 子进程执行、原会话续聊', async () => {
  const f = fixture(), script = join(f.root, 'native.cjs');
  writeFileSync(script, String.raw`
const readline=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\n');let thread='isolated-native';
const input=readline.createInterface({input:process.stdin});input.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='config/read')send({id:m.id,result:{config:{model_provider:'bridge_preset'}}});
if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||thread;send({id:m.id,result:{thread:{id:thread},modelProvider:m.params.modelProvider}});}
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});setTimeout(()=>{
send({method:'item/completed',params:{threadId:thread,turnId:'turn',item:{type:'agentMessage',phase:'final_answer',id:'final',text:process.env.BRIDGE_PRESET_API_KEY==='isolated-test-key'?'AUTO_PRESET_OK':'BAD_ENV'}}});
send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn',status:'completed',items:[]}}});},10);}
});input.on('close',()=>process.exit(0));`);
  const command = { command: process.execPath, args: [script] }, remoteRoot = f.target.remoteRoot!;
  const daemonConfig = { version: 1 as const, expectedHostname: hostname(), engines: { codex: { agentCommand: command, defaultCwd: remoteRoot } } };
  const daemon = new RemoteDaemon(remoteRoot, daemonConfig); await daemon.listen();
  const endpoint = JSON.parse(readFileSync(join(daemon.dataDirectory, 'endpoint.json'), 'utf8')) as { port: number; token: string };
  mkdirSync(join(f.workspace, 'remote-agents'));
  writeFileSync(join(f.workspace, 'remote-agents', 'registry.json'), JSON.stringify({ version: 1, targets: [{ id: 'home', label: '隔离电脑', expectedHostname: hostname(),
    sshConfig: resolve(f.root, 'ssh-config'), alias: 'fixture', remoteRoot, nodePath: process.execPath, engines: daemonConfig.engines }] }));
  const engineering = join(f.root, 'engineering'); mkdirSync(engineering);
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: engineering, contextWorkspace: f.workspace,
    proxyUrl: null, commands: { codex: command, claude: command }, dataDir: join(f.root, 'controller-data'), attachmentsDir: f.root, logsDir: f.root, maxImageBytes: 1024 };
  const local: AgentAdapter = { run: async () => { throw Error('不能回退本机执行'); }, interrupt: async () => {}, close: async () => {} };
  const service = new RemoteDeploymentService(async () => [{ target: f.target, cwd: f.workspace }], () => {}, async () => ({ state: 'ready' }), async () => ({} as ExecutorRelease), Date.now,
    async (target, workspace) => { const value = (await presetMaterials(workspace, target))!; await installMaterials(f.privateRoot, value, parseLaunchProfiles); return value.profiles.length; });
  const catalog = new TargetCatalogService(config, { codex: local, claude: local }, { pollMs: 2,
    clientFactory: () => ({ request: <T>(method: string, args: unknown) => requestRemoteHttp<T>(endpoint.port, endpoint.token, method, args), close: async () => {} }) });
  const registry = new TaskRegistry(config.dataDir), runtime = new ControllerRuntime(config, { codex: local, claude: local }, registry,
    { targetCatalog: catalog, onCompletion: () => {}, onCountChanged: () => {}, onStall: () => {}, onError: () => {}, pollIntervalMs: 25 });
  try {
    service.start(); assert.equal((await service.ensure(f.target, f.workspace)).state, 'ready'); await runtime.start();
    const context = registry.createContext({ conversationId: 'parent', userId: 'owner', channelId: 'local-sink', originMessageId: 'test-message', nativeId: 'controller', agent: 'codex', cwd: engineering });
    const turn: AgentTurn = { conversation: { id: 'parent', userId: 'owner', agent: 'codex', nativeId: 'controller', cwd: engineering, model: f.profile.model, title: '隔离主控', createdAt: '', updatedAt: '' },
      text: '仅隔离测试', imagePaths: [], taskContextPath: context.contextPath, signal: new AbortController().signal, onProgress: () => {} };
    const first = await runtime.invoke(turn, 'bridge_start_worker', { presetId: f.entry.id, title: '自动准备与派工', prompt: '仅验证隔离环境' }) as { workerId: string; jobId: string };
    const completed = async (id: string) => {
      const deadline = Date.now() + 15000;
      for (;;) {
        const job = runtime.store.getJob(id)!;
        if (['completed', 'failed', 'uncertain'].includes(job.status)) { assert.equal(job.status, 'completed', job.result ?? undefined); assert.equal(job.result, 'AUTO_PRESET_OK'); return; }
        if (Date.now() > deadline) throw Error('隔离助手未按期完成'); await new Promise(done => setTimeout(done,10));
      }
    };
    await completed(first.jobId);
    const continuation = await runtime.invoke(turn, 'bridge_continue_worker', { workerId: first.workerId, prompt: '继续隔离测试', delivery: 'next' }) as { jobId: string };
    await completed(continuation.jobId);
    assert.equal(runtime.store.jobs().length, 2); assert.equal(runtime.store.getWorker(first.workerId)!.nativeId, 'isolated-native');
    assert.ok(!JSON.stringify(runtime.store.getWorker(first.workerId)).includes('isolated-test-key'));
    assert.equal(existsSync(join(remoteRoot, 'agent-presets', 'registry.json')), false);
  } finally { await runtime.close(); await catalog.close(); await service.close(); registry.close(); await daemon.close(); }
});
