import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DurableIngress, type DMHistoryPage } from '../src/ingress.js';
import type { IncomingDM } from '../src/types.js';

const dm = (id: string, changes: Partial<IncomingDM> = {}): IncomingDM => ({
  id, userId: '111', channelId: '222', text: `message ${id}`, attachments: [], ...changes,
});
const cleanups = new Map<string, Array<() => Promise<void>>>();
const cleanup = (root: string, job: () => Promise<void>) => { cleanups.get(root)!.push(job); };
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 2000;
  while (!check()) { if (Date.now() > until) throw new Error('condition timeout'); await delay(5); }
}
async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'bridge-ingress-test-'));
  cleanups.set(path, []);
  t.after(async () => {
    for (const job of cleanups.get(path)!) await job();
    cleanups.delete(path);
    assert.equal(dirname(resolve(path)), resolve(tmpdir()));
    assert(basename(path).startsWith('bridge-ingress-test-'));
    await rm(path, { force: true, recursive: true });
  });
  return path;
}
const empty: DMHistoryPage = { messages: [], oldestId: null, newestId: null, hasMore: false };

test('Gateway ordinary text and attachment metadata are durable before preparation starts', async t => {
  const root = await directory(t);
  const hold = gate();
  const calls: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    handle: async message => { calls.push(message.id); await hold.promise; } });
  cleanup(root, () => ingress.close());
  const attachment = { id: '888', filename: 'shot.png', url: 'https://cdn.discordapp.com/attachments/222/888/shot.png',
    size: 100, content_type: 'image/png' };
  ingress.capture(dm('101', { attachments: [attachment] }));
  assert.deepEqual(calls, []);
  const readonly = new DatabaseSync(ingress.path, { readOnly: true });
  const row = readonly.prepare('SELECT text, attachments_json, state FROM messages WHERE id = ?').get('101')!;
  readonly.close();
  assert.equal(row.text, 'message 101');
  assert.deepEqual(JSON.parse(String(row.attachments_json)), [attachment]);
  assert.equal(row.state, 'received');
  ingress.start();
  await eventually(() => calls.length === 1);
  await ingress.receive(dm('102'));
  assert.equal(ingress.getMessage('102')?.state, 'received');
  hold.release();
  await ingress.whenIdle();
  assert.deepEqual(calls, ['101', '102']);
});

test('restart recovers unfinished preparation but never reruns a SessionManager accepted/uncertain message', async t => {
  const root = await directory(t);
  const hold = gate();
  const old = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    handle: async () => { await hold.promise; } });
  old.start();
  await old.receive(dm('101'));
  await old.receive(dm('102'));
  await eventually(() => old.getMessage('101')?.state === 'processing');
  await old.close();
  const calls: string[] = [];
  const recovered = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: id => id === '102',
    handle: async message => { calls.push(message.id); } });
  cleanup(root, () => recovered.close());
  recovered.start();
  await recovered.whenIdle();
  assert.deepEqual(calls, ['101']);
  assert.equal(recovered.getMessage('101')?.state, 'accepted');
  assert.equal(recovered.getMessage('102')?.state, 'accepted');
  hold.release();
  await old.whenIdle();
  await recovered.receive(dm('101'));
  await recovered.whenIdle();
  assert.deepEqual(calls, ['101']);
});

test('READY gap recovery merges paged history and simultaneous live input in snowflake order', async t => {
  const root = await directory(t);
  const hold = gate();
  const calls: string[] = [];
  const queries: unknown[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false, pageSize: 2,
    handle: async message => { calls.push(message.id); } });
  cleanup(root, () => ingress.close());
  ingress.seedChannel({ userId: '111', channelId: '222', cursor: '100' });
  const recovery = ingress.recover(async (_channel, options) => {
    queries.push(options);
    if (!options.before) { await hold.promise; return { messages: [dm('104')], oldestId: '104', newestId: '105', hasMore: true }; }
    if (options.before === '104') return { messages: [dm('103'), dm('102')], oldestId: '102', newestId: '103', hasMore: true };
    return { messages: [dm('101'), dm('100')], oldestId: '100', newestId: '101', hasMore: true };
  });
  ingress.start();
  await ingress.receive(dm('110'));
  assert.equal(ingress.knownChannels()[0]?.cursor, '100', 'Live startup input must not skip the outage gap');
  assert.deepEqual(calls, []);
  hold.release();
  await recovery;
  await ingress.whenIdle();
  assert.deepEqual(queries, [{ limit: 2 }, { limit: 2, before: '104' }, { limit: 2, before: '102' }]);
  assert.deepEqual(calls, ['101', '102', '103', '104', '110']);
  assert.equal(ingress.knownChannels()[0]?.cursor, '110');
});

test('gap recovery walks newest pages backwards and does not combine forward after with before pagination', async t => {
  const root = await directory(t);
  const calls: string[] = [];
  const queries: unknown[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    pageSize: 2, handle: async message => { calls.push(message.id); } });
  cleanup(root, () => ingress.close());
  ingress.seedChannel({ userId: '111', channelId: '222', cursor: '100' });
  const history = ['105', '104', '103', '102', '101', '100', '99'];
  ingress.start();
  await ingress.recover(async (_channel, options) => {
    queries.push(options);
    const eligible = history.filter(id => (!options.after || BigInt(id) > BigInt(options.after)) &&
      (!options.before || BigInt(id) < BigInt(options.before)));
    // Discord after pages start nearest the cursor, whereas the default page is newest.
    const ids = options.after ? eligible.slice(-options.limit!) : eligible.slice(0, options.limit);
    return { messages: ids.map(id => dm(id)), oldestId: ids.at(-1) ?? null,
      newestId: ids[0] ?? null, hasMore: ids.length === options.limit };
  });
  await ingress.whenIdle();
  assert.deepEqual(queries, [{ limit: 2 }, { limit: 2, before: '104' }, { limit: 2, before: '102' }]);
  assert.deepEqual(calls, ['101', '102', '103', '104', '105']);
  assert.equal(ingress.getMessage('100'), null);
  assert.equal(ingress.getMessage('99'), null);
  assert.equal(ingress.knownChannels()[0]?.cursor, '105');
});

test('recovery page bound failure keeps the old cursor and live messages queued until a complete retry', async t => {
  const root = await directory(t);
  const calls: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    pageSize: 2, maxRecoveryPages: 2, handle: async message => { calls.push(message.id); } });
  cleanup(root, () => ingress.close());
  ingress.seedChannel({ userId: '111', channelId: '222', cursor: '100' });
  let page = 0;
  await assert.rejects(ingress.recover(async () => {
    page++; const newest = 106 - (page - 1) * 2;
    return { messages: [dm(String(newest)), dm(String(newest - 1))], oldestId: String(newest - 1),
      newestId: String(newest), hasMore: true };
  }), /超过补取页数/);
  ingress.start();
  await ingress.receive(dm('110'));
  assert.deepEqual(calls, []);
  assert.equal(ingress.knownChannels()[0]?.cursor, '100');
  await ingress.recover(async (_channel, options) => !options.before
    ? { messages: [dm('106'), dm('105')], oldestId: '105', newestId: '106', hasMore: true }
    : { messages: [dm('101')], oldestId: '101', newestId: '101', hasMore: false });
  await ingress.whenIdle();
  assert.deepEqual(calls, ['101', '103', '104', '105', '106', '110']);
});

test('unknown initial DM starts at its first received message rather than replaying old chat', async t => {
  const root = await directory(t);
  const calls: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    handle: async message => { calls.push(message.id); } });
  cleanup(root, () => ingress.close());
  let queries = 0;
  await ingress.recover(async () => { queries++; return empty; });
  assert.equal(queries, 0);
  await ingress.receive(dm('200'));
  ingress.start();
  await ingress.whenIdle();
  await ingress.recover(async (_channel, options) => {
    assert.equal(options.after, undefined);
    assert.equal(options.before, undefined);
    return { messages: [dm('199')], oldestId: '199', newestId: '199', hasMore: false };
  });
  await ingress.whenIdle();
  assert.deepEqual(calls, ['200']);
});

test('control commands bypass a slow image while subsequent ordinary input keeps its barrier', async t => {
  const root = await directory(t);
  const hold = gate();
  const events: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    handle: async message => { events.push(message.text); if (message.text === 'image') await hold.promise; } });
  cleanup(root, () => ingress.close());
  ingress.start();
  await ingress.receive(dm('101', { text: 'image' }));
  await eventually(() => events.length === 1);
  await ingress.receive(dm('102', { text: '/stop' }));
  await ingress.receive(dm('103', { text: 'after stop' }));
  await eventually(() => events.length === 2);
  assert.deepEqual(events, ['image', '/stop']);
  hold.release();
  await ingress.whenIdle();
  assert.deepEqual(events, ['image', '/stop', 'after stop']);
});

test('a read-only /agent query waits behind a slow image and never advances its preparation cancellation epoch', async t => {
  const root = await directory(t);
  const hold = gate();
  let revision = 0;
  const stamps = new Map<string, number>();
  const accepted: string[] = [];
  const discarded: string[] = [];
  const events: string[] = [];
  // Match main's hook semantics while exercising ingress's actual default control rule.
  const isControl = (message: IncomingDM): boolean =>
    /^(?:\/(?:stop|new|cwd)(?:\s|$)|\/agent\s+\S|new\s+chat$|新会话$|新聊天$)/i.test(message.text.trim());
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    onQueued: (message, replayOnly) => {
      revision += isControl(message) ? 1 : 0;
      if (!replayOnly) stamps.set(message.id, revision);
    }, handle: async message => {
      if (!isControl(message) && stamps.get(message.id) !== revision) { discarded.push(message.id); return; }
      if (message.text === 'image') { events.push('image:downloading'); await hold.promise; }
      if (!isControl(message) && stamps.get(message.id) !== revision) { discarded.push(message.id); return; }
      accepted.push(message.id); events.push(message.text);
    } });
  cleanup(root, () => ingress.close());
  ingress.start();
  await ingress.receive(dm('101', { text: 'image', attachments: [
    { id: '888', filename: 'shot.png', url: 'https://cdn.discordapp.com/attachments/222/888/shot.png', size: 100 },
  ] }));
  await eventually(() => events.length === 1);
  await ingress.receive(dm('102', { text: '/agent' }));
  await ingress.receive(dm('103', { text: 'after query' }));
  await delay(10);
  assert.deepEqual(events, ['image:downloading'], 'Read-only query must not bypass slow preparation');
  assert.equal(revision, 0);
  hold.release(); await ingress.whenIdle();
  assert.deepEqual(accepted, ['101', '102', '103']);
  assert.deepEqual(discarded, []);
  assert.deepEqual(events, ['image:downloading', 'image', '/agent', 'after query']);
});

test('only authorized DM metadata is persisted; interaction credentials stay in memory', async t => {
  const root = await directory(t);
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false, handle: async () => {} });
  cleanup(root, () => ingress.close());
  assert.equal(ingress.capture(dm('101', { userId: '999' })), false);
  ingress.seedChannel({ userId: '111', channelId: '222', cursor: '100' });
  assert.equal(ingress.capture(dm('102', { userId: '999' })), false);
  const secret = 'fake-interaction-credential-must-not-persist';
  assert.throws(() => ingress.capture(dm('103', { interaction: { id: '103', applicationId: '999', token: secret } })), /不能写入/);
  ingress.start();
  await ingress.receive(dm('103', { interaction: { id: '103', applicationId: '999', token: secret } }));
  assert.equal(ingress.getMessage('103'), null);
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(`${ingress.path}${suffix}`).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
});

test('preparation failure is recorded once, does not block following input or retry silently', async t => {
  const root = await directory(t);
  const calls: string[] = [];
  const failures: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    handle: async message => { calls.push(message.id); if (message.id === '101') throw new Error('expired image'); },
    onError: message => { failures.push(message.id); } });
  cleanup(root, () => ingress.close());
  ingress.start();
  await ingress.receive(dm('101'));
  await ingress.receive(dm('102'));
  await ingress.whenIdle();
  assert.deepEqual(calls, ['101', '102']);
  assert.deepEqual(failures, ['101']);
  assert.equal(ingress.getMessage('101')?.state, 'failed');
  await ingress.receive(dm('101'));
  await ingress.whenIdle();
  assert.deepEqual(calls, ['101', '102']);
});

test('onQueued stamps cancellation epoch before a control command overtakes slow preparation', async t => {
  const root = await directory(t);
  const hold = gate();
  let revision = 0;
  const stamped = new Map<string, number>();
  const accepted: string[] = [];
  const discarded: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    onQueued: message => { if (message.text === '/new') revision++; stamped.set(message.id, revision); },
    handle: async message => {
      if (message.text === 'image') await hold.promise;
      if (message.text !== '/new' && stamped.get(message.id) !== revision) discarded.push(message.id);
      else accepted.push(message.id);
    } });
  cleanup(root, () => ingress.close());
  ingress.start();
  await ingress.receive(dm('101', { text: 'image' }));
  await eventually(() => ingress.getMessage('101')?.state === 'processing');
  await ingress.receive(dm('102', { text: 'old queued text' }));
  await ingress.receive(dm('103', { text: '/new' }));
  await ingress.receive(dm('104', { text: 'new scope text' }));
  await eventually(() => accepted.includes('103'));
  hold.release();
  await ingress.whenIdle();
  assert.deepEqual(accepted, ['103', '104']);
  assert.deepEqual(discarded, ['101', '102']);
});

test('recovered onQueued scope stamps follow complete history order rather than REST page order', async t => {
  const root = await directory(t);
  const stamps: Array<[string, number]> = [];
  let revision = 0;
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    onQueued: message => { if (message.text === '/new') revision++; stamps.push([message.id, revision]); },
    handle: async () => {} });
  cleanup(root, () => ingress.close());
  ingress.seedChannel({ userId: '111', channelId: '222', cursor: '100' });
  ingress.start();
  await ingress.recover(async () => ({ messages: [dm('104'), dm('103', { text: '/new' }), dm('102'), dm('101')],
    oldestId: '101', newestId: '104', hasMore: false }));
  await ingress.whenIdle();
  assert.deepEqual(stamps, [['101', 0], ['102', 0], ['103', 1], ['104', 1]]);
  await ingress.close();
  await assert.rejects(ingress.receive(dm('105')), /已关闭/);
});

test('completed /new remains a durable cancellation barrier after crash before slow preparation discards', async t => {
  const root = await directory(t);
  const oldHold = gate();
  const admitted = new Set<string>();
  const old = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: id => admitted.has(id),
    handle: async message => { if (message.text === 'image') await oldHold.promise; else if (message.text === '/new') admitted.add(message.id); } });
  old.start();
  await old.receive(dm('101', { text: 'image' }));
  await eventually(() => old.getMessage('101')?.state === 'processing');
  await old.receive(dm('102', { text: 'old queued text' }));
  await old.receive(dm('103', { text: '/new' }));
  await old.receive(dm('104', { text: 'new scope text' }));
  await eventually(() => old.getMessage('103')?.state === 'accepted');
  await old.close();
  let revision = 0;
  const stamps = new Map<string, number>();
  const cancelled: string[] = [];
  const accepted: string[] = [];
  const barriers: string[] = [];
  const recovered = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: id => admitted.has(id),
    onQueued: (message, replayOnly) => {
      if (message.text === '/new') { revision++; if (replayOnly) barriers.push(message.id); }
      if (!replayOnly) stamps.set(message.id, revision);
    }, handle: async message => {
      if (stamps.get(message.id) !== revision) cancelled.push(message.id); else accepted.push(message.id);
    } });
  cleanup(root, () => recovered.close());
  recovered.start();
  await recovered.whenIdle();
  assert.deepEqual(barriers, ['103']);
  assert.deepEqual(cancelled, ['101', '102']);
  assert.deepEqual(accepted, ['104']);
  assert.equal(stamps.has('103'), false, 'Completed command is a barrier, not an executable replay');
  oldHold.release(); await old.whenIdle();
});

test('repeated kick and READY do not restamp old controls or cancel their following live image', async t => {
  const root = await directory(t);
  const hold = gate();
  let revision = 0;
  const stamps = new Map<string, number>();
  const accepted: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    onQueued: (message, replayOnly) => { if (message.text === '/new') revision++; if (!replayOnly) stamps.set(message.id, revision); },
    handle: async message => {
      if (message.text === 'image') await hold.promise;
      assert.equal(stamps.get(message.id), revision, 'Scope cannot change just because recovery ran again');
      accepted.push(message.id);
    } });
  cleanup(root, () => ingress.close());
  ingress.start();
  await ingress.receive(dm('103', { text: '/new' }));
  await ingress.whenIdle();
  await ingress.receive(dm('104', { text: 'image' }));
  await eventually(() => ingress.getMessage('104')?.state === 'processing');
  await ingress.receive(dm('105'));
  await ingress.recover(async () => empty);
  await ingress.recover(async () => empty);
  await ingress.receive(dm('106'));
  assert.equal(revision, 1);
  hold.release(); await ingress.whenIdle();
  assert.deepEqual(accepted, ['103', '104', '105', '106']);
});

test('an ACKed control interaction persists only a terminal barrier without token or history cursor advancement', async t => {
  const root = await directory(t);
  const hold = gate();
  const secret = 'fake-slash-barrier-token-must-not-persist';
  const old = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    handle: async message => { if (!message.interaction) await hold.promise; } });
  old.start();
  await old.receive(dm('101', { text: 'image' }));
  await eventually(() => old.getMessage('101')?.state === 'processing');
  await old.receive(dm('103', { text: '/new', interaction: { id: '103', applicationId: '999', token: secret } }));
  assert.equal(old.getMessage('103')?.state, 'accepted');
  assert.equal(old.knownChannels()[0]?.cursor, '101', 'Interaction is not a REST message cursor');
  await old.recover(async () => empty);
  assert.equal(old.knownChannels()[0]?.cursor, '101', 'Reconciliation also excludes interaction-only barriers');
  assert.equal('interaction' in old.getMessage('103')!, false);
  await old.close();
  let revision = 0;
  const stamps = new Map<string, number>();
  const discarded: string[] = [];
  const recovered = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    onQueued: (message, replayOnly) => { if (message.text === '/new') revision++; if (!replayOnly) stamps.set(message.id, revision); },
    handle: async message => { assert.notEqual(stamps.get(message.id), revision); discarded.push(message.id); } });
  cleanup(root, () => recovered.close());
  recovered.start(); await recovered.whenIdle();
  assert.deepEqual(discarded, ['101']);
  for (const suffix of ['', '-wal']) {
    const bytes = await readFile(`${recovered.path}${suffix}`).catch(() => Buffer.alloc(0));
    assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
  hold.release(); await old.whenIdle();
});

test('an interaction during startup recovery is stamped in historical order without persisting its token', async t => {
  const root = await directory(t);
  const hold = gate();
  let revision = 0;
  const stamps = new Map<string, number>();
  const order: string[] = [];
  const cancelled: string[] = [];
  const accepted: string[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: id => id === '95',
    onQueued: (message, replayOnly) => {
      order.push(message.id);
      if (message.text === '/new') revision++;
      if (!replayOnly) stamps.set(message.id, revision);
    }, handle: async message => {
      if (!message.interaction && stamps.get(message.id) !== revision) cancelled.push(message.id);
      else accepted.push(message.id);
    } });
  cleanup(root, () => ingress.close());
  ingress.seedChannel({ userId: '111', channelId: '222', cursor: '100' });
  ingress.capture(dm('95', { text: '/new' }));
  const recovery = ingress.recover(async () => { await hold.promise; return {
    messages: [dm('101')], oldestId: '101', newestId: '101', hasMore: false,
  }; });
  ingress.start();
  const interaction = ingress.receive(dm('103', { text: '/new', interaction: {
    id: '103', applicationId: '999', token: 'fake-startup-ephemeral-token',
  } }));
  await ingress.receive(dm('104'));
  assert.deepEqual(order, [], 'No scope is stamped before complete historical recovery');
  hold.release();
  await recovery; await interaction; await ingress.whenIdle();
  assert.deepEqual(order, ['95', '101', '103', '104']);
  assert.deepEqual(cancelled, ['101']);
  assert.deepEqual(accepted, ['103', '104']);
});
