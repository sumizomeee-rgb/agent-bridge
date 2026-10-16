import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuTransport, splitUtf8 } from '../src/feishu.js';
import { DurableIngress } from '../src/ingress.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';
const prefix = 'feishu:cli_testApp|';
function setup(t: TestContext) {
  const cleaners: Array<() => void | Promise<void>> = [];
  const cleanup = (fn: () => void | Promise<void>) => { cleaners.push(fn); };
  const root = mkdtempSync(join(tmpdir(), 'agent-feishu-')); t.after(async () => { for (const fn of cleaners) await fn(); rmSync(root, { recursive: true, force: true }); });
  const config = { platform: 'feishu', profile: 'feishu/test', scopePrefix: prefix, applicationId: 'cli_testApp', appSecret: 'do-not-print', token: '',
    allowedUserIds: [prefix + 'ou_owner'], externalAllowedUserIds: ['ou_owner'], proxyUrl: null, dataDir: root, attachmentsDir: join(root, 'images'), logsDir: root, workspace: root,
    maxImageBytes: 10 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024, defaultAgent: 'codex', commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } } as BridgeConfig;
  return { root, config, cleanup };
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const event = (id = 'om_z', override: Record<string, unknown> = {}) => ({ header: { app_id: 'cli_testApp' }, event: {
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } }, message: { message_id: id, create_time: '1700000000000', chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: '{"text":"/status"}', ...override } } });
test('Feishu accepts whitelisted P2P only and journals opaque identity before acknowledgement', async t => {
  const { root, config, cleanup } = setup(t), accepted: IncomingDM[] = [];
  const ingress = new DurableIngress(root, { allowedUserIds: config.allowedUserIds, handle: async message => { accepted.push(message); }, hasMessage: () => false });
  const bridge = new FeishuTransport(config, message => ingress.receive(message), { onReceive: message => { ingress.capture(message); } }); cleanup(async () => { await bridge.close(); await ingress.close(); });
  const outsider = event('om_bad'); outsider.event.sender.sender_id.open_id = 'ou_other'; await bridge.receiveEvent(outsider);
  await bridge.receiveEvent(event('om_group', { chat_type: 'group' })); assert.equal(ingress.knownChannels().length, 0);
  await bridge.receiveEvent(event()); await bridge.receiveEvent(event());
  const message = ingress.getMessage(prefix + '1700000000000|om_z')!; assert.equal(message.channelId, prefix + 'oc_chat'); assert.equal(message.userId, prefix + 'ou_owner'); assert.equal(message.text, '/status');
  assert.equal(accepted.length, 0); ingress.start(); await ingress.whenIdle(); assert.equal(accepted.length, 1);
});
test('Feishu token cache coalesces authentication and diagnostics never include credential bodies', async t => {
  const { config, cleanup } = setup(t); let auth = 0;
  const http = (async (url: any) => {
    if (String(url).includes('/auth/')) { auth++; return response({ code: 0, tenant_access_token: 'private-token', expire: 7200 }); }
    return response({ code: 0, data: { bot: { app_name: 'Bridge' } } });
  }) as any;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: http }); cleanup(() => bridge.close());
  assert.deepEqual(await Promise.all([bridge.verifyIdentity(), bridge.verifyIdentity()]), ['cli_testApp', 'cli_testApp']); assert.equal(auth, 1); assert.equal(bridge.botUser?.username, 'Bridge');
  const bad = new FeishuTransport(config, async () => {}, { fetch: (async () => response({ code: 999, msg: config.appSecret }, 403)) as any }); cleanup(() => bad.close());
  await assert.rejects(bad.verifyIdentity(), error => error instanceof Error && !error.message.includes(config.appSecret!) && /鉴权失败/.test(error.message));
});
test('Feishu UTF8 splitting preserves all characters; output files are serialized and failed sends are never retried', async t => {
  const { config, cleanup } = setup(t), paths: string[] = [], types: string[] = [];
  const text = '你好🌸'.repeat(5000); const chunks = splitUtf8(text, 24 * 1024); assert.equal(chunks.join(''), text); assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 24 * 1024));
  const http = (async (url: any, options: any) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.includes('/auth/')) return response({ code: 0, tenant_access_token: 'private-token' });
    if (path.endsWith('/images')) return response({ code: 0, data: { image_key: 'img_test' } });
    if (path.endsWith('/files')) return response({ code: 0, data: { file_key: 'file_test' } });
    if (options.body && typeof options.body === 'string') types.push(JSON.parse(options.body).msg_type);
    return response({ code: 0, data: {} });
  }) as any;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: http }); cleanup(() => bridge.close());
  await bridge.sendText('oc_chat', 'hello', { images: [{ filename: 'image.png', contentType: 'image/png', data: Buffer.from([137,80,78,71,13,10,26,10]) }],
    files: [{ filename: 'note.txt', contentType: 'text/plain', data: Buffer.from('file') }] });
  assert.deepEqual(types, ['text', 'image', 'file']);
  const before = paths.length; await assert.rejects(bridge.sendText('oc_chat', 'do not send', { files: [{ filename: 'empty', contentType: 'text/plain', data: Buffer.alloc(0) }] }), /为空/); assert.equal(paths.length, before);
  let sends = 0;
  const failed = new FeishuTransport(config, async () => {}, { fetch: (async (url: any) => String(url).includes('/auth/') ? response({ code: 0, tenant_access_token: 'token' }) : (sends++, response({ code: 999, msg: 'internal' }, 500))) as any }); cleanup(() => failed.close());
  await assert.rejects(failed.sendText('oc_chat', 'one'), /未自动重发/); assert.equal(sends, 1);
});
test('Feishu validates actual image bytes, rejects ordinary file input and removes partial downloads', async t => {
  const { config, cleanup } = setup(t); config.maxImageBytes = 10;
  const http = (async (url: any) => {
    if (String(url).includes('/auth/')) return response({ code: 0, tenant_access_token: 'token' });
    return new Response(String(url).includes('bad') ? new Uint8Array(32) : new Uint8Array([137,80,78,71,13,10,26,10]));
  }) as any;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: http }); cleanup(() => bridge.close());
  const message: IncomingDM = { id: prefix + '1700000000000|om_source', channelId: prefix + 'oc_chat', userId: prefix + 'ou_owner', text: '', attachments: [
    { id: 'img_good', filename: 'image', size: 0, url: '', content_type: 'image/unknown', resourceKey: 'img_good', messageId: 'om_source' },
    { id: 'img_bad', filename: 'image', size: 0, url: '', content_type: 'image/unknown', resourceKey: 'img_bad', messageId: 'om_source' }] };
  await assert.rejects(bridge.downloadImages(message), /超过/); assert.deepEqual(readdirSync(config.attachmentsDir), []);
  await assert.rejects(bridge.downloadImages({ ...message, attachments: [{ ...message.attachments[0]!, content_type: 'application/octet-stream' }] }), /普通文件输入尚未启用/);
});
test('Feishu SDK startup waits for core recovery and force-closes on shutdown', async t => {
  const { config, cleanup } = setup(t); let ready = 0, closed = false;
  const bridge = new FeishuTransport(config, async () => {}, { onReady: async () => { ready++; },
    socketFactory: parameters => ({ start: async () => { parameters.onReady?.(); }, close: () => { closed = true; } }) });
  await bridge.start(); assert.equal(ready, 1); await bridge.close(); assert.equal(closed, true);
});

test('飞书实际发送路径使用卡片展示命令和模型回复，生命周期只通知就绪时的当前用户', async t => {
  const { config, cleanup } = setup(t); const messages: any[] = [];
  const http = (async (url: any, options: any) => {
    if (String(url).includes('/auth/')) return response({ code: 0, tenant_access_token: 'token' });
    if (String(url).includes('/messages?')) messages.push(JSON.parse(options.body));
    return response({ code: 0, data: {} });
  }) as any;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: http }); cleanup(() => bridge.close());
  const header = '[Codex · 6.1-sol · 极高 · 1234]';
  await bridge.sendText('oc_chat', header + '\n\n**完成**\n```ts\nconst x = 1;\n```', { repeatHeader: header });
  assert.equal(messages[0].msg_type, 'interactive');
  const card = JSON.parse(messages[0].content); assert.equal(card.header.template, 'green');
  assert.equal(card.header.title.content, 'Codex · 6.1-sol · 极高 · 1234'); assert.match(card.body.elements[0].content, /```ts/);
  await bridge.onBridgeLifecycle({ phase: 'recovering', recipient: { userId: prefix + 'ou_owner', channelId: prefix + 'oc_chat' } });
  await bridge.onBridgeLifecycle({ phase: 'ready', recipient: { userId: prefix + 'ou_outside', channelId: prefix + 'oc_chat' } });
  await bridge.onBridgeLifecycle({ phase: 'ready' }); assert.equal(messages.length, 1);
  await bridge.onBridgeLifecycle({ phase: 'ready', reason: 'restart', recipient: { userId: prefix + 'ou_owner', channelId: prefix + 'oc_chat' } });
  assert.equal(messages.length, 2); assert.equal(messages[1].receive_id, 'oc_chat');
  const readyCard = JSON.parse(messages[1].content);
  assert.equal(readyCard.header.title.content, '已重启');
  assert.match(JSON.stringify(readyCard.body), /可以继续。/);
  assert(!/机器人：|Profile：|默认 Agent：|\/help|连接与恢复/.test(JSON.stringify(readyCard)), '启动通知只给必要状态');
  assert.equal(JSON.parse(messages[1].content).header.template, 'orange', '系统成功通知也使用黄框，模型回复保留绿框');
});
test('Feishu recovery spans equal timestamps across pages without losing lower opaque IDs or replaying duplicates', async t => {
  const { root, config, cleanup } = setup(t), handled: string[] = [];
  const make = (id: string): IncomingDM => ({ id: prefix + '1700000000000|' + id, userId: prefix + 'ou_owner', channelId: prefix + 'oc_chat', text: id, attachments: [] });
  const ingress = new DurableIngress(root, { allowedUserIds: config.allowedUserIds, handle: async message => { handled.push(message.id); }, hasMessage: () => false }); cleanup(() => ingress.close());
  ingress.seedChannel({ userId: prefix + 'ou_owner', channelId: prefix + 'oc_chat', cursor: make('om_z').id });
  await ingress.recover(async (_channel, options) => options.pageToken === 'next'
    ? { messages: [make('om_a')], oldestId: make('om_a').id, newestId: make('om_a').id, hasMore: false }
    : { messages: [make('om_z')], oldestId: make('om_z').id, newestId: make('om_z').id, hasMore: true, pageToken: 'next' });
  ingress.start(); await ingress.whenIdle(); assert.deepEqual(handled, [make('om_a').id, make('om_z').id]);
  await ingress.receive(make('om_a')); await ingress.whenIdle(); assert.equal(handled.length, 2);
});

test('飞书收件回执不阻塞收件，快速完成等待处理中表情，去重并只清理自己的表情', async t => {
  const { config, cleanup } = setup(t); config.features = { reactions: true };
  const requests: Array<{ method: string; emoji?: string; path: string }> = [];
  let finishTyping!: () => void, received = 0, capture = true;
  const gate = new Promise<void>(resolve => { finishTyping = resolve; });
  const http = (async (url: any, options: any) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/auth/')) return response({ code: 0, tenant_access_token: 'private-token' });
    const emoji = options.body ? JSON.parse(options.body).reaction_type?.emoji_type : undefined;
    requests.push({ method: options.method, emoji, path });
    if (emoji === 'Status_PrivateMessage') { await gate; return response({ code: 0, data: { reaction_id: 'own-typing' } }); }
    return response({ code: 0, data: { reaction_id: 'done' } });
  }) as any;
  const bridge = new FeishuTransport(config, async () => { received++; }, { fetch: http, onReceive: () => capture }); cleanup(() => bridge.close());
  await bridge.receiveEvent(event()); assert.equal(received, 1);
  const source = { id: prefix + '1700000000000|om_z', channelId: prefix + 'oc_chat' };
  const completed = bridge.markReplyDelivered([source, source]);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(requests.map(item => item.emoji), ['Status_PrivateMessage']);
  finishTyping(); await completed;
  assert.deepEqual(requests.map(item => [item.method, item.emoji]), [['POST', 'Status_PrivateMessage'], ['POST', 'CheckMark'], ['DELETE', undefined]]);
  assert(requests[2]!.path.endsWith('/own-typing'));
  const before = requests.length; await bridge.receiveEvent(event()); capture = false; await bridge.receiveEvent(event('om_replayed'));
  await bridge.markReplyDelivered([{ ...source, id: 'feishu:cli_other|1700000000000|om_other' }]);
  assert.equal(requests.length, before);
});

test('飞书重启后找回自己的处理中表情，送达失败时保留处理中，不影响消息处理', async t => {
  const { config, cleanup } = setup(t); config.features = { reactions: true };
  const deleted: string[] = [], logs: string[] = []; let failDone = false;
  const http = (async (url: any, options: any) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/auth/')) return response({ code: 0, tenant_access_token: 'private-token' });
    if (options.method === 'GET') return response({ code: 0, data: { items: [
      { reaction_id: 'ours', operator: { operator_type: 'app', operator_id: config.applicationId }, reaction_type: { emoji_type: 'Status_PrivateMessage' } },
      { reaction_id: 'user', operator: { operator_type: 'user', operator_id: 'ou_owner' }, reaction_type: { emoji_type: 'Status_PrivateMessage' } },
      { reaction_id: 'other-bot', operator: { operator_type: 'app', operator_id: 'cli_other' }, reaction_type: { emoji_type: 'Status_PrivateMessage' } },
    ] } });
    if (options.method === 'DELETE') deleted.push(path.split('/').at(-1)!);
    if (failDone && options.method === 'POST') return response({ code: 999, msg: 'private-token' }, 403);
    return response({ code: 0, data: {} });
  }) as any;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: http, logger: log => logs.push(log) }); cleanup(() => bridge.close());
  const source = { id: prefix + '1700000000000|om_old', channelId: prefix + 'oc_chat' };
  await bridge.markReplyDelivered([source]); assert.deepEqual(deleted, ['ours']);
  failDone = true; await bridge.markReplyDelivered([{ ...source, id: prefix + '1700000000000|om_failed' }]); assert.deepEqual(deleted, ['ours']);
  assert.deepEqual(logs, ['FEISHU_RECEIPT_FAILED']); assert(!JSON.stringify(logs).includes('private-token'));
});


test('飞书群入口显式启用后只收白名单真人，实体提及和回复链保留原始平台身份', async t => {
  const { config, cleanup } = setup(t); config.groupMode = true;
  const accepted: IncomingDM[] = [], captured: IncomingDM[] = [];
  const bridge = new FeishuTransport(config, async message => { accepted.push(message); }, { onReceive: message => { captured.push(message); } }); cleanup(() => bridge.close());
  const group = event('om_group', { chat_type: 'group', chat_id: 'oc_raw', content: JSON.stringify({ text: '@_user_1 /group start' }),
    mentions: [{ key: '@_user_1', name: '同名显示名', id: { open_id: 'ou_realBot' } }, { key: '@_user_2', id: { open_id: 'ou_realBot' } }, { key: '@_user_3', id: { user_id: 'unmapped' } }], parent_id: 'om_parent' });
  await bridge.receiveEvent(group); await bridge.receiveEvent(group);
  assert.equal(accepted.length, 1); assert.equal(captured.length, 1);
  assert.equal(accepted[0]!.text, '/group start');
  assert.equal(accepted[0]!.channelId, prefix + 'oc_raw');
  assert.deepEqual(accepted[0]!.space, { kind: 'group', spaceId: 'oc_raw', mentionedUserIds: ['ou_realBot'], replyToMessageId: 'om_parent' });
  const bot = event('om_bot', { chat_type: 'group' }); bot.event.sender.sender_type = 'app'; await bridge.receiveEvent(bot);
  const outsider = event('om_outsider', { chat_type: 'group' }); outsider.event.sender.sender_id.open_id = 'ou_outsider'; await bridge.receiveEvent(outsider);
  const foreign = event('om_foreign', { chat_type: 'group' }); foreign.header.app_id = 'cli_other'; await bridge.receiveEvent(foreign);
  assert.equal(accepted.length, 1);
  await bridge.receiveEvent(event('om_plain', { chat_type: 'group', content: '{"text":"@同名显示名 /new"}' }));
  assert.deepEqual(accepted[1]!.space?.mentionedUserIds, []); assert.equal(accepted[1]!.text, '@同名显示名 /new');
  await bridge.receiveEvent(event('om_p2p', { mentions: [{ key: '@_user_1', id: { open_id: 'ou_realBot' } }] }));
  assert.equal(accepted[2]!.space, undefined, '启用群功能不改变私聊事件归属');
});

test('飞书群信息须逐应用验证is_in_chat，名称和数量不代替在群证明', async t => {
  const { config, cleanup } = setup(t); const urls: string[] = []; let inside = false;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: (async (input: any) => {
    const url = String(input); urls.push(url);
    if (url.includes('/auth/')) return response({ code: 0, tenant_access_token: 'private-token' });
    if (url.endsWith('/bot/v3/info')) return response({ code: 0, data: { bot: { app_name: 'Bot', open_id: 'ou_bot' } } });
    return response({ code: 0, data: url.endsWith('/is_in_chat') ? { is_in_chat: inside } : { chat_mode: 'group', name: '相同群名', owner_id: 'ou_owner', owner_id_type: 'open_id', user_count: '1' } });
  }) as any }); cleanup(() => bridge.close());
  await bridge.verifyIdentity(); assert.equal(bridge.botUser?.id, 'ou_bot');
  assert.deepEqual(await bridge.getGroupInfo('oc_appSpecific'), { spaceId: 'oc_appSpecific', name: '相同群名', ownerId: 'ou_owner', memberCount: 1, botIsMember: false });
  inside = true; assert.equal((await bridge.getGroupInfo('oc_appSpecific')).botIsMember, true);
  assert(urls.some(url => url.endsWith('/members/is_in_chat')));
  await assert.rejects(bridge.getGroupInfo('../oc_other'), /无效/);
});

test('飞书群真人成员分页使用open_id，不能把不完整结果当完整或推导机器人集合', async t => {
  const { config, cleanup } = setup(t); const urls: string[] = []; let limited = false;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: (async (input: any) => {
    const url = new URL(String(input)); urls.push(url.toString());
    if (url.pathname.includes('/auth/')) return response({ code: 0, tenant_access_token: 'token' });
    assert.equal(url.searchParams.get('member_id_type'), 'open_id');
    return response({ code: 0, data: url.searchParams.get('page_token') === 'next&opaque'
      ? { items: [{ member_id_type: 'open_id', member_id: 'ou_owner', name: '可改名' }], has_more: false }
      : { items: [{ member_id_type: 'open_id', member_id: 'ou_other' }], has_more: true, page_token: 'next&opaque', trigger_security_conf_limit: limited } });
  }) as any }); cleanup(() => bridge.close());
  const first = await bridge.listGroupMembers('oc_chat', { limit: 1 });
  assert.deepEqual(first, { members: [{ id: 'ou_other', idType: 'open_id', isBot: false }], hasMore: true, pageToken: 'next&opaque', verification: 'verified', scope: 'humans' });
  assert.deepEqual(await bridge.getGroupMember('oc_chat', 'ou_owner'), { id: 'ou_owner', idType: 'open_id', isBot: false });
  assert.equal(await bridge.getGroupMember('oc_chat', 'ou_missing'), null);
  assert(urls.some(url => url.includes('page_token=next%26opaque')));
  limited = true; assert.equal((await bridge.listGroupMembers('oc_chat')).verification, 'unknown');
  await assert.rejects(bridge.getGroupMember('oc_chat', 'ou_missing'), /无法确认/);
});

test('飞书群查询拒绝权限错误、无在群字段和缺少后续游标，不泄漏原始响应', async t => {
  const { config, cleanup } = setup(t); let mode = 'permission';
  const bridge = new FeishuTransport(config, async () => {}, { fetch: (async (input: any) => {
    const url = String(input);
    if (url.includes('/auth/')) return response({ code: 0, tenant_access_token: 'token' });
    if (mode === 'permission') return response({ code: 99991672, msg: 'private-token' }, 403);
    if (url.endsWith('/is_in_chat')) return response({ code: 0, data: {} });
    if (url.includes('/members?')) return response({ code: 0, data: { items: [], has_more: true } });
    return response({ code: 0, data: { chat_mode: 'group', name: '同名群' } });
  }) as any }); cleanup(() => bridge.close());
  await assert.rejects(bridge.getGroupInfo('oc_chat'), error => error instanceof Error && /99991672/.test(error.message) && !/private-token/.test(error.message));
  mode = 'partial'; await assert.rejects(bridge.getGroupInfo('oc_chat'), /无法确认/);
  await assert.rejects(bridge.listGroupMembers('oc_chat'), /返回格式/);
});


test('飞书群历史恢复只返回负责人真人，保持原消息、实体提及、回复与群空间，分页边界包含Bot', async t => {
  const { config, cleanup } = setup(t); config.groupMode = true;
  config.externalAllowedUserIds = ['ou_owner', 'ou_other'];
  const queries: URL[] = [], paths: string[] = [];
  const item = (id: string, sender: Record<string, unknown>, changes: Record<string, unknown> = {}) => ({
    message_id: id, chat_id: 'oc_chat', create_time: '1700000000123', msg_type: 'text', sender,
    body: { content: '{"text":"@_user_1 /status"}' }, mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: '可改名' }], parent_id: 'om_parent', ...changes,
  });
  const bridge = new FeishuTransport(config, async () => {}, { fetch: (async (input: any) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname.includes('/auth/')) return response({ code: 0, tenant_access_token: 'token' });
    if (url.pathname.endsWith('/is_in_chat')) return response({ code: 0, data: { is_in_chat: true } });
    if (url.pathname.endsWith('/members')) return response({ code: 0, data: { items: [{ member_id: 'ou_owner', member_id_type: 'open_id' }], has_more: false } });
    if (url.pathname.endsWith('/messages')) {
      queries.push(url);
      return response({ code: 0, data: { has_more: true, page_token: 'next&opaque', items: [
        item('om_z', { id: 'cli_other', id_type: 'app_id', sender_type: 'app' }, { body: { content: 'invalid JSON ignored' } }),
        item('om_y', { id: 'ou_other', id_type: 'open_id', sender_type: 'user' }, { body: { content: 'invalid JSON ignored' } }),
        item('om_x', { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }),
        item('om_x', { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }),
        item('om_a', { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }, { deleted: true }),
      ] } });
    }
    return response({ code: 0, data: { chat_mode: 'group' } });
  }) as any }); cleanup(() => bridge.close());
  await assert.rejects(bridge.readGroupHistory('oc_chat'), /明确/);
  const page = await bridge.readGroupHistory('oc_chat', { ownerUserId: 'ou_owner', since: prefix + '1700000000123|om_old', pageToken: 'previous&opaque', limit: 100 });
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0]!.id, prefix + '1700000000123|om_x');
  assert.deepEqual(page.messages[0]!.space, { kind: 'group', spaceId: 'oc_chat', mentionedUserIds: ['ou_bot'], replyToMessageId: 'om_parent' });
  assert.equal(page.messages[0]!.text, '/status'); assert.equal(page.messages[0]!.userId, prefix + 'ou_owner');
  assert.equal(page.oldestId, prefix + '1700000000123|om_a'); assert.equal(page.newestId, prefix + '1700000000123|om_z');
  assert.equal(page.pageToken, 'next&opaque'); assert.equal(page.hasMore, true);
  assert.equal(queries[0]!.searchParams.get('start_time'), '1699999999');
  assert.equal(queries[0]!.searchParams.get('page_token'), 'previous&opaque');
  assert.equal(queries[0]!.searchParams.get('page_size'), '50');
  assert(paths.every(path => !/resources|reactions/.test(path)), '恢复只取元数据，不下载非负责人附件、不做收件反馈');
});

test('飞书群历史成员撤销、群地址错配和分页损坏均拒绝，默认关闭时不发请求', async t => {
  const { config, cleanup } = setup(t); let calls = 0, mode = 'outside';
  const bridge = new FeishuTransport(config, async () => {}, { fetch: (async (input: any) => {
    calls++; const url = new URL(String(input));
    if (url.pathname.includes('/auth/')) return response({ code: 0, tenant_access_token: 'token' });
    if (url.pathname.endsWith('/is_in_chat')) return response({ code: 0, data: { is_in_chat: mode !== 'outside' } });
    if (url.pathname.endsWith('/members')) return response({ code: 0, data: { items: mode === 'owner-removed' ? [] : [{ member_id: 'ou_owner', member_id_type: 'open_id' }], has_more: false } });
    if (url.pathname.endsWith('/messages')) return response({ code: 0, data: mode === 'bad-page' ? { items: [], has_more: true } : { items: [{ message_id: 'om_wrong', create_time: '1700000000000', chat_id: 'oc_other' }], has_more: false } });
    return response({ code: 0, data: { chat_mode: 'group' } });
  }) as any }); cleanup(() => bridge.close());
  await assert.rejects(bridge.readGroupHistory('oc_chat'), /未启用/); assert.equal(calls, 0);
  config.groupMode = true; await assert.rejects(bridge.readGroupHistory('oc_chat'), /失效/);
  mode = 'owner-removed'; await assert.rejects(bridge.readGroupHistory('oc_chat'), /失效/);
  mode = 'wrong-space'; await assert.rejects(bridge.readGroupHistory('oc_chat'), /其他群/);
  mode = 'bad-page'; await assert.rejects(bridge.readGroupHistory('oc_chat'), /分页格式/);
  const before = calls;
  await assert.rejects(bridge.readGroupHistory('oc_chat', { since: 'feishu:cli_other|1700000000000|om_wrong' }), /不属于/);
  await assert.rejects(bridge.readGroupHistory('oc_chat', { ownerUserId: 'ou_other' }), /已授权/);
  assert.equal(calls, before);
});
