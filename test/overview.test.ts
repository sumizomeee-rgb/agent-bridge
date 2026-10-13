import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager, type SessionManagerOptions } from '../src/manager.js';
import { elapsedText, formatComputerOverview, formatWorkerOverview, type ComputerOverview, type WorkerOverview } from '../src/overview.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, BridgeMessage, Conversation } from '../src/types.js';

const now = Date.parse('2026-10-13T08:00:00Z');
const computers: ComputerOverview[] = [
  { targetId: 'local', label: '桥电脑', transport: 'local', connection: 'connected', checkedAt: '2026-10-13T08:00:00Z',
    agents: [{ agent: 'codex', cli: 'ready' }, { agent: 'claude', cli: 'unavailable', reason: 'CLI 不存在' }] },
  { targetId: 'workstation', label: '工位', transport: 'ssh', connection: 'unknown', checkedAt: null, agents: [{ agent: 'codex', cli: 'unknown' }] },
  { targetId: 'offline', label: '离线电脑', transport: 'ssh', connection: 'unreachable', checkedAt: '2026-10-13T08:00:00Z',
    reason: '连接超时', agents: [{ agent: 'claude', cli: 'unknown' }] },
];
const worker = (changes: Partial<WorkerOverview> = {}): WorkerOverview => ({
  workerId: 'worker-1', conversationId: 'parent-1', conversationTitle: '修桥', targetId: 'workstation', targetLabel: '工位',
  agent: 'codex', title: '审查修改', model: 'gpt-6.1-sol', effort: 'high', nativeId: 'native-1', status: 'running',
  running: true, queued: 2, startedAt: '2026-10-13T07:58:30Z', ...changes,
});

test('电脑清单区分登记、连接与 CLI 入口，未知和失败不冒充可用', () => {
  const text = formatComputerOverview(computers);
  assert.match(text, /桥电脑（local · 桥电脑）/);
  assert.match(text, /已连接/); assert.match(text, /Codex：CLI 入口可用/);
  assert.match(text, /Claude Code：CLI 入口不可用（CLI 不存在）/);
  assert.match(text, /工位（workstation · 跨电脑）/);
  assert.match(text, /连接尚未确认；检查：尚未检查/);
  assert.match(text, /连接不可用：连接超时/);
  assert.match(text, /CLI 入口可用不代表模型服务或现有会话一定健康/);
});

test('直属 Agent 展示电脑、引擎、会话、本轮耗时，运行人数和等待轮数分开', () => {
  const text = formatWorkerOverview([worker(), worker({ workerId: 'worker-2', title: '等待编译', running: false, status: 'queued', queued: 1, startedAt: null })], 'all', now);
  assert.match(text, /运行 1 个 · 等待 3 轮/);
  assert.match(text, /审查修改/); assert.match(text, /工位（workstation） · Codex/);
  assert.match(text, /模型：gpt-6.1-sol；强度：high/);
  assert.match(text, /本轮耗时：1分30秒；等待 2 轮/);
  assert.match(text, /等待执行；本轮耗时：尚未开始/);
  assert.match(text, /主控对话：修桥/);
});

test('原记录开始时间未知，待核对可见，已结束与已交接会话不计入运行列表', () => {
  const text = formatWorkerOverview([
    worker({ startedAt: null }), worker({ workerId: 'uncertain', status: 'uncertain', running: false, queued: 0 }),
    worker({ title: '已结束项目', status: 'completed', running: false, queued: 0 }),
    worker({ title: '用户会话', status: 'handed-off', running: false, queued: 0 }),
  ], 'current', now);
  assert.match(text, /运行 1 个 · 等待 2 轮 · 待核对 1 个/);
  assert.match(text, /本轮耗时：开始时间未记录/); assert.match(text, /状态待核对/);
  assert(!text.includes('已结束项目')); assert(!text.includes('用户会话')); assert(!text.includes('主控对话：'));
  assert.match(formatWorkerOverview([], 'all', now), /你的全部对话没有运行/);
  assert.equal(elapsedText('invalid', now), '开始时间未记录');
  assert.equal(elapsedText('2026-10-13T09:00:00Z', now), '开始时间未记录');
  assert.equal(elapsedText('2026-10-13T06:00:00Z', now), '2小时0分');
});

class Adapter implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  private readonly pending: Array<() => void> = [];
  run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    return new Promise(resolve => this.pending.push(() => resolve({ nativeId: 'fake-native', text: '完成' })));
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { this.pending.forEach(finish => finish()); }
}

function message(id: string, text: string, userId = 'owner'): BridgeMessage {
  return { id, text, userId, channelId: `dm-${userId}`, imagePaths: [] };
}
function fixture(t: TestContext, options: SessionManagerOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-overview-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner', 'other'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 100 };
  const adapter = new Adapter(), replies: string[] = [], counts: number[] = [];
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, {
    async sendText(_channelId, text) { replies.push(text); }, async setTaskCount(_message, count) { counts.push(count); },
  }, { mergeDelayMs: 0, ...options });
  t.after(async () => {
    await manager.close();
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir())); assert(basename(target).startsWith('bridge-overview-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { config, adapter, replies, counts, manager };
}

test('文本和交互命令直接查询认证后的对话，默认刷新和本用户 all，不启动模型', async t => {
  const calls: Array<{ conversation: Conversation; kind: string; value: unknown }> = [];
  const f = fixture(t, {
    onListComputers: async (conversation, refresh) => { calls.push({ conversation, kind: 'computers', value: refresh }); return computers; },
    onListWorkers: async (conversation, scope) => { calls.push({ conversation, kind: 'workers', value: scope }); return [worker()]; },
  });
  await f.manager.handle(message('text-computers', '/computers'));
  const slashReplies: string[] = [];
  await f.manager.handle(message('slash-cached', '/computers cached'), async text => { slashReplies.push(text); });
  await f.manager.handle(message('slash-workers', '/workers all'), async text => { slashReplies.push(text); });
  await f.manager.handle(message('other-workers', '/workers', 'other'));
  assert.deepEqual(calls.map(call => [call.kind, call.value, call.conversation.userId]), [
    ['computers', true, 'owner'], ['computers', false, 'owner'], ['workers', 'all', 'owner'], ['workers', 'current', 'other'],
  ]);
  assert(calls.every(call => call.conversation.cwd === f.config.workspace));
  assert.equal(calls[0]!.conversation.id, calls[2]!.conversation.id);
  assert.notEqual(calls[2]!.conversation.id, calls[3]!.conversation.id);
  assert.equal(f.replies.length, 2); assert.equal(slashReplies.length, 2);
  assert.equal(f.adapter.turns.length, 0); assert.deepEqual(f.counts, []);
});

test('用户不能用参数指定别人的范围，未授权用户不会查询数据', async t => {
  let queries = 0;
  const f = fixture(t, { onListComputers: async () => { queries++; return []; }, onListWorkers: async () => { queries++; return []; } });
  await f.manager.handle(message('invalid-workers', '/workers all other'));
  await f.manager.handle(message('invalid-computers', '/computers user=other'));
  await f.manager.handle(message('unauthorized', '/workers all', 'stranger'));
  assert.equal(queries, 0); assert.equal(f.replies.length, 2); assert.equal(f.adapter.turns.length, 0);
});

test('运行期间可查询直属数据，查询失败只回当前交互且不暴露底层错误', async t => {
  const f = fixture(t, { onListWorkers: async () => [worker()], onListComputers: async () => { throw new Error('credential-sensitive raw failure'); } });
  await f.manager.handle(message('normal-turn', '开始正常任务'));
  const deadline = Date.now() + 2000;
  while (f.adapter.turns.length !== 1) { assert(Date.now() < deadline); await delay(5); }
  const replies: string[] = [];
  await f.manager.handle(message('during-turn', '/workers'), async text => { replies.push(text); });
  await f.manager.handle(message('failed-computers', '/computers'), async text => { replies.push(text); });
  assert.match(replies[0]!, /运行 1 个/); assert.equal(replies[1], '命令失败：电脑清单检查失败，请稍后重试。');
  assert(!replies.join('').includes('credential-sensitive'));
  assert.equal(f.adapter.turns.length, 1); assert.deepEqual(f.replies, []);
});

test('并发查询的交互回复不会串到另一条命令或普通私聊', async t => {
  let release!: (value: ComputerOverview[]) => void;
  const f = fixture(t, { onListComputers: async () => new Promise(resolve => { release = resolve; }), onListWorkers: async () => [] });
  const first: string[] = [], second: string[] = [];
  const pending = f.manager.handle(message('slow-query', '/computers'), async text => { first.push(text); });
  await f.manager.handle(message('fast-query', '/workers'), async text => { second.push(text); });
  assert.equal(first.length, 0); assert.equal(second.length, 1);
  release(computers); await pending;
  assert.equal(first.length, 1); assert.deepEqual(f.replies, []); assert.equal(f.adapter.turns.length, 0);
});
