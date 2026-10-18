import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextImmediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentName, AgentResult, AgentTurn, BridgeConfig, BridgeMessage, ReplyOptions } from '../src/types.js';

const USER = 'owner', CHANNEL = 'private-owner';
type InputUpdate = Awaited<ReturnType<NonNullable<AgentTurn['onPrivateInputCheck']>>>;
type Run = (turn: AgentTurn) => Promise<AgentResult>;
const checkPrivate = (turn: AgentTurn) => turn.onPrivateInputCheck!({ name: 'bridge_start_worker', args: { title: 'Inspect', prompt: 'Read' }, callId: 'private-check' });
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function eventual(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 6000; i++) { if (check()) return; await nextImmediate(); }
  assert.fail('No progress: ' + label);
}
async function fixture(t: TestContext, platform: 'feishu' | 'discord' = 'feishu', agent: AgentName = 'codex') {
  const path = await mkdtemp(join(tmpdir(), 'bridge-private-input-manager-test-'));
  const config: BridgeConfig = { token: '', allowedUserIds: [USER], ownerUserId: USER, defaultAgent: agent, platform,
    workspace: path, dataDir: join(path, 'data'), attachmentsDir: join(path, 'images'), logsDir: join(path, 'logs'),
    proxyUrl: null, maxImageBytes: 1024, maxFileBytes: 4096, controllerMode: true,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } };
  const inspect = new SessionStore(config.dataDir), conversation = inspect.createConversation(USER, agent, path, { controllerMode: true });
  const native = (turn: AgentTurn) => turn.conversation.nativeId ?? 'native-' + turn.conversation.agent + '-' + turn.conversation.id;
  inspect.saveNativeId(conversation.id, 'native-' + agent); inspect.setActive(USER, conversation.id);
  const calls: AgentTurn[] = [], replies: Array<{ channel: string; text: string; options?: ReplyOptions }> = [],
    attempts: Array<{ channel: string; text: string; options?: ReplyOptions }> = [], marks: string[] = [], waits: ReturnType<typeof gate>[] = [];
  let steering = 0, sendHook: ((channel: string, text: string, options?: ReplyOptions) => Promise<void>) | undefined;
  const done = (turn: AgentTurn): AgentResult => ({ nativeId: native(turn), text: 'DONE', controlledOutput: true });
  const final = async (turn: AgentTurn, text = 'FINAL ' + turn.text): Promise<AgentResult> => {
    if (turn.groupContext) await turn.onSilent!();
    else await turn.onPublicMessage!(text, [], 'final-' + turn.source!.messageId);
    return done(turn);
  };
  let run: Run = final;
  const adapter: AgentAdapter = {
    async run(turn) {
      calls.push(turn); turn.onNativeId?.(native(turn)); turn.onReady?.();
      return new Promise<AgentResult>((resolveResult, reject) => {
        const abort = () => reject(Object.assign(new Error('fake native turn stopped'), { name: 'AbortError' }));
        turn.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => run(turn)).then(resolveResult, reject)
          .finally(() => turn.signal.removeEventListener('abort', abort)).catch(() => undefined);
      });
    },
    async steer() { steering++; return { status: 'accepted' }; }, async interrupt() {}, async close() {},
  };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, {
    async sendText(channel, text, options) {
      attempts.push({ channel, text, options }); await sendHook?.(channel, text, options); replies.push({ channel, text, options });
    }, async markReplyDelivered(messages) { marks.push(...messages.map(value => value.id)); },
  }, { mergeDelayMs: 0,
    async onControllerPublish(_context, _text, _paths, targetId, _messageKey, deliver) {
      if (targetId === undefined || targetId === 'private') await deliver();
      else if (targetId === 'public-group') await deliver('public-group-channel');
      else throw new Error('Unknown test destination');
    },
  });
  const message = (id: string, text = id, extra: Partial<BridgeMessage> = {}): BridgeMessage => ({ id, text, userId: USER, channelId: CHANNEL, imagePaths: [],
    source: { messageId: id, userId: USER, channelId: CHANNEL, authorType: 'user' }, ...extra });
  const send = (id: string, text = id, extra: Partial<BridgeMessage> = {}) => manager.handle(message(id, text, extra));
  t.after(async () => { for (const wait of waits) wait.release(); await manager.close(); inspect.close(); await rm(path, { recursive: true, force: true }); });
  return { path, config, manager, inspect, conversation, calls, replies, attempts, marks, message, send, done, final,
    run: (next: Run) => { run = next; }, steering: () => steering, onSend: (next: typeof sendHook) => { sendHook = next; },
    gate: () => { const wait = gate(); waits.push(wait); return wait; } };
}

for (const platform of ['feishu', 'discord'] as const) for (const agent of ['codex', 'claude'] as const) {
  test(`${platform}/${agent}: one fresh-input check takes B/C as real owner input and one FINAL covers A/B/C; D waits for the next turn`, async t => {
    const f = await fixture(t, platform, agent), check = f.gate(), finish = f.gate(); let update: InputUpdate | undefined;
    f.run(async turn => {
      if (turn.text !== 'A') return f.final(turn);
      await check.promise; update = await checkPrivate(turn); await finish.promise; return f.final(turn, 'FINAL A B C');
    });
    await f.send('a', 'A'); await eventual(() => f.calls.length === 1, 'A running');
    const image = join(f.path, 'incoming.png'); await writeFile(image, 'test input path');
    const source = { messageId: 'platform-b', userId: USER, channelId: CHANNEL, authorType: 'user' as const };
    await f.send('b', 'B', { source, imagePaths: [image] }); await f.send('c', 'C');
    assert.equal(f.inspect.getMessage('b')!.state, 'queued'); assert.equal(f.inspect.getMessage('c')!.state, 'queued');
    check.release(); await eventual(() => update !== undefined, 'B/C claimed');
    assert.equal(update!.refreshRequired, true); assert.deepEqual(update!.input!.messages.map(value => value.id), ['b', 'c']);
    assert.deepEqual(update!.input!.messages[0]!.source, source); assert.deepEqual(update!.input!.messages[0]!.imagePaths, [image]);
    assert.equal('canAuthorize' in update!.input!.messages[0]!, false); assert(update!.input!.version > 0);
    assert.equal(f.inspect.getMessage('b')!.state, 'running'); assert.equal(f.inspect.getMessage('c')!.state, 'running');
    await f.send('d', 'D'); assert.equal((await checkPrivate(f.calls[0]!)).refreshRequired, false);
    assert.equal(f.inspect.getMessage('d')!.state, 'queued'); finish.release();
    await eventual(() => f.inspect.getMessage('d')!.replyState === 'delivered' && f.manager.isIdle(), 'all replies finished');
    assert.deepEqual(f.calls.map(value => value.text), ['A', 'D']); assert.equal(f.steering(), 0);
    for (const id of ['a', 'b', 'c', 'd']) assert.equal(f.inspect.getMessage(id)!.replyState, 'delivered');
    assert.equal(f.replies.filter(value => value.text.includes('FINAL A B C')).length, 1);
    assert.equal(f.replies.length, 2); assert.deepEqual(f.marks, []);
    assert.deepEqual(f.inspect.privateBatch('a')!.messages.map(value => value.id), ['a', 'b', 'c']);
  });
}

test('new input arriving while FINAL is being transported stays queued and cannot be swallowed by a late check', async t => {
  const f = await fixture(t), transport = f.gate(); let started = false;
  f.onSend(async (_channel, text) => { if (text.includes('FINAL A')) { started = true; await transport.promise; } });
  await f.send('a', 'A'); await eventual(() => started, 'A final transport started');
  await f.send('b', 'B'); assert.equal((await checkPrivate(f.calls[0]!)).refreshRequired, false);
  assert.equal(f.inspect.getMessage('b')!.state, 'queued'); assert.deepEqual(f.inspect.privateBatch('a')!.messages.map(value => value.id), ['a']);
  transport.release(); await eventual(() => f.inspect.getMessage('b')!.replyState === 'delivered' && f.manager.isIdle(), 'B answered separately');
  assert.deepEqual(f.calls.map(value => value.text), ['A', 'B']); assert.equal(f.replies.length, 2);
});

for (const mode of ['controlled-DONE', 'private-progress', 'group-progress'] as const) test(`${mode} does not falsely complete the original private reply obligations`, async t => {
  const f = await fixture(t), check = f.gate(); let claimed = false;
  f.run(async turn => {
    await check.promise; claimed = (await checkPrivate(turn)).refreshRequired;
    if (mode !== 'controlled-DONE') await turn.onPublicMessage!('Progress only', [], 'progress', mode === 'group-progress' ? 'public-group' : undefined, false);
    return f.done(turn);
  });
  await f.send('a', 'A'); await eventual(() => f.calls.length === 1, 'A running'); await f.send('b', 'B'); check.release();
  await eventual(() => f.manager.isIdle(), 'private turn finished with unmet reply obligations');
  assert.equal(claimed, true); assert.equal(f.calls.length, 1);
  for (const id of ['a', 'b']) assert.equal(f.inspect.getMessage(id)!.replyState, 'failed');
  assert(f.replies.some(value => value.text.includes('最终回复'))); assert.deepEqual(f.marks, []);
  if (mode === 'group-progress') assert(f.replies.some(value => value.channel === 'public-group-channel'));
});

test('a private final cannot be redirected exclusively to a public group', async t => {
  const f = await fixture(t);
  f.run(async turn => { await turn.onPublicMessage!('Wrong final area', [], 'wrong-final', 'public-group', true); return f.done(turn); });
  await f.send('a', 'A'); await eventual(() => f.manager.isIdle(), 'wrong final area rejected');
  assert.equal(f.inspect.getMessage('a')!.replyState, 'failed');
  assert.equal(f.replies.some(value => value.channel === 'public-group-channel'), false);
});

test('attachment delivery failure fails every claimed private reply without rerunning B or repeating the model turn', async t => {
  const f = await fixture(t), check = f.gate(), report = join(f.path, 'report.txt'); await writeFile(report, 'Result');
  f.onSend(async (_channel, _text, options) => { if (options?.files?.length) throw new Error('attachment transport failed'); });
  f.run(async turn => { await check.promise; await checkPrivate(turn); await turn.onPublicMessage!('FINAL report', [report], 'attachment-final'); return f.done(turn); });
  await f.send('a', 'A'); await eventual(() => f.calls.length === 1, 'A running'); await f.send('b', 'B'); check.release();
  await eventual(() => f.manager.isIdle(), 'failed delivery settled');
  for (const id of ['a', 'b']) assert.equal(f.inspect.getMessage(id)!.replyState, 'failed');
  assert.equal(f.calls.length, 1); assert.equal(f.attempts.filter(value => value.options?.files?.length).length, 1);
  assert.deepEqual(f.marks, []);
});

for (const boundary of ['channel', 'group', 'control', 'host-group-arrival'] as const) test(`${boundary} boundary prevents a private turn absorbing later same-chat input`, async t => {
  const f = await fixture(t), check = f.gate(); let refreshed: boolean | undefined;
  f.run(async turn => {
    if (turn.text !== 'A') return f.final(turn);
    await check.promise; refreshed = (await checkPrivate(turn)).refreshRequired; return f.final(turn);
  });
  await f.send('a', 'A'); await eventual(() => f.calls.length === 1, 'A running');
  if (boundary === 'channel') await f.send('different-channel', 'Other chat', { channelId: 'another-private', source: { messageId: 'other', userId: USER, channelId: 'another-private', authorType: 'user' } });
  if (boundary === 'group') await f.send('group-message', 'Group input', { channelId: 'group-channel', groupContext: {
    eventId: 'group-message', rootId: 'group-root', botId: 'bot', spaceId: 'group', generation: 1, bindingEpoch: 1,
    originChannelId: 'group-channel', principalId: 'principal', scene: '{}' } });
  if (boundary === 'control') await f.send('status', '/status');
  if (boundary === 'host-group-arrival') f.manager.privateInputBarrier(USER, 'external-group-input-before-attachments');
  await f.send('b', 'B'); check.release();
  await eventual(() => f.inspect.getMessage('b')!.replyState === 'delivered' && f.manager.isIdle(), 'post-boundary input handled separately');
  assert.equal(refreshed, false); assert.equal(f.calls.filter(value => value.text === 'B').length, 1);
  assert.deepEqual(f.inspect.privateBatch('a')!.messages.map(value => value.id), ['a']);
  if (boundary === 'group') assert.equal(f.calls.find(value => value.text === 'Group input')!.onPrivateInputCheck, undefined);
});

for (const action of ['new', 'stop'] as const) test(`/${action} cancels all already-claimed private input obligations and never resubmits B`, async t => {
  const f = await fixture(t), check = f.gate(), hold = f.gate(); let claimed = false;
  f.run(async turn => {
    if (turn.text !== 'A') return f.final(turn);
    await check.promise; claimed = (await checkPrivate(turn)).refreshRequired; await hold.promise; return f.final(turn);
  });
  await f.send('a', 'A'); await eventual(() => f.calls.length === 1, 'A running'); await f.send('b', 'B'); check.release();
  await eventual(() => claimed, 'B claimed'); await f.send('command', '/' + action);
  await eventual(() => f.manager.isIdle(), 'reset or stop completed');
  for (const id of ['a', 'b']) { assert.equal(f.inspect.getMessage(id)!.state, 'cancelled'); assert.equal(f.inspect.getMessage(id)!.replyState, 'cancelled'); }
  assert.equal(f.calls.length, 1); assert.equal(f.inspect.privateBatch('a')!.refreshUsed, true);
  await f.send('d', 'D'); await eventual(() => f.inspect.getMessage('d')!.replyState === 'delivered' && f.manager.isIdle(), 'new ordinary input works');
  assert.deepEqual(f.calls.map(value => value.text), ['A', 'D']);
});

test('recovery interrupts every previously claimed running input and only runs messages that remained queued', async t => {
  const f = await fixture(t), a = f.message('a', 'A'), b = f.message('b', 'B'), d = f.message('d', 'D');
  f.inspect.addMessage(a, f.conversation.id, 'running'); f.inspect.startPrivateBatch('a');
  f.inspect.addMessage(b, f.conversation.id, 'queued'); assert(f.inspect.claimPrivateRefresh('a'));
  f.inspect.addMessage(d, f.conversation.id, 'queued'); await f.manager.recover();
  await eventual(() => f.inspect.getMessage('d')!.replyState === 'delivered' && f.manager.isIdle(), 'unclaimed D resumed');
  for (const id of ['a', 'b']) assert.equal(f.inspect.getMessage(id)!.state, 'interrupted');
  assert.deepEqual(f.calls.map(value => value.text), ['D']); assert.equal(f.inspect.privateBatch('a')!.refreshUsed, true);
  await f.send('b', 'B duplicate'); assert.deepEqual(f.calls.map(value => value.text), ['D']);
  assert.equal(f.replies.filter(value => value.text.includes('未自动重做')).length, 1);
});
