import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownTemporaryDirectory } from './temp-directory.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { commandHelp } from '../src/commands.js';
import { SLASH_COMMANDS, GROUP_SLASH_COMMANDS, slashText } from '../src/slash.js';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';

function fixture(t: TestContext) {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'checklist-command-')), 'checklist-command-');
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner', 'other'], defaultAgent: 'codex', controllerMode: true,
    workspace: root, dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'images'), maxImageBytes: 100,
    proxyUrl: null, commands: { codex: { command: 'unused', args: [] }, claude: { command: 'unused', args: [] } } };
  let calls = 0, sequence = 0;
  const adapter: AgentAdapter = { async run() { calls++; throw new Error('只读命令不能启动模型'); }, async interrupt() {}, async close() {} };
  const replies: string[] = [], manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText(_channel, text) { replies.push(text); } });
  const store = new SessionStore(config.dataDir), scope = { userId: 'owner', channelId: 'private' };
  t.after(async () => { await manager.close(); store.close(); });
  return { store, scope, config, manager, get calls() { return calls; },
    async command(text: string, userId = 'owner', channelId = 'private') { const before = replies.length;
      await manager.handle({ id: 'command-' + ++sequence, userId, channelId, text, imagePaths: [] }); return replies.slice(before).join('\n'); } };
}

test('任务清单命令只读同一份登记，区分未结束与全部，不创建会话或启动模型', async t => {
  const f = fixture(t);
  assert.match(await f.command('/tasks'), /没有登记的未结束任务/); assert.equal(f.manager.currentConversation('owner'), null);
  const states = ['pending', 'in_progress', 'blocked', 'paused', 'done', 'cancelled', 'superseded'];
  f.store.knowledge.update(f.scope, { changes: states.map(state => ({ id: state, expectedVersion: 0, title: 'TASK_' + state + '_END', state, nextStep: '按原目标继续' })) }, 'seed');
  const before = f.store.knowledge.list(f.scope, { includeClosed: true, limit: 20 });
  const open = await f.command('/tasks'); for (const state of states.slice(0, 4)) assert.match(open, new RegExp('TASK_' + state + '_END'));
  for (const state of states.slice(4)) assert.doesNotMatch(open, new RegExp('TASK_' + state + '_END'));
  const all = await f.command('/tasks all'); for (const state of states) assert.match(all, new RegExp('TASK_' + state + '_END'));
  assert.match(all, /状态由主控维护/); assert.deepEqual(f.store.knowledge.list(f.scope, { includeClosed: true, limit: 20 }), before);
  assert.equal(f.calls, 0); assert.equal(f.manager.currentConversation('owner'), null);
});

test('任务清单分页不漏项，参数错误不启动模型，私聊及用户之间不泄露', async t => {
  const f = fixture(t);
  for (let offset = 0; offset < 12; offset += 6) f.store.knowledge.update(f.scope, { changes: Array.from({ length: 6 }, (_, n) => ({ id: 'id-' + (offset + n), expectedVersion: 0, title: 'ITEM_' + (offset + n) + '_END' })) }, 'seed-' + offset);
  f.store.knowledge.update({ ...f.scope, spaceId: 'group' }, { changes: [{ id: 'group', expectedVersion: 0, title: 'GROUP_SECRET' }] }, 'group');
  const first = await f.command('/tasks'), second = await f.command('/tasks 2');
  const titles = (value: string) => value.match(/ITEM_\d+_END/g) ?? [];
  assert.equal(titles(first).length, 10); assert.equal(titles(second).length, 2); assert.equal(new Set([...titles(first), ...titles(second)]).size, 12);
  assert.match(first, /下一页：\/tasks 2/); assert.match(second, /上一页：\/tasks 1/);
  assert.match(await f.command('/tasks 3'), /该页没有任务/);
  for (const text of ['/tasks 0', '/tasks 101', '/tasks all all', '/tasks history']) assert.match(await f.command(text), /用法/);
  assert.doesNotMatch(first, /GROUP_SECRET/);
  for (const [user, channel] of [['other', 'private'], ['owner', 'other-chat'], ['unauthorized', 'private']]) assert.doesNotMatch(await f.command('/tasks all', user, channel), /ITEM_|GROUP_SECRET/);
  assert.equal(f.calls, 0);
});

test('任务清单命令在菜单与帮助中可见，Discord 参数保留且群菜单不暴露私聊清单', () => {
  assert(SLASH_COMMANDS.some(command => command.name === 'tasks')); assert(!GROUP_SLASH_COMMANDS.some(command => command.name === 'tasks'));
  assert.match(commandHelp(true), /\/tasks/);
  assert.deepEqual(slashText({ name: 'tasks', options: [{ name: 'args', type: 3, value: 'all 2' }] }), { text: '/tasks all 2' });
});
