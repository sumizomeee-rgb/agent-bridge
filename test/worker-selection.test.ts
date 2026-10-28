import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { ControllerStore } from '../src/controller/store.js';
import { SessionHandoffs } from '../src/controller/handoff.js';
import { parseWorkerDefaultCommand } from '../src/controller/worker-selection.js';
import { SessionManager } from '../src/manager.js';
import { TaskRegistry } from '../src/tasks.js';
import { TargetCatalogService } from '../src/remote/catalog.js';
import { slashText, GROUP_SLASH_COMMANDS } from '../src/slash.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';
import type { ControllerTargetCatalog } from '../src/controller/runtime-types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

function fixture() {
  const dir = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'worker-selection-')), 'worker-selection-');
  const turns: AgentTurn[] = [];
  const adapter: AgentAdapter = {
    async run(turn) { turns.push(turn); turn.onNativeId?.(turn.conversation.nativeId ?? `native-${turn.conversation.id}`); return { nativeId: turn.conversation.nativeId ?? `native-${turn.conversation.id}`, text: turn.text.includes('本次是用户 /new continue') ? JSON.stringify({ continuation: '历史选择测试，不自动续做' }) : 'selection-result', processStopped: true }; },
    async getModelInfo() { return { defaultModel: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-luna', 'haiku'].map(id => ({ id, displayName: id, supportedEfforts: ['low', 'medium', 'xhigh'] })) }; },
    async interrupt() {}, async close() {}, async preparePreset() { return {} as never; },
  };
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', controllerMode: true, workspace: dir,
    proxyUrl: null, commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } },
    dataDir: join(dir, 'data'), attachmentsDir: dir, logsDir: dir, maxImageBytes: 100 };
  mkdirSync(join(dir, 'remote-agents')); mkdirSync(join(dir, 'agent-presets'));
  writeFileSync(join(dir, 'remote-agents/registry.json'), JSON.stringify({ version: 1, targets: ['home', 'claude-only'].map(id => ({
    id, label: id, expectedHostname: 'fixture', sshConfig: join(dir, 'ssh-config'), alias: 'fixture', remoteRoot: dir, nodePath: process.execPath,
    engines: Object.fromEntries((id === 'home' ? ['codex', 'claude'] : ['claude']).map(agent => [agent, { agentCommand: config.commands.codex, defaultCwd: dir }])),
  })) }));
  let enabled = true, presetConnections = 0, localPreset = false;
  const presets = () => [
    { id: 'home-luna', aliases: ['家用 Luna'], targetId: 'home', agent: 'codex' as const, model: 'gpt-6-luna', profileId: 'luna', revision: 1, enabled },
    ...(localPreset ? [{ id: 'local-sol', aliases: ['本机 SOL'], targetId: 'local', agent: 'codex' as const, model: 'gpt-6.1-sol', profileId: 'sol', revision: 1, enabled }] : []),
    { id: 'disabled-local', aliases: ['停用'], targetId: 'local', agent: 'codex' as const, model: 'gpt-6-luna', profileId: 'luna', revision: 1, enabled: false },
  ];
  writeFileSync(join(dir, 'agent-presets/registry.json'), JSON.stringify({ version: 1, presets: presets() }));
  const catalog = new TargetCatalogService(config, { codex: adapter, claude: adapter });
  const targetCatalog: ControllerTargetCatalog = {
    listTargets: (...args) => catalog.listTargets(...args), resolveTarget: (...args) => catalog.resolveTarget(...args),
    listPresets: async () => presets(),
    resolvePreset: async (workspace, id, cwd) => {
      presetConnections++;
      const preset = presets().find(p => p.id === id && p.enabled); if (!preset) throw new Error('预设不存在或尚未启用');
      const target = await catalog.resolveTarget(workspace, preset.targetId, preset.agent, cwd);
      return { ...target, preset: { id: preset.id, targetId: preset.targetId, profileId: preset.profileId, revision: 1, agent: preset.agent, model: preset.model, fingerprint: 'a'.repeat(64) } };
    },
    adapterFor: () => adapter, handoff: async () => { throw new Error('not authorized'); },
  };
  const registry = new TaskRegistry(config.dataDir);
  const runtime = new ControllerRuntime(config, { codex: adapter, claude: adapter }, registry, { targetCatalog, pollIntervalMs: 60000 });
  const origin = { conversationId: 'parent', userId: 'owner', channelId: 'local-sink', originMessageId: 'input', agent: 'codex' as const, nativeId: 'parent-native', cwd: dir };
  const context = registry.createContext(origin);
  const turn: AgentTurn = { conversation: { id: 'parent', userId: 'owner', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', nativeId: 'parent-native',
    title: 'parent', cwd: dir, createdAt: '2026-10-27', updatedAt: '2026-10-27' }, text: 'test', imagePaths: [], taskContextPath: context.contextPath,
    signal: new AbortController().signal, onProgress() {} };
  const launch = async (args: Record<string, unknown> = {}, name = 'bridge_start_worker') => runtime.invoke(turn, name, { title: '隔离选择测试', prompt: 'test', ...args }) as Promise<{ workerId: string; jobId: string; scheduleId?: string }>;
  return { dir, turns, config, registry, runtime, catalog, turn, launch, presetConnections: () => presetConnections, enableLocalPreset() { localPreset = true; }, disablePreset() { enabled = false; },
    async close() { await runtime.close(); await catalog.close(); registry.close(); } };
}
const flush = () => new Promise<void>(done => setImmediate(done));
function prepareContinuation(f: ReturnType<typeof fixture>): void {
  new SessionHandoffs(f.config.dataDir).prepare({ ...f.turn.conversation, id: 'previous-parent', nativeId: null }, f.turn.conversation, 'local-sink', [], []);
}

test('初始桥电脑动态跟随；远端省略或 default 均拒绝且不留下 worker/job', async () => {
  const f = fixture(); try {
    const first = await f.launch(); assert.equal(f.runtime.store.getWorker(first.workerId)!.model, 'gpt-6.1-sol');
    f.turn.conversation.model = 'gpt-6-luna'; f.turn.conversation.effort = 'xhigh';
    const second = await f.launch({ assistant: { kind: 'default' } }); assert.equal(f.runtime.store.getWorker(second.workerId)!.model, 'gpt-6-luna');
    assert.equal(f.runtime.store.getWorker(second.workerId)!.effort, 'xhigh');
    for (const assistant of [undefined, { kind: 'default' }]) await assert.rejects(f.launch({ targetId: 'home', ...(assistant ? { assistant } : {}) }), /尚未设置默认助手/);
    assert.equal(f.runtime.store.workers().length, 2); assert.equal(f.runtime.store.jobs().length, 2);
  } finally { await f.close(); }
});
test('普通固定默认与父模型/强度独立；单次明确选择覆盖默认', async () => {
  const f = fixture(); try {
    await f.runtime.workerDefaultCommand('agentworker local codex gpt-6-luna xhigh');
    const fixed = await f.launch(); assert.equal(f.runtime.store.getWorker(fixed.workerId)!.model, 'gpt-6-luna'); assert.equal(f.runtime.store.getWorker(fixed.workerId)!.effort, 'xhigh');
    const explicit = await f.launch({ assistant: { kind: 'ordinary', agent: 'codex', model: 'gpt-6.1-sol' } });
    assert.equal(f.runtime.store.getWorker(explicit.workerId)!.model, 'gpt-6.1-sol'); assert.equal(f.runtime.store.getWorker(explicit.workerId)!.effort, null);
    assert.equal(f.turn.conversation.model, 'gpt-6.1-sol'); assert.equal(f.turn.conversation.effort, 'medium');
    await f.runtime.workerDefaultCommand('agentworker local codex gpt-6-luna ultra');
    await assert.rejects(f.launch(), /不支持 ultra/);
    await f.runtime.workerDefaultCommand('agentworker local clear'); assert.deepEqual(f.runtime.store.workerDefault('local'), { kind: 'follow' });
  } finally { await f.close(); }
});
test('远端固定普通默认可以派工；未配置引擎拒绝且不改原设置', async () => {
  const f = fixture(); try {
    await f.runtime.workerDefaultCommand('agentworker home codex gpt-6-luna');
    const handle = await f.launch({ targetId: 'home' }); const worker = f.runtime.store.getWorker(handle.workerId)!;
    assert.equal(worker.target!.id, 'home'); assert.equal(worker.model, 'gpt-6-luna'); assert.equal(worker.effort, null);
    await assert.rejects(f.runtime.workerDefaultCommand('agentworker claude-only codex gpt-6-luna'), /未登记/);
    await assert.rejects(f.launch({ targetId: 'claude-only', assistant: { kind: 'ordinary', agent: 'codex', model: 'gpt-6-luna' } }), /未登记/);
    await assert.rejects(f.launch({ targetId: 'home', agent: 'codex' }), /明确指定/);
    await assert.rejects(f.launch({ targetId: 'home', model: 'default' }), /明确指定/);
    assert.equal(f.runtime.store.workerDefault('claude-only'), null);
  } finally { await f.close(); }
});
test('预设默认按电脑归属，跨电脑/禁用/混搭均拒绝，不能回退普通助手', async () => {
  const f = fixture(); try {
    await assert.rejects(f.runtime.workerDefaultCommand('agentworker local preset home-luna'), /不属于/);
    await f.runtime.workerDefaultCommand('agentworker home preset home-luna xhigh');
    const handle = await f.launch({ targetId: 'home', assistant: { kind: 'default' } });
    assert.equal(f.runtime.store.getWorker(handle.workerId)!.target!.preset!.id, 'home-luna');
    await assert.rejects(f.launch({ targetId: 'local', assistant: { kind: 'preset', presetId: 'home-luna' } }), /冲突/);
    assert.equal(f.presetConnections(), 1, '跨电脑预设在连接前拒绝');
    await assert.rejects(f.launch({ assistant: { kind: 'ordinary', agent: 'codex', model: 'gpt-6-luna' }, model: 'gpt-6.1-sol' }), /不能混用/);
    f.disablePreset(); await assert.rejects(f.launch({ targetId: 'home' }), /尚未启用/);
    assert.equal(f.presetConnections(), 1, '停用预设在连接前拒绝');
    assert.equal(f.runtime.store.workers().length, 1);
  } finally { await f.close(); }
});
test('一次查询返回所有电脑、默认与已启用候选；筛选与详情不串电脑', async () => {
  const f = fixture(); try {
    await f.runtime.workerDefaultCommand('agentworker home preset home-luna');
    const view = await f.runtime.invoke(f.turn, 'bridge_list_targets', {}) as Awaited<ReturnType<ControllerRuntime['workerChoices']>>;
    assert.equal(view.computers.length, 3); assert.equal(view.computers[0]!.defaultAssistant!.kind, 'follow');
    assert(view.computers.find(c => c.targetId === 'home')!.assistants.some(a => a.kind === 'preset' && a.presetId === 'home-luna'));
    assert(!view.computers[0]!.assistants.some(a => a.kind === 'preset'));
    const detail = await f.runtime.workerChoices({ targetId: 'local', details: true }); assert.equal(detail.computers.length, 1); assert(detail.computers[0]!.assistants.some(a => a.kind === 'preset'));
  } finally { await f.close(); }
});
test('默认按 Bot 持久保存，重开及新父会话不覆盖；已有续聊/预约保持快照', async () => {
  const f = fixture(); try {
    await f.runtime.workerDefaultCommand('agentworker local codex gpt-6-luna xhigh');
    const old = await f.launch(); await flush(); await flush();
    const plan = await f.launch({ afterSeconds: 100 }, 'bridge_schedule_worker') as unknown as { scheduleId: string };
    await f.runtime.workerDefaultCommand('agentworker local codex gpt-6.1-sol low');
    await f.runtime.invoke(f.turn, 'bridge_continue_worker', { workerId: old.workerId, prompt: 'continue', delivery: 'next' }); await flush();
    assert.equal(f.runtime.store.getWorker(old.workerId)!.model, 'gpt-6-luna'); assert.equal(f.runtime.store.getWorker(old.workerId)!.effort, 'xhigh');
    assert.equal(f.runtime.store.getSchedule(plan.scheduleId)!.worker!.model, 'gpt-6-luna');
    const reopened = new ControllerStore(f.config.dataDir); assert.equal(reopened.workerDefault('local')!.kind, 'ordinary'); reopened.close();
    const other = new ControllerStore(join(f.dir, 'other-bot')); assert.deepEqual(other.workerDefault('local'), { kind: 'follow' }); assert.equal(other.workerDefault('home'), null); other.close();
  } finally { await f.close(); }
});
test('历史续接助手读取桥电脑指定默认模型和强度；旧平铺明确参数仍可用', async () => {
  const f = fixture(); prepareContinuation(f); try {
    await f.runtime.workerDefaultCommand('agentworker local codex gpt-6-luna xhigh');
    const initialized = await f.runtime.initializeWorkspace(f.turn) as { workerId: string };
    const worker = f.runtime.store.getWorker(initialized.workerId)!; assert.equal(worker.model, 'gpt-6-luna'); assert.equal(worker.effort, 'xhigh'); assert.equal(worker.target!.id, 'local');
    const legacy = await f.launch({ targetId: 'home', agent: 'codex', model: 'gpt-6-luna', effort: 'xhigh' }); assert.equal(f.runtime.store.getWorker(legacy.workerId)!.target!.id, 'home');
  } finally { await f.close(); }
});
test('历史续接助手使用桥电脑默认预设并固定本轮选择；修改默认不重复初始化', async () => {
  const f = fixture(); prepareContinuation(f); try {
    f.enableLocalPreset(); f.turn.conversation.model = 'gpt-6-luna'; f.turn.conversation.effort = 'xhigh';
    await f.runtime.workerDefaultCommand('agentworker local preset local-sol');
    const [first, duplicate] = await Promise.all([f.runtime.initializeWorkspace(f.turn), f.runtime.initializeWorkspace(f.turn)]) as Array<{ workerId: string; jobId: string }>;
    assert.deepEqual(first, duplicate);
    const worker = f.runtime.store.getWorker(first!.workerId)!;
    assert.equal(worker.target!.id, 'local'); assert.equal(worker.target!.preset!.id, 'local-sol');
    assert.equal(worker.model, 'gpt-6.1-sol'); assert.equal(worker.effort, null); assert.equal(worker.cwd, f.dir);
    assert.equal(worker.origin.purpose, 'workspace-context'); assert.equal(worker.target!.sessionVisibility, 'hidden');
    await f.runtime.workerDefaultCommand('agentworker local codex gpt-6-luna low');
    assert.deepEqual(await f.runtime.initializeWorkspace(f.turn), first);
    assert.equal(f.runtime.store.workers().length, 1); assert.equal(f.presetConnections(), 1);
  } finally { await f.close(); }
});

test('历史续接助手支持默认切换后端；默认预设不可用时明确失败且不回退主控', async () => {
  const ordinary = fixture(); prepareContinuation(ordinary); try {
    await ordinary.runtime.workerDefaultCommand('agentworker local claude haiku xhigh');
    const handle = await ordinary.runtime.initializeWorkspace(ordinary.turn) as { workerId: string }; await flush();
    const worker = ordinary.runtime.store.getWorker(handle.workerId)!;
    assert.equal(worker.agent, 'claude'); assert.equal(worker.model, 'haiku'); assert.equal(worker.effort, 'xhigh');
    assert.equal(ordinary.turns[0]!.conversation.agent, 'claude'); assert.equal(worker.origin.agent, 'codex');
  } finally { await ordinary.close(); }
  const unavailable = fixture(); prepareContinuation(unavailable); try {
    unavailable.enableLocalPreset(); await unavailable.runtime.workerDefaultCommand('agentworker local preset local-sol');
    unavailable.disablePreset(); await assert.rejects(unavailable.runtime.initializeWorkspace(unavailable.turn), /尚未启用/);
    assert.equal(unavailable.runtime.store.workers().length, 0); assert.equal(unavailable.runtime.store.jobs().length, 0);
    assert.equal(unavailable.turns.length, 0); assert.equal(unavailable.runtime.store.getWorkspaceInitialization('parent'), undefined);
  } finally { await unavailable.close(); }
});

test('斜杠菜单、私聊命令与实际默认设置同路；无模型回合、不改群命令', async () => {
  const f = fixture(); const replies: string[] = [];
  const commandAdapter: AgentAdapter = { run: async () => { throw new Error('command must not invoke LLM'); }, interrupt: async () => {}, close: async () => {} };
  const manager = new SessionManager(f.config, { codex: commandAdapter, claude: commandAdapter },
    { sendText: async (_channel, text) => { replies.push(text); } }, { onWorkerDefaults: args => f.runtime.workerDefaultCommand(args) });
  try {
    const encoded = slashText({ name: 'default', options: [{ type: 3, name: 'args', value: 'agentworker home preset home-luna xhigh' }] });
    assert('text' in encoded); await manager.handle({ id: 'command-1', userId: 'owner', channelId: 'local-sink', text: encoded.text, imagePaths: [] });
    assert.equal(f.runtime.store.workerDefault('home')!.kind, 'preset'); assert(replies.some(s => s.includes('默认助手已保存')));
    await manager.handle({ id: 'command-2', userId: 'owner', channelId: 'local-sink', text: '/default agentworker', imagePaths: [] });
    assert(replies.some(s => s.includes('[local]') && s.includes('[home]'))); assert(!GROUP_SLASH_COMMANDS.some(c => c.name === 'default'));
    assert.throws(() => parseWorkerDefaultCommand('agentworker home follow'), /仅用于/);
    assert.throws(() => parseWorkerDefaultCommand('agentworker home codex default'), /明确指定模型/);
    assert.throws(() => parseWorkerDefaultCommand('agentworker home codex gpt-6-luna bad!'), /强度无效/);
  } finally { try { await manager.close(); } finally { await f.close(); } }
});
