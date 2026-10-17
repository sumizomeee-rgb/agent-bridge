import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuTransport } from '../src/feishu.js';
import { DiscordTransport } from '../src/discord.js';
import { historyOptions, historyPage } from '../src/group-history.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';

function config(platform: 'feishu' | 'discord'): BridgeConfig {
  const owner = platform === 'feishu' ? 'ou_owner' : '42';
  return { platform, applicationId: platform === 'feishu' ? 'cli_test' : '55', scopePrefix: platform === 'feishu' ? 'feishu:cli_test|' : 'discord:55|',
    appSecret: 'not-real', token: 'not-real', allowedUserIds: [owner], externalAllowedUserIds: [owner], groupMode: true, proxyUrl: null,
    dataDir: '.', attachmentsDir: '.', logsDir: '.', workspace: '.', maxImageBytes: 100, defaultAgent: 'codex', commands: {} } as BridgeConfig;
}
const reply = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
function feishu(items: unknown[], extra: Record<string, unknown> = {}) {
  const queries: URL[] = [], methods: string[] = [];
  const bridge = new FeishuTransport(config('feishu'), async () => {}, { fetch: (async (input: any, init: any) => {
    const url = new URL(String(input)); methods.push(init.method);
    if (url.pathname.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'fake' }));
    queries.push(url); return reply({ items, has_more: false, ...extra });
  }) as any });
  bridge.getGroupInfo = async spaceId => ({ spaceId, botIsMember: true });
  bridge.getGroupMember = async () => ({ id: 'ou_owner', idType: 'open_id', isBot: false });
  return { bridge, queries, methods };
}
const item = (id: string, sender: Record<string, unknown>, changes: Record<string, unknown> = {}) => ({ message_id: id, chat_id: 'oc_group', create_time: '1700000000123', sender, msg_type: 'text', body: { content: '{"text":"群讨论"}' }, ...changes });

test('history query validates time bounds, page size and opaque internal cursor before any request', () => {
  assert.throws(() => historyOptions({ limit: 51 }), /1～50/);
  assert.throws(() => historyOptions({ startTime: 'yesterday' }), /ISO/);
  assert.throws(() => historyOptions({ startTime: '2026-01-02T00:00:00Z', endTime: '2026-01-01T00:00:00Z' }), /早于/);
  assert.throws(() => historyOptions({ pageToken: '' }), /游标/);
  assert.equal(historyOptions({ limit: 50 }).limit, 50);
});

test('Feishu evidence history contains outsider humans and app bots with author, mentions, reply and attachment descriptors', async t => {
  const { bridge, queries, methods } = feishu([
    item('om_outsider', { id: 'ou_outsider', id_type: 'open_id', sender_type: 'user' }, { mentions: [{ id: 'ou_bot', name: 'Miku' }], parent_id: 'om_previous' }),
    item('om_bot', { id: 'cli_other', id_type: 'app_id', sender_type: 'app' }, { msg_type: 'file', body: { content: '{"file_key":"file_123","file_name":"notes.txt"}' } }),
  ], { has_more: true, page_token: 'opaque&next' }); t.after(() => bridge.close());
  const page = await bridge.readConversationHistory('oc_group', { startTime: '2023-11-14T22:13:20.000Z', endTime: '2023-11-14T22:13:21Z', limit: 5, pageToken: 'opaque&previous' });
  assert.equal(page.evidenceOnly, true); assert.equal(page.messages.length, 2);
  const human = page.messages.find(m => m.id === 'om_outsider')!;
  assert.equal(human.author.type, 'user'); assert.equal(human.text, '群讨论'); assert.equal(human.replyToMessageId, 'om_previous'); assert.deepEqual(human.mentions, [{ id: 'ou_bot', name: 'Miku' }]);
  const bot = page.messages.find(m => m.id === 'om_bot')!;
  assert.equal(bot.author.type, 'bot'); assert.deepEqual(bot.attachments, [{ id: 'file_123', name: 'notes.txt', contentType: 'application/octet-stream' }]);
  assert.equal(page.pageToken, 'opaque&next'); assert.equal(page.hasMore, true);
  assert.equal(queries[0]!.searchParams.get('start_time'), '1700000000'); assert.equal(queries[0]!.searchParams.get('end_time'), '1700000001');
  assert.equal(queries[0]!.searchParams.get('page_token'), 'opaque&previous'); assert(methods.slice(1).every(m => m === 'GET')); assert(queries.every(u => !/resources|reactions/.test(u.pathname)));
});

test('Feishu card history explicitly describes API projection and compatibility fallback limits', async t => {
  const { bridge } = feishu([item('om_card', { id: 'cli_bot', sender_type: 'app' }, { msg_type: 'interactive', body: { content: JSON.stringify({ title: '卡片消息', elements: [{ tag: 'div', text: '请升级客户端以查看此消息' }] }) } })]); t.after(() => bridge.close());
  const page = await bridge.readConversationHistory('oc_group');
  assert(page.messages[0]!.text.includes('请升级客户端'));
  assert(page.coverage.notes.some(note => note.includes('接口可见投影') && note.includes('不得') && note.includes('不保证原卡完整')));
});

test('Feishu evidence refuses wrong group, broken pagination, revoked membership and filters subsecond bounds', async t => {
  const wrong = feishu([item('om_x', {}, { chat_id: 'oc_other' })]); t.after(() => wrong.bridge.close());
  await assert.rejects(wrong.bridge.readConversationHistory('oc_group'), /其他群/);
  const broken = feishu([], { has_more: true }); t.after(() => broken.bridge.close());
  await assert.rejects(broken.bridge.readConversationHistory('oc_group'), /分页/);
  const revoked = feishu([]); t.after(() => revoked.bridge.close()); revoked.bridge.getGroupMember = async () => null;
  await assert.rejects(revoked.bridge.readConversationHistory('oc_group'), /失效/); assert.equal(revoked.queries.length, 0);
  const bounds = feishu([item('om_x', { id: 'ou_owner', sender_type: 'user' })]); t.after(() => bounds.bridge.close());
  assert.equal((await bounds.bridge.readConversationHistory('oc_group', { startTime: '2023-11-14T22:13:20.124Z' })).messages.length, 0);
});

test('Feishu realtime group observers reach Host with factual source while outsider private messages remain blocked', async t => {
  const accepted: IncomingDM[] = [], cfg = config('feishu');
  const bridge = new FeishuTransport(cfg, async message => { accepted.push(message); }, { onReceive: () => false }); t.after(() => bridge.close());
  const event = (chatType: string) => ({ event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_outsider' } }, message: { message_id: 'om_'+chatType, create_time: '1700000000123', chat_id: 'oc_group', chat_type: chatType, message_type: 'text', content: '{"text":"普通成员讨论"}' } } });
  await bridge.receiveEvent(event('p2p')); assert.equal(accepted.length, 0);
  await bridge.receiveEvent(event('group')); assert.equal(accepted.length, 1); assert.equal(accepted[0]!.source?.authorType, 'user'); assert.equal(accepted[0]!.source?.time, '2023-11-14T22:13:20.123Z');
});

test('history output limits Unicode body, metadata and total byte budget without losing page positions', () => {
  const messages = Array.from({ length: 50 }, (_, n) => ({ id: String(n), author: { id: 'ou_x', type: 'user' as const, name: '名'.repeat(1000) }, time: '2026-01-01T00:00:00.000Z', text: '🌸'.repeat(10000),
    mentions: Array.from({ length: 50 }, () => ({ id: 'ou_'+ 'a'.repeat(200), name: '人'.repeat(500) })), attachments: Array.from({ length: 50 }, () => ({ id: 'a'.repeat(1000), name: '文'.repeat(500) })) }));
  const page = historyPage('oc_group', {}, messages, true, 'next');
  assert.equal(page.messages.length, 50); assert.equal(page.truncated, true); assert(Buffer.byteLength(JSON.stringify(page)) <= 60 * 1024); assert(page.messages.every(m => m.truncated && !m.text.includes('\uFFFD')));
});

test('Discord evidence uses GET snowflake paging, includes outsider and bot, and stops at requested start', async t => {
  const bridge = new DiscordTransport(config('discord'), async () => {}); t.after(() => bridge.close());
  bridge.getGroupInfo = async spaceId => ({ spaceId, guildId: '77', botIsMember: true }); bridge.getGroupMember = async () => ({ id: '42', idType: 'discord', isBot: false });
  const queries: string[] = [];
  (bridge as any).rest = async (path: string, method: string) => { assert.equal(method, 'GET'); queries.push(path); return [
    { id: '1002', channel_id: '88', author: { id: '99', username: 'visitor' }, timestamp: '2026-01-01T12:00:00Z', content: 'discuss', mentions: [{ id: '55' }], message_reference: { message_id: '1000' } },
    { id: '1001', channel_id: '88', author: { id: '55', bot: true }, timestamp: '2026-01-01T11:00:00Z', content: 'reply', attachments: [{ id: '12', filename: 'x.png', url: 'https://secret.invalid', size: 123, content_type: 'image/png' }] },
  ]; };
  const page = await bridge.readConversationHistory('88', { limit: 2, endTime: '2026-01-02T00:00:00Z' });
  assert.equal(page.messages.length, 2); assert.equal(page.messages[1]!.author.type, 'bot'); assert.equal(page.pageToken, '1001'); assert.equal(page.hasMore, true); assert(!JSON.stringify(page).includes('secret.invalid'));
  await bridge.readConversationHistory('88', { limit: 2, pageToken: page.pageToken }); assert(queries[1]!.includes('before=1001'));
  const bounded = await bridge.readConversationHistory('88', { limit: 2, startTime: '2026-01-01T11:30:00Z' }); assert.equal(bounded.messages.length, 1); assert.equal(bounded.hasMore, false);
  await assert.rejects(bridge.readConversationHistory('88', { pageToken: '../99' }), /游标/);
});
