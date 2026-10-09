import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Response } from 'undici';
import WebSocket from 'ws';
import { DiscordTransport, type DiscordTransportOptions } from '../src/discord.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';

class FakeGateway extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  packets: Array<{ op: number; d: unknown }> = [];
  sequence = 0;
  constructor() { super(); queueMicrotask(() => this.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 20 } }))); }
  send(raw: string): void {
    const packet = JSON.parse(raw) as { op: number; d: unknown };
    this.packets.push(packet);
    if (packet.op === 1) queueMicrotask(() => this.emit('message', '{"op":11}'));
    if (packet.op === 2) queueMicrotask(() => this.event('READY', {
      session_id: 'local-session', user: { id: '999', username: 'fake', bot: true },
    }));
    if (packet.op === 6) queueMicrotask(() => this.event('RESUMED', {}));
  }
  event(t: string, d: unknown): void { this.emit('message', JSON.stringify({ op: 0, t, s: ++this.sequence, d })); }
  terminate(): void { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit('close', 1006); }
}
const rawDM = (changes: Record<string, unknown> = {}) => ({ id: '101', channel_id: '222', author: { id: '111', bot: false },
  content: 'hello', attachments: [], ...changes });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 2000;
  while (!check()) { if (Date.now() > until) throw new Error('condition timeout'); await delay(5); }
}
async function fixture(t: TestContext, onMessage: (message: IncomingDM) => Promise<void>, options: DiscordTransportOptions) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-ingress-discord-test-'));
  const sockets: FakeGateway[] = [];
  const config: BridgeConfig = { token: 'fake-local-token', allowedUserIds: ['111'], defaultAgent: 'codex',
    workspace: root, proxyUrl: null, commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 100 };
  const transport = new DiscordTransport(config, onMessage, { gatewayUrl: 'ws://127.0.0.1/fake',
    restBaseUrl: 'http://127.0.0.1/fake', logger: () => {}, identifyIntervalMs: 1,
    reconnectBaseMs: 1, reconnectMaxMs: 1, random: () => 0.5,
    webSocketFactory: () => { const socket = new FakeGateway(); sockets.push(socket); return socket as unknown as WebSocket; },
    fetch: async () => new Response(null, { status: 204 }), ...options });
  t.after(async () => {
    await transport.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('bridge-ingress-discord-test-'));
    await rm(root, { force: true, recursive: true });
  });
  return { transport, sockets };
}

test('ordinary Gateway journal hook runs synchronously before receipt or queued message callback', async t => {
  const events: string[] = [];
  const f = await fixture(t, async () => { events.push('handle'); }, {
    onReceive: message => { assert.equal(message.id, '101'); events.push('capture'); },
    fetch: async () => { events.push('receipt'); return new Response(null, { status: 204 }); },
  });
  await f.transport.start();
  f.sockets[0]!.event('MESSAGE_CREATE', rawDM());
  assert.deepEqual(events, ['capture', 'receipt']);
  await eventually(() => events.includes('handle'));
  assert.deepEqual(events, ['capture', 'receipt', 'handle']);
});

test('READY and RESUMED call recovery; its first wait gates start without blocking heartbeats or journaling', async t => {
  const hold = gate();
  let readyCalls = 0;
  let captured = 0;
  let started = false;
  const f = await fixture(t, async () => {}, {
    onReceive: () => { captured++; },
    onReady: async () => { readyCalls++; if (readyCalls === 1) await hold.promise; },
  });
  const initial = f.transport.start().then(() => { started = true; });
  await eventually(() => readyCalls === 1);
  f.sockets[0]!.event('MESSAGE_CREATE', rawDM());
  await eventually(() => f.sockets[0]!.packets.filter(packet => packet.op === 1).length >= 2);
  assert.equal(captured, 1);
  assert.equal(started, false);
  hold.release();
  await initial;
  f.sockets[0]!.terminate();
  await eventually(() => readyCalls === 2);
  assert.equal(f.sockets[1]!.packets.some(packet => packet.op === 6), true);
});

test('readDMHistory verifies DM ownership, filters authors and keeps raw bot-message page boundaries', async t => {
  const paths: string[] = [];
  const f = await fixture(t, async () => {}, { fetch: async (input, options) => {
    assert.equal(options?.method, 'GET', 'Recovery is read-only');
    const url = new URL(String(input));
    paths.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/channels/222')) return new Response(JSON.stringify({ type: 1, recipients: [{ id: '111' }] }));
    return new Response(JSON.stringify([
      rawDM({ id: '110', author: { id: '999', bot: true } }),
      rawDM({ id: '109' }),
      rawDM({ id: '108', author: { id: '444', bot: false } }),
    ]));
  } });
  const page = await f.transport.readDMHistory('222', { after: '100', limit: 3 });
  assert.deepEqual(paths, ['/fake/channels/222', '/fake/channels/222/messages?limit=3&after=100']);
  assert.deepEqual(page.messages.map(message => message.id), ['109']);
  assert.equal(page.oldestId, '108');
  assert.equal(page.newestId, '110');
  assert.equal(page.hasMore, true);
  await f.transport.readDMHistory('222', { before: '108', limit: 3 });
  assert.equal(paths.filter(path => path === '/fake/channels/222').length, 1, 'Only verified DM channel is cached');
  await assert.rejects(f.transport.readDMHistory('222', { after: '100', before: '200' }), /游标无效/);
  await assert.rejects(f.transport.readDMHistory('222', { limit: 101 }), /页面大小无效/);
});

test('readDMHistory cannot turn a guild/group/untrusted channel into a DM recovery source', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {}, { fetch: async () => {
    calls++; return new Response(JSON.stringify({ type: 0, recipients: [{ id: '111' }] }));
  } });
  await assert.rejects(f.transport.readDMHistory('333'), /普通私聊/);
  assert.equal(calls, 1, 'No history fetch occurs after rejecting the channel');
});
