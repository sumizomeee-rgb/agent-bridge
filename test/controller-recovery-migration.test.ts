import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrateWorkspaceRegistry } from '../src/registry-migration.js';
import { loadHostConfig, projectRoot } from '../src/config.js';
import { ControllerCore, type ControllerCoreDependencies, type ControllerCoreHooks } from '../src/controller/core.js';
import { SessionStore } from '../src/store.js';
import { SessionHandoffs } from '../src/controller/handoff.js';
import { ExecutorMessages } from '../src/executor-messages.js';
import type { AgentAdapter, AgentTurn } from '../src/types.js';

const oldUser = 'feishu:cli_test|ou_owner', userId = 'principal:owner', channelId = 'feishu:cli_test|oc_private';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
for (const phase of ['committed', 'prepared'] as const) test(`v3 ${phase}切换日志及续接材料离线迁移后真实Core恢复，冻结历史和平台来源不变`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-recovery-migration-')), project = join(root, 'project'), workspace = join(root, 'workspace');
  const dataDir = join(project, '.local', 'data', 'bots', 'feishu', 'cli_test'), configPath = join(project, '.local', 'config.json');
  const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  let core: ControllerCore | undefined;
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'README.md'), '# Shared\n{{include:bridge/controller-protocol}}\n{{include:bridge/tool-index}}\n{{include:workspace/MEMORY.md}}');
    writeFileSync(join(workspace, 'MEMORY.md'), '# Owner rules');
    write(configPath, { version: 3, startupProfiles: ['feishu/test'], registeredProfiles: ['feishu/test'], workspaceRoot: '.local/workspaces', dataDir: '.local/data',
      defaultAgent: 'codex', commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } },
      principals: [{ id: 'owner', accounts: { 'feishu:cli_test': 'ou_owner' } }], spaces: [] });
    write(join(project, '.local', 'bots', 'feishu', 'test.json'), { platform: 'feishu', applicationId: 'cli_test', appSecret: 'fixture-only', allowedUserIds: ['ou_owner'],
      workspace, defaultAgent: phase === 'committed' ? 'claude' : 'codex', aliases: ['Teto'], ownerPrincipalId: 'owner', network: { proxyPort: null } });
    const old = new SessionStore(dataDir);
    const source = old.createConversation(oldUser, 'codex', workspace, { controllerMode: true }); old.saveNativeId(source.id, 'old-native');
    const target = old.createConversation(oldUser, 'claude', workspace, { controllerMode: true }); old.saveNativeId(target.id, 'target-native');
    const beforeSource = old.getConversation(source.id)!, beforeTarget = old.getConversation(target.id)!;
    // Historical platform input is separate from the active controller's unfinished work.
    const history = old.createConversation(oldUser, 'codex', workspace, { controllerMode: true });
    old.addMessage({ id: 'platform-original', userId: oldUser, channelId, text: '原平台用户原话', imagePaths: [],
      source: { messageId: 'platform-original', userId: oldUser, channelId, authorType: 'user' } }, history.id, 'completed');
    const handoffs = new SessionHandoffs(dataDir); handoffs.prepare(beforeSource, beforeTarget, channelId, [{ role: 'user', text: '继续原目标', at: '2026-11-01T00:00:00Z' }], []);
    if (phase === 'committed') handoffs.finish(beforeTarget, channelId, JSON.stringify({ workspaceContext: '原工作区约定', continuation: '保留待验收目标' }));
    const artifact = join(dataDir, 'session-handoffs', target.id), frozen = readFileSync(join(artifact, 'source.json'));
    const originalManifest = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8'));
    write(join(dataDir, 'agent-switches', target.id + '.json'), { version: 1, source: beforeSource, target: beforeTarget, channelId, phase,
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }); old.close();
    const migration = await migrateWorkspaceRegistry({ configPath, dryRun: false, controllerIds: { 'feishu:cli_test': 'teto' } });
    const config = loadHostConfig(['--config', configPath], false).controllerConfigs[0]!, migratedData = migration.bindings[0]!.controllerDataDir;
    const movedArtifact = join(migratedData, 'session-handoffs', target.id);
    assert.deepEqual(readFileSync(join(movedArtifact, 'source.json')), frozen, '迁移不能重写冻结历史后重新背书');
    const manifest = JSON.parse(readFileSync(join(movedArtifact, 'manifest.json'), 'utf8'));
    assert.equal(manifest.userId, userId); assert.equal(manifest.source.userId, userId);
    assert.equal(manifest.snapshotHash, originalManifest.snapshotHash); assert.equal(manifest.snapshotHash, digest(frozen));
    assert.equal(manifest.contextHash, originalManifest.contextHash);
    assert.equal(JSON.parse(frozen.toString()).source.userId, oldUser, '冻结Conversation是原始历史证据，不是当前业务owner');
    const db = new DatabaseSync(join(migratedData, 'bridge.sqlite'), { readOnly: true });
    try { const original = db.prepare("SELECT user_id,source_json FROM inbox WHERE id='platform-original'").get()!;
      assert.equal(original.user_id, userId); assert.equal(JSON.parse(String(original.source_json)).userId, oldUser); }
    finally { db.close(); }
    let active = phase === 'committed' ? target.id : source.id, nativeCalls = 0;
    const fake = (): AgentAdapter => ({ async run(_turn: AgentTurn) { nativeCalls++; throw new Error('offline recovery must not call an LLM'); }, async interrupt() {}, async close() {} });
    const execution = { codex: fake(), claude: fake() }, controllers = { codex: fake(), claude: fake() };
    const hooks: ControllerCoreHooks = { authorize: owner => owner === userId, manager: { binding: { getActive: owner => owner === userId ? active : null, setActive: (_owner, id) => { active = id; } } },
      invoke: (_turn, _name, args, _id, delegate) => delegate(args), pauseGroup() {}, resumeGroup() {}, requestRestart: async () => ({}), isDraining: () => false };
    const dependencies: ControllerCoreDependencies = { createExecutionAdapters: () => execution, createControllerAdapters: () => controllers, createExternalAdapter: fake,
      createExecutorMessages: () => new ExecutorMessages(projectRoot, join(root, 'isolated-user-home')),
      createTargetCatalog: () => ({ async listTargets() { return []; }, async resolveTarget() { throw new Error('no execution during recovery'); }, adapterFor: binding => execution[binding.agent],
        async computerOverview() { return []; }, async handoff() { throw new Error('no remote handoff'); }, async close() {} }) };
    core = new ControllerCore(config, hooks, undefined, dependencies); await core.recover();
    assert.equal(core.manager.currentConversation(userId)!.id, active); assert.equal(core.manager.currentConversation(userId)!.userId, userId); assert.equal(nativeCalls, 0);
    const recoveredJournal = JSON.parse(readFileSync(join(migratedData, 'agent-switches', target.id + '.json'), 'utf8'));
    assert.equal(recoveredJournal.source.userId, userId); assert.equal(recoveredJournal.target.userId, userId);
    assert.equal(recoveredJournal.phase, phase === 'committed' ? 'committed' : 'failed');
    const targetNow = core.manager.conversationById(target.id)!;
    assert.doesNotThrow(() => new SessionHandoffs(migratedData).prompt(targetNow, channelId));
    if (phase === 'committed') assert.doesNotThrow(() => new SessionHandoffs(migratedData).validate(targetNow, channelId, JSON.stringify({ continuation: '继续保留原待办' })));
    assert.deepEqual(readFileSync(join(artifact, 'source.json')), frozen, '旧材料仍保留供核验');
  } finally { await core?.close(); rmSync(root, { recursive: true, force: true }); }
});
