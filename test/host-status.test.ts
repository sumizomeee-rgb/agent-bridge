import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { hostStatusPresentation, processorUsage, rankHostProcesses, type HostSnapshot } from '../src/host-status.js';
import { SessionManager } from '../src/manager.js';
import { presentationText } from '../src/presentation.js';
import { slashText } from '../src/slash.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, BridgeConfig } from '../src/types.js';

const GiB = 1024 ** 3;
const sample = (pid: number, cpuMs: number | null, privateBytes = pid * 100, started = 'same-start') =>
  ({ pid, cpuMs, privateBytes, workingSetBytes: 10_000 - pid, name: `app-${pid}`, started });
const snapshot: HostSnapshot = { hostname: 'bridge-laptop', sampledAt: '2026-11-12T04:00:00Z', logicalCpus: 8,
  cpuPercent: 12.5, totalBytes: 32 * GiB, availableBytes: 10 * GiB, uptimeSeconds: 93780,
  cpuTop: [{ pid: 1, name: 'cpu-app', cpuPercent: 12.5, privateBytes: GiB, workingSetBytes: GiB / 2 }],
  memoryTop: [{ pid: 2, name: 'memory-app', cpuPercent: 0, privateBytes: 2 * GiB, workingSetBytes: GiB }] };

test('overall CPU uses only the sampled counter delta and reports unknown for reset or unavailable counters', () => {
  assert.equal(processorUsage({ idle: 8000, total: 10000 }, { idle: 8750, total: 11000 }), 25);
  assert.equal(processorUsage({ idle: 1, total: 1 }, { idle: 1, total: 1 }), null);
  assert.equal(processorUsage({ idle: 20, total: 100 }, { idle: 19, total: 200 }), null);
  assert.equal(processorUsage({ idle: 0, total: 0 }, { idle: 200, total: 100 }), null);
});

test('process CPU uses counter deltas and all logical cores; memory ranks private bytes rather than working set', () => {
  const first = Array.from({ length: 7 }, (_, i) => sample(i + 1, 10_000));
  const last = Array.from({ length: 7 }, (_, i) => sample(i + 1, 10_000 + (i + 1) * 1000));
  const ranked = rankHostProcesses(first, last, 1000, 8);
  assert.equal(ranked.cpuTop.length, 5); assert.equal(ranked.memoryTop.length, 5);
  assert.equal(ranked.cpuTop[0]!.cpuPercent, 87.5);
  assert.deepEqual(ranked.memoryTop.map(p => p.pid), [7, 6, 5, 4, 3]);
  assert.equal(ranked.cpuTop.find(p => p.pid === 3)!.cpuPercent, 37.5);
});

test('new/reused PIDs, missing counters and reset CPU clocks are not misreported as sampled CPU', () => {
  const ranked = rankHostProcesses([sample(1, 100), sample(2, 100), sample(3, null)],
    [sample(1, 200, 100, 'new-start'), sample(2, 50), sample(3, null), sample(4, 1000)], 1000, 8);
  assert.deepEqual(ranked.cpuTop, []); assert.equal(ranked.memoryTop.length, 4);
  assert(ranked.memoryTop.every(p => p.cpuPercent === null));
  assert.throws(() => rankHostProcesses([], [], 0, 8), /sampling interval/);
});

test('snapshot clearly labels physical RAM, private memory and working set, with partial failure retained', () => {
  const text = presentationText(hostStatusPresentation(snapshot));
  assert.match(text, /22\.00 GiB \/ 32\.00 GiB（68\.8%）/);
  assert.match(text, /1天 2小时 3分/); assert.match(text, /全部逻辑核折算/);
  assert.match(text, /私有 2\.00 GiB · 工作集 1\.00 GiB/);
  const partial = hostStatusPresentation({ ...snapshot, cpuTop: [], memoryTop: [], processError: '进程采集超时，请稍后重试' });
  assert.equal(partial.tone, 'warning'); assert.match(presentationText(partial), /采集超时/);
  assert.match(presentationText(partial), /32\.00 GiB/);
});

test('DM and group slash host options reuse the same text query; foreign scopes are rejected', () => {
  const command = { name: 'status', type: 1, options: [{ name: 'scope', type: 3, value: 'host' }] };
  assert.deepEqual(slashText(command), { text: '/status host' });
  assert.deepEqual(slashText(command, 'group'), { text: '/status host' });
  assert.deepEqual(slashText({ name: 'status', type: 1 }), { text: '/status' });
  assert('error' in slashText({ ...command, options: [{ name: 'scope', type: 3, value: 'remote-host' }] }));
});

async function fixture(t: TestContext, collect: () => Promise<HostSnapshot>) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-host-status-'));
  const turns: string[] = [], replies: string[] = [];
  let finish!: (result: AgentResult) => void;
  const pending = new Promise<AgentResult>(resolve => { finish = resolve; });
  const adapter: AgentAdapter = { async run(turn) { turns.push(turn.text); turn.onNativeId?.('native-live'); return pending; }, async interrupt() {}, async close() {} };
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter },
    { async sendText(_channel, text) { replies.push(text); } }, { mergeDelayMs: 0, onHostStatus: collect });
  const store = new SessionStore(root);
  t.after(async () => { finish({ nativeId: 'native-live', text: 'done' }); await manager.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, store, turns, replies, message: (id: string, text: string) => ({ id, text, userId: 'owner', channelId: 'dm', imagePaths: [] }) };
}

test('/status host does not create a conversation or invoke an agent; ordinary status and bad arguments remain separate', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return snapshot; });
  await f.manager.handle(f.message('host', '/status host'));
  assert.match(f.replies[0]!, /桥电脑状态 · 即时快照/); assert.equal(calls, 1);
  assert.equal(f.store.getActive('owner'), null); assert.equal(f.turns.length, 0);
  await f.manager.handle(f.message('plain', '/status'));
  assert.match(f.replies[1]!, /会话：尚未创建/); assert.equal(calls, 1);
  await f.manager.handle(f.message('invalid', '/status unknown'));
  assert.match(f.replies[2]!, /用法/); assert.equal(calls, 1);
});

test('busy controller and queued input are unaffected; the snapshot uses its own command reply', async t => {
  const f = await fixture(t, async () => snapshot);
  await f.manager.handle(f.message('work', 'keep working'));
  for (let i = 0; i < 100 && !f.turns.length; i++) await delay(5);
  assert.equal(f.turns.length, 1);
  await f.manager.handle(f.message('queued', 'next task'));
  const before = f.store.getActive('owner')!, count = f.store.pendingCount(before.id);
  const previousReplies = f.replies.length;
  assert.equal(count, 1);
  const direct: string[] = [];
  await f.manager.handle(f.message('host', '/status host'), async text => { direct.push(text); });
  assert.match(direct[0]!, /桥电脑状态/);
  assert.equal(f.turns.length, 1); assert.equal(f.replies.length, previousReplies);
  assert.deepEqual(f.store.getActive('owner'), before); assert.equal(f.store.pendingCount(before.id), count);
});

test('a failed collector never starts a model or leaks subprocess diagnostics', async t => {
  const f = await fixture(t, async () => { throw new Error('PRIVATE_SUBPROCESS_DIAGNOSTIC'); });
  await f.manager.handle(f.message('host', '/status host'));
  assert.match(f.replies[0]!, /命令失败/); assert.doesNotMatch(f.replies[0]!, /PRIVATE_/);
  assert.equal(f.turns.length, 0); assert.equal(f.store.getActive('owner'), null);
});
