import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry } from '../src/tasks.js';
import { ControllerLaunchAdapter } from '../src/controller/launch.js';
import { PresetRuntime, parseLaunchProfiles } from '../src/presets/runtime.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, Conversation } from '../src/types.js';
import type { PresetBinding } from '../src/presets/types.js';

const preset: PresetBinding = { id: 'bridge-sol', profileId: 'route-sol', targetId: 'local', revision: 1, fingerprint: 'a'.repeat(64), agent: 'codex', model: 'preset-model' };
class Adapter implements AgentAdapter {
  turns: AgentTurn[] = []; fail = false; closed = false;
  async run(turn: AgentTurn) { this.turns.push(turn); if (this.fail) throw new Error('preset unavailable'); const nativeId = turn.conversation.nativeId ?? `native-${turn.conversation.id}`; turn.onNativeId?.(nativeId); return { nativeId, text: '', controlledOutput: true }; }
  async getModelInfo() { return { defaultModel: 'ordinary-model', models: [{ id: 'ordinary-model', displayName: 'ordinary' }, { id: 'preset-model', displayName: 'preset' }] }; }
  async interrupt() {}
  async confirmStopped() { return true; }
  async close() { this.closed = true; }
}

test('主控预设通过现有 model 命令原子切换；new、重启保留，default 返回普通线路', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-presets-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, dataDir: join(root, 'data'), logsDir: root,
    attachmentsDir: root, maxImageBytes: 100, proxyUrl: null, controllerMode: true, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } };
  mkdirSync(join(root, 'bridge-agent-presets'));
  writeFileSync(join(root, 'bridge-agent-presets', 'registry.json'), JSON.stringify({ version: 1, presets: [
    { ...preset, aliases: ['桥 sol'], enabled: true }, { ...preset, id: 'remote', targetId: 'office', aliases: ['工位 sol'], enabled: true },
  ] }));
  const registry = new TaskRegistry(config.dataDir), adapter = new Adapter(), replies: string[] = [], rebound: Array<[Conversation, Conversation]> = [];
  let failResolve = false, seq = 0;
  const create = () => new SessionManager(config, { codex: adapter, claude: adapter }, { sendText: async (_channel, text) => { replies.push(text); } }, {
    taskRegistry: registry,
    resolveControllerPreset: async selector => { if (failResolve || !['bridge-sol', '桥 sol'].includes(selector)) throw new Error('preset not found'); return preset; },
    onPrepareSwitch: async () => ({ contextSeed: '已对齐的原始目标与必要背景' }),
    onRebindSwitch: async (source, target) => { rebound.push([source, target]); },
  });
  let manager = create();
  const send = (text: string) => manager.handle({ id: `message-${seq++}`, userId: 'owner', channelId: 'dm', text, imagePaths: [] });
  const inspect = <T>(callback: (store: SessionStore) => T) => { const store = new SessionStore(config.dataDir); try { return callback(store); } finally { store.close(); } };
  try {
    await send('/model preset'); assert.match(replies.at(-1)!, /bridge-sol/); assert.doesNotMatch(replies.at(-1)!, /工位 sol/);
    const original = inspect(s => s.getActive('owner')!);
    await send('/model preset 桥 sol');
    const selected = inspect(s => s.getActive('owner')!);
    assert.notEqual(selected.id, original.id); assert.deepEqual(selected.preset, preset); assert.equal(selected.model, preset.model);
    assert.match(selected.contextSeed!, /原始目标/); assert.equal(rebound.length, 1); assert.equal(adapter.turns.at(-1)!.conversation.preset?.id, preset.id);
    assert.equal(inspect(s => s.getConversation(original.id)!.preset), undefined);
    await send('/model preset bridge-sol'); assert.equal(inspect(s => s.getActive('owner')!.id), selected.id);
    failResolve = true; await send('/model preset missing'); assert.equal(inspect(s => s.getActive('owner')!.id), selected.id); failResolve = false;
    await send('/new'); const renewed = inspect(s => s.getActive('owner')!); assert.deepEqual(renewed.preset, preset);
    await manager.close(); manager = create(); assert.deepEqual(manager.currentConversation('owner')!.preset, preset);
    await send('/model default'); const ordinary = inspect(s => s.getActive('owner')!);
    assert.notEqual(ordinary.id, renewed.id); assert.equal(ordinary.preset, undefined); assert.equal(ordinary.model, null);
    assert.equal(inspect(s => s.preferences('codex')!.preset), undefined);
    // Target generation failure never commits the prepared route.
    adapter.fail = true; await send('/model preset bridge-sol'); assert.equal(inspect(s => s.getActive('owner')!.id), ordinary.id);
    assert.equal(inspect(s => s.preferences('codex')!.preset), undefined);
  } finally { await manager.close(); registry.close(); rmSync(root, { recursive: true, force: true }); }
});

test('主控启动路由隔离普通配置、复用本会话准备、恢复快照并拒绝远端与错模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-launch-')), privateRoot = join(root, 'private'); mkdirSync(privateRoot);
  const profile = parseLaunchProfiles({ version: 1, profiles: [{ id: 'route', revision: 1, agent: 'codex', model: 'preset-model', baseUrl: 'https://preset.example', credentialId: 'key', transport: { kind: 'direct' } }] })[0]!;
  writeFileSync(join(privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [profile] }));
  writeFileSync(join(privateRoot, 'credentials.json'), JSON.stringify({ version: 1, credentials: { key: { apiKey: 'test-secret' } } }));
  const runtime = new PresetRuntime(privateRoot, root, join(root, 'user'));
  const binding = { id: 'local', targetId: 'local', ...await runtime.describe('route', 1, 'codex', 'preset-model') };
  const ordinary = new Adapter(), launches: Adapter[] = [];
  const router = new ControllerLaunchAdapter(ordinary, runtime, { command: 'fake', args: [] }, { OPENAI_API_KEY: 'wrong-secret' }, prepared => {
    assert.equal(prepared.env.OPENAI_API_KEY, undefined); assert.equal(prepared.env.BRIDGE_PRESET_API_KEY, 'test-secret');
    const adapter = new Adapter(); launches.push(adapter); return adapter;
  });
  const conversation: Conversation = { id: 'main-one', userId: 'owner', agent: 'codex', model: binding.model, preset: binding, nativeId: null, cwd: root, title: '', createdAt: '', updatedAt: '' };
  const turn: AgentTurn = { conversation, text: 'hello', imagePaths: [], signal: new AbortController().signal, onProgress() {} };
  try {
    await router.run(turn); await router.run(turn); assert.equal(launches.length, 1); assert.equal(ordinary.turns.length, 0);
    assert.equal((await router.getModelInfo(root, conversation)).defaultModel, binding.model);
    await assert.rejects(router.run({ ...turn, conversation: { ...conversation, model: 'wrong-model' } }), /不一致/);
    await assert.rejects(router.run({ ...turn, conversation: { ...conversation, preset: { ...binding, targetId: 'remote' } } }), /桥电脑/);
    await router.interrupt(conversation.id); assert.equal(launches[0]!.closed, true);
    await router.run({ ...turn, conversation: { ...conversation, nativeId: 'native-main-one' } }); assert.equal(launches.length, 2);
    await router.run({ ...turn, conversation: { ...conversation, id: 'ordinary', preset: undefined } }); assert.equal(ordinary.turns.length, 1);
  } finally { await router.close(); rmSync(root, { recursive: true, force: true }); }
});
