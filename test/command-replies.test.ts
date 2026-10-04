import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentModelInfo, AgentResult, AgentTurn, BridgeConfig, BridgeMessage } from '../src/types.js';

const catalog: AgentModelInfo = {
  defaultModel: 'configured-model', models: [{ id: 'configured-model', displayName: 'Configured Model' }],
};

class CommandAdapter implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  readonly pending: Array<(result: AgentResult) => void> = [];
  readonly metadata: Array<(info: AgentModelInfo) => void> = [];
  holdMetadata = false;
  metadataError: Error | null = null;

  async getModelInfo(): Promise<AgentModelInfo> {
    if (this.metadataError) throw this.metadataError;
    if (!this.holdMetadata) return catalog;
    return new Promise(resolve => this.metadata.push(resolve));
  }
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    turn.onNativeId?.(`native-${turn.conversation.id}`);
    return new Promise(resolve => this.pending.push(resolve));
  }
  finish(index: number, text: string): void {
    this.pending[index]!({ nativeId: `native-${this.turns[index]!.conversation.id}`, text });
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    for (const resolve of this.metadata) resolve(catalog);
    for (let index = 0; index < this.pending.length; index++) this.finish(index, 'cancelled output');
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Command fixture did not reach the expected state');
    await delay(5);
  }
}

function message(id: string, text: string): BridgeMessage {
  return { id, userId: 'owner', channelId: 'same-private-channel', text, imagePaths: [] };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-command-replies-'));
  const config: BridgeConfig = {
    token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'attachments'), logsDir: join(root, 'logs'), maxImageBytes: 100,
  };
  const adapter = new CommandAdapter();
  const sinkReplies: Array<{ channelId: string; text: string }> = [];
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, {
    async sendText(channelId, text) { sinkReplies.push({ channelId, text }); },
  });
  t.after(async () => {
    await manager.close();
    const cleanupRoot = resolve(root);
    assert.equal(dirname(cleanupRoot), resolve(tmpdir()));
    assert(basename(cleanupRoot).startsWith('bridge-command-replies-'));
    const directories = [cleanupRoot];
    while (directories.length) {
      const directory = directories.pop()!;
      assert(!(await lstat(directory)).isSymbolicLink());
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        const stat = await lstat(path);
        assert(!stat.isSymbolicLink());
        if (stat.isDirectory()) directories.push(path);
      }
    }
    await rm(cleanupRoot, { recursive: true, force: true });
  });
  return { root, config, adapter, manager, sinkReplies };
}

test('同频道两条并发 slash 模型命令各自使用自己的交互回调，即使查询反序完成', async t => {
  const f = await fixture(t);
  f.adapter.holdMetadata = true;
  const firstReplies: string[] = [];
  const secondReplies: string[] = [];
  const first = f.manager.handle(message('interaction-list', '/models'), async text => { firstReplies.push(text); });
  const second = f.manager.handle(message('interaction-current', '/model'), async text => { secondReplies.push(text); });
  await until(() => f.adapter.metadata.length === 2);
  f.adapter.metadata[1]!(catalog);
  await second;
  assert.equal(firstReplies.length, 0);
  assert.equal(secondReplies.length, 1);
  assert.match(secondReplies[0]!, /实际模型/);
  f.adapter.metadata[0]!(catalog);
  await first;
  assert.equal(firstReplies.length, 1);
  assert.match(firstReplies[0]!, /模型选项/);
  assert.deepEqual(f.sinkReplies, []);
});

test('普通命令的异步回调不会被同频道下一条命令替换', async t => {
  const f = await fixture(t);
  const firstReplies: string[] = [];
  const secondReplies: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = f.manager.handle(message('interaction-help', '/help'), async text => {
    firstReplies.push(text); await waiting;
  });
  await until(() => firstReplies.length === 1);
  await f.manager.handle(message('interaction-status', '/status'), async text => { secondReplies.push(text); });
  assert.equal(secondReplies.length, 1);
  assert.match(firstReplies[0]!, /直接发送文字或图片/);
  assert.match(secondReplies[0]!, /还没有会话/);
  release();
  await first;
  assert.deepEqual(f.sinkReplies, []);
});

test('命令交互回调不劫持运行中的模型最终回复', async t => {
  const f = await fixture(t);
  await f.manager.handle(message('normal-task', 'do a task'));
  await until(() => f.adapter.turns.length === 1);
  const commandReplies: string[] = [];
  await f.manager.handle(message('interaction-status-during-task', '/status'), async text => { commandReplies.push(text); });
  assert.match(commandReplies[0]!, /正在执行/);
  assert.equal(f.sinkReplies.length, 0);
  f.adapter.finish(0, 'final task output');
  await until(() => f.sinkReplies.length === 1);
  assert(f.sinkReplies[0]!.text.endsWith('\n\nfinal task output'));
  assert.equal(f.sinkReplies[0]!.channelId, 'same-private-channel');
  assert.equal(commandReplies.length, 1);
});

test('非命令文本即便传入 callback，也只通过 sink 回复模型结果', async t => {
  const f = await fixture(t);
  const commandReplies: string[] = [];
  await f.manager.handle(message('text-with-unused-callback', 'hello'), async text => { commandReplies.push(text); });
  await until(() => f.adapter.turns.length === 1);
  f.adapter.finish(0, 'normal final');
  await until(() => f.sinkReplies.length === 1);
  assert(f.sinkReplies[0]!.text.endsWith('\n\nnormal final'));
  assert.deepEqual(commandReplies, []);
});

test('命令执行异常通过同一交互回调反馈，失败不会发普通频道消息', async t => {
  const f = await fixture(t);
  const commandReplies: string[] = [];
  await f.manager.handle(message('bad-cwd-command', `/cwd "${join(f.root, 'missing directory')}"`),
    async text => { commandReplies.push(text); });
  assert.equal(commandReplies.length, 1);
  assert.match(commandReplies[0]!, /^命令失败：/);
  assert.deepEqual(f.sinkReplies, []);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getMessage('bad-cwd-command')!.state, 'failed'); }
  finally { inspect.close(); }
});

test('模型元数据命令异常也使用交互回调', async t => {
  const f = await fixture(t);
  f.adapter.metadataError = new Error('fixture metadata unavailable');
  const replies: string[] = [];
  await f.manager.handle(message('failed-model-command', '/model list'), async text => { replies.push(text); });
  assert.deepEqual(replies, ['命令失败：fixture metadata unavailable']);
  assert.deepEqual(f.sinkReplies, []);
  assert.equal(f.adapter.turns.length, 0);
});

test('没有交互回调的原文本命令继续走 sink，包括模型菜单和 new chat', async t => {
  const f = await fixture(t);
  await f.manager.handle(message('text-help', '/help'));
  await f.manager.handle(message('text-model-menu', '/model list'));
  await f.manager.handle(message('text-new-chat', 'new chat'));
  assert.equal(f.sinkReplies.length, 3);
  assert.match(f.sinkReplies[0]!.text, /直接发送文字或图片/);
  assert.match(f.sinkReplies[1]!.text, /模型选项/);
  assert.match(f.sinkReplies[2]!.text, /已新建/);
  assert.equal(f.adapter.turns.length, 0);
});

test('命令回复失败仍通过原交互 callback 报错，不退回普通消息发送', async t => {
  const f = await fixture(t);
  const attempted: string[] = [];
  await f.manager.handle(message('failed-interaction-reply', '/help'), async text => {
    attempted.push(text);
    if (attempted.length === 1) throw new Error('fixture interaction unavailable');
  });
  assert.equal(attempted.length, 2);
  assert.equal(attempted[1], '命令失败：fixture interaction unavailable');
  assert.deepEqual(f.sinkReplies, []);
});

test('旧 resume 命令的交互回复只告知停用，不恢复会话', async t => {
  const f = await fixture(t);
  const replies: string[] = [];
  await f.manager.handle(message('disabled-resume-menu', '/resume native-historical'), async text => { replies.push(text); });
  assert.equal(replies.length, 1);
  assert.match(replies[0]!, /resume 已停用/);
  assert.deepEqual(f.sinkReplies, []);
  assert.equal(f.adapter.turns.length, 0);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getActive('owner'), null); }
  finally { inspect.close(); }
});

test('重复命令去重，交互 callback 与闭包 token 不进入 SQLite', async t => {
  const f = await fixture(t);
  const closureToken = 'FAKE_INTERACTION_TOKEN_NOT_FOR_STORAGE';
  const replies: string[] = [];
  const callback = async (text: string) => { assert.equal(closureToken.length, 38); replies.push(text); };
  await f.manager.handle(message('same-interaction', '/help'), callback);
  await f.manager.handle(message('same-interaction', '/help'), callback);
  assert.equal(replies.length, 1);
  assert.deepEqual(f.sinkReplies, []);
  const inspect = new SessionStore(f.config.dataDir);
  try {
    const stored = inspect.getMessage('same-interaction')!;
    assert.equal(stored.state, 'completed');
    assert(!Object.hasOwn(stored, 'commandReply'));
  } finally { inspect.close(); }
  await f.manager.close();
  const database = await readFile(join(f.config.dataDir, 'bridge.sqlite'));
  assert(!database.includes(Buffer.from(closureToken)));
});
