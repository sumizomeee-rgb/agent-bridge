import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { fetch, ProxyAgent, Response } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket, { WebSocketServer } from 'ws';
import { DiscordTransport, type DiscordTransportOptions } from '../src/discord.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';

interface Packet { op: number; d?: Record<string, unknown> | number | null; t?: string; s?: number }
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
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const httpAddress = http.address();
  assert(httpAddress && typeof httpAddress !== 'string');
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
  const body = 'a'.repeat(1999 - prefix.length) + '😀' + 'b'.repeat(2100);
  await Promise.all([
    f.transport.sendText('222', `${prefix}${body}`, { repeatHeader: header }),
    f.transport.sendText('222', 'command menu'),
  ]);
  const contents = f.posts.slice(0, -1).map(post => post.content as string);
  assert(contents.length > 1);
  assert.equal(contents.map(content => content.slice(prefix.length)).join(''), body);
  assert.equal(f.posts.at(-1)!.content, 'command menu');
  for (const content of contents) {
    assert(content.startsWith(prefix));
    assert(content.length <= 2000);
    assert(!/[\ud800-\udbff]$/.test(content));
    assert(!/^[\udc00-\udfff]/.test(content.slice(prefix.length)));
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
  assert(f.posts.every(post => (post.content as string).startsWith(`${header}\n\n`)));
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
