import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../src/store.js';

test('恢复队列保留真实消息来源，路由owner不冒充群发言者', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-chat-source-'));
  let store = new SessionStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); });
  const conversation = store.createConversation('owner-route', 'claude', root);
  const source = { messageId: 'platform-source-id', userId: 'actual-member-id', channelId: 'source-group',
    authorName: 'Member', authorType: 'user' as const, time: '2026-10-17T09:00:00Z',
    space: { kind: 'group' as const, spaceId: 'source-group', mentionedUserIds: ['actual-bot'], replyToMessageId: 'earlier-message' } };
  store.addMessage({ id: 'host-delivery-id', userId: 'owner-route', channelId: 'delivery-group', text: '真实群消息', imagePaths: [], source }, conversation.id, 'queued');
  store.close(); store = new SessionStore(root);
  const queued = store.nextQueued(conversation.id)!;
  assert.equal(queued.userId, 'owner-route'); assert.equal(queued.channelId, 'delivery-group');
  assert.deepEqual(queued.source, source); assert.equal(queued.source!.userId, 'actual-member-id');
});

test('旧收件库增加来源列时不改旧消息和会话绑定，也不臆造历史来源', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-chat-source-legacy-'));
  let store = new SessionStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }); });
  const conversation = store.createConversation('owner', 'codex', root);
  store.addMessage({ id: 'old', userId: 'owner', channelId: 'dm', text: '旧私聊', imagePaths: [] }, conversation.id, 'queued');
  store.close();
  const database = new DatabaseSync(join(root, 'bridge.sqlite'));
  database.exec('ALTER TABLE inbox DROP COLUMN source_json'); database.close();
  store = new SessionStore(root);
  assert.equal(store.getConversation(conversation.id)!.userId, 'owner');
  assert.equal(store.getMessage('old')!.text, '旧私聊'); assert.equal(store.getMessage('old')!.source, undefined);
  assert.equal(store.nextQueued(conversation.id)!.id, 'old');
});
