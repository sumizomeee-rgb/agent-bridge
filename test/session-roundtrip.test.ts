import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ownTemporaryDirectory } from './temp-directory.js';
import { RemoteDaemon } from '../src/remote/daemon.js';
import { PresetRuntime, profileFingerprint, parseLaunchProfiles } from '../src/presets/runtime.js';
import { WorkerSessionRuntime } from '../src/agents/worker-session.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { TaskRegistry } from '../src/tasks.js';
import type { LaunchProfile, PresetBinding } from '../src/presets/types.js';
import type { AgentName, SessionVisibility, AgentAdapter, BridgeConfig, AgentTurn } from '../src/types.js';
import type { NativeSessionExecution, NativeSessionRead, NativeSessionAdoptArgs } from '../src/native-sessions.js';

const nativeId = '11111111-2222-3333-4444-555555555555';
for (const agent of ['codex', 'claude'] as const) for (const preset of [false, true]) for (const visibility of ['hidden', 'visible'] as const) {
  test(`${agent} ${preset ? 'preset' : 'ordinary'} ${visibility}: two user/bridge transfers retain history, choices and a unique holder`, async t => {
    const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-roundtrip-')), 'bridge-roundtrip-');
    const home = join(root, 'user'), cwd = join(root, 'workspace'), data = join(root, '.local', 'remote'), privateRoot = join(root, '.local', 'agent-presets');
    mkdirSync(cwd); mkdirSync(join(home, '.codex', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model_provider="ordinary-route"\n');
    const model = agent === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5.5';
    let transcript: string;
    if (agent === 'codex') {
      transcript = join(home, '.codex', 'sessions', `rollout-${nativeId}.jsonl`);
      writeFileSync(transcript, [
        { type: 'session_meta', payload: { id: nativeId, cwd } },
        { type: 'turn_context', payload: { cwd, model, effort: 'high' } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ].map(v => JSON.stringify(v)).join('\n') + '\n');
      const db = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'));
      db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,model_provider TEXT,title TEXT,archived INTEGER,updated_at INTEGER)');
      db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0,1)').run(nativeId, transcript, cwd, preset ? 'bridge_preset' : 'ordinary-route', 'roundtrip'); db.close();
    } else {
      const projects = join(home, '.claude', 'projects', 'fixture'); mkdirSync(projects, { recursive: true });
      transcript = join(projects, nativeId + '.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: nativeId, cwd, message: { model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'original' }] } }) + '\n');
    }
    const command = { command: process.execPath, args: [] };
    const daemon = new RemoteDaemon(root, { version: 1, expectedHostname: hostname(), engines: { [agent]: { agentCommand: command, defaultCwd: cwd } } }, {
      nativeSessionOptions: { userHome: home, busyProbe: async () => ({ status: 'clear', evidence: [] }) },
    });
    t.after(() => daemon.close());
    const runtime = new PresetRuntime(privateRoot, data, home), workers = new WorkerSessionRuntime(data, home);
    let binding: PresetBinding | undefined;
    if (preset) {
      mkdirSync(privateRoot, { recursive: true });
      const profile = parseLaunchProfiles({ version: 1, profiles: [{ id: 'fixed-route', revision: 1, agent, model, baseUrl: 'https://example.invalid', credentialId: 'fixture', transport: { kind: 'direct' } }] })[0]!;
      writeFileSync(join(privateRoot, 'profiles.json'), JSON.stringify({ version: 1, profiles: [profile] }));
      writeFileSync(join(privateRoot, 'credentials.json'), JSON.stringify({ version: 1, credentials: { fixture: { apiKey: 'fake-only' } } }));
      binding = { id: 'fixed-assistant', profileId: profile.id, revision: 1, agent, model, fingerprint: profileFingerprint(profile), targetId: 'fixture' };
      await runtime.pin(binding, 'original-worker', null, visibility);
    } else workers.prepare(agent, 'original-worker', null, visibility, {});
    daemon.store.create({ dispatchId: 'original-job', workerId: 'original-worker', userId: 'owner', agent, agentCommand: command, nativeId,
      cwd, text: 'original', imagePaths: [], model, effort: 'high', acceptSupplements: false, sessionVisibility: visibility, ...(binding ? { preset: binding } : {}) });
    daemon.store.update('original-job', { status: 'completed', stopped: true }); daemon.store.bindSession(nativeId, 'original-worker', agent, cwd, 'owner');
    const ref = { agent, profile: 'default' as const, nativeId }; let workerId = 'original-worker';
    for (let cycle = 1; cycle <= 2; cycle++) {
      await daemon.nativeSessions.prepareHandoff(ref); daemon.store.handoff(nativeId);
      const before = await daemon.nativeSessions.read('owner', ref);
      // Starting user control invalidates a read that raced immediately before it.
      daemon.store.nativeLeases.startUser(ref, workerId);
      await assert.rejects(daemon.nativeSessions.adopt('owner', { ref, workerId: 'stale', adoptionId: `stale-${cycle}`, expectedRevision: before.revision }), /发生变化/);
      appendFileSync(transcript, JSON.stringify(agent === 'codex' ? { type: 'event_msg', payload: { type: 'task_complete' } } : { type: 'assistant', sessionId: nativeId, cwd, message: { model, stop_reason: 'end_turn', content: [{ type: 'text', text: `user-${cycle}` }] } }) + '\n');
      const info = await daemon.nativeSessions.read('owner', ref); assert.equal(info.health, 'healthy');
      const next = `bridge-worker-${cycle}`;
      const receipt = await daemon.nativeSessions.adopt('owner', { ref, workerId: next, adoptionId: `adopt-${cycle}`, expectedRevision: info.revision });
      assert.equal(receipt.nativeId, nativeId); assert.equal(receipt.execution!.model, model); assert.equal(receipt.execution!.effort, 'high');
      assert.equal(receipt.execution!.sessionVisibility, visibility); assert.deepEqual(receipt.execution!.preset, binding);
      assert.equal(receipt.execution!.workerId, next);
      assert.throws(() => daemon.store.nativeLeases.startUser(ref, workerId), /失效/);
      await assert.rejects(daemon.nativeSessions.assertRunOwnership(ref, 'owner', workerId), /另一 worker/);
      if (binding) { const launch = await runtime.prepare(binding, next, nativeId, command, {}, visibility); await launch.close(); }
      else workers.prepare(agent, next, nativeId, visibility, {});
      await daemon.nativeSessions.assertRunOwnership(ref, 'owner', next); workerId = next;
    }
  });
}

for (const agent of ['codex', 'claude'] as const) for (const preset of [false, true]) {
  test(`controller ${agent} ${preset ? 'preset' : 'ordinary'} returns the same native conversation twice without losing choices`, async t => {
    const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-roundtrip-')), 'bridge-roundtrip-'), registry = new TaskRegistry(root);
    const command = { command: process.execPath, args: [] }, model = agent === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5.5';
    const config: BridgeConfig = { token: '', workspace: root, dataDir: root, attachmentsDir: root, logsDir: root, proxyUrl: null, allowedUserIds: ['owner'], defaultAgent: 'codex', commands: { codex: command, claude: command }, maxImageBytes: 100 };
    const target = { id: 'local', label: 'fixture', transport: 'local' as const, agent, agentCommand: command, cwd: root };
    const binding: PresetBinding = { id: 'preset', profileId: 'fixed', revision: 1, agent, model, targetId: 'local', fingerprint: 'a'.repeat(64) };
    let execution: NativeSessionExecution = { workerId: 'old-worker', model, effort: 'high', sessionVisibility: 'hidden', ...(preset ? { preset: binding } : {}) }, revision = 0;
    const ref = { agent, profile: 'default' as const, nativeId };
    const read = (): NativeSessionRead => ({ ref, nativeId, profile: 'default', cwd: root, title: 'same conversation', model: null, effort: null, provider: null, revision: String(revision), health: 'healthy', busyEvidence: [], messages: [], truncated: false, execution });
    const noop: AgentAdapter = { async run() { throw new Error('No inference in this test'); }, async interrupt() {}, async close() {} };
    const runtime = new ControllerRuntime(config, { codex: noop, claude: noop }, registry, { targetCatalog: {
      async listTargets() { return []; }, async resolveTarget() { return target; }, adapterFor() { return noop; },
      async readNativeSession() { return read(); }, async listNativeSessions() { return { sessions: [], nextCursor: null }; },
      async adoptNativeSession(_target, userId, args: NativeSessionAdoptArgs) { execution = { ...execution, workerId: args.workerId }; revision++; return { ...read(), workerId: args.workerId, userId, adoptionId: args.adoptionId, status: 'adopted', leaseRevision: revision }; },
      async handoff(selected, id, cwd, selectedAgent) { assert.deepEqual(selected.preset, preset ? binding : undefined); assert.equal(selected.sessionVisibility, 'hidden'); return { targetId: 'local', nativeId: id, cwd, agent: selectedAgent, resumeCommand: 'fixture user launcher', stopped: true }; },
    } });
    t.after(async () => { await runtime.close(); registry.close(); });
    const origin = { conversationId: 'parent', userId: 'owner', channelId: 'private', originMessageId: 'input', nativeId: null, agent: 'codex' as const, cwd: root };
    const turn: AgentTurn = { conversation: { id: 'parent', userId: 'owner', agent: 'codex', nativeId: null, model: null, title: '', cwd: root, createdAt: '', updatedAt: '' }, text: '', imagePaths: [], taskContextPath: registry.createContext(origin).contextPath, signal: new AbortController().signal, onProgress() {} };
    runtime.store.addWorker({ id: 'old-worker', origin, agent, model, actualModel: model, nativeId, cwd: root, title: 'same conversation', effort: 'high', target: { ...target, sessionVisibility: 'hidden', ...(preset ? { preset: binding } : {}) }, ownership: 'user', imagePaths: [], wakeAllowed: false, createdAt: '', updatedAt: '' });
    for (let cycle = 0; cycle < 2; cycle++) {
      const adopted = await runtime.invoke(turn, 'bridge_adopt_native_session', { agent, nativeId, profile: 'default', expectedRevision: String(revision) }) as { workerId: string };
      const worker = runtime.store.getWorker(adopted.workerId)!;
      assert.equal(worker.nativeId, nativeId); assert.equal(worker.model, model); assert.equal(worker.effort, 'high');
      assert.deepEqual(worker.target!.preset, preset ? binding : undefined); assert.equal(worker.target!.sessionVisibility, 'hidden');
      const handed = await runtime.invoke(turn, 'bridge_handoff_worker', { workerId: worker.id }) as { ownership: string };
      assert.equal(handed.ownership, 'user');
    }
  });
}
