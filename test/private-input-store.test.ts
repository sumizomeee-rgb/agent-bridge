import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionStore, type InboxState } from '../src/store.js';
import type { BridgeMessage } from '../src/types.js';

const USER = 'owner', CHANNEL = 'private-chat';
async function setup(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'bridge-private-input-store-test-')), stores: SessionStore[] = [], closed = new Set<SessionStore>();
  const open = () => { const value = new SessionStore(path); stores.push(value); return value; };
  const close = (store: SessionStore) => { if (!closed.has(store)) { store.close(); closed.add(store); } };
  t.after(async () => { for (const store of stores) close(store); await rm(path, { recursive: true, force: true }); });
  const store = open(), conversation = store.createConversation(USER, 'codex', path, { controllerMode: true });
  store.setActive(USER, conversation.id);
  const message = (id: string, text = id, extra: Partial<BridgeMessage> = {}): BridgeMessage => ({ id, userId: USER, channelId: CHANNEL, text, imagePaths: [], ...extra });
  const add = (id: string, text = id, extra: Partial<BridgeMessage> = {}, state: InboxState = 'queued', conversationId: string | null = conversation.id) => {
    const value = message(id, text, extra); assert.equal(store.addMessage(value, conversationId, state), true); return value;
  };
  add('root', 'Original request', {}, 'running');
  return { store, conversation, message, add, path, open, close };
}

test('private input refresh claims fresh owner inputs atomically, preserves sources and images, and uses one persistent batch', async t => {
  const f = await setup(t), initial = f.store.startPrivateBatch('root');
  assert.deepEqual(initial.messages.map(value => value.id), ['root']); assert.equal(initial.messages[0]!.state, 'running');
  const source = { messageId: 'platform-followup', userId: USER, channelId: CHANNEL, authorType: 'user' as const };
  f.add('fresh-text', 'Use the newest instruction', { source });
  f.add('fresh-picture', '', { imagePaths: ['C:\\workspace\\picture.png'] });
  const result = f.store.claimPrivateRefresh('root'); assert(result);
  assert(result.version > initial.version); assert.deepEqual(result.messages.map(value => value.id), ['fresh-text', 'fresh-picture']);
  assert.deepEqual(result.messages[0]!.source, source); assert.deepEqual(result.messages[1]!.imagePaths, ['C:\\workspace\\picture.png']);
  assert(result.messages.every(value => value.state === 'running'));
  const batch = f.store.privateBatch('root')!;
  assert.equal(batch.refreshUsed, true); assert.equal(batch.version, result.version);
  assert.deepEqual(batch.messages.map(value => value.id), ['root', 'fresh-text', 'fresh-picture']);
  assert.deepEqual(f.store.startPrivateBatch('root'), { version: result.version, messages: batch.messages });
  f.add('later', 'Keep this for a later ordinary turn');
  assert.equal(f.store.claimPrivateRefresh('root'), null); assert.equal(f.store.getMessage('later')!.state, 'queued');
});

test('an empty refresh does not spend its allowance and messages from another user do not break owner ordering', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root');
  assert.equal(f.store.claimPrivateRefresh('root'), null); assert.equal(f.store.privateBatch('root')!.refreshUsed, false);
  const other = f.store.createConversation('another-owner', 'codex', f.path);
  f.add('other-user', 'Unrelated', { userId: 'another-owner', channelId: 'another-private' }, 'queued', other.id);
  f.add('owner-followup');
  assert.deepEqual(f.store.claimPrivateRefresh('root')!.messages.map(value => value.id), ['owner-followup']);
  assert.equal(f.store.getMessage('other-user')!.state, 'queued');
});

const boundaries: Array<{ name: string; extra?: Partial<BridgeMessage>; state?: InboxState; nullConversation?: true; otherConversation?: true; text?: string }> = [
  { name: 'unbound command', state: 'command', nullConversation: true, text: '/new' },
  { name: 'queued command text', text: '/status' },
  { name: 'new-chat alias', text: 'new chat' },
  { name: 'different private channel', extra: { channelId: 'another-private' } },
  { name: 'different conversation', otherConversation: true },
  { name: 'running input', state: 'running' },
  { name: 'steering input', state: 'steering' },
  { name: 'uncertain input', state: 'uncertain' },
  { name: 'completed input', state: 'completed' },
  { name: 'cancelled input', state: 'cancelled' },
  { name: 'interrupted input', state: 'interrupted' },
  { name: 'failed input', state: 'failed' },
  { name: 'Bot author', extra: { source: { messageId: 'bot', userId: USER, channelId: CHANNEL, authorType: 'bot' } } },
  { name: 'system author', extra: { source: { messageId: 'system', userId: USER, channelId: CHANNEL, authorType: 'system' } } },
  { name: 'unknown author', extra: { source: { messageId: 'unknown', userId: USER, channelId: CHANNEL, authorType: 'unknown' } } },
  { name: 'source group', extra: { source: { messageId: 'group', userId: USER, channelId: CHANNEL, authorType: 'user', space: { kind: 'group', spaceId: 'group', mentionedUserIds: [] } } } },
  { name: 'host group', extra: { groupContext: { eventId: 'event', rootId: 'group-root', botId: 'bot', spaceId: 'group', generation: 1, bindingEpoch: 1, originChannelId: 'group', principalId: 'principal', scene: '' } } },
];
for (const boundary of boundaries) test(`private refresh stops at ${boundary.name} and never skips to later same-chat input`, async t => {
  const f = await setup(t); f.store.startPrivateBatch('root'); f.add('before-boundary');
  const other = boundary.otherConversation ? f.store.createConversation(USER, 'codex', f.path).id : f.conversation.id;
  f.add('boundary', boundary.text ?? 'Boundary', boundary.extra, boundary.state ?? 'queued', boundary.nullConversation ? null : other);
  f.add('after-boundary');
  const refresh = f.store.claimPrivateRefresh('root');
  if (boundary.extra?.channelId && boundary.extra.channelId !== CHANNEL) {
    assert.equal(refresh, null); assert.equal(f.store.getMessage('before-boundary')!.state, 'queued');
  } else assert.deepEqual(refresh!.messages.map(value => value.id), ['before-boundary']);
  assert.equal(f.store.getMessage('boundary')!.state, boundary.state ?? 'queued');
  assert.equal(f.store.getMessage('after-boundary')!.state, 'queued');
  assert.equal(f.store.privateBatch('root')!.messages.some(value => value.id === 'after-boundary'), false);
});

test('message count and character limits keep whole excess inputs queued and never truncate owner instructions', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root');
  f.add('one', '1234'); f.add('two', '5678'); f.add('three', '90');
  const result = f.store.claimPrivateRefresh('root', 2, 7)!;
  assert.deepEqual(result.messages.map(value => [value.id, value.text]), [['one', '1234']]);
  assert.equal(f.store.getMessage('two')!.state, 'queued'); assert.equal(f.store.getMessage('three')!.state, 'queued');
});

test('an oversized first fresh input stays queued, prevents skipping, and does not spend the refresh allowance', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root');
  f.add('long', '12345678'); f.add('short', 'x');
  assert.equal(f.store.claimPrivateRefresh('root', 20, 7), null);
  assert.equal(f.store.privateBatch('root')!.refreshUsed, false); assert.equal(f.store.getMessage('long')!.state, 'queued');
  assert.deepEqual(f.store.claimPrivateRefresh('root', 1, 8)!.messages.map(value => value.id), ['long']);
  assert.equal(f.store.getMessage('short')!.state, 'queued');
});

test('arrival barriers are durable, deduplicated per user, and cannot be reset by starting the same batch again', async t => {
  const f = await setup(t);
  f.store.markPrivateInputBarrier(USER, 'old-barrier'); f.add('root-after-old-barrier', 'New root', {}, 'running'); f.store.startPrivateBatch('root-after-old-barrier');
  f.store.markPrivateInputBarrier(USER, 'old-barrier'); f.store.markPrivateInputBarrier('another-owner', 'unrelated');
  f.add('fresh'); assert(f.store.claimPrivateRefresh('root-after-old-barrier'));
  const other = await setup(t); other.store.startPrivateBatch('root');
  other.store.markPrivateInputBarrier(USER, 'new-command-before-attachments');
  other.add('fresh'); other.store.startPrivateBatch('root');
  assert.equal(other.store.claimPrivateRefresh('root'), null);
  assert.equal(other.store.getMessage('fresh')!.state, 'queued'); assert.equal(other.store.privateBatch('root')!.refreshUsed, false);
  other.close(other.store); const restored = other.open();
  assert.equal(restored.claimPrivateRefresh('root'), null);
});

test('once budget and batch membership survive reopening; normal interrupted-running recovery never replays claimed inputs', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root'); f.add('fresh');
  f.store.claimPrivateRefresh('root'); f.add('unclaimed');
  f.close(f.store); const restored = f.open();
  assert.equal(restored.privateBatch('root')!.refreshUsed, true);
  assert.equal(restored.claimPrivateRefresh('root'), null);
  assert.deepEqual(restored.interruptRunning().map(value => value.id), ['root', 'fresh']);
  assert.equal(restored.claimPrivateRefresh('root'), null); assert.equal(restored.getMessage('fresh')!.state, 'interrupted');
  assert.equal(restored.getMessage('unclaimed')!.state, 'queued');
});

test('independent SQLite clients cannot claim the same fresh owner input twice', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root'); f.add('fresh'); const peer = f.open();
  assert.equal(f.store.claimPrivateRefresh('root')!.messages.length, 1);
  assert.equal(peer.claimPrivateRefresh('root'), null);
  assert.deepEqual(peer.privateBatch('root')!.messages.map(value => value.id), ['root', 'fresh']);
});

test('roots must be ordinary running inputs in the active owner conversation; changed bindings stop refresh', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root'); f.add('fresh');
  const replacement = f.store.createConversation(USER, 'claude', f.path); f.store.setActive(USER, replacement.id);
  assert.equal(f.store.claimPrivateRefresh('root'), null); assert.throws(() => f.store.startPrivateBatch('root'), /普通运行中/);
  f.store.setActive(USER, f.conversation.id); f.store.setState('root', 'completed');
  assert.equal(f.store.claimPrivateRefresh('root'), null); assert.throws(() => f.store.startPrivateBatch('root'), /普通运行中/);
  assert.throws(() => f.store.startPrivateBatch('missing'), /普通运行中/); assert.equal(f.store.claimPrivateRefresh('missing'), null);
  f.add('bot-root', 'Not a human request', { source: { messageId: 'bot', userId: USER, channelId: CHANNEL, authorType: 'bot' } }, 'running');
  assert.throws(() => f.store.startPrivateBatch('bot-root'), /普通运行中/);
});

test('failed batch membership insertion rolls back every claimed state and the once allowance', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root'); f.add('first-fresh'); f.add('other-root', 'Other root', {}, 'running');
  f.store.startPrivateBatch('other-root'); f.store.setState('other-root', 'queued');
  assert.throws(() => f.store.claimPrivateRefresh('root'), /UNIQUE/);
  assert.equal(f.store.getMessage('first-fresh')!.state, 'queued'); assert.equal(f.store.getMessage('other-root')!.state, 'queued');
  assert.equal(f.store.privateBatch('root')!.refreshUsed, false); assert.deepEqual(f.store.privateBatch('root')!.messages.map(value => value.id), ['root']);
});

test('private refresh rejects invalid bounds and barrier identities', async t => {
  const f = await setup(t); f.store.startPrivateBatch('root');
  for (const limit of [0, 101, 0.5, NaN]) assert.throws(() => f.store.claimPrivateRefresh('root', limit), /上限无效/);
  for (const chars of [0, 1_000_001, 0.5, NaN]) assert.throws(() => f.store.claimPrivateRefresh('root', 20, chars), /上限无效/);
  assert.throws(() => f.store.markPrivateInputBarrier('', 'id'), /有效用户/);
  assert.throws(() => f.store.markPrivateInputBarrier(USER, ''), /有效用户/);
});

test('a root queued before a control barrier cannot absorb post-barrier input when its model starts later', async t => {
  const f = await setup(t); f.store.setState('root', 'queued');
  f.store.markPrivateInputBarrier(USER, 'command-arrived-before-root-start');
  f.store.setState('root', 'running'); f.store.startPrivateBatch('root'); f.add('post-barrier');
  assert.equal(f.store.claimPrivateRefresh('root'), null);
  assert.equal(f.store.getMessage('post-barrier')!.state, 'queued'); assert.equal(f.store.privateBatch('root')!.refreshUsed, false);
});

test('raw arrival preserves a slow attachment root boundary across a group arrival and later preparation', async t => {
  const f = await setup(t), slow = f.message('slow-root', 'Slow image', { imagePaths: ['C:\\workspace\\slow.png'] });
  f.store.notePrivateInputArrival(slow);
  f.store.markPrivateInputBarrier(USER, 'group-message-arrived-during-download');
  f.store.addMessage(slow, f.conversation.id, 'running'); f.store.startPrivateBatch(slow.id);
  f.add('post-group-private');
  assert.equal(f.store.claimPrivateRefresh(slow.id), null); assert.equal(f.store.getMessage('post-group-private')!.state, 'queued');
});

test('raw arrival dedup preserves original order and a cross-chat arrival advances the private boundary before persistence', async t => {
  const f = await setup(t), slow = f.message('slow-root'), other = f.message('other-chat-raw', 'Other chat', { channelId: 'another-private' });
  f.store.notePrivateInputArrival(slow); f.store.notePrivateInputArrival(other); f.store.notePrivateInputArrival(slow);
  f.store.addMessage(slow, f.conversation.id, 'running'); f.store.startPrivateBatch(slow.id); f.add('post-chat-switch');
  assert.equal(f.store.claimPrivateRefresh(slow.id), null); assert.equal(f.store.getMessage('post-chat-switch')!.state, 'queued');
  assert.throws(() => f.store.notePrivateInputArrival({ ...slow, userId: 'another-owner' }), /复用于其他用户或聊天/);
  assert.throws(() => f.store.notePrivateInputArrival({ ...slow, channelId: 'another-private' }), /复用于其他用户或聊天/);
});

test('an arrival identity conflict rolls back the newly prepared inbox message', async t => {
  const f = await setup(t), raw = f.message('reserved-raw'); f.store.notePrivateInputArrival(raw);
  assert.throws(() => f.store.addMessage({ ...raw, channelId: 'wrong-prepared-channel' }, f.conversation.id, 'queued'), /复用于其他用户或聊天/);
  assert.equal(f.store.hasMessage(raw.id), false);
  assert.equal(f.store.addMessage(raw, f.conversation.id, 'queued'), true);
});
