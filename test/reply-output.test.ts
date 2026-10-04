import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, BridgeMessage, ReplySink } from '../src/types.js';

class PendingAdapter implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  readonly pending: Array<{ resolve: (result: AgentResult) => void; reject: (error: Error) => void }> = [];
  readonly interrupts: string[] = [];

  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    turn.onNativeId?.(`native-${turn.conversation.id}`);
    return new Promise<AgentResult>((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  finish(index: number, text: string): void {
    this.pending[index]!.resolve({ nativeId: `native-${this.turns[index]!.conversation.id}`, text });
  }

  async interrupt(id: string): Promise<void> { this.interrupts.push(id); }
  async close(): Promise<void> {
    for (let index = 0; index < this.pending.length; index++) this.finish(index, 'late shutdown result');
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('测试条件等待超时');
    await delay(5);
  }
}

function message(id: string, text = 'hello'): BridgeMessage {
  return { id, userId: 'owner', channelId: 'owner-dm', text, imagePaths: [] };
}

function finalBody(text: string): string {
  assert.match(text, /^\[Codex · 模型未知 · 强度未知 · …[^\n]+\]\n\n/);
  return text.slice(text.indexOf('\n\n') + 2);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'discord-bridge-reply-output-'));
  const config: BridgeConfig = {
    token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'attachments'), logsDir: join(root, 'logs'), maxImageBytes: 100,
  };
  const adapter = new PendingAdapter();
  const replies: Array<{ channelId: string; text: string }> = [];
  let failDelivery = false;
  const sink: ReplySink = {
    async sendText(channelId, text) {
      if (failDelivery) { failDelivery = false; throw new Error('delivery unavailable'); }
      replies.push({ channelId, text });
    },
  };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, sink);
  t.after(async () => {
    await manager.close();
    const cleanupRoot = resolve(root);
    assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
    assert(basename(cleanupRoot).startsWith('discord-bridge-reply-output-'));
    const directories = [cleanupRoot];
    while (directories.length) {
      const directory = directories.pop()!;
      assert(!lstatSync(directory).isSymbolicLink());
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const stat = lstatSync(path);
        assert(!stat.isSymbolicLink());
        if (stat.isDirectory()) directories.push(path);
      }
    }
    rmSync(cleanupRoot, { recursive: true, force: true });
  });
  return { manager, adapter, config, replies, failNextDelivery() { failDelivery = true; } };
}

test('多个 token/delta 不发独立消息，最终回复只发送一次并由程序加回复头', async t => {
  const f = fixture(t);
  await f.manager.handle(message('deltas'));
  await until(() => f.adapter.turns.length === 1);
  const turn = f.adapter.turns[0]!;
  for (const delta of ['你', '好', '，', '这是', '最终', '回复']) turn.onProgress(delta);
  await delay(10);
  assert.equal(f.replies.length, 0);
  f.adapter.finish(0, '你好，这是最终回复');
  await until(() => f.replies.length === 1);
  turn.onProgress('final echoed as progress');
  await delay(10);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0]!.channelId, 'owner-dm');
  assert.equal(finalBody(f.replies[0]!.text), '你好，这是最终回复');
});

test('协议、工具和思考进度不泄漏到 Discord 正文', async t => {
  const f = fixture(t);
  await f.manager.handle(message('protocol'));
  await until(() => f.adapter.turns.length === 1);
  const turn = f.adapter.turns[0]!;
  turn.onProgress('{"type":"tool_call","arguments":"private path"}');
  turn.onProgress('tool result: PRIVATE RAW OUTPUT');
  turn.onProgress('reasoning: PRIVATE REASONING');
  f.adapter.finish(0, '检查完成，结果正常。');
  await until(() => f.replies.length === 1);
  assert.deepEqual(f.replies.map(reply => finalBody(reply.text)), ['检查完成，结果正常。']);
});

test('长最终回复整体交给 transport，manager 仅添加一次确定回复头', async t => {
  const f = fixture(t);
  const final = '一个长回复\n' + '内容'.repeat(2100);
  await f.manager.handle(message('long'));
  await until(() => f.adapter.turns.length === 1);
  f.adapter.turns[0]!.onProgress(final.slice(0, 100));
  f.adapter.finish(0, final);
  await until(() => f.replies.length === 1);
  assert.equal(finalBody(f.replies[0]!.text), final);
});

test('/stop 后迟到 progress 和最终结果不会发送，原会话可继续', async t => {
  const f = fixture(t);
  await f.manager.handle(message('stopped'));
  await until(() => f.adapter.turns.length === 1);
  const old = f.adapter.turns[0]!;
  old.onProgress('partial before stop');
  await f.manager.handle(message('stop-command', '/stop'));
  assert.equal(old.signal.aborted, true);
  old.onProgress('stale progress after stop');
  f.adapter.finish(0, 'stale completed reply');
  await f.manager.handle(message('continued', '继续'));
  await until(() => f.adapter.turns.length === 2);
  const next = f.adapter.turns[1]!;
  assert.equal(next.conversation.id, old.conversation.id);
  assert.equal(next.conversation.nativeId, `native-${old.conversation.id}`);
  next.onProgress('new turn delta');
  f.adapter.finish(1, '已继续原会话。');
  await until(() => f.replies.length === 2);
  assert.match(f.replies[0]!.text, /已停止/);
  assert.equal(finalBody(f.replies[1]!.text), '已继续原会话。');
  assert(!f.replies[1]!.text.includes('✅'));
  assert(f.replies.every(reply => !/partial|stale|delta/.test(reply.text)));
});

test('new chat 后旧任务迟到失败不发消息，新会话回复头不假标连续', async t => {
  const f = fixture(t);
  await f.manager.handle(message('old'));
  await until(() => f.adapter.turns.length === 1);
  await f.manager.handle(message('new-command', 'new chat'));
  await f.manager.handle(message('new-turn'));
  await until(() => f.adapter.turns.length === 2);
  f.adapter.turns[0]!.onProgress('old delta');
  f.adapter.pending[0]!.reject(new Error('old late failure'));
  f.adapter.turns[1]!.onProgress('new delta');
  f.adapter.finish(1, '新会话回复');
  await until(() => f.replies.length === 2);
  assert.match(f.replies[0]!.text, /已新建/);
  assert.equal(finalBody(f.replies[1]!.text), '新会话回复');
  assert(!f.replies[1]!.text.includes('✅'));
  assert(f.replies.every(reply => !/old delta|late failure|new delta/.test(reply.text)));
});

test('失败仅反馈一次可读错误，不发送未完成文本或随机 ID 标签', async t => {
  const f = fixture(t);
  await f.manager.handle(message('failed'));
  await until(() => f.adapter.turns.length === 1);
  f.adapter.turns[0]!.onProgress('unfinished answer');
  f.adapter.pending[0]!.reject(new Error('test agent failure'));
  await until(() => f.replies.length === 1);
  assert.equal(f.replies[0]!.text, '执行或回复失败：test agent failure');
});

test('最终回复投递失败不重跑模型，已完成状态和 nativeId 仍保留', async t => {
  const f = fixture(t);
  await f.manager.handle(message('delivery-failed'));
  await until(() => f.adapter.turns.length === 1);
  f.failNextDelivery();
  f.adapter.finish(0, 'final answer that failed delivery');
  await until(() => f.replies.length === 1);
  assert.equal(f.replies[0]!.text, '执行或回复失败：delivery unavailable');
  await f.manager.handle(message('delivery-failed', 'duplicate replay'));
  assert.equal(f.adapter.turns.length, 1);
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.getMessage('delivery-failed')!.state, 'completed');
    assert.equal(inspect.getActive('owner')!.nativeId, `native-${f.adapter.turns[0]!.conversation.id}`);
    assert.equal(inspect.getLastDelivery('owner', 'owner-dm'), null);
  } finally { inspect.close(); }
});

test('关闭桥时取消未完成任务，不发送迟到的 progress 或结果', async t => {
  const f = fixture(t);
  await f.manager.handle(message('closing'));
  await until(() => f.adapter.turns.length === 1);
  const turn = f.adapter.turns[0]!;
  turn.onProgress('partial before shutdown');
  await f.manager.close();
  turn.onProgress('late after shutdown');
  assert.equal(turn.signal.aborted, true);
  assert.deepEqual(f.replies, []);
});
