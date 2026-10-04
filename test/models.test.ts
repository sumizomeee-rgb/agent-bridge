import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { isModelId, loadConfig } from '../src/config.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentModelInfo, AgentName, AgentResult, AgentTurn, BridgeConfig } from '../src/types.js';

const catalog: AgentModelInfo = {
  defaultModel: 'gpt-5.6-sol', models: [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true },
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  ],
};
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('测试等待超时'); await delay(5); }
}
class ModelAdapter implements AgentAdapter {
  calls: AgentTurn[] = [];
  metadataCalls = 0;
  metadata: (() => Promise<AgentModelInfo>) | null = null;
  pending: Array<() => void> = [];
  constructor(readonly auto = true) {}
  async getModelInfo(): Promise<AgentModelInfo> { this.metadataCalls++; return this.metadata ? this.metadata() : catalog; }
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.calls.push(turn);
    const nativeId = turn.conversation.nativeId ?? `native-${turn.conversation.id}`;
    turn.onNativeId?.(nativeId);
    turn.onModel?.(turn.conversation.model ?? catalog.defaultModel!);
    if (!this.auto) await new Promise<void>(resolve => this.pending.push(resolve));
    return { nativeId, text: `reply:${turn.text}` };
  }
  async interrupt(): Promise<void> { this.pending.splice(0).forEach(resolve => resolve()); }
  async close(): Promise<void> { await this.interrupt(); }
}
function fixture(t: TestContext, auto = true) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-models-'));
  const config: BridgeConfig = {
    token: '', allowedUserIds: ['owner', 'other'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(root, 'data'), attachmentsDir: join(root, 'images'), logsDir: join(root, 'logs'), maxImageBytes: 100,
    modelOptions: { codex: ['gateway/model-v1'], claude: ['gpt-6-sol'] },
  };
  const codex = new ModelAdapter(auto), claude = new ModelAdapter(auto);
  const replies: Array<{ channel: string; text: string }> = [];
  const sink = { async sendText(channel: string, text: string) { replies.push({ channel, text }); } };
  const f = { root, config, codex, claude, replies, sink, manager: new SessionManager(config, { codex, claude }, sink) };
  t.after(async () => { await f.manager.close(); rmSync(root, { recursive: true, force: true }); });
  let sequence = 0;
  const send = (text: string, userId = 'owner') => f.manager.handle({ id: `message-${sequence++}`, userId, channelId: userId, text, imagePaths: [] });
  const inspect = <T>(read: (store: SessionStore) => T) => { const store = new SessionStore(config.dataDir); try { return read(store); } finally { store.close(); } };
  return { f, send, inspect };
}

test('/model 查询区分实际模型与CLI默认，/models列目录且不生成', async t => {
  const { f, send, inspect } = fixture(t);
  await send('/model');
  assert.match(f.replies.at(-1)!.text, /实际模型：尚未由 CLI 回报/);
  assert.match(f.replies.at(-1)!.text, /CLI 当前新会话默认：gpt-5.6-sol/);
  await send('/models');
  assert.match(f.replies.at(-1)!.text, /gpt-6\.1-sol.*目录推荐/);
  assert.match(f.replies.at(-1)!.text, /gateway\/model-v1/);
  assert.equal(f.codex.calls.length, 0);
  assert.equal(inspect(store => store.getActive('owner')!.model), null);
});

test('切model保留nativeID及上下文，实际model与选择持久化到重启', async t => {
  const { f, send, inspect } = fixture(t);
  await send('first');
  await waitFor(() => f.replies.some(reply => reply.text.endsWith('\n\nreply:first')));
  const prior = inspect(store => store.getActive('owner')!);
  await send('/model gpt-6.1-sol');
  const selected = inspect(store => store.getActive('owner')!);
  assert.equal(selected.id, prior.id);
  assert.equal(selected.nativeId, prior.nativeId);
  assert.equal(selected.model, 'gpt-6.1-sol');
  assert.equal(selected.actualModel, 'gpt-5.6-sol');
  await send('continue');
  await waitFor(() => f.replies.some(reply => reply.text.endsWith('\n\nreply:continue')));
  assert.equal(f.codex.calls[1]!.conversation.nativeId, prior.nativeId);
  assert.equal(f.codex.calls[1]!.conversation.model, 'gpt-6.1-sol');
  await f.manager.close();
  f.manager = new SessionManager(f.config, { codex: f.codex, claude: f.claude }, f.sink);
  await send('/status');
  assert.match(f.replies.at(-1)!.text, /实际模型：gpt-6\.1-sol/);
  assert.equal(inspect(store => store.getActive('owner')!.nativeId), prior.nativeId);
});

test('/model default解析配置默认5.6，保留原生会话，避免误用目录推荐6.1', async t => {
  const { f, send, inspect } = fixture(t);
  await send('first'); await waitFor(() => f.replies.some(reply => reply.text.endsWith('\n\nreply:first')));
  const id = inspect(store => store.getActive('owner')!.nativeId);
  await send('/model gpt-6.1-sol');
  await send('/model default');
  const selected = inspect(store => store.getActive('owner')!);
  assert.equal(selected.model, 'gpt-5.6-sol'); assert.equal(selected.nativeId, id);
  await send('default turn'); await waitFor(() => f.codex.calls.length === 2);
  assert.equal(f.codex.calls[1]!.conversation.model, 'gpt-5.6-sol');
});

test('同Agent的/new和/cwd保留显式model，清除原生上下文和实际model；换Agent用CLI默认', async t => {
  const { f, send, inspect } = fixture(t);
  await send('first'); await waitFor(() => f.replies.some(reply => reply.text.endsWith('\n\nreply:first')));
  await send('/model gpt-6.1-sol');
  const previous = inspect(store => store.getActive('owner')!);
  await send('/new');
  const next = inspect(store => store.getActive('owner')!);
  assert.notEqual(next.id, previous.id); assert.equal(next.model, 'gpt-6.1-sol');
  assert.equal(next.nativeId, null); assert.equal(next.actualModel, null);
  await send(`/cwd ${f.root}`);
  const moved = inspect(store => store.getActive('owner')!);
  assert.notEqual(moved.id, next.id); assert.equal(moved.model, 'gpt-6.1-sol'); assert.equal(moved.actualModel, null);
  await send('/agent claude');
  assert.equal(inspect(store => store.getActive('owner')!.model), null);
  await send('/model sonnet'); await send('/new claude');
  assert.equal(inspect(store => store.getActive('owner')!.model), 'sonnet');
  assert.equal(inspect(store => store.getActive('owner')!.actualModel), null);
  await send('/new codex');
  assert.equal(inspect(store => store.getActive('owner')!.model), null);
  assert.equal(inspect(store => store.getConversation(previous.id)!.model), 'gpt-6.1-sol');
  assert.equal(inspect(store => store.getConversation(previous.id)!.nativeId), previous.nativeId);
});

test('忙中切model拒绝且不改排队，另一用户独立可切换', async t => {
  const { f, send, inspect } = fixture(t, false);
  await send('running'); await waitFor(() => f.codex.calls.length === 1);
  await send('queued');
  const prior = inspect(store => store.getActive('owner')!);
  await send('/model gpt-6.1-sol');
  assert.match(f.replies.at(-1)!.text, /正在执行、排队/);
  assert.equal(inspect(store => store.getActive('owner')!.model), null);
  assert.equal(inspect(store => store.pendingCount(prior.id)), 1);
  await send('/model gpt-6.1-sol', 'other');
  assert.equal(inspect(store => store.getActive('other')!.model), 'gpt-6.1-sol');
  assert.equal(inspect(store => store.getActive('owner')!.nativeId), prior.nativeId);
});

test('模型目录查询期间收到新任务则拒绝切换，新任务使用旧默认', async t => {
  const { f, send, inspect } = fixture(t);
  let accept!: (info: AgentModelInfo) => void;
  f.codex.metadata = () => new Promise(resolve => { accept = resolve; });
  const changing = send('/model gpt-6.1-sol');
  await waitFor(() => !!accept);
  await send('during model lookup');
  assert.equal(f.codex.calls.length, 0);
  accept(catalog); await changing;
  await waitFor(() => f.codex.calls.length === 1);
  assert.equal(f.codex.calls[0]!.conversation.model, null);
  assert.equal(inspect(store => store.getActive('owner')!.model), null);
  assert(f.replies.some(reply => reply.text.includes('查询期间已有新任务排队')));
});

test('目录等待期间切会话，不会把model写到新会话或旧会话', async t => {
  const { f, send, inspect } = fixture(t);
  let accept!: (info: AgentModelInfo) => void;
  f.codex.metadata = () => new Promise(resolve => { accept = resolve; });
  const changing = send('/model gpt-6.1-sol'); await waitFor(() => !!accept);
  const oldId = inspect(store => store.getActive('owner')!.id);
  await send('/new'); accept(catalog); await changing;
  assert.equal(inspect(store => store.getConversation(oldId)!.model), null);
  assert.equal(inspect(store => store.getActive('owner')!.model), null);
  assert(f.replies.some(reply => reply.text.includes('当前会话已改变')));
});

test('Codex未知型号不改会话，自定义通道与配置目录允许网关模型', async t => {
  const { f, send, inspect } = fixture(t);
  await send('/model unknown-model');
  assert.equal(inspect(store => store.getActive('owner')!.model), null);
  assert.match(f.replies.at(-1)!.text, /未修改会话/);
  await send('/model custom unknown-model');
  assert.equal(inspect(store => store.getActive('owner')!.model), 'unknown-model');
  assert.match(f.replies.at(-1)!.text, /尚未验证/);
  await send('/model gateway/model-v1');
  assert.equal(inspect(store => store.getActive('owner')!.model), 'gateway/model-v1');
});

test('Claude支持网关跨协议型号，不强制官方白名单，并支持/models别名', async t => {
  const { f, send, inspect } = fixture(t);
  await send('/new claude'); await send('/model gpt-6-sol');
  assert.equal(inspect(store => store.getActive('owner')!.model), 'gpt-6-sol');
  assert.match(f.replies.at(-1)!.text, /尚未验证/);
  await send('/models');
  assert.match(f.replies.at(-1)!.text, /sonnet/);
  await send('hello'); await waitFor(() => f.claude.calls.length === 1);
  assert.equal(f.claude.calls[0]!.conversation.model, 'gpt-6-sol');
});

test('元数据失败和无法解析default均不改变旧选择', async t => {
  const { f, send, inspect } = fixture(t);
  await send('/model gateway/model-v1');
  f.codex.metadata = async () => { throw new Error('metadata offline'); };
  await send('/model gpt-6.1-sol');
  assert.equal(inspect(store => store.getActive('owner')!.model), 'gateway/model-v1');
  f.codex.metadata = async () => ({ models: [], defaultModel: null });
  await send('/model default');
  assert.equal(inspect(store => store.getActive('owner')!.model), 'gateway/model-v1');
  assert.match(f.replies.at(-1)!.text, /无法确认 CLI 当前默认/);
});

test('旧SQLite迁移保留active、nativeId和历史，新model列可重启恢复', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-model-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = new DatabaseSync(join(root, 'bridge.sqlite'));
  legacy.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,agent TEXT NOT NULL,native_id TEXT,title TEXT NOT NULL,cwd TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE active_conversations(user_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id));`);
  legacy.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)').run('old', 'owner', 'codex', 'native-existing', '旧会话', root, 'before', 'before');
  legacy.prepare('INSERT INTO active_conversations VALUES(?,?)').run('owner', 'old'); legacy.close();
  let store = new SessionStore(root);
  assert.equal(store.getActive('owner')!.nativeId, 'native-existing'); assert.equal(store.getActive('owner')!.model, null);
  store.setModel('old', 'gpt-6-sol'); store.saveActualModel('old', 'gpt-6-sol'); store.close();
  store = new SessionStore(root);
  try { assert.equal(store.getActive('owner')!.model, 'gpt-6-sol'); assert.equal(store.getActive('owner')!.actualModel, 'gpt-6-sol'); }
  finally { store.close(); }
});

test('配置可选model目录及参考默认，不自动覆盖CLI；安全ID校验', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-model-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const raw = { token: 'fake', allowedUserIds: ['123456789012345678'], workspace: root, dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'images'),
    commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } },
    defaultModels: { codex: 'gpt-5.6-sol' }, modelOptions: { claude: ['gateway/gpt-6-sol'], codex: ['custom-v1'] } };
  writeFileSync(path, JSON.stringify(raw));
  const config = loadConfig(['--config', path]);
  assert.equal(config.defaultModels!.codex, 'gpt-5.6-sol');
  assert.deepEqual(config.commands.codex.args, []);
  for (const id of ['gpt-6.1-sol', 'sonnet[1m]', 'gateway/model:latest']) assert(isModelId(id));
  for (const id of ['', '--flag', 'bad model', '$(echo x)', 'a'.repeat(201), 'x\n--dangerous']) assert(!isModelId(id));
  writeFileSync(path, JSON.stringify({ ...raw, modelOptions: { codex: ['bad model'] } }));
  assert.throws(() => loadConfig(['--config', path]), /有效模型 ID 数组/);
});

const fakeCli = String.raw`
const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});
const trace=x=>fs.appendFileSync(process.env.MODEL_TRACE,JSON.stringify(x)+'\n');
trace({args:process.argv.slice(2)});
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
let id='native-existing';
const timer=setInterval(()=>{},1000);
rl.on('close',()=>{clearInterval(timer);process.exit(0)});
rl.on('line',line=>{const m=JSON.parse(line);trace(m);
  if(m.method==='initialize')send({id:m.id,result:{userAgent:'fake'}});
  if(m.method==='config/read')send({id:m.id,result:{config:{model:'gpt-5.6-sol'}}});
  if(m.method==='model/list')send({id:m.id,result:m.params.cursor
    ?{data:[{model:'gpt-5.6-sol',displayName:'5.6',isDefault:false}],nextCursor:null}
    :{data:[{model:'gpt-6.1-sol',displayName:'6.1',isDefault:true}],nextCursor:'page2'}});
  if(m.method==='thread/resume'||m.method==='thread/start')send({id:m.id,result:{thread:{id:m.params.threadId||id},model:m.params.model||'gpt-5.6-sol',reasoningEffort:'high'}});
  if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({method:'model/rerouted',params:{threadId:'other-thread',turnId:'turn',toModel:'ignore-other-thread'}});send({method:'model/rerouted',params:{threadId:id,turnId:'turn',toModel:'provider-effective-model'}});send({method:'turn/completed',params:{threadId:id,turn:{id:'turn',status:'completed',items:[{type:'agentMessage',id:'reply',phase:'final_answer',text:'fake'}]}}});}
  if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'sonnet',displayName:'Sonnet'}],defaultModel:'claude-fixture-default'}}});
  if(m.type==='user'){const at=process.argv.indexOf('--model');send({type:'system',subtype:'init',session_id:id,model:at>=0?process.argv[at+1]:'claude-fixture-default'});send({type:'assistant',parent_tool_use_id:null,message:{model:'provider-effective-model'}});send({type:'assistant',parent_tool_use_id:'subagent-tool',message:{model:'ignore-subagent-model'}});send({type:'result',subtype:'success',session_id:id,result:'fake'});}
});`;
for (const agent of ['codex', 'claude'] as const) test(`${agent} metadata无user/turn，真实spawn模型override与resume原生ID`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-model-process-'));
  const cli = join(root, 'model-fixture.cjs'), tracePath = join(root, 'trace.jsonl');
  writeFileSync(cli, fakeCli);
  const command = { command: process.execPath, args: [cli] };
  const adapter = agent === 'codex' ? new CodexAdapter(command, { MODEL_TRACE: tracePath }) : new ClaudeAdapter(command, { MODEL_TRACE: tracePath });
  t.after(async () => { await adapter.close(); rmSync(root, { recursive: true, force: true }); });
  const info = await adapter.getModelInfo(root);
  assert.equal(info.defaultModel, agent === 'codex' ? 'gpt-5.6-sol' : 'claude-fixture-default');
  let trace: any[] = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(!trace.some(message => message.method === 'thread/start' || message.method === 'turn/start' || message.type === 'user'));
  if (agent === 'codex') assert.equal(info.models.length, 2);
  const reported: string[] = [];
  const efforts: Array<string | null> = [];
  await adapter.run({ conversation: { id: 'conv', userId: 'owner', agent, nativeId: 'native-existing', model: 'gpt-6-sol',
    title: 'test', cwd: root, createdAt: 'before', updatedAt: 'now' }, text: 'fake', imagePaths: [], signal: new AbortController().signal,
    onProgress: () => {}, onModel: model => reported.push(model), onReasoningEffort: effort => efforts.push(effort) });
  assert.deepEqual(reported, ['gpt-6-sol', 'provider-effective-model']);
  assert.deepEqual(efforts, agent === 'codex' ? ['high'] : []);
  trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  if (agent === 'codex') {
    const resume = trace.find(message => message.method === 'thread/resume');
    assert.equal(resume.params.threadId, 'native-existing'); assert.equal(resume.params.model, 'gpt-6-sol');
    assert.equal(trace.find(message => message.method === 'turn/start').params.model, 'gpt-6-sol');
  } else {
    const args: string[] = trace.findLast(message => message.args).args;
    assert.equal(args[args.indexOf('--resume') + 1], 'native-existing'); assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-sol');
  }
});
