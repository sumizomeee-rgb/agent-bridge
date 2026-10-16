import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { replyHeader } from '../src/reply.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, ReplyOptions } from '../src/types.js';

interface PlannedReply { nativeId?: string; initialNativeId?: string; model?: string; effort?: string | null; error?: Error }
class MetadataAdapter implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  readonly plans: PlannedReply[] = [];
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    const plan = this.plans.shift() ?? {};
    const nativeId = plan.nativeId ?? turn.conversation.nativeId ?? `native-${turn.conversation.id}`;
    turn.onNativeId?.(plan.initialNativeId ?? nativeId);
    if (plan.model) turn.onModel?.(plan.model);
    if ('effort' in plan) turn.onReasoningEffort?.(plan.effort ?? null);
    turn.onProgress('never deliver this delta');
    if (plan.error) throw plan.error;
    return { nativeId, text: turn.text };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('测试等待超时'); await delay(5); }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-reply-header-'));
  const config: BridgeConfig = {
    token: '', allowedUserIds: ['owner', 'other'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 100,
    defaultModels: { codex: 'reference-only-model' },
  };
  const codex = new MetadataAdapter(), claude = new MetadataAdapter();
  const replies: Array<{ channelId: string; text: string; options?: ReplyOptions }> = [];
  let fail = false, sequence = 0;
  const sink = { async sendText(channelId: string, text: string, options?: ReplyOptions) {
    if (fail) { fail = false; throw new Error('delivery failed after partial output'); }
    replies.push({ channelId, text, options });
  } };
  const f = { root, config, codex, claude, sink, replies, manager: new SessionManager(config, { codex, claude }, sink) };
  t.after(async () => { await f.manager.close(); rmSync(root, { recursive: true, force: true }); });
  const send = (text: string, userId = 'owner', channelId = `${userId}-dm`) => f.manager.handle({
    id: `message-${sequence++}`, userId, channelId, text, imagePaths: [],
  });
  const respond = async (text: string, userId = 'owner', channelId = `${userId}-dm`) => {
    const prior = replies.length;
    await send(text, userId, channelId);
    await until(() => replies.length > prior);
    return replies.at(-1)!;
  };
  const inspect = <T>(read: (store: SessionStore) => T): T => {
    const store = new SessionStore(config.dataDir);
    try { return read(store); } finally { store.close(); }
  };
  return { f, send, respond, inspect, failNextDelivery() { fail = true; } };
}

test('回复头来自本轮实际 metadata 和最终 nativeId，不使用选择、默认或模型自拟标签', async t => {
  const { f, send, respond, inspect } = fixture(t);
  await send('/model custom selected-alias');
  f.codex.plans.push({ initialNativeId: 'early-123456', nativeId: 'actual-abcdef', model: 'provider-model', effort: 'high' });
  const reply = await respond('[Claude · invented-model]\n模型自己写的正文');
  assert.equal(reply.options?.repeatHeader, '[Codex · provider-model · 高 · cdef]');
  assert.equal(reply.text, '[Codex · provider-model · 高 · cdef]\n\n[Claude · invented-model]\n模型自己写的正文');
  assert.equal(f.codex.turns[0]!.conversation.model, 'selected-alias');
  const active = inspect(store => store.getActive('owner')!);
  assert.equal(active.nativeId, 'actual-abcdef');
  assert.equal(active.actualModel, 'provider-model');
  assert.equal(active.actualEffort, 'high');
  await send('/status');
  assert.match(f.replies.at(-1)!.text, /推理强度：high/);
  assert.match(f.replies.at(-1)!.text, /原生会话：actual-abcdef/);
});

test('本轮未回报 metadata 时不把旧实际值、参考默认或已选别名冒充实际值', async t => {
  const { f, send, respond } = fixture(t);
  f.codex.plans.push({ model: 'prior-model', effort: 'high' });
  await respond('first');
  await send('/model custom selected-alias');
  const reply = await respond('unconfirmed');
  assert.match(reply.text, /^\[Codex · 模型未知 · 强度未知 · [^\n]+\]\n\nunconfirmed$/);
  assert(!reply.text.includes('prior-model') && !reply.text.includes('selected-alias') && !reply.text.includes('reference-only-model'));
});

test('回复头不含连续绿勾，命令不改变投递记录，同尾号原生会话仍记录完整 ID', async t => {
  const { f, send, respond, inspect } = fixture(t);
  f.codex.plans.push({ nativeId: 'first-abcdef' });
  const first = await respond('first');
  assert.equal(first.options?.repeatHeader, '[Codex · 模型未知 · 强度未知 · cdef]');
  const prior = inspect(store => store.getLastDelivery('owner', 'owner-dm'));
  assert.equal(prior?.nativeId, 'first-abcdef');
  await send('/help');
  assert.deepEqual(inspect(store => store.getLastDelivery('owner', 'owner-dm')), prior);
  assert.equal((await respond('second')).options?.repeatHeader, first.options?.repeatHeader);
  f.codex.plans.push({ nativeId: 'different-abcdef' });
  assert.equal((await respond('changed')).options?.repeatHeader, first.options?.repeatHeader);
  assert.equal(inspect(store => store.getLastDelivery('owner', 'owner-dm'))?.nativeId, 'different-abcdef');
  assert(!((await respond('continued')).text.includes('✅')));
});

test('/new 后不显示连续标记，同一个原生 ID 仍绑定新桥会话', async t => {
  const { f, send, respond, inspect } = fixture(t);
  f.codex.plans.push({ nativeId: 'same-native-abcdef' });
  await respond('old');
  const prior = inspect(store => store.getLastDelivery('owner', 'owner-dm'))!;
  await send('/new');
  f.codex.plans.push({ nativeId: 'same-native-abcdef' });
  assert(!((await respond('new')).text.includes('✅')));
  const current = inspect(store => store.getLastDelivery('owner', 'owner-dm'))!;
  assert.equal(current.nativeId, prior.nativeId);
  assert.notEqual(current.conversationId, prior.conversationId);
  assert(!((await respond('continue new')).text.includes('✅')));
  assert.deepEqual(inspect(store => store.getLastDelivery('owner', 'owner-dm')), current);
});

test('上一条成功投递身份持久化，桥重启后仍保存身份且不显示连续绿勾', async t => {
  const { f, respond, inspect } = fixture(t);
  await respond('before');
  const prior = inspect(store => store.getLastDelivery('owner', 'owner-dm'));
  assert(prior);
  await f.manager.close();
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, f.sink);
  await f.manager.recover();
  assert(!((await respond('after')).text.includes('✅')));
  assert.deepEqual(inspect(store => store.getLastDelivery('owner', 'owner-dm')), prior);
});

test('第一次回复投递失败或只投递部分时不建立连续记录，模型不重跑', async t => {
  const { f, respond, inspect, failNextDelivery } = fixture(t);
  failNextDelivery();
  assert.match((await respond('failed delivery')).text, /^执行或回复失败：/);
  assert.equal(inspect(store => store.getLastDelivery('owner', 'owner-dm')), null);
  assert(!((await respond('first successful')).text.includes('✅')));
  assert.equal(f.codex.turns.length, 2);
  assert(!((await respond('next successful')).text.includes('✅')));
});

test('失败的原生会话变化不覆盖上一条成功投递身份，Agent 失败也不更新', async t => {
  const { f, respond, inspect, failNextDelivery } = fixture(t);
  f.codex.plans.push({ nativeId: 'delivered-abcdef' });
  await respond('delivered');
  f.codex.plans.push({ nativeId: 'failed-123456' });
  failNextDelivery(); await respond('not delivered');
  f.codex.plans.push({ nativeId: 'agent-failed-777777', error: new Error('agent failure') });
  assert.match((await respond('agent failed')).text, /^执行或回复失败：/);
  assert.equal(inspect(store => store.getLastDelivery('owner', 'owner-dm'))!.nativeId, 'delivered-abcdef');
  f.codex.plans.push({ nativeId: 'delivered-abcdef' });
  assert(!((await respond('back to delivered')).text.includes('✅')));
});

test('用户和私聊的投递历史独立，另一个 channel 的回复不会替换原私聊记录', async t => {
  const { respond, inspect } = fixture(t);
  await respond('owner first');
  assert(!((await respond('other first', 'other')).text.includes('✅')));
  assert(!((await respond('another channel first', 'owner', 'second-dm')).text.includes('✅')));
  assert(!((await respond('owner continue')).text.includes('✅')));
  assert(inspect(store => store.getLastDelivery('other', 'other-dm')));
  assert(inspect(store => store.getLastDelivery('owner', 'second-dm')));
});

test('/agent 菜单和同后端选择不重置，来回切换向前交接并保留后端模型选择', async t => {
  const { f, send, respond, inspect } = fixture(t);
  await send('/agent');
  assert.match(f.replies.at(-1)!.text, /Codex CLI/);
  assert.match(f.replies.at(-1)!.text, /Claude Code/);
  assert.equal(inspect(store => store.getActive('owner')), null);
  await respond('codex context');
  await send('/model custom chosen-codex-model');
  const codex = inspect(store => store.getActive('owner')!);
  await send('/agent codex');
  assert.equal(inspect(store => store.getActive('owner'))!.id, codex.id);
  assert(!((await respond('same agent')).text.includes('✅')));
  await send('/agent claude');
  assert.match(f.replies.at(-1)!.text, /已切换到 Claude Code/);
  const claudeReply = await respond('claude context');
  assert.match(claudeReply.text, /^\[Claude · 模型未知 · 强度未知/);
  assert(!claudeReply.text.includes('✅'));
  const claude = inspect(store => store.getActive('owner')!);
  await send('/agent codex');
  assert.match(f.replies.at(-1)!.text, /最新上下文/);
  assert.notEqual(inspect(store => store.getActive('owner'))!.id, codex.id);
  assert.match(inspect(store => store.getActive('owner'))!.contextSeed!, /claude context/);
  assert.equal(inspect(store => store.getActive('owner'))!.model, 'chosen-codex-model');
  assert(!((await respond('back to codex')).text.includes('✅')));
  assert.equal(f.codex.turns.at(-1)!.conversation.nativeId, null);
  await send('/agent claude');
  assert.notEqual(inspect(store => store.getActive('owner'))!.id, claude.id);
});

test('/agent 不从历史列表猜目标后端分支，即使同用户和目录存在旧会话', async t => {
  const { f, send, inspect } = fixture(t);
  const otherCwd = join(f.root, 'other-cwd'); mkdirSync(otherCwd);
  const expected = inspect(store => {
    const codex = store.createConversation('owner', 'codex', f.root); store.setActive('owner', codex.id);
    const target = store.createConversation('owner', 'claude', f.root); store.saveNativeId(target.id, 'saved-native-abcdef');
    for (let i = 0; i < 25; i++) store.createConversation('owner', 'codex', f.root);
    store.createConversation('other', 'claude', f.root);
    store.createConversation('owner', 'claude', otherCwd);
    return target;
  });
  await send('/agent claude');
  assert.notEqual(inspect(store => store.getActive('owner'))!.id, expected.id);
  assert.equal(inspect(store => store.getActive('owner'))!.nativeId, null);
  assert.match(f.replies.at(-1)!.text, /原生会话：下轮创建/);
  assert.equal(f.claude.turns.length, 0);
});

test('头部不拼连续绿勾，metadata 不允许换行刷消息', () => {
  const previous = { conversationId: 'same', agent: 'codex' as const, nativeId: 'native-abcdef' };
  const identity = { ...previous, agent: 'claude' as const };
  const header = replyHeader(identity, previous, 'model\n@everyone', 'high\r\n');
  assert.equal(header, '[Claude · model ＠everyone · 高 · cdef]');
  assert(!header.includes('\n') && !header.includes('✅'));
});
