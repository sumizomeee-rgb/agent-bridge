import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Response } from 'undici';
import WebSocket from 'ws';
import { DiscordTransport } from '../src/discord.js';
import { formatComputerOverview, formatWorkerOverview, splitOverviewMessage, type WorkerOverview } from '../src/overview.js';
import type { BridgeConfig } from '../src/types.js';

function fixture(t: TestContext) {
  const requests: Array<{ path: string; method: string | undefined; body: { content: string; allowed_mentions: unknown } }> = [];
  const packets: Array<{ op: number; d: { activities: Array<{ state: string }> } }> = [];
  const config: BridgeConfig = { token: 'unused', allowedUserIds: ['111'], defaultAgent: 'codex', workspace: 'unused', proxyUrl: null,
    commands: { codex: { command: 'unused', args: [] }, claude: { command: 'unused', args: [] } }, dataDir: 'unused', attachmentsDir: 'unused', logsDir: 'unused', maxImageBytes: 100 };
  const transport = new DiscordTransport(config, async () => assert.fail('不能收到真实消息'), {
    restBaseUrl: 'https://overview.test.invalid/api', presenceCoalesceMs: 1, presenceWindowMs: 20,
    webSocketFactory: () => { throw new Error('不能连接 Gateway'); },
    fetch: async (input, options) => {
      assert(String(input).startsWith('https://overview.test.invalid/api/'));
      requests.push({ path: String(input), method: options?.method, body: JSON.parse(String(options?.body)) });
      return new Response('{"id":"555"}', { status: 200 });
    },
  });
  // 只注入内存 socket，验证实际 presence 路径，不创建网络连接或启动桥。
  Reflect.set(transport, 'ws', { readyState: WebSocket.OPEN, send: (text: string) => packets.push(JSON.parse(text)), terminate() {} });
  Reflect.set(transport, 'gatewayReady', true);
  t.after(() => transport.close());
  return { transport, requests, packets, state: () => packets.at(-1)?.d.activities[0]?.state };
}

test('presence 使用运行助手与等待轮数，0、无效计数、重启覆盖和合并保持原语义', async t => {
  const f = fixture(t);
  f.transport.setPresence('idle'); assert.equal(f.state(), '已重启');
  f.transport.setWorkCounts({ running: 1, queued: 2 });
  f.transport.setWorkCounts({ running: 3, queued: 4 });
  await delay(10); assert.equal(f.state(), '已重启 · 运行助手3 · 等待4轮');
  for (const count of [-1, 0.5, NaN, Infinity]) f.transport.setWorkCounts({ running: count, queued: 0 });
  await delay(5); assert.equal(f.state(), '已重启 · 运行助手3 · 等待4轮');
  f.transport.setPresence('draining'); assert.equal(f.state(), '准备重启');
  f.transport.setWorkCounts({ running: 2, queued: 0 }); await delay(5); assert.equal(f.state(), '准备重启');
  f.transport.setPresence('idle'); assert.equal(f.state(), '已重启 · 运行助手2');
  Reflect.set(f.transport, 'restartNotice', false);
  f.transport.setWorkCounts({ running: 0, queued: 0 }); await delay(30); assert.equal(f.state(), '空闲');
  f.transport.setWorkCounts({ running: 0, queued: 5 }); await delay(30); assert.equal(f.state(), '等待5轮');
  assert.equal(f.requests.length, 0);
});

test('普通 DM 和斜杠交互均在总览完整条目边界分页，保持编号且禁用提及', async t => {
  const workers: WorkerOverview[] = Array.from({ length: 25 }, (_, i) => ({
    workerId: 'worker-' + i, conversationId: 'parent', targetId: 'local', targetLabel: '桥电脑', agent: 'codex', title: '中文长标题😀'.repeat(100),
    model: 'gpt-6.1-sol', effort: 'xhigh', nativeId: 'native-' + i, status: 'running', running: true, queued: i % 3, startedAt: '2026-10-13T08:00:00Z',
  }));
  const computerText = formatComputerOverview(Array.from({ length: 25 }, (_, i) => ({ targetId: 'computer-' + i, label: '电脑'.repeat(100),
    transport: 'ssh', connection: 'unknown', checkedAt: null, agents: [{ agent: 'codex', cli: 'unknown' }] })));
  for (const text of [formatWorkerOverview(workers, 'current', Date.parse('2026-10-13T08:01:00Z')), computerText]) {
    const f = fixture(t), parts = splitOverviewMessage(text)!;
    await f.transport.sendText('222', text);
    assert.deepEqual(f.requests.map(request => request.body.content), parts);
    assert(f.requests.every(request => request.path.endsWith('/channels/222/messages') && request.method === 'POST'));
    f.requests.length = 0;
    await f.transport.sendInteractionText({ id: '12345', applicationId: '777', token: 'unused-interaction' }, text);
    assert.deepEqual(f.requests.map(request => request.body.content), parts);
    assert.equal(f.requests[0]!.method, 'PATCH');
    assert(f.requests.slice(1).every(request => request.method === 'POST' && request.path.endsWith('/webhooks/777/unused-interaction')));
    for (const request of f.requests) {
      assert(request.body.content.length <= 2000);
      assert.equal((request.body.content.match(/^```/gm) ?? []).length % 2, 0);
      assert.deepEqual(request.body.allowed_mentions, { parse: [] });
    }
  }
});
