import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BridgeLifecycle, type BridgeLifecycleEvent } from '../src/lifecycle.js';
import { COMMANDS, commandHelp } from '../src/commands.js';
import { SLASH_COMMANDS } from '../src/slash.js';
import { computerOverview, workerOverview } from '../src/overview.js';
import { discordPresentationPages, feishuPresentationCards, markdownParts } from '../src/presentation.js';
import { DurableIngress } from '../src/ingress.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { FeishuTransport } from '../src/feishu.js';
import type { BridgeConfig, ReplyOptions, AgentAdapter } from '../src/types.js';

test('normal Feishu startup and restart do not send chat notifications', async () => {
  const sends: unknown[] = [];
  const transport = { config: { allowedUserIds: ['owner'], scopePrefix: 'feishu:test|' },
    sendText: async (...args: unknown[]) => { sends.push(args); } } as unknown as FeishuTransport;
  for (const reason of ['start', 'restart'] as const) {
    await FeishuTransport.prototype.onBridgeLifecycle.call(transport, { phase: 'ready', reason,
      recipient: { userId: 'owner', channelId: 'feishu:test|private' } });
  }
  assert.deepEqual(sends, []);
});

const prefix = 'feishu:cli_personal|';
const configFor = (root: string, scope = prefix): BridgeConfig => ({ platform: 'feishu', profile: 'feishu/default', applicationId: 'cli_personal',
  scopePrefix: scope, token: '', allowedUserIds: [scope + 'ou_owner'], defaultAgent: 'codex', workspace: root, dataDir: root,
  attachmentsDir: root, logsDir: root, maxImageBytes: 100, proxyUrl: null, controllerMode: true,
  commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } });

test('命令菜单和帮助来自同一注册表，两平台没有各自的业务清单', () => {
  assert.deepEqual(SLASH_COMMANDS.map(item => item.name), COMMANDS.filter(item => item.contexts?.includes('dm') ?? !item.contexts).map(item => item.name));
  for (const command of COMMANDS.filter(item => item.contexts?.includes('dm') ?? !item.contexts)) assert(commandHelp().includes('/' + command.name));
  assert(!commandHelp().includes('/group '));
  assert.match(commandHelp(true), /停止桥管理的执行子 Agent/);
  assert(!COMMANDS.some(command => ['platform', 'bot', 'startup'].includes(command.name)));
});
test('结构化总览无平台颜色代码，渲染器保持 Discord 样式并生成飞书卡片', () => {
  const view = workerOverview([{ workerId: '123456789', conversationId: 'parent', targetId: 'local', targetLabel: '桥电脑', agent: 'codex',
    title: '<at id=all>任务</at>', model: 'gpt-6.1-sol', effort: 'xhigh', nativeId: 'native-id', status: 'running', running: true, queued: 0, startedAt: null }], 'current');
  assert(!JSON.stringify(view).includes('ansi')); assert(!JSON.stringify(view).includes('\\u001b'));
  assert(discordPresentationPages(view)[0]!.startsWith('```ansi\n\u001b[33m'));
  const cards = feishuPresentationCards(view); const encoded = JSON.stringify(cards);
  assert.equal((cards[0]!.header as any).template, 'orange');
  assert(!encoded.includes('ansi'));
  assert((cards[0]!.body as any).elements.some((element: any) => element.tag === 'div' && element.text.tag === 'plain_text'));
  assert(!encoded.includes('原生会话 ID'));
  assert.match(JSON.stringify(feishuPresentationCards(workerOverview([], 'current'))), /没有正在执行、排队或待核对/); assert.equal(cards[0]!.schema, '2.0');
  assert.equal(feishuPresentationCards(computerOverview([])).length, 1);
});
test('长中文和代码回复按实际 JSON 大小分页，标题每页重复且代码围栏闭合', () => {
  const body = '说明😀\n```typescript\n' + 'const 值 = "你好😀";\n'.repeat(1800) + '```\n结束';
  const cards = feishuPresentationCards({ title: 'Codex · 6.1-sol · 极高 · 1234', tone: 'success', blocks: [{ kind: 'text', text: body }] });
  assert(cards.length > 1);
  for (const card of cards) {
    assert(Buffer.byteLength(JSON.stringify(card)) < 24 * 1024);
    assert.match((card.header as any).title.content, /^Codex/);
    for (const element of (card.body as any).elements) if (element.tag === 'markdown') {
      assert.equal((element.content.match(/^```/gm) ?? []).length % 2, 0);
      assert(!/[\uD800-\uDBFF]$/.test(element.content));
    }
  }
  assert.equal(markdownParts('中文😀'.repeat(7000)).join(''), '中文😀'.repeat(7000));
});
test('启动通知只触发一次，失败记为不确定；不同 bot 互不继承重启状态', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-lifecycle-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const events: BridgeLifecycleEvent[] = []; let failures = 0;
  const config = configFor(root);
  const first = new BridgeLifecycle(config, async event => { events.push(event); throw new Error('uncertain'); },
    () => ({ userId: prefix + 'ou_owner', channelId: prefix + 'oc_chat' }), () => { failures++; });
  await Promise.all([first.ready(), first.ready()]); await first.close();
  assert.equal(events.length, 1); assert.equal(failures, 1); assert.equal(events[0]!.reason, 'start');
  const db = new DatabaseSync(join(root, 'lifecycle.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT delivery FROM lifecycle_events').get()!.delivery, 'uncertain'); db.close();
  const next = new BridgeLifecycle(config, async event => { events.push(event); },
    () => ({ userId: 'discord:another|ou_owner', channelId: 'discord:another|oc_chat' }), () => {});
  await next.ready(); await next.close(); assert.equal(events[1]!.reason, 'restart'); assert.equal(events[1]!.recipient, undefined);
  const other = new BridgeLifecycle(configFor(root, 'feishu:cli_other|'), async event => { events.push(event); }, () => undefined, () => {});
  await other.ready(); await other.close(); assert.equal(events[2]!.reason, 'start');
});
test('生命周期关闭等待投递完成，空联系人正常就绪', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-lifecycle-close-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let release!: () => void; const send = new Promise<void>(resolve => { release = resolve; });
  const bridge = new BridgeLifecycle(configFor(root), async event => { assert.equal(event.recipient, undefined); await send; }, () => undefined, error => assert.fail(String(error)));
  const ready = bridge.ready(); let closed = false; const close = bridge.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); release(); await Promise.all([ready, close]);
});
test('最后联系人查询限当前白名单，状态查询信息完整且不创建任何会话或模型调用', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-status-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configFor(root); const replies: Array<{ text: string; options?: ReplyOptions }> = [];
  const adapter: AgentAdapter = { run: async () => { assert.fail('状态不得启动模型'); }, interrupt: async () => {}, close: async () => {} };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { sendText: async (_channel, text, options) => { replies.push({ text, options }); } },
    { botName: () => '黄永熙 BridgeBot' });
  const ingress = new DurableIngress(root, { allowedUserIds: config.allowedUserIds, hasMessage: () => false, handle: async () => {} });
  const incoming = { id: prefix + '1700000000000|om_status', userId: prefix + 'ou_owner', channelId: prefix + 'oc_owner', text: '/status', attachments: [] };
  ingress.capture(incoming); ingress.capture({ ...incoming, id: 'feishu:cli_other|1700000000001|om_other', userId: 'feishu:cli_other|ou_owner', channelId: 'feishu:cli_other|oc_other' });
  assert.deepEqual(ingress.lastAuthorizedContact(), { userId: incoming.userId, channelId: incoming.channelId });
  await manager.handle({ ...incoming, imagePaths: [] });
  const inspect = new SessionStore(root); assert.equal(inspect.listConversations(incoming.userId).length, 0); inspect.close();
  assert.match(replies[0]!.text, /黄永熙 BridgeBot/); assert.match(replies[0]!.text, /feishu\/default/);
  assert.match(replies[0]!.text, /尚未由 CLI 回报/); assert.match(replies[0]!.text, /排队 0 条/); assert.equal(replies[0]!.options!.presentation!.title, '桥状态');
  await ingress.close(); await manager.close();
});
