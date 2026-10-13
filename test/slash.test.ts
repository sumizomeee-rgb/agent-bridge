import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Response, type fetch } from 'undici';
import WebSocket, { WebSocketServer } from 'ws';
import { DiscordTransport } from '../src/discord.js';
import { OrderedInbox } from '../src/inbox.js';
import { SLASH_COMMANDS, slashText, type SlashInteraction } from '../src/slash.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';

interface Request { path: string; method: string; headers: Headers; body: any; signal?: AbortSignal }
const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const option = (name: string, value: string | boolean) => ({ name, type: typeof value === 'boolean' ? 5 : 3, value });
const result = (name: string, options: ReturnType<typeof option>[] = []) => slashText({ name, type: 1, options });

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('等待模拟交互超时'); await delay(5); }
}

async function fixture(t: TestContext, readyApplication = true, allowedUserIds = ['111']) {
  const requests: Request[] = [], received: IncomingDM[] = [], logs: string[] = [], sockets: WebSocket[] = [];
  let handler: (request: Request) => Promise<Response> | Response = request =>
    request.path === '/applications/@me' ? new Response('{"id":"777"}', { status: 200 }) : ok();
  let onMessage: (message: IncomingDM) => Promise<void> = async () => {};
  let sequence = 0, heartbeats = 0;
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => gateway.once('listening', resolve));
  const address = gateway.address(); assert(address && typeof address !== 'string');
  const wsUrl = `ws://127.0.0.1:${address.port}`;
  gateway.on('connection', socket => {
    sockets.push(socket);
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 40 } }));
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.op === 1) { heartbeats++; socket.send('{"op":11}'); }
      if (packet.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: ++sequence, d: {
        session_id: 'local-session', resume_gateway_url: wsUrl, user: { id: '999', username: 'LocalTestBot' },
        ...(readyApplication ? { application: { id: '777' } } : {}),
      } }));
    });
  });
  const config: BridgeConfig = {
    token: 'FAKE_BOT_SECRET', allowedUserIds, defaultAgent: 'codex', workspace: '.', proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: '.', attachmentsDir: '.', logsDir: '.', maxImageBytes: 100,
  };
  const transport = new DiscordTransport(config, async message => { received.push(message); await onMessage(message); }, {
    restBaseUrl: 'https://slash.test.invalid/api', gatewayUrl: wsUrl, readyTimeoutMs: 2000, random: () => 0.5,
    logger: line => logs.push(line), fetch: (async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href);
      assert.equal(url.origin, 'https://slash.test.invalid', 'Never contact a real Discord endpoint');
      const request = { path: url.pathname.replace(/^\/api/, ''), method: options?.method ?? 'GET',
        headers: new Headers(options?.headers as HeadersInit), body: options?.body ? JSON.parse(String(options.body)) : null, signal: options?.signal ?? undefined };
      requests.push(request);
      return handler(request);
    }) as typeof fetch,
  });
  t.after(async () => {
    await transport.close();
    sockets.forEach(socket => socket.terminate());
    await new Promise<void>(resolve => gateway.close(() => resolve()));
  });
  await transport.start();
  const dispatch = (changes: Record<string, unknown> = {}) => {
    const data = { id: String(10000 + ++sequence), application_id: '777', type: 2,
      token: 'FAKE_INTERACTION_SECRET', context: 1, channel_id: '222', user: { id: '111' },
      data: { name: 'status', type: 1 }, ...changes };
    sockets.at(-1)!.send(JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', s: sequence, d: data }));
    return data.id;
  };
  const callbacks = () => requests.filter(request => request.path.endsWith('/callback'));
  return { transport, requests, received, logs, dispatch, callbacks,
    get heartbeats() { return heartbeats; },
    set handler(value: typeof handler) { handler = value; },
    set onMessage(value: typeof onMessage) { onMessage = value; },
    dispatchText(text: string, changes: Record<string, unknown> = {}) {
      sockets.at(-1)!.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: ++sequence,
        d: { id: String(20000 + sequence), channel_id: '222', author: { id: '111' }, content: text, attachments: [], ...changes } }));
    },
  };
}

test('native registry contains twelve supported DM-only commands, never resume/startup', () => {
  assert.deepEqual(SLASH_COMMANDS.map(command => command.name), ['new', 'agent', 'chats', 'cwd', 'model', 'effort', 'models', 'status', 'computers', 'workers', 'stop', 'help']);
  assert(SLASH_COMMANDS.every(command => command.type === 1 && command.contexts.length === 1 && command.contexts[0] === 1));
  assert(SLASH_COMMANDS.every(command => command.description.length <= 100));
  assert.equal(SLASH_COMMANDS.find(command => command.name === 'model')!.options![0]!.choices, undefined);
});

test('native options map to existing text commands including custom models and Windows paths', () => {
  for (const name of ['help', 'status', 'chats', 'models', 'stop', 'new', 'agent', 'model']) assert.deepEqual(result(name), { text: `/${name}` });
  assert.deepEqual(result('new', [option('agent', 'claude')]), { text: '/new claude' });
  assert.deepEqual(result('agent', [option('agent', 'codex')]), { text: '/agent codex' });
  assert.deepEqual(result('cwd', [option('path', 'C:\\My Project\\src')]), { text: '/cwd C:\\My Project\\src' });
  assert.deepEqual(result('model', [option('name', 'list')]), { text: '/model list' });
  assert.deepEqual(result('model', [option('name', 'default')]), { text: '/model default' });
  assert.deepEqual(result('model', [option('name', 'gateway/model-v2'), option('custom', true)]), { text: '/model custom gateway/model-v2' });
  assert.deepEqual(result('model', [option('name', 'sonnet'), option('custom', false)]), { text: '/model sonnet' });
});

test('computer and worker options map to direct text queries and reject foreign scope parameters', () => {
  assert.deepEqual(result('computers'), { text: '/computers' });
  assert.deepEqual(result('computers', [option('refresh', true)]), { text: '/computers refresh' });
  assert.deepEqual(result('computers', [option('refresh', false)]), { text: '/computers cached' });
  assert.deepEqual(result('workers'), { text: '/workers' });
  assert.deepEqual(result('workers', [option('scope', 'all')]), { text: '/workers all' });
  assert.deepEqual(result('workers', [option('scope', 'current')]), { text: '/workers current' });
  assert('error' in result('workers', [option('scope', 'another-user')]));
  assert('error' in result('workers', [option('userId', '444')]));
  assert('error' in result('computers', [option('refresh', 'true')]));
});

test('real DM slash computer and worker interactions use type5 ACK and carry query parameters', async t => {
  const f = await fixture(t);
  f.dispatch({ data: { name: 'computers', type: 1, options: [option('refresh', false)] } });
  f.dispatch({ data: { name: 'workers', type: 1, options: [option('scope', 'all')] } });
  await until(() => f.received.length === 2);
  assert.deepEqual(f.received.map(message => message.text), ['/computers cached', '/workers all']);
  assert(f.callbacks().every(request => request.body.type === 5));
  assert(f.received.every(message => message.userId === '111' && message.interaction != null));
});

test('unsupported names, incomplete options, types, duplicates and unsafe line breaks are rejected', () => {
  const invalid = [result('resume'), result('startup'), result('cwd'), result('agent', [option('agent', 'other')]),
    result('model', [option('custom', true)]), result('model', [option('name', 'a'.repeat(201))]),
    result('model', [option('name', 'one\n/model two')]), result('status', [option('extra', 'x')]),
    result('model', [option('name', 'first'), option('name', 'second')]),
    slashText({ name: 'model', options: 'invalid' }), slashText({ name: 'model', options: [{ name: 'name', type: 5, value: true }] }),
    slashText({ name: 'status', type: 2 }), slashText(null)];
  assert(invalid.every(value => 'error' in value));
});

test('registration uses READY application ID and PUTs twelve global BOT_DM definitions', async t => {
  const f = await fixture(t);
  await f.transport.syncSlashCommands();
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.equal(request.path, '/applications/777/commands');
  assert.equal(request.method, 'PUT');
  assert.equal(request.headers.get('authorization'), 'Bot FAKE_BOT_SECRET');
  assert.deepEqual(request.body, SLASH_COMMANDS);
  assert(!JSON.stringify(request.body).includes('SECRET'));
});

test('missing READY application metadata uses the current application endpoint and caches its ID', async t => {
  const f = await fixture(t, false);
  await f.transport.syncSlashCommands(); await f.transport.syncSlashCommands();
  assert.deepEqual(f.requests.map(request => [request.method, request.path]), [
    ['GET', '/applications/@me'], ['PUT', '/applications/777/commands'], ['PUT', '/applications/777/commands'],
  ]);
});

test('registration failure does not close transport or break ordinary DMs', async t => {
  const f = await fixture(t);
  f.handler = () => new Response('{}', { status: 403 });
  await assert.rejects(f.transport.syncSlashCommands(), /HTTP 403/);
  f.dispatchText('ordinary text still works');
  await until(() => f.received.length === 1);
  assert.equal(f.received[0]!.text, 'ordinary text still works');
  assert.equal(f.received[0]!.interaction, undefined);
});

test('a valid model interaction ACKs type5 anonymously then forwards text and memory-only metadata', async t => {
  const f = await fixture(t);
  const id = f.dispatch({ data: { name: 'model', type: 1, options: [option('name', 'gpt-6.1-sol')] } });
  await until(() => f.received.length === 1);
  assert.equal(f.callbacks().length, 1);
  assert.deepEqual(f.callbacks()[0]!.body, { type: 5 });
  assert.equal(f.callbacks()[0]!.headers.get('authorization'), null);
  assert.deepEqual(f.received[0], { id, userId: '111', channelId: '222', text: '/model gpt-6.1-sol', attachments: [],
    interaction: { id, token: 'FAKE_INTERACTION_SECRET', applicationId: '777' } });
});

test('ACK completes before command dispatch and never blocks Gateway heartbeats', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.handler = async () => { await gate; return ok(); };
  f.dispatch();
  await until(() => f.callbacks().length === 1 && f.heartbeats >= 3);
  assert.equal(f.received.length, 0);
  release(); await until(() => f.received.length === 1);
});

test('failed ACK never executes the command and never logs a token-bearing network error', async t => {
  const f = await fixture(t);
  f.handler = () => new Response('{}', { status: 403 });
  f.dispatch(); await until(() => f.logs.some(line => line.includes('斜杠命令处理失败')));
  assert.equal(f.received.length, 0);
  assert(f.logs.some(line => /stage=ack.*reason=http status=403/.test(line)));
  f.handler = () => { throw new Error('FAKE_INTERACTION_SECRET / FAKE_BOT_SECRET'); };
  f.dispatch(); await until(() => f.callbacks().length === 2);
  await delay(10);
  assert.equal(f.received.length, 0);
  assert(f.logs.every(line => !line.includes('SECRET')));
  assert(f.logs.some(line => /stage=ack.*reason=network/.test(line)));
});

test('expired initial ACK logs only numeric status/code and never response details or credentials', async t => {
  const f = await fixture(t);
  f.handler = () => new Response('{"code":10062,"message":"FAKE_INTERACTION_SECRET / FAKE_BOT_SECRET"}', { status: 404 });
  const id = f.dispatch({ data: { name: 'workers', type: 1 } });
  await until(() => f.logs.some(line => line.includes('code=10062')));
  assert.equal(f.received.length, 0);
  assert(f.logs.some(line => line.includes(`command=workers interaction=${id}`) && /elapsed_ms=\d+ reason=http status=404 code=10062/.test(line)));
  assert(f.logs.every(line => !line.includes('SECRET') && !line.includes('/callback')));
});

test('initial ACK transport deadline is distinguished from immediate network failure without dispatch', async t => {
  const f = await fixture(t);
  f.handler = request => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new Error('FAKE_INTERACTION_SECRET')); request.signal!.addEventListener('abort', abort, { once: true });
    if (request.signal!.aborted) abort();
  });
  f.dispatch({ data: { name: 'workers', type: 1 } });
  await until(() => f.logs.some(line => line.includes('reason=timeout')));
  assert.equal(f.received.length, 0); assert.equal(f.callbacks().length, 1);
  assert(f.logs.every(line => !line.includes('SECRET')));
});

for (const [name, change] of [
  ['unauthorized user', { user: { id: '444' } }],
  ['guild', { guild_id: '333', context: 0 }],
  ['group DM', { context: 2, channel: { id: '222', type: 3 } }],
  ['wrong application', { application_id: '888' }],
] as const) test(`${name} receives a friendly type4 refusal without command execution`, async t => {
  const f = await fixture(t);
  f.dispatch(change); await until(() => f.callbacks().length === 1);
  assert.equal(f.callbacks()[0]!.body.type, 4);
  assert.equal(f.callbacks()[0]!.body.data.flags, 64);
  assert.deepEqual(f.callbacks()[0]!.body.data.allowed_mentions, { parse: [] });
  assert.equal(f.callbacks()[0]!.headers.get('authorization'), null);
  assert.equal(f.received.length, 0);
});

test('unknown legacy commands and invalid arguments receive type4, never type5 or business dispatch', async t => {
  const f = await fixture(t);
  for (const name of ['startup', 'resume', 'cwd']) f.dispatch({ data: { name, type: 1 } });
  await until(() => f.callbacks().length === 3);
  assert(f.callbacks().every(request => request.body.type === 4));
  assert.equal(f.received.length, 0);
});

test('an older DM payload without context is accepted only when its channel is explicitly a DM', async t => {
  const f = await fixture(t);
  f.dispatch({ context: null, channel_id: undefined, channel: { id: '222', type: 1 } });
  await until(() => f.received.length === 1);
  assert.equal(f.received[0]!.channelId, '222');
  f.dispatch({ context: null }); await until(() => f.callbacks().length === 2);
  assert.equal(f.callbacks()[1]!.body.type, 4);
  assert.equal(f.received.length, 1);
});

test('duplicate Gateway interactions do not ACK, execute or edit the original twice', async t => {
  const f = await fixture(t);
  f.onMessage = message => f.transport.sendInteractionText(message.interaction!, 'one command result');
  const id = f.dispatch(); f.dispatch({ id });
  await until(() => f.requests.some(request => request.method === 'PATCH'));
  f.dispatch({ id }); await delay(30);
  assert.equal(f.callbacks().length, 1);
  assert.equal(f.received.length, 1);
  assert.equal(f.requests.filter(request => request.method === 'PATCH').length, 1);
});

test('interaction replies edit original then send followups, preserve emoji, and never post an ordinary DM', async t => {
  const f = await fixture(t);
  const interaction: SlashInteraction = { id: '12345', applicationId: '777', token: 'FAKE_INTERACTION_SECRET' };
  const text = 'a'.repeat(1999) + '😀' + 'b'.repeat(2100);
  await f.transport.sendInteractionText(interaction, text);
  assert.equal(f.requests[0]!.method, 'PATCH');
  assert.equal(f.requests[0]!.path, '/webhooks/777/FAKE_INTERACTION_SECRET/messages/@original');
  assert(f.requests.slice(1).every(request => request.method === 'POST' && request.path === '/webhooks/777/FAKE_INTERACTION_SECRET'));
  assert.equal(f.requests.map(request => request.body.content).join(''), text);
  for (const request of f.requests) {
    assert.equal(request.headers.get('authorization'), null);
    assert.deepEqual(request.body.allowed_mentions, { parse: [] });
    assert(request.body.content.length <= 2000);
    assert(!/[\ud800-\udbff]$/.test(request.body.content));
    assert(!/^[\udc00-\udfff]/.test(request.body.content));
  }
  assert(f.requests.every(request => !request.path.startsWith('/channels/')));
});

test('followup 429 retries only the rejected piece without duplicating the successful original', async t => {
  const f = await fixture(t);
  let count = 0;
  f.handler = () => ++count === 2 ? new Response('{"retry_after":0.001}', { status: 429 }) : ok();
  await f.transport.sendInteractionText({ id: '12345', applicationId: '777', token: 'FAKE_INTERACTION_SECRET' }, 'x'.repeat(2001));
  assert.deepEqual(f.requests.map(request => [request.method, request.body.content.length]), [['PATCH', 2000], ['POST', 1], ['POST', 1]]);
});

test('urgent ACK bypasses a normal message global rate-limit wait and channel send queue', async t => {
  const f = await fixture(t);
  let limited = false, ordinaryFinished = false;
  f.handler = request => {
    if (request.path.startsWith('/channels/') && !limited) {
      limited = true; return new Response('{"retry_after":0.6,"global":true}', { status: 429 });
    }
    return ok();
  };
  const ordinary = f.transport.sendText('222', 'old ordinary response').then(() => { ordinaryFinished = true; });
  await until(() => limited);
  f.dispatch(); await until(() => f.received.length === 1);
  assert.equal(ordinaryFinished, false);
  assert.deepEqual(f.callbacks()[0]!.body, { type: 5 });
  await ordinary;
});

test('business dispatch failure is reported through the original interaction, without a normal DM duplicate', async t => {
  const f = await fixture(t);
  f.onMessage = async () => { throw new Error('FAKE_INTERACTION_SECRET'); };
  f.dispatch(); await until(() => f.requests.some(request => request.method === 'PATCH'));
  assert.equal(f.callbacks().length, 1);
  assert(f.requests.every(request => !request.path.startsWith('/channels/')));
  assert(f.logs.every(line => !line.includes('SECRET')));
  assert.equal(f.requests.find(request => request.method === 'PATCH')!.body.content, '这条命令处理失败，请稍后重试。');
});

test('registration non-global 429 waits locally without delaying ordinary DM delivery', async t => {
  const f = await fixture(t);
  let limited = false, registered = false;
  f.handler = request => {
    if (request.path === '/applications/777/commands' && !limited) {
      limited = true; return new Response('{"retry_after":0.6,"global":false}', { status: 429 });
    }
    return ok();
  };
  const registering = f.transport.syncSlashCommands().then(() => { registered = true; });
  await until(() => limited);
  await f.transport.sendText('222', 'ordinary response while menu sync waits');
  assert.equal(registered, false);
  assert(f.requests.some(request => request.path === '/channels/222/messages'));
  await registering;
  assert.equal(f.requests.filter(request => request.path === '/applications/777/commands').length, 2);
});

for (const command of ['agent', 'new'] as const) test(`native /${command} reserves its arrival position before a following text message`, async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.handler = async request => { if (request.path.endsWith('/callback')) await gate; return ok(); };
  let context = 'old';
  const dispatched: string[] = [];
  f.onMessage = async message => {
    if (message.text.startsWith(`/${command}`)) context = 'new';
    else dispatched.push(`${context}:${message.text}`);
  };
  f.dispatch({ data: { name: command, type: 1, ...(command === 'agent' ? { options: [option('agent', 'claude')] } : {}) } });
  f.dispatchText('hi');
  await until(() => f.callbacks().length === 1 && f.heartbeats >= 3);
  assert.equal(f.received.length, 0);
  release(); await until(() => f.received.length === 2);
  assert.deepEqual(f.received.map(message => message.text), [command === 'agent' ? '/agent claude' : '/new', 'hi']);
  assert.deepEqual(dispatched, ['new:hi']);
});

test('out-of-order successful ACKs cannot reorder slash/slash/text delivery', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstId = '';
  f.handler = async request => { if (request.path.includes(`/interactions/${firstId}/`)) await gate; return ok(); };
  firstId = f.dispatch({ data: { name: 'agent', type: 1, options: [option('agent', 'claude')] } });
  f.dispatch({ data: { name: 'new', type: 1 } });
  f.dispatchText('after both');
  await until(() => f.callbacks().length === 2 && f.heartbeats >= 3);
  assert.equal(f.received.length, 0);
  release(); await until(() => f.received.length === 3);
  assert.deepEqual(f.received.map(message => message.text), ['/agent claude', '/new', 'after both']);
});

test('an ACK can start behind slow preparation while production OrderedInbox preserves text/slash order', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const inbox = new OrderedInbox<IncomingDM>(message => message.userId, async message => {
    events.push(`start:${message.text}`);
    if (message.text === 'slow attachment preparation') await gate;
    events.push(`end:${message.text}`);
  });
  f.onMessage = message => inbox.handle(message);
  f.dispatchText('slow attachment preparation');
  await until(() => events.length === 1);
  f.dispatch({ data: { name: 'new', type: 1 } });
  await until(() => f.callbacks().length === 1 && f.received.length === 2);
  assert.deepEqual(f.callbacks()[0]!.body, { type: 5 });
  assert.deepEqual(events, ['start:slow attachment preparation']);
  release(); await until(() => events.length === 4);
  assert.deepEqual(events, ['start:slow attachment preparation', 'end:slow attachment preparation', 'start:/new', 'end:/new']);
});

test('failed ACK releases its reserved position and later ordinary messages continue', async t => {
  const f = await fixture(t);
  f.handler = request => request.path.endsWith('/callback') ? new Response('{}', { status: 403 }) : ok();
  f.dispatch({ data: { name: 'agent', type: 1, options: [option('agent', 'claude')] } });
  f.dispatchText('continue original agent');
  await until(() => f.received.length === 1);
  assert.equal(f.received[0]!.text, 'continue original agent');
  assert.equal(f.received[0]!.interaction, undefined);
  assert(f.logs.some(line => line.includes('斜杠命令处理失败')));
});

test('a later ACK may reject before its queued slot becomes ready without unhandled rejection or blocking text', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstId = '', failedId = '';
  f.handler = async request => {
    if (request.path.includes(`/interactions/${firstId}/`)) { await gate; return ok(); }
    if (request.path.includes(`/interactions/${failedId}/`)) return new Response('{}', { status: 403 });
    return ok();
  };
  firstId = f.dispatch({ data: { name: 'new', type: 1 } });
  failedId = f.dispatch({ data: { name: 'stop', type: 1 } });
  f.dispatchText('continue after failed stop');
  await until(() => f.callbacks().length === 2 && f.logs.some(line => line.includes('斜杠命令处理失败')) && f.heartbeats >= 3);
  assert.equal(f.received.length, 0);
  release(); await until(() => f.received.length === 2);
  assert.deepEqual(f.received.map(message => message.text), ['/new', 'continue after failed stop']);
});

test('one user waiting for slash ACK does not block another user or Gateway heartbeats', async t => {
  const f = await fixture(t, true, ['111', '444']);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.handler = async request => { if (request.path.endsWith('/callback')) await gate; return ok(); };
  f.dispatch();
  f.dispatchText('other user message', { author: { id: '444' }, channel_id: '555' });
  await until(() => f.received.length === 1 && f.heartbeats >= 3);
  assert.equal(f.received[0]!.userId, '444');
  release(); await until(() => f.received.length === 2);
  assert.equal(f.received[1]!.userId, '111');
});

test('effort slash uses level, supports query/default, and rejects unknown options', () => {
  assert.deepEqual(result('effort'), { text: '/effort' });
  assert.deepEqual(result('effort', [option('level', 'xhigh')]), { text: '/effort xhigh' });
  assert.deepEqual(result('effort', [option('level', 'default')]), { text: '/effort default' });
  assert.ok('error' in result('effort', [option('level', 'extreme')]));
  assert.ok('error' in result('effort', [option('name', 'high')]));
});
