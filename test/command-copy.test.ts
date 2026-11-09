import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { parseWorkerDefaultCommand } from '../src/controller/worker-selection.js';
import { commandFailureCopy } from '../src/command-copy.js';
import { commandHelp, COMMANDS, groupCommands } from '../src/commands.js';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

function fixture(t: TestContext, controllerMode = false) {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'command-copy-')), 'command-copy-');
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', controllerMode,
    workspace: root, dataDir: join(root, 'data'), logsDir: root, attachmentsDir: root, maxImageBytes: 100, proxyUrl: null,
    commands: { codex: { command: 'unused', args: [] }, claude: { command: 'unused', args: [] } } };
  let calls = 0, sequence = 0, defaultFailure: Error | null = null;
  const adapter: AgentAdapter = { async run() { calls++; throw new Error('文案命令不应生成模型回合'); }, async interrupt() {}, async close() {},
    async getModelInfo() { return { defaultModel: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol', displayName: 'Sol', supportedEfforts: ['low', 'xhigh'] }] }; } };
  const store = new SessionStore(config.dataDir);
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText() {} }, {
    onWorkerDefaults: async args => { if (defaultFailure) throw defaultFailure; parseWorkerDefaultCommand(args); return '默认查询清单'; },
  });
  t.after(async () => { await manager.close(); store.close(); });
  return { root, config, store, manager, get calls() { return calls; }, failDefault(error: Error) { defaultFailure = error; },
    async command(text: string) {
      const replies: string[] = [], id = 'copy-' + ++sequence;
      await manager.handle({ id, userId: 'owner', channelId: 'private', text, imagePaths: [] }, async value => { replies.push(value); });
      return { text: replies.join('\n'), id };
    },
    active(agent: 'codex' | 'claude' = 'codex') {
      const conversation = store.createConversation('owner', agent, root, { controllerMode });
      store.setActive('owner', conversation.id); store.saveNativeId(conversation.id, 'native-existing'); return conversation.id;
    },
  };
}

test('模型设置仅报下轮选择，清覆盖与自定义未验证不误报实际模型', async t => {
  const f = fixture(t), id = f.active();
  f.store.saveActualModel(id, 'previous-effective-model');
  const selected = await f.command('/model gpt-6.1-sol');
  assert.equal(selected.text, '当前 Codex CLI 模型已设置为 gpt-6.1-sol，下轮使用，上下文保留。');
  assert.doesNotMatch(selected.text, /模型选项|\/model|previous-effective-model/);
  assert.equal(f.store.getActive('owner')!.actualModel, 'previous-effective-model');
  const custom = await f.command('/model custom gateway-model');
  assert.match(custom.text, /gateway-model.*下轮使用.*提供方可用性尚未验证/);
  const cleared = await f.command('/model default');
  assert.match(cleared.text, /CLI 默认（已清除显式覆盖）.*下轮使用/);
  assert.equal(f.store.getActive('owner')!.model, null);
  assert.equal(f.store.getActive('owner')!.nativeId, 'native-existing'); assert.equal(f.calls, 0);
});

test('强度成功与查询区分选择和回报，无参不夹带模型Fast，显式list保留能力帮助', async t => {
  const f = fixture(t), id = f.active();
  f.store.saveActualEffort(id, 'low');
  const selected = await f.command('/effort xhigh');
  assert.equal(selected.text, '已设置当前 Codex CLI 会话强度为 xhigh，下轮提交；实际采用尚未由 CLI 确认，现有子任务不变。');
  assert.doesNotMatch(selected.text, /\/effort|Agent 强度参数|模型能力参考/);
  assert.equal(f.store.getActive('owner')!.actualEffort, null);
  f.store.saveActualEffort(id, 'low');
  const query = await f.command('/effort');
  assert.match(query.text, /强度选择：xhigh\n推理强度：low/);
  assert.doesNotMatch(query.text, /实际模型：|会话选择：|Fast 设置|模型能力参考（/);
  const list = await f.command('/effort list');
  assert.match(list.text, /Agent 强度参数/); assert.match(list.text, /模型能力参考（不阻止传参）/);
  const cleared = await f.command('/effort default'); assert.match(cleared.text, /CLI 默认.*下轮提交.*尚未由 CLI 确认/);
  assert.equal(f.store.getActive('owner')!.effort, null); assert.equal(f.calls, 0);
});

test('Fast成功保留当前主控范围和采用待确认，开启保留额度提示', async t => {
  const f = fixture(t, true); f.active();
  const on = await f.command('/fast on');
  assert.equal(on.text, '当前 Codex 主控 Fast 已设置为开启，下轮请求使用；额度消耗更快，服务端采用尚未确认。');
  assert.equal(f.store.getActive('owner')!.fastMode, true);
  const off = await f.command('/fast off');
  assert.equal(off.text, '当前 Codex 主控 Fast 已设置为关闭，下轮请求使用；服务端采用尚未确认。');
  assert.doesNotMatch(off.text, /额度|上下文保留|\/fast/);
  assert.match((await f.command('/fast invalid')).text, /用法/);
  assert.equal(f.store.getActive('owner')!.fastMode, false); assert.equal(f.calls, 0);
});

test('Agent查询及幂等成功不附身份和其他命令教程，切换保留交接范围', async t => {
  const f = fixture(t);
  const query = await f.command('/agent'); assert.match(query.text, /当前 Agent：Codex CLI/);
  assert.doesNotMatch(query.text, /\/new|\/chats|真正切换时/); assert.equal(f.store.getActive('owner'), null);
  const id = f.active();
  assert.equal((await f.command('/agent codex')).text, '当前已是 Codex CLI，继续原会话。');
  assert.equal(f.store.getActive('owner')!.id, id);
  const switched = await f.command('/agent claude');
  assert.equal(switched.text, '已切换到 Claude Code，接续最新上下文；普通助手与定时计划保留。');
  assert.equal(f.store.getActive('owner')!.agent, 'claude'); assert.notEqual(f.store.getActive('owner')!.id, id);
  assert.equal(f.calls, 0);
});

test('任务尾部按筛选给单个跳转，保留作用范围、状态和分页，不改登记', async t => {
  const f = fixture(t, true), scope = { userId: 'owner', channelId: 'private' };
  for (let batch = 0; batch < 2; batch++) f.store.knowledge.update(scope, { changes: Array.from({ length: 6 }, (_, n) => ({
    id: 'task-' + (batch * 6 + n), expectedVersion: 0, title: 'TASK_' + (batch * 6 + n), nextStep: '继续原工作',
  })) }, 'seed-' + batch);
  const before = f.store.knowledge.list(scope, { includeClosed: true, limit: 20 });
  const first = await f.command('/tasks'), second = await f.command('/tasks 2'), all = await f.command('/tasks all');
  assert.match(first.text, /下一页：\/tasks 2/); assert.match(second.text, /上一页：\/tasks 1/);
  assert.match(first.text, /本 Bot 当前私聊任务，跨新会话保留；状态由主控维护/);
  assert.match(first.text, /\/tasks all 查看全部/); assert.doesNotMatch(first.text, /\/tasks 查看未结束/);
  assert.match(all.text, /\/tasks 查看未结束/); assert.doesNotMatch(all.text, /\/tasks all 查看全部/);
  assert.match(first.text, /下一步：继续原工作/);
  assert.deepEqual(f.store.knowledge.list(scope, { includeClosed: true, limit: 20 }), before);
  assert.equal(f.store.getActive('owner'), null); assert.equal(f.calls, 0);
});

test('状态保留实际与选择信息、目录及人数，无会话不创建，有会话不附常驻教程', async t => {
  const f = fixture(t, true);
  assert.match((await f.command('/status')).text, /只查询状态，不创建会话/); assert.equal(f.store.getActive('owner'), null);
  const id = f.active(); f.store.setModel(id, 'requested-model'); f.store.saveActualModel(id, 'reported-model');
  const status = await f.command('/status');
  assert.match(status.text, /实际模型：reported-model/); assert.match(status.text, /会话选择：requested-model/);
  assert.match(status.text, /目录：/); assert.match(status.text, /排队 0 条/);
  assert.doesNotMatch(status.text, /\/new|\/help|直接发送文字或图片继续/); assert.equal(f.calls, 0);
});

test('已知输入错误保留原因和短用法，通过原回调发送，未知异常不公开诊断', async t => {
  const f = fixture(t, true); f.active('claude');
  const missing = await f.command('/default agentworker local preset');
  assert.match(missing.text, /缺少预设 ID/); assert.match(missing.text, /\/default agentworker local preset <预设ID>/);
  assert.doesNotMatch(missing.text, /follow\|clear|codex\|claude/);
  assert.equal(f.store.getMessage(missing.id)!.state, 'failed');
  assert.match((await f.command('/default agentworker home follow')).text, /仅用于 local/);
  assert.match((await f.command('/default agentworker local codex default')).text, /明确指定模型/);
  const effort = await f.command('/effort ultra');
  assert.match(effort.text, /CLI 不支持此强度.*可用值：low、medium、high、xhigh、max/);
  assert.equal(f.store.getActive('owner')!.effort, null);
  assert.match((await f.command(`/cwd "${join(f.root, 'missing')}"`)).text, /目录不存在.*核对路径/);
  f.failDefault(new Error('未知内部异常 token=PRIVATE_SECRET'));
  const unknown = await f.command('/default agentworker');
  assert.equal(unknown.text, '❌ 【桥】命令失败\n\n请核对命令或查看本地记录。');
  assert.equal(commandFailureCopy('unknown', '', new Error('PRIVATE_SECRET')), null); assert.equal(f.calls, 0);
});

test('显式帮助模型清单保持完整，新建回执不误称初始化或预约取消已完成', async t => {
  const f = fixture(t, true);
  const help = await f.command('/help'); for (const name of ['new', 'model', 'tasks', 'default', 'workers', 'restart']) assert(help.text.includes('/' + name));
  assert(help.text.includes(commandHelp(true)));
  const models = await f.command('/models'); assert.match(models.text, /1\. gpt-6.1-sol/); assert.match(models.text, /\/model 序号/);
  const model = await f.command('/model'); assert.doesNotMatch(model.text, /强度选择：|Fast 设置/); assert.match(model.text, /实际模型：尚未由 CLI 回报/);
  const created = await f.command('/new'); assert.match(created.text, /工作区初始化中/); assert.match(created.text, /目录：/);
  assert.doesNotMatch(created.text, /初始化完成|已取消.*预约|旧定时已取消|完成后由主控/); assert.equal(f.calls, 0);
});

test('new帮助保留续接和跨入口范围，不误称全部旧预约已取消', () => {
  const definition = COMMANDS.find(c => c.name === 'new')!;
  assert.match(definition.help, /continue.*提炼/);
  assert.match(definition.options!.find(o => o.name === 'continue')!.description, /不接管旧助手/);
  assert.doesNotMatch(JSON.stringify(definition), /取消旧定时/);
  const group = groupCommands().find(c => c.name === 'new')!;
  assert.match(group.help, /重置本群全部成员.*影响其私聊和其他群/);
  assert.doesNotMatch(group.help, /取消旧定时/);
});
