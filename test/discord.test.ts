import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { fetch, ProxyAgent, Response } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket, { WebSocketServer } from 'ws';
import { DiscordTransport, ImagePreparationError, ingressFailureText, type DiscordTransportOptions } from '../src/discord.js';
import { discordReplyHeader } from '../src/reply.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';

interface Packet { op: number; d?: Record<string, unknown> | number | null; t?: string; s?: number }
const badHttpPorts = (createRequire(import.meta.url)('undici/lib/web/fetch/constants.js') as { badPortsSet: Set<string> }).badPortsSet;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)]);
const attachment = (changes: Record<string, unknown> = {}) => ({
  id: '888', filename: 'image.png', url: 'https://cdn.discordapp.com/attachments/123/888/image.png',
  size: png.length, content_type: 'image/png', ...changes,
});
const message = (changes: Partial<IncomingDM> = {}): IncomingDM => ({
  id: '1', userId: '111', channelId: '222', text: '', attachments: [attachment()], ...changes,
});

async function eventually(check: () => boolean, timeout = 2000): Promise<void> {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error('Condition not reached before deadline');
    await delay(5);
  }
}

async function fixture(t: TestContext, onMessage: (message: IncomingDM) => Promise<void> = async () => {},
  overrides: DiscordTransportOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'discord-transport-test-'));
  const packets: Packet[] = [];
  const posts: Record<string, unknown>[] = [];
  const headers: IncomingMessage['headers'][] = [];
  const sockets: WebSocket[] = [];
  let heartbeatCount = 0;
  let acknowledge = true;
  let sequence = 0;
  let postHandler: ((body: Record<string, unknown>, response: ServerResponse) => void) | undefined;
  let imageHandler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  const http = createServer(async (request, response) => {
    headers.push(request.headers);
    if (request.url?.startsWith('/attachments/')) {
      if (imageHandler) imageHandler(request, response);
      else { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); }
      return;
    }
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      posts.push(parsed);
      if (postHandler) postHandler(parsed, response);
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"id":"555"}'); }
    } else { response.writeHead(404); response.end(); }
  });
  let httpAddress: ReturnType<typeof http.address> = null;
  // Windows may assign an ephemeral legacy service port that Fetch explicitly forbids.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    assert(address && typeof address !== 'string');
    if (!badHttpPorts.has(String(address.port))) { httpAddress = address; break; }
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
  assert(httpAddress && typeof httpAddress !== 'string', 'Could not allocate a safe local HTTP test port');
  const rest = `http://127.0.0.1:${httpAddress.port}`;
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => gateway.once('listening', resolve));
  const gatewayAddress = gateway.address();
  assert(gatewayAddress && typeof gatewayAddress !== 'string');
  const wsUrl = `ws://127.0.0.1:${gatewayAddress.port}`;
  gateway.on('connection', socket => {
    sockets.push(socket);
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 40 } }));
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString()) as Packet;
      packets.push(packet);
      if (packet.op === 1) {
        heartbeatCount++;
        if (acknowledge) socket.send('{"op":11}');
      } else if (packet.op === 2) {
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: ++sequence,
          d: { session_id: 'test-session', resume_gateway_url: wsUrl, user: { id: '999', username: 'TestBot', bot: true } } }));
      } else if (packet.op === 6) {
        socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: ++sequence, d: {} }));
      }
    });
  });
  const config: BridgeConfig = {
    token: 'fake-token-for-local-tests', allowedUserIds: ['111'], defaultAgent: 'codex',
    workspace: root, proxyUrl: null, commands: { codex: { command: 'codex', args: [] }, claude: { command: 'claude', args: [] } },
    dataDir: root, attachmentsDir: join(root, 'attachments'), logsDir: root, maxImageBytes: 32,
  };
  const transport = new DiscordTransport(config, onMessage, {
    restBaseUrl: rest, gatewayUrl: wsUrl, reconnectBaseMs: 5, reconnectMaxMs: 20,
    identifyIntervalMs: 1, invalidSessionDelayMs: 5, readyTimeoutMs: 2000, random: () => 0.5, logger: () => {},
    fetch: (input, options) => {
      const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href);
      if (['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
        return fetch(`${rest}${url.pathname}${url.search}`, options);
      }
      assert.equal(url.origin, rest, 'Tests must never call real Discord endpoints');
      return fetch(input, options);
    }, ...overrides,
  });
  t.after(async () => {
    await transport.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    const cleanupRoot = resolve(root);
    assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
    assert(basename(cleanupRoot).startsWith('discord-transport-test-'));
    const directories = [cleanupRoot];
    while (directories.length) {
      const directory = directories.pop()!;
      assert(!(await lstat(directory)).isSymbolicLink());
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        const stat = await lstat(path);
        assert(!stat.isSymbolicLink());
        if (stat.isDirectory()) directories.push(path);
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  function dispatch(changes: Record<string, unknown> = {}) {
    const socket = sockets.at(-1)!;
    socket.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: ++sequence, d: {
      id: String(sequence + 100), channel_id: '222', content: 'hello', author: { id: '111', bot: false },
      attachments: [], ...changes,
    } }));
  }
  return { transport, config, packets, posts, headers, sockets, dispatch, rest, wsUrl,
    get heartbeats() { return heartbeatCount; },
    set acknowledge(value: boolean) { acknowledge = value; },
    set postHandler(handler: typeof postHandler) { postHandler = handler; },
    set imageHandler(handler: typeof imageHandler) { imageHandler = handler; },
  };
}

test('Presence仅op3自定义state，去重并重连恢复当前状态，READY/RESUMED不伪造重启私信', async t => {
  const f = await fixture(t);
  f.transport.setPresence('idle'); await f.transport.start();
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 1);
  f.transport.setPresence('idle'); f.transport.setPresence('idle'); await delay(10);
  assert.equal(f.packets.filter(packet => packet.op === 3).length, 1);
  f.transport.setPresence('draining'); f.transport.setPresence('draining');
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 2);
  const first = f.packets.find(packet => packet.op === 3)!.d as Record<string, unknown>;
  assert.equal(first.status, 'online');
  assert.deepEqual(first.activities, [{ name: 'Bridge', type: 4, state: '已重启' }]);
  f.sockets.at(-1)!.terminate();
  await eventually(() => f.packets.some(packet => packet.op === 6) && f.packets.filter(packet => packet.op === 3).length === 3);
  const restored = f.packets.filter(packet => packet.op === 3).at(-1)!.d as Record<string, unknown>;
  assert.equal(restored.status, 'idle'); assert.deepEqual(restored.activities, [{ name: 'Bridge', type: 4, state: '准备重启' }]);
  assert.equal(f.posts.length, 0);
});

test('重启提示保留至获准用户输入，后台发送和未授权消息不清除，重连不重新出现', async t => {
  const received: IncomingDM[] = [];
  const f = await fixture(t, async message => { received.push(message); }, { presenceCoalesceMs: 5, presenceWindowMs: 100 });
  const state = () => {
    const packet = f.packets.filter(packet => packet.op === 3).at(-1);
    return packet ? ((packet.d as Record<string, unknown>).activities as Array<{ state: string }>)[0]!.state : undefined;
  };
  f.transport.setPresence('idle'); await f.transport.start(); await eventually(() => state() === '已重启');
  f.transport.setWorkCounts({ running: 1, queued: 0 }); await eventually(() => state() === '已重启 · 运行 1');
  await f.transport.sendText('222', '后台结果。'); assert.equal(state(), '已重启 · 运行 1');
  f.dispatch({ author: { id: '444', bot: false } }); await delay(20); assert.equal(state(), '已重启 · 运行 1');
  f.dispatch(); await eventually(() => received.length === 1 && state() === '运行 1');
  f.transport.setWorkCounts({ running: 0, queued: 0 }); await eventually(() => state() === '空闲');
  f.sockets.at(-1)!.terminate(); await eventually(() => f.packets.some(packet => packet.op === 6));
  await eventually(() => f.packets.filter(packet => packet.op === 3).length >= 5); assert.equal(state(), '空闲');
});

test('全桥数量合并、完整文字去重，重启阶段覆盖数字，恢复正常后采用最新数量', async t => {
  const f = await fixture(t, async () => {}, { presenceCoalesceMs: 15 });
  f.transport.setPresence('idle'); await f.transport.start();
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 1);
  f.transport.setWorkCounts({ running: 1, queued: 0 });
  f.transport.setWorkCounts({ running: 2, queued: 3 });
  f.transport.setWorkCounts({ running: 2, queued: 3 });
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 2);
  const state = () => ((f.packets.filter(packet => packet.op === 3).at(-1)!.d as Record<string, unknown>).activities as Array<{ state: string }>)[0]!.state;
  assert.equal(state(), '已重启 · 运行 2 · 排队 3');
  f.transport.setWorkCounts({ running: 2, queued: 3 }); await delay(25);
  assert.equal(f.packets.filter(packet => packet.op === 3).length, 2);
  f.transport.setPresence('draining');
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 3);
  f.transport.setWorkCounts({ running: 9, queued: 8 }); await delay(25);
  assert.equal(state(), '准备重启');
  assert.equal(f.packets.filter(packet => packet.op === 3).length, 3);
  f.transport.setPresence('idle');
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 4);
  assert.equal(state(), '已重启 · 运行 9 · 排队 8');
  assert.equal(f.posts.length, 0);
});

test('全桥数量同阶段限流只保留最新值，重连强制发布，错误数量不影响状态', async t => {
  const f = await fixture(t, async () => {}, { presenceWindowMs: 100, presenceCoalesceMs: 0 });
  f.transport.setPresence('idle'); await f.transport.start();
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 1);
  for (let count = 1; count <= 4; count++) {
    f.transport.setWorkCounts({ running: count, queued: 0 });
    await eventually(() => f.packets.filter(packet => packet.op === 3).length === count + 1);
  }
  f.transport.setWorkCounts({ running: 5, queued: 2 });
  f.transport.setWorkCounts({ running: 6, queued: 3 });
  await delay(10); assert.equal(f.packets.filter(packet => packet.op === 3).length, 5);
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 6);
  const latest = () => f.packets.filter(packet => packet.op === 3).at(-1)!.d as Record<string, unknown>;
  assert.deepEqual(latest().activities, [{ name: 'Bridge', type: 4, state: '已重启 · 运行 6 · 排队 3' }]);
  for (const count of [-1, 0.5, NaN, Infinity]) f.transport.setWorkCounts({ running: count, queued: 0 });
  await delay(10); assert.equal(f.packets.filter(packet => packet.op === 3).length, 6);
  f.sockets.at(-1)!.terminate();
  await eventually(() => f.packets.some(packet => packet.op === 6) && f.packets.filter(packet => packet.op === 3).length === 7);
  assert.deepEqual(latest().activities, [{ name: 'Bridge', type: 4, state: '已重启 · 运行 6 · 排队 3' }]);
  assert.equal(f.posts.length, 0);
});

test('恢复和失败状态优先于全桥计数，关闭后不会继续发布', async t => {
  const f = await fixture(t, async () => {}, { presenceCoalesceMs: 15 });
  f.transport.setWorkCounts({ running: 3, queued: 2 });
  await f.transport.start();
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 1);
  assert.deepEqual((f.packets.find(packet => packet.op === 3)!.d as Record<string, unknown>).activities,
    [{ name: 'Bridge', type: 4, state: '恢复中' }]);
  f.transport.setPresence('failed');
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 2);
  const failed = f.packets.filter(packet => packet.op === 3).at(-1)!.d as Record<string, unknown>;
  assert.equal(failed.status, 'dnd');
  assert.deepEqual(failed.activities, [{ name: 'Bridge', type: 4, state: '重启失败' }]);
  f.transport.setPresence('idle');
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 3);
  f.transport.setWorkCounts({ running: 4, queued: 0 });
  await f.transport.close(); await delay(25);
  assert.equal(f.packets.filter(packet => packet.op === 3).length, 3);
  assert.equal(f.posts.length, 0);
});

test('Presence每个窗口最多5次，超限合并到最新状态，不发送限流通知私信', async t => {
  const f = await fixture(t, async () => {}, { presenceWindowMs: 100 });
  await f.transport.start(); await eventually(() => f.packets.filter(packet => packet.op === 3).length === 1);
  f.transport.setPresence('idle'); f.transport.setPresence('draining'); f.transport.setPresence('idle'); f.transport.setPresence('recovering');
  f.transport.setPresence('failed'); f.transport.setPresence('draining');
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 5);
  await delay(10); assert.equal(f.packets.filter(packet => packet.op === 3).length, 5);
  await eventually(() => f.packets.filter(packet => packet.op === 3).length === 6);
  const packet = f.packets.filter(item => item.op === 3).at(-1)!.d as Record<string, unknown>;
  assert.deepEqual(packet.activities, [{ name: 'Bridge', type: 4, state: '准备重启' }]);
  assert.equal(f.posts.length, 0);
});

test('⏳ 只标记白名单普通私聊，重放去重且不等待表情请求', async t => {
  const received: IncomingDM[] = [];
  const reactions: Array<{ url: string; method: string | undefined }> = [];
  const f = await fixture(t, async dm => { received.push(dm); }, {
    fetch: async (input, options) => {
      const url = String(input);
      if (url.includes('/reactions/')) {
        reactions.push({ url, method: options?.method });
        return new Promise(() => {});
      }
      throw new Error('测试不允许其他 REST 请求');
    },
  });
  await f.transport.start();
  f.dispatch({ guild_id: '333' });
  f.dispatch({ author: { id: '444' } });
  f.dispatch({ author: { id: '111', bot: true } });
  f.dispatch({ id: '200' });
  f.dispatch({ id: '200' });
  f.dispatch({ id: '201' });
  await eventually(() => received.length === 2 && f.heartbeats >= 2);
  assert.equal(reactions.length, 2);
  assert.equal(reactions[0]!.method, 'PUT');
  assert.equal(new URL(reactions[0]!.url).pathname, '/channels/222/messages/200/reactions/%E2%8F%B3/@me');
});

test('⏳ 请求被拒绝不阻挡收件，也不发多余错误私聊', async t => {
  const received: IncomingDM[] = [];
  const f = await fixture(t, async dm => { received.push(dm); }, {
    fetch: async () => new Response('{}', { status: 403 }),
  });
  await f.transport.start();
  f.dispatch({ id: '300' });
  await eventually(() => received.length === 1);
  await delay(20);
  assert.equal(f.posts.length, 0);
});

test('快速回复等待初始沙漏请求完成后再改成完成，不阻挡收件和心跳', async t => {
  const received: IncomingDM[] = [];
  const calls: Array<{ path: string; method: string | undefined }> = [];
  let release!: (response: Response) => void;
  const f = await fixture(t, async dm => { received.push(dm); }, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      if (path.endsWith('/reactions/⏳/@me') && options?.method === 'PUT') {
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return new Response(null, { status: 204 });
    },
  });
  await f.transport.start();
  f.dispatch({ id: '400' });
  await eventually(() => received.length === 1 && calls.length === 1);
  const completion = f.transport.markReplyDelivered([{ id: '400', channelId: '222' }]);
  await eventually(() => f.heartbeats >= 2);
  assert.equal(calls.length, 1, 'Completion cannot overtake the pending receipt');
  release(new Response(null, { status: 204 }));
  await completion;
  assert.deepEqual(calls, [
    { path: '/channels/222/messages/400/reactions/⏳/@me', method: 'PUT' },
    { path: '/channels/222/messages/400/reactions/✅/@me', method: 'PUT' },
    { path: '/channels/222/messages/400/reactions/⏳/@me', method: 'DELETE' },
  ]);
  assert.equal(f.posts.length, 0, 'Reaction updates do not add chat messages');
});

test('完成表情添加失败保留沙漏，反应错误不变成额外私聊', async t => {
  const received: IncomingDM[] = [];
  const calls: Array<{ path: string; method: string | undefined }> = [];
  const f = await fixture(t, async dm => { received.push(dm); }, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      return new Response(null, { status: path.endsWith('/reactions/✅/@me') ? 403 : 204 });
    },
  });
  await f.transport.start();
  f.dispatch({ id: '401' });
  await eventually(() => received.length === 1);
  await f.transport.markReplyDelivered([{ id: '401', channelId: '222' }]);
  assert.deepEqual(calls.map(call => call.method), ['PUT', 'PUT']);
  assert(calls[0]!.path.endsWith('/reactions/⏳/@me'));
  assert(calls[1]!.path.endsWith('/reactions/✅/@me'));
  assert.equal(f.posts.length, 0);
});

test('批次完成按各自 channel 和原消息 ID 更新，重复 ID 去重，初始反应失败也可标完成', async t => {
  const received: IncomingDM[] = [];
  const calls: Array<{ path: string; method: string | undefined }> = [];
  const f = await fixture(t, async dm => { received.push(dm); }, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      return new Response(null, { status: options?.method === 'PUT' && path.endsWith('/reactions/⏳/@me') ? 403 : 204 });
    },
  });
  await f.transport.start();
  f.dispatch({ id: '402' });
  f.dispatch({ id: '403', channel_id: '223' });
  await eventually(() => received.length === 2);
  await f.transport.markReplyDelivered([
    { id: '402', channelId: '222' }, { id: '403', channelId: '223' }, { id: '402', channelId: '222' },
  ]);
  const completion = calls.filter(call => call.path.endsWith('/reactions/✅/@me'));
  assert.deepEqual(completion, [
    { path: '/channels/222/messages/402/reactions/✅/@me', method: 'PUT' },
    { path: '/channels/223/messages/403/reactions/✅/@me', method: 'PUT' },
  ]);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 2);
});

test('原生斜杠交互不使用消息 reaction，关闭后也不新增反应请求', async t => {
  const received: IncomingDM[] = [];
  const reactionPaths: string[] = [];
  const f = await fixture(t, async dm => { received.push(dm); }, {
    fetch: async input => {
      const path = new URL(String(input)).pathname;
      if (path.includes('/reactions/')) reactionPaths.push(path);
      return new Response(null, { status: 204 });
    },
  });
  await f.transport.start();
  f.sockets.at(-1)!.send(JSON.stringify({
    op: 0, t: 'INTERACTION_CREATE', s: 10, d: {
      type: 2, id: '405', application_id: '999', token: 'fake-local-interaction',
      channel_id: '222', context: 1, user: { id: '111', bot: false },
      data: { name: 'status', type: 1 },
    },
  }));
  await eventually(() => received.length === 1);
  assert(received[0]!.interaction);
  await f.transport.markReplyDelivered([{ id: '405', channelId: '222' }]);
  await f.transport.setTaskCount({ id: '405', channelId: '222' }, 2);
  await f.transport.close();
  await f.transport.markReplyDelivered([{ id: '406', channelId: '222' }]);
  await f.transport.setTaskCount({ id: '406', channelId: '222' }, 2);
  assert.deepEqual(reactionPaths, []);
});

test('登记 Agent 数量按最新值更新、重复值不重发、归零只移除自己的数字', async t => {
  const calls: Array<{ path: string; method: string | undefined }> = [];
  const f = await fixture(t, undefined, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      return options?.method === 'GET' ? new Response('{"reactions":[]}', { status: 200 })
        : new Response(null, { status: 204 });
    },
  });
  const target = { id: '501', channelId: '222' };
  await f.transport.setTaskCount(target, 1);
  await f.transport.setTaskCount(target, 1);
  await f.transport.setTaskCount(target, 3);
  await f.transport.setTaskCount(target, 0);
  await f.transport.setTaskCount(target, 0);
  assert.deepEqual(calls, [
    { path: '/channels/222/messages/501', method: 'GET' },
    { path: '/channels/222/messages/501/reactions/1️⃣/@me', method: 'PUT' },
    { path: '/channels/222/messages/501/reactions/3️⃣/@me', method: 'PUT' },
    { path: '/channels/222/messages/501/reactions/1️⃣/@me', method: 'DELETE' },
    { path: '/channels/222/messages/501/reactions/3️⃣/@me', method: 'DELETE' },
  ]);
  assert.equal(f.posts.length, 0);
});

test('十个 Agent 用 🔟，超过十个用 🔟 和 ➕，下降时及时移除额外标记', async t => {
  const calls: Array<{ path: string; method: string | undefined }> = [];
  const f = await fixture(t, undefined, {
    fetch: async (input, options) => {
      calls.push({ path: decodeURIComponent(new URL(String(input)).pathname), method: options?.method });
      return options?.method === 'GET' ? new Response('{"reactions":[]}', { status: 200 })
        : new Response(null, { status: 204 });
    },
  });
  const target = { id: '502', channelId: '222' };
  await f.transport.setTaskCount(target, 11);
  await f.transport.setTaskCount(target, 12);
  await f.transport.setTaskCount(target, 10);
  await f.transport.setTaskCount(target, 2);
  assert.deepEqual(calls.slice(1).map(call => [call.method, call.path.split('/reactions/')[1]]), [
    ['PUT', '🔟/@me'], ['PUT', '➕/@me'], ['DELETE', '➕/@me'], ['PUT', '2️⃣/@me'], ['DELETE', '🔟/@me'],
  ]);
});

test('重启后的首次计数读取现有反应，仅修正机器人自己的数字并保留用户、沙漏和完成反应', async t => {
  const calls: Array<{ path: string; method: string | undefined }> = [];
  const f = await fixture(t, undefined, {
    fetch: async (input, options) => {
      calls.push({ path: decodeURIComponent(new URL(String(input)).pathname), method: options?.method });
      return options?.method === 'GET' ? new Response(JSON.stringify({ reactions: [
        { me: true, emoji: { name: '3⃣' } }, { me: false, emoji: { name: '8️⃣' } },
        { me: true, emoji: { name: '➕' } }, { me: true, emoji: { name: '⏳' } },
        { me: true, emoji: { name: '✅' } }, { me: true, emoji: { name: 'custom-marker', id: '444' } },
      ] }), { status: 200 }) : new Response(null, { status: 204 });
    },
  });
  await f.transport.setTaskCount({ id: '503', channelId: '222' }, 2);
  assert.deepEqual(calls.slice(1), [
    { path: '/channels/222/messages/503/reactions/2️⃣/@me', method: 'PUT' },
    { path: '/channels/222/messages/503/reactions/3⃣/@me', method: 'DELETE' },
    { path: '/channels/222/messages/503/reactions/➕/@me', method: 'DELETE' },
  ]);
  assert(calls.filter(call => call.method === 'DELETE').every(call => call.path.endsWith('/@me')));
});

test('同一消息的并发计数严格按调用顺序完成，不会留下过期数字', async t => {
  const calls: Array<{ path: string; method: string | undefined }> = [];
  let release!: (response: Response) => void;
  const f = await fixture(t, undefined, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      if (path.endsWith('/reactions/1️⃣/@me') && options?.method === 'PUT') {
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return options?.method === 'GET' ? new Response('{"reactions":[]}', { status: 200 })
        : new Response(null, { status: 204 });
    },
  });
  const target = { id: '504', channelId: '222' };
  const first = f.transport.setTaskCount(target, 1);
  const second = f.transport.setTaskCount(target, 2);
  const third = f.transport.setTaskCount(target, 0);
  await eventually(() => calls.length === 2);
  await delay(20);
  assert.equal(calls.length, 2);
  release(new Response(null, { status: 204 }));
  await Promise.all([first, second, third]);
  assert.deepEqual(calls.slice(1).map(call => [call.method, call.path.split('/reactions/')[1]]), [
    ['PUT', '1️⃣/@me'], ['PUT', '2️⃣/@me'], ['DELETE', '1️⃣/@me'], ['DELETE', '2️⃣/@me'],
  ]);
});

test('任务计数等待初始收件完成，父回复完成后仍保留运行子任务数字', async t => {
  const received: IncomingDM[] = [];
  const calls: Array<{ path: string; method: string | undefined }> = [];
  let release!: (response: Response) => void;
  const f = await fixture(t, async dm => { received.push(dm); }, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      if (path.endsWith('/reactions/⏳/@me') && options?.method === 'PUT') {
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return options?.method === 'GET' ? new Response('{"reactions":[]}', { status: 200 })
        : new Response(null, { status: 204 });
    },
  });
  await f.transport.start();
  f.dispatch({ id: '505' });
  await eventually(() => received.length === 1);
  const target = { id: '505', channelId: '222' };
  const pending = f.transport.setTaskCount(target, 2);
  await delay(20);
  assert.equal(calls.length, 1);
  release(new Response(null, { status: 204 }));
  await pending;
  await f.transport.markReplyDelivered([target]);
  assert(calls.some(call => call.method === 'PUT' && call.path.endsWith('/reactions/2️⃣/@me')));
  assert(calls.some(call => call.method === 'PUT' && call.path.endsWith('/reactions/✅/@me')));
  assert(!calls.some(call => call.method === 'DELETE' && call.path.endsWith('/reactions/2️⃣/@me')));
  await f.transport.setTaskCount(target, 0);
  assert(calls.at(-1)!.path.endsWith('/reactions/2️⃣/@me'));
  assert.equal(calls.at(-1)!.method, 'DELETE');
});

test('计数读取或反应失败不会阻断对话，后续调用能重试并清理已成功的部分', async t => {
  const calls: Array<{ path: string; method: string | undefined }> = [];
  let rejectGet = true, rejectPlus = true, rejectDelete = true;
  const f = await fixture(t, undefined, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      if (options?.method === 'GET') {
        if (rejectGet) { rejectGet = false; return new Response('{}', { status: 403 }); }
        return new Response('{"reactions":[]}', { status: 200 });
      }
      if (options?.method === 'PUT' && path.endsWith('/reactions/➕/@me') && rejectPlus) {
        rejectPlus = false; return new Response('{}', { status: 403 });
      }
      if (options?.method === 'DELETE' && rejectDelete) {
        rejectDelete = false; return new Response('{}', { status: 403 });
      }
      return new Response(null, { status: 204 });
    },
  });
  const target = { id: '506', channelId: '222' };
  await f.transport.setTaskCount(target, 11);
  await f.transport.setTaskCount(target, 11);
  await f.transport.setTaskCount(target, 11);
  await f.transport.setTaskCount(target, 0);
  await f.transport.setTaskCount(target, 0);
  assert.equal(calls.filter(call => call.method === 'GET').length, 2);
  assert.equal(calls.filter(call => call.method === 'PUT' && call.path.endsWith('/reactions/🔟/@me')).length, 1);
  assert.equal(calls.filter(call => call.method === 'PUT' && call.path.endsWith('/reactions/➕/@me')).length, 2);
  assert.equal(calls.filter(call => call.method === 'DELETE' && call.path.endsWith('/reactions/🔟/@me')).length, 2);
  assert.equal(calls.filter(call => call.method === 'DELETE' && call.path.endsWith('/reactions/➕/@me')).length, 1);
  assert.equal(f.posts.length, 0);
});

test('不同消息计数不相互阻塞，非法 ID 或计数不发网络请求', async t => {
  const calls: Array<{ path: string; method: string | undefined }> = [];
  let release!: (response: Response) => void;
  const f = await fixture(t, undefined, {
    fetch: async (input, options) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      calls.push({ path, method: options?.method });
      if (path === '/channels/222/messages/507') return new Promise<Response>(resolve => { release = resolve; });
      return options?.method === 'GET' ? new Response('{"reactions":[]}', { status: 200 })
        : new Response(null, { status: 204 });
    },
  });
  await f.transport.setTaskCount({ id: 'bad', channelId: '222' }, 1);
  await f.transport.setTaskCount({ id: '507', channelId: 'bad' }, 1);
  for (const count of [-1, 0.5, NaN, Infinity]) await f.transport.setTaskCount({ id: '507', channelId: '222' }, count);
  assert.equal(calls.length, 0);
  const first = f.transport.setTaskCount({ id: '507', channelId: '222' }, 1);
  await eventually(() => calls.length === 1);
  await f.transport.setTaskCount({ id: '508', channelId: '223' }, 2);
  assert(calls.some(call => call.path === '/channels/223/messages/508/reactions/2️⃣/@me'));
  release(new Response('{"reactions":[]}', { status: 200 }));
  await first;
});

test('READY exposes bot identity, only allowed human DMs are delivered, replay is deduplicated', async t => {
  const received: IncomingDM[] = [];
  const f = await fixture(t, async dm => { received.push(dm); });
  await f.transport.start();
  assert.deepEqual(f.transport.botUser, { id: '999', username: 'TestBot' });
  const identify = f.packets.find(packet => packet.op === 2)!;
  assert.equal((identify.d as Record<string, unknown>).intents, 4096);
  f.dispatch({ guild_id: '333' });
  f.dispatch({ author: { id: '111', bot: true } });
  f.dispatch({ author: { id: '444' } });
  f.dispatch({ webhook_id: '555' });
  f.dispatch({ id: '200', content: '', attachments: [attachment()] });
  f.dispatch({ id: '200', content: 'replayed' });
  await eventually(() => received.length === 1);
  await delay(30);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.text, '');
  assert.equal(received[0]!.attachments.length, 1);
});

test('an unfinished agent turn does not block heartbeat or subsequent messages', async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let received = 0;
  const f = await fixture(t, async () => { received++; await blocked; });
  await f.transport.start();
  f.dispatch(); f.dispatch();
  await eventually(() => received === 2 && f.heartbeats >= 3);
  release();
});

test('callback failures send one generic safe feedback without echoing secrets', async t => {
  const f = await fixture(t, async () => { throw new Error('DO NOT ECHO: a secret'); });
  await f.transport.start();
  f.dispatch({ id: '201' }); f.dispatch({ id: '201' });
  await eventually(() => f.posts.length === 1);
  assert.equal(f.posts[0]!.content, '这条消息处理失败，请稍后再试。');
  assert.deepEqual(f.posts[0]!.allowed_mentions, { parse: [] });
});

test('messages split at 2000 units without breaking emoji and channel sends stay ordered', async t => {
  const f = await fixture(t);
  const text = 'a'.repeat(1999) + '😀' + 'b'.repeat(2001);
  await Promise.all([f.transport.sendText('222', text), f.transport.sendText('222', 'after')]);
  const contents = f.posts.map(post => post.content as string);
  assert.equal(contents.slice(0, -1).join(''), text);
  assert.equal(contents.at(-1), 'after');
  for (const content of contents) {
    assert(content.length <= 2000);
    assert(!/[\ud800-\udbff]$/.test(content));
    assert(!/^[\udc00-\udfff]/.test(content));
  }
  assert(f.headers.every(header => header.authorization === 'Bot fake-token-for-local-tests'));
});

test('429 retries only the rejected chunk with the same nonce, no duplicate successful chunks', async t => {
  const f = await fixture(t);
  let count = 0;
  f.postHandler = (_body, response) => {
    response.setHeader('content-type', 'application/json');
    if (++count === 2) { response.writeHead(429); response.end('{"retry_after":0.005,"global":true}'); }
    else { response.writeHead(200); response.end('{"id":"555"}'); }
  };
  await f.transport.sendText('222', 'x'.repeat(2001));
  assert.equal(f.posts.length, 3);
  assert.equal((f.posts[0]!.content as string).length, 2000);
  assert.equal(f.posts[1]!.content, 'x');
  assert.equal(f.posts[2]!.content, 'x');
  assert.equal(f.posts[1]!.nonce, f.posts[2]!.nonce);
});

test('every physical reply chunk repeats the explicit header while preserving emoji and ordering', async t => {
  const f = await fixture(t);
  const header = '[Codex · confirmed-model · high · …abcdef ✅]';
  const prefix = `${header}\n\n`;
  const displayPrefix = `${discordReplyHeader(header)}\n\n`;
  const body = 'a'.repeat(1999 - displayPrefix.length) + '😀' + 'b'.repeat(2100) + '\n**完成**\n```ts\nconst value = 1;\n```';
  await Promise.all([
    f.transport.sendText('222', `${prefix}${body}`, { repeatHeader: header }),
    f.transport.sendText('222', 'command menu'),
  ]);
  const contents = f.posts.slice(0, -1).map(post => post.content as string);
  assert(contents.length > 1);
  assert.equal(contents.map(content => content.slice(displayPrefix.length)).join(''), body);
  assert.equal(f.posts.at(-1)!.content, 'command menu');
  for (const content of contents) {
    assert(content.startsWith(displayPrefix));
    assert(content.length <= 2000);
    assert(!/[\ud800-\udbff]$/.test(content));
    assert(!/^[\udc00-\udfff]/.test(content.slice(displayPrefix.length)));
  }
});

test('partial long-reply delivery reports failure without replaying successful chunks', async t => {
  const f = await fixture(t);
  let count = 0;
  f.postHandler = (_body, response) => {
    response.writeHead(++count === 2 ? 403 : 200, { 'content-type': 'application/json' });
    response.end('{"id":"555"}');
  };
  const header = '[Claude Code · model · 强度未知 · …abcdef]';
  await assert.rejects(f.transport.sendText('222', `${header}\n\n${'x'.repeat(5000)}`, { repeatHeader: header }), /HTTP 403/);
  assert.equal(f.posts.length, 2);
  assert(f.posts.every(post => (post.content as string).startsWith(`${discordReplyHeader(header)}\n\n`)));
});

test('downloads Discord images to random safe filenames and never forwards Bot authorization', async t => {
  const f = await fixture(t);
  const paths = await f.transport.downloadImages(message());
  assert.equal(paths.length, 1);
  assert.match(paths[0]!, /[0-9a-f-]{36}\.png$/);
  assert.deepEqual(await readFile(paths[0]!), png);
  assert.equal(f.headers.at(-1)!.authorization, undefined);
});

test('JPG, PNG, WebP and GIF file signatures are accepted', async t => {
  const f = await fixture(t);
  for (const [type, extension, bytes] of [
    ['image/jpeg', 'jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['image/png', 'png', png],
    ['image/webp', 'webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
    ['image/gif', 'gif', Buffer.from('GIF89a')],
  ] as const) {
    f.imageHandler = (_request, response) => { response.writeHead(200); response.end(bytes); };
    const paths = await f.transport.downloadImages(message({ attachments: [attachment({
      filename: `image.${extension}`, content_type: type, size: bytes.length,
    })] }));
    assert(paths[0]!.endsWith(`.${extension}`));
    assert.deepEqual(await readFile(paths[0]!), bytes);
  }
});

test('截图真实格式优先于文件名、附件声明及 HTTP Content-Type', async t => {
  const f = await fixture(t);
  f.config.maxImageBytes = 1024;
  const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ZkAAAAASUVORK5CYII=', 'base64');
  const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  for (const [bytes, filename, declaration, extension] of [
    [screenshot, 'image.png', 'image/webp', 'png'],
    [webp, 'image.png', 'image/png', 'webp'],
    [screenshot, 'Screenshot.png', 'image/png', 'png'],
    [screenshot, 'image.webp', 'application/octet-stream', 'png'],
    [screenshot, 'image.jpeg', 'text/plain', 'png'],
    [webp, 'image.png', undefined, 'webp'],
    [screenshot, 'image.bin', 'image/unknown', 'png'],
  ] as const) {
    f.imageHandler = (_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(bytes); };
    const paths = await f.transport.downloadImages(message({ attachments: [attachment({
      filename, content_type: declaration, size: bytes.length,
    })] }));
    assert.equal(paths.length, 1);
    assert(paths[0]!.endsWith(`.${extension}`), 'manifest 路径必须使用真实格式');
    assert.deepEqual(await readFile(paths[0]!), bytes, '不转换或修改截图字节');
  }
});

test('伪装图片被拒绝，错误提示说明附件已收到且隐藏下载凭据', async t => {
  const f = await fixture(t);
  f.imageHandler = (_request, response) => { response.writeHead(200); response.end('<script>alert(1)</script>'); };
  for (const type of ['image/png', 'image/webp', 'image/svg+xml']) {
    await assert.rejects(f.transport.downloadImages(message({ attachments: [attachment({ content_type: type })] })), error => {
      assert(error instanceof ImagePreparationError);
      const text = ingressFailureText(error);
      assert.match(text, /桥已收到.*未能交给模型/);
      assert.match(text, /不是支持的图片格式/);
      return true;
    });
  }
  assert.deepEqual(await readdir(f.config.attachmentsDir), []);
  assert(!ingressFailureText(new ImagePreparationError(new Error('network https://cdn.discordapp.com/?secret=private'))).includes('secret'));
  assert.match(ingressFailureText(new ImagePreparationError(new Error('图片下载失败（HTTP 403）。'))), /HTTP 403/);
  assert.equal(ingressFailureText(new Error('unrelated')), '这条消息处理失败，请稍后再试。');
});

test('REST, CDN and Gateway each receive an explicit proxy agent', async t => {
  const f = await fixture(t);
  let restDispatcher: unknown;
  let cdnDispatcher: unknown;
  let websocketAgent: unknown;
  const transport = new DiscordTransport({ ...f.config, proxyUrl: 'http://127.0.0.1:7898' }, async () => {}, {
    gatewayUrl: f.wsUrl, restBaseUrl: f.rest, readyTimeoutMs: 2000, logger: () => {},
    fetch: async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href);
      if (url.hostname === 'cdn.discordapp.com') {
        cdnDispatcher = options?.dispatcher;
        assert.equal(new Headers(options?.headers as Record<string, string>).get('authorization'), null);
        return new Response(png, { status: 200 });
      }
      assert.equal(url.origin, f.rest);
      restDispatcher = options?.dispatcher;
      return new Response('{"id":"555"}', { status: 200 });
    },
    webSocketFactory: (url, options) => {
      websocketAgent = options.agent;
      // Only this injected test adapter bypasses the agent to reach the local fake Gateway.
      return new WebSocket(url, { ...options, agent: undefined });
    },
  });
  try {
    await transport.start();
    await transport.sendText('222', 'local mock');
    await transport.downloadImages(message());
    assert(restDispatcher instanceof ProxyAgent);
    assert(cdnDispatcher instanceof ProxyAgent);
    assert(websocketAgent instanceof HttpsProxyAgent);
    assert.notEqual(restDispatcher, cdnDispatcher);
  } finally { await transport.close(); }
});

test('attachment HTTPS/CDN checks and declared byte/count limits reject before download', async t => {
  const f = await fixture(t, undefined, { maxImages: 1 });
  for (const url of ['http://cdn.discordapp.com/attachments/a/b/x.png',
    'https://cdn.discordapp.com.evil.test/attachments/a/b/x.png',
    'https://127.0.0.1/attachments/a/b/x.png', 'https://cdn.discordapp.com:8443/attachments/a/b/x.png']) {
    await assert.rejects(f.transport.downloadImages(message({ attachments: [attachment({ url })] })), /HTTPS/);
  }
  await assert.rejects(f.transport.downloadImages(message({ attachments: [attachment({ size: 33 })] })), /大小/);
  await assert.rejects(f.transport.downloadImages(message({ attachments: [attachment(), attachment()] })), /数量/);
  assert.equal(f.headers.length, 0);
});

test('streaming byte limit rejects an understated attachment and deletes partial files', async t => {
  const f = await fixture(t);
  f.imageHandler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.write(png); response.end(Buffer.alloc(40));
  };
  await assert.rejects(f.transport.downloadImages(message({ attachments: [attachment({ size: 1 })] })), /实际大小/);
  assert.deepEqual(await readdir(f.config.attachmentsDir), []);
});

test('aggregate streamed size and invalid image bytes roll back completed downloads', async t => {
  const f = await fixture(t, undefined, { maxTotalImageBytes: 20 });
  await assert.rejects(f.transport.downloadImages(message({ attachments: [attachment({ size: 1 }), attachment({ size: 1 })] })), /实际大小/);
  assert.deepEqual(await readdir(f.config.attachmentsDir), []);
  f.imageHandler = (_request, response) => { response.writeHead(200); response.end('not a png'); };
  await assert.rejects(f.transport.downloadImages(message()), /图片格式/);
  assert.deepEqual(await readdir(f.config.attachmentsDir), []);
});

test('a CDN redirect cannot download an arbitrary host', async t => {
  const f = await fixture(t);
  f.imageHandler = (_request, response) => { response.writeHead(302, { location: 'https://evil.test/image.png' }); response.end(); };
  await assert.rejects(f.transport.downloadImages(message()), /HTTPS/);
  assert.equal(f.headers.length, 1);
});

test('reconnect resumes the READY session and last dispatch sequence', async t => {
  const f = await fixture(t);
  await f.transport.start();
  f.dispatch();
  await delay(15);
  f.sockets.at(-1)!.send('{"op":7,"d":null}');
  await eventually(() => f.packets.some(packet => packet.op === 6));
  const resume = f.packets.find(packet => packet.op === 6)!;
  assert.equal((resume.d as Record<string, unknown>).session_id, 'test-session');
  assert.equal((resume.d as Record<string, unknown>).seq, 2);
});

test('missing heartbeat ACK forces reconnect and RESUME', async t => {
  const f = await fixture(t);
  await f.transport.start();
  f.acknowledge = false;
  await eventually(() => f.sockets.length >= 2 && f.packets.some(packet => packet.op === 6));
  f.acknowledge = true;
});

test('invalid non-resumable session identifies again; close cancels reconnect', async t => {
  const f = await fixture(t);
  await f.transport.start();
  f.sockets.at(-1)!.send('{"op":9,"d":false}');
  await eventually(() => f.packets.filter(packet => packet.op === 2).length === 2);
  assert.equal(f.packets.filter(packet => packet.op === 6).length, 0);
  f.sockets.at(-1)!.send('{"op":7,"d":null}');
  await f.transport.close();
  const connections = f.sockets.length;
  await delay(50);
  assert.equal(f.sockets.length, connections);
  await assert.rejects(f.transport.sendText('222', 'closed'), /已关闭/);
});

test('fatal Gateway authentication errors stop reconnect attempts', async t => {
  const f = await fixture(t);
  await f.transport.start();
  f.sockets.at(-1)!.close(4004, 'authentication failed');
  await eventually(() => f.sockets.at(-1)!.readyState === WebSocket.CLOSED);
  await delay(30);
  assert.equal(f.sockets.length, 1);
  await assert.rejects(f.transport.sendText('222', 'closed'), /已关闭/);
});
