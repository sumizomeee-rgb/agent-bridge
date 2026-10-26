import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager, type SessionManagerOptions } from '../src/manager.js';
import { elapsedText, formatComputerOverview as renderComputerDetails, formatWorkerOverview as renderWorkerDetails, splitOverviewMessage, type ComputerOverview, type WorkerOverview } from '../src/overview.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, BridgeMessage, Conversation } from '../src/types.js';

const formatComputerOverview = (items: readonly ComputerOverview[]) => renderComputerDetails(items, true);
const formatWorkerOverview = (items: readonly WorkerOverview[], scope: 'current' | 'all', now: number) => renderWorkerDetails(items, scope, now, true);

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

test('电脑总览黄色头、独立编号框区分连接、hello、静态入口和派发准备', () => {
  const text = formatComputerOverview(computers);
  assert(text.startsWith('```ansi\n\u001b[33m当前工作区的电脑 · 已登记3台\u001b[0m\n```'));
  assert.equal((text.match(/^```$/gm) ?? []).length, 7);
  assert.match(text, /1\. 桥电脑 · local/);
  assert.match(text, /2\. 工位 · workstation/);
  assert.match(text, /SSH 连接：连接尚未确认/);
  assert.match(text, /执行器 hello：未确认/);
  assert.match(text, /Codex CLI 静态入口：可用/);
  assert.match(text, /Codex 直属派发准备：入口已就绪（模型未实测）/);
  assert.match(text, /Claude Code CLI 静态入口：不可用/);
  assert.match(text, /Claude Code 直属派发准备：未就绪/);
  assert.match(text, /Claude Code 失败原因：CLI 不存在/);
  assert.match(text, /失败原因：连接超时/);
  assert.match(text, /模型实测：未提供实测结果/);
  const unknown = text.split('\n\n')[2]!;
  assert.match(unknown, /Codex 直属派发准备：未确认/); assert(!unknown.includes('入口已就绪'));
  const staticOnly = formatComputerOverview([{ ...computers[1]!, agents: [{ agent: 'codex', cli: 'ready' }] }]);
  assert.match(staticOnly, /CLI 静态入口：可用/); assert.match(staticOnly, /直属派发准备：未确认/);
  assert.match(formatComputerOverview([]), /已登记0台/);
  const missingReasons = formatComputerOverview([{ ...computers[2]!, reason: undefined, agents: [{ agent: 'claude', cli: 'unavailable' }] }]);
  assert.match(missingReasons, /失败原因：连接检查失败，具体原因未回报/);
  assert.match(missingReasons, /Claude Code 失败原因：CLI 静态入口检查未通过，具体原因未回报/);
});

test('助手条目用实际短模型和中文强度，运行助手人数与排队轮数分开', () => {
  const text = formatWorkerOverview([worker(), worker({ workerId: 'worker-2', title: '等待编译', running: false, status: 'queued', queued: 1, startedAt: null })], 'all', now);
  assert(text.startsWith('```ansi\n\u001b[33m你的全部对话的直属助手 · 运行1个 · 等待3轮'));
  assert.match(text, /1\. 普通 · 工位 · Codex · 6\.1-sol · 高 · worker-1/);
  assert.match(text, /2\. 普通 · 工位 · Codex/);
  assert.match(text, /会话名：审查修改/);
  assert.match(text, /运行中 · 本轮耗时：1分30秒 · 等待2轮/);
  assert.match(text, /等待执行 · 本轮耗时：尚未开始 · 等待1轮/);
  assert.match(text, /主控对话：修桥/);
  assert.match(text, /workerId：worker-1/); assert.match(text, /原生会话 ID：native-1/);
});

test('空列表、未知回报、完成、空闲及阻塞状态均可读，历史记录不计为运行', () => {
  const text = formatWorkerOverview([
    worker({ startedAt: null, model: null, effort: null }),
    worker({ workerId: 'uncertain', status: 'uncertain', running: false, queued: 0, blocked: true, statusReason: '进程退出未确认', lastResultPreview: '核对远端', unresolvedSupplements: 2 }),
    worker({ workerId: 'finished', title: '已结束项目', status: 'completed', running: false, queued: 0, startedAt: '2026-10-13T06:00:00Z', endedAt: '2026-10-13T06:00:20Z' }),
    worker({ workerId: 'idle', status: 'idle', running: false, queued: 0, startedAt: null }),
    worker({ workerId: 'handoff', title: '用户会话', status: 'handed-off', running: false, queued: 0, ownership: 'user' }),
    worker({ workerId: 'pending', status: 'handoff-pending', running: false, queued: 0, statusReason: '交接回执尚未确认' }),
    worker({ workerId: 'failed', status: 'failed', running: false, queued: 0, lastResultPreview: '真实执行失败', endedAt: '2026-10-13T07:59:00Z' }),
  ], 'current', now);
  assert.match(text, /运行1个 · 等待2轮 · 待核对1个/);
  assert.match(text, /模型未知 · CLI 默认 · 未回报/);
  assert.match(text, /本轮耗时：开始时间未记录/);
  assert.match(text, /阻塞：已阻塞/); assert.match(text, /状态说明：进程退出未确认/);
  assert.match(text, /未确认补充回执：2条/);
  assert.match(text, /状态待核对 · 本轮耗时：未知/);
  assert.match(text, /已完成 · 本轮耗时：20秒/); assert.match(text, /空闲 · 本轮耗时：未回报/);
  assert.match(text, /拥有权：用户/); assert.match(text, /已交给用户/); assert.match(text, /交接待确认/);
  assert.match(text, /最近回执：真实执行失败/); assert.match(text, /失败 · 本轮耗时：30秒/);
  assert(!text.includes('主控对话：'));
  const empty = formatWorkerOverview([], 'all', now);
  assert.match(empty, /运行0个 · 等待0轮/); assert.match(empty, /没有正在执行、排队或待核对的助手/);
  assert.equal(elapsedText('invalid', now), '开始时间未记录');
  assert.equal(elapsedText('2026-10-13T09:00:00Z', now), '开始时间未记录');
  assert.equal(elapsedText('2026-10-13T06:00:00Z', now), '2小时0分');
  assert.equal(elapsedText('2026-10-13T06:00:00Z', NaN), '开始时间未记录');
});

test('助手按最后结束时间倒序，运行置顶，历史失败不插队，简版和详情顺序一致', () => {
  const finished = (workerId: string, endedAt?: string, status: WorkerOverview['status'] = 'completed') =>
    worker({ workerId, status, running: false, queued: 0, startedAt: '2026-10-13T06:00:00Z', endedAt });
  const history = [
    finished('missing'), finished('older', '2026-10-13T06:01:00Z'),
    finished('failed', '2026-10-13T06:02:00Z', 'failed'), finished('invalid', 'invalid'),
    finished('newest', '2026-10-13T06:04:00Z'), finished('tied', '2026-10-13T06:04:00Z', 'cancelled'),
  ];
  const original = history.map(item => item.workerId);
  const expected = ['newest', 'tied', 'failed', 'older', 'missing', 'invalid'];
  for (const details of [false, true]) {
    for (const scope of ['current', 'all'] as const) {
      for (const active of [false, true]) {
        const items = active ? [...history, worker({ workerId: 'running' })] : history;
        const text = renderWorkerDetails(items, scope, now, details, active ? 'active' : 'history');
        const ids = text.split('\n').filter(line => /^\d+\. /.test(line)).map(line => line.split(' · ').at(-1));
        assert.deepEqual(ids, active ? ['running', ...expected] : expected);
      }
    }
  }
  assert.deepEqual(history.map(item => item.workerId), original);
});

test('会话名安全截断、短 ID 碰撞扩展且完整复制信息保留', () => {
  const hostile = '长中文标题'.repeat(100) + '\n```ansi\n\u001b[31m@everyone\u202e';
  const workers = [worker({ workerId: '12345678-a', title: hostile, nativeId: 'native-long-123456789', effort: 'xhigh' }),
    worker({ workerId: '12345678-b', title: '正常会话', model: 'gpt-6.1-sol', effort: null }),
    worker({ workerId: 'worker-c', title: '```\u001b[31m\n@everyone', targetLabel: '```\u001b[31m', model: 'gpt-```\n\u001b[31m', effort: '```\n\u001b[31m' })];
  const text = formatWorkerOverview(workers, 'current', now);
  assert.match(text, /极高 · 12345678-a/); assert.match(text, /CLI 默认 · 未回报 · 12345678-b/);
  assert.match(text, /workerId：12345678-a/); assert.match(text, /原生会话 ID：native-long-123456789/);
  const title = text.split('\n').find(line => line.startsWith('会话名：'))!.slice(4);
  assert(title.length <= 80); assert(title.endsWith('…'));
  assert.equal((text.match(/\u001b/g) ?? []).length, 2);
  assert(!text.includes('\u202e')); assert(!text.includes('@everyone'));
  assert.equal((text.match(/```ansi/g) ?? []).length, 1);
  assert.equal((text.match(/^```$/gm) ?? []).length, 7);
  assert.match(formatWorkerOverview([worker({ effort: '__proto__' })], 'current', now), /__proto__/);
});

test('长列表在完整条目之间拆分，每段黄色总览且低于 Discord 2000 单位限制', () => {
  for (const text of [
    formatWorkerOverview(Array.from({ length: 30 }, (_, i) => worker({ workerId: 'worker-' + i, title: '中文标题😀'.repeat(100), targetLabel: '工位'.repeat(100), nativeId: 'native-' + i, lastResultPreview: '回执'.repeat(200), statusReason: '核对'.repeat(200) })), 'all', now),
    formatComputerOverview(Array.from({ length: 30 }, (_, i) => ({ ...computers[0]!, targetId: 'target-' + i, label: '电脑名称😀'.repeat(100), reason: '原因```\u001b[31m'.repeat(100) }))),
  ]) {
    const parts = splitOverviewMessage(text)!;
    assert(parts.length > 1);
    const originalBlocks = text.split('\n\n').slice(1);
    assert.deepEqual(parts.flatMap(part => part.split('\n\n').slice(1)), originalBlocks);
    for (const part of parts) {
      assert(part.length <= 2000); assert(part.startsWith('```ansi\n\u001b[33m'));
      assert.equal((part.match(/^```/gm) ?? []).length % 2, 0);
      assert(!/[\uD800-\uDBFF]$/.test(part));
    }
  }
  assert.equal(splitOverviewMessage('普通主控回复'.repeat(500)), null);
  assert.equal(splitOverviewMessage('```ansi\n\u001b[33m普通黄色回复\u001b[0m\n```'), null);
  const longest = worker({ workerId: 'a'.repeat(35) + '1', conversationTitle: '名'.repeat(120), targetId: 't'.repeat(64), targetLabel: '电'.repeat(120), title: '名'.repeat(200), model: 'm'.repeat(200), effort: 'e'.repeat(120), nativeId: 'n'.repeat(200), status: 'uncertain', running: false, blocked: true, ownership: 'bridge', statusReason: '原'.repeat(200), lastResultPreview: '回'.repeat(200), unresolvedSupplements: 9999 });
  assert(splitOverviewMessage(formatWorkerOverview([longest, { ...longest, workerId: 'a'.repeat(35) + '2' }], 'all', now))!.every(part => part.length <= 2000));
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
function fixture(t: TestContext, options: SessionManagerOptions = {}, configChanges: Partial<BridgeConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-overview-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner', 'other'], defaultAgent: 'codex', workspace: root,
    proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 100, ...configChanges };
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

test('workers uses the saved preset ID, resolves aliases on demand and keeps preset status when the registry is unavailable', async t => {
  const items = [worker({ workerId: 'ordinary', queued: 0 }), worker({ workerId: 'preset', queued: 0, presetId: 'saved-sol' }),
    worker({ workerId: 'retired', presetId: 'retired-sol', running: false, queued: 0, status: 'completed' })];
  const f = fixture(t, { onListWorkers: async () => items });
  const root = join(f.config.workspace, 'agent-presets'); mkdirSync(root);
  const path = join(root, 'registry.json');
  writeFileSync(path, JSON.stringify({ version: 1, presets: [{ id: 'saved-sol', aliases: ['工位 sol'], targetId: 'workstation',
    agent: 'codex', model: 'gpt-6.1-sol', profileId: 'gateway-sol', revision: 1, enabled: false }] }));
  await f.manager.handle(message('labels', '/workers'));
  assert.match(f.replies[0]!, /普通 · 工位 · Codex · 6\.1-sol/);
  assert.match(f.replies[0]!, /预设·工位 sol · 工位 · Codex · 6\.1-sol/);
  await f.manager.handle(message('retired-label', '/workers history details'));
  assert.match(f.replies[1]!, /预设·retired-sol/); assert.match(f.replies[1]!, /预设 ID：retired-sol/);
  writeFileSync(path, '{');
  await f.manager.handle(message('unavailable-label', '/workers details'));
  assert.match(f.replies[2]!, /预设·saved-sol/); assert.match(f.replies[2]!, /预设 ID：saved-sol/);
  assert.match(f.replies[2]!, /普通 · 工位/); assert.equal(f.adapter.turns.length, 0);
  assert.equal(items[1]!.presetLabel, undefined);
});

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
  assert.match(replies[0]!, /运行1个/); assert.equal(replies[1], '❌ 【桥】命令失败\n\n请核对命令或查看本地记录。');
  assert(!replies.join('').includes('credential-sensitive'));
  assert.equal(f.adapter.turns.length, 1); assert.deepEqual(f.replies, []);
});

test('主控处理只表示已有执行状态，纯排队保持原输入条数并不合并计数', async t => {
  const f = fixture(t, { onListWorkers: async () => [] }, { controllerMode: true });
  await f.manager.handle(message('create', '/workers'));
  const replies: string[] = [];
  await f.manager.handle(message('idle-status', '/status'), async text => { replies.push(text); });
  assert.match(replies[0]!, /空闲；排队 0 条/); assert(!replies[0]!.includes('主控处理'));
  await f.manager.handle(message('first-work', '开始工作'));
  const deadline = Date.now() + 2000;
  while (f.adapter.turns.length !== 1) { assert(Date.now() < deadline); await delay(5); }
  await f.manager.handle(message('queued-work', '下一轮工作'));
  await f.manager.handle(message('busy-status', '/status'), async text => { replies.push(text); });
  assert.match(replies[1]!, /主控处理1；排队 1 条/); assert(!replies[1]!.includes('主控处理2'));
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

test('workers 当前与历史互斥，all 和 details 不改变筛选，查询不启动模型', async t => {
  const items = [worker({ workerId: 'active', title: '当前运行' }),
    worker({ workerId: 'queued', title: '正在排队', status: 'queued', running: false, queued: 1 }),
    worker({ workerId: 'uncertain', title: '尚待核对', status: 'uncertain', running: false, queued: 0 }),
    ...(['retiring', 'completed', 'failed', 'cancelled', 'idle', 'handed-off'] as const).map(status => worker({ workerId: status, title: '历史_' + status, status, running: false, queued: 0 }))];
  const scopes: string[] = [];
  const f = fixture(t, { onListWorkers: async (_conversation, scope) => { scopes.push(scope); return items; } });
  await f.manager.handle(message('active-query', '/workers'));
  assert.match(f.replies[0]!, /当前运行/); assert.match(f.replies[0]!, /正在排队/); assert.match(f.replies[0]!, /尚待核对/); assert(!f.replies[0]!.includes('历史_'));
  await f.manager.handle(message('history-query', '/workers history all details'));
  const history = f.replies[1]!;
  assert.match(history, /你的全部对话的历史助手 · 共6个/);
  for (const status of ['retiring', 'completed', 'failed', 'cancelled', 'idle', 'handed-off']) assert(history.includes('历史_' + status));
  assert(!history.includes('当前运行')); assert(!history.includes('正在排队')); assert(!history.includes('尚待核对'));
  assert.match(history, /workerId：completed/); assert.deepEqual(scopes, ['current', 'all']); assert.equal(f.adapter.turns.length, 0);
});
