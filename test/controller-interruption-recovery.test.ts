import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry } from '../src/tasks.js';
import { ControllerRecoveryJournal, retryableControllerFailure, recoveryBackoffMs } from '../src/controller/recovery.js';
import { harnessText } from '../src/harness.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('recovery test timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-recovery-'));
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', controllerMode: true, workspace: root,
    dataDir: join(root, 'data'), logsDir: root, attachmentsDir: root, maxImageBytes: 100, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } } };
  const store = new SessionStore(config.dataDir), registry = new TaskRegistry(config.dataDir), turns: AgentTurn[] = [], sent: string[] = [];
  const conversation = store.createConversation('owner','codex',root,{controllerMode:true});
  store.saveNativeId(conversation.id,'native-main'); store.setActive('owner',conversation.id);
  let stopped = true, failDelivery = false;
  let run: (turn: AgentTurn) => Promise<void> = async () => { throw new Error('502 upstream stream ended'); };
  const create = () => {
    const adapter: AgentAdapter = {
      async run(turn) { turns.push(turn); turn.onNativeId?.('native-main'); turn.onReady?.(); await run(turn); return { nativeId:'native-main', text:'', controlledOutput:true }; },
      async interrupt() {}, async confirmStopped() { return stopped; }, async close() {},
    };
    return new SessionManager(config,{codex:adapter,claude:adapter},{async sendText(_channel,text) {
      if (failDelivery && text.includes('final answer')) throw new Error('network delivery failure'); sent.push(text);
    }},{taskRegistry:registry,mergeDelayMs:0});
  };
  let manager = create();
  t.after(async () => { await manager.close(); registry.close(); store.close(); rmSync(root,{recursive:true,force:true}); });
  return { store, registry, turns, sent, config, conversation,
    get manager() { return manager; },
    setRun(value: typeof run) { run=value; }, setStopped(value:boolean) { stopped=value; }, setFailDelivery(value:boolean) { failDelivery=value; },
    async send(id='original',text='original authorized goal') { await manager.handle({id,text,userId:'owner',channelId:'dm',imagePaths:[]}); await until(()=>manager.isIdle()); },
    async restart() { await manager.close(); manager=create(); await manager.recover(); },
    async poll() { const row=store.recoveries.active()[0]; assert(row); await manager.pollControllerRecovery(row.dueAt+1); await until(()=>manager.isIdle()); },
  };
}

test('20秒后发送短恢复事件而非重放用户内容，真实回复后原消息标记已答', async t => {
  const f=fixture(t); await f.send();
  const original=f.store.recoveries.active()[0]!; assert(original); assert.equal(original.attempts,0);
  await f.manager.pollControllerRecovery(original.dueAt-1); assert.equal(f.turns.length,1);
  f.setRun(async turn=>{assert.equal(turn.event?.kind,'recovery'); assert.equal(turn.text,harnessText('manager.controller_recovery')); assert(!turn.text.includes('original authorized goal')); await turn.onPublicMessage!('final answer');});
  await f.poll();
  assert.equal(f.turns.length,2); assert.equal(f.turns[1]!.conversation.nativeId,'native-main');
  assert.equal(f.store.recoveries.get(original.id)!.state,'done'); assert.equal(f.store.getMessage('original')!.replyState,'delivered');
  assert.equal(f.sent.filter(text=>text.includes('final answer')).length,1);
});

test('确认旧进程退出前不消耗次数，连续失败最多自动恢复五次', async t => {
  const f=fixture(t); await f.send(); const id=f.store.recoveries.active()[0]!.id;
  f.setStopped(false); await f.poll(); assert.equal(f.turns.length,1); assert.equal(f.store.recoveries.get(id)!.attempts,0);
  f.setStopped(true);
  for (let attempt=1; attempt<=5; attempt++) { await f.poll(); assert.equal(f.turns.length,attempt+1); assert.equal(f.store.recoveries.get(id)!.attempts,attempt); }
  assert.equal(f.store.recoveries.get(id)!.state,'exhausted');
  await f.manager.pollControllerRecovery(Date.now()+1e9); assert.equal(f.turns.length,6);
  assert.equal(f.sent.filter(text=>text.includes('自动恢复已停止')).length,1);
});

test('新用户输入优先并取消旧恢复，stop和new也取消旧事件', async t => {
  for (const command of ['new message','/stop','/new']) {
    const f=fixture(t); await f.send(); const id=f.store.recoveries.active()[0]!.id;
    f.setRun(async turn=>{await turn.onPublicMessage!('final answer');});
    await f.send('next',command);
    await f.manager.pollControllerRecovery(Date.now()+1e9);
    assert.equal(f.store.recoveries.get(id)!.state,'cancelled');
    assert.equal(f.turns.filter(turn=>turn.event?.kind==='recovery').length,0);
  }
});

test('等待恢复跨桥重启保留，保持原native且不重放原用户消息', async t => {
  const f=fixture(t); await f.send(); const id=f.store.recoveries.active()[0]!.id;
  await f.restart(); assert.equal(f.store.recoveries.get(id)!.state,'pending');
  f.setRun(async turn=>{assert.equal(turn.event?.kind,'recovery'); await turn.onPublicMessage!('final answer');});
  await f.poll(); assert.equal(f.turns.length,2); assert.equal(f.store.recoveries.get(id)!.attempts,1);
});

test('恢复已经入队后重启仍只执行一次；队列与源消息身份保持绑定', async t => {
  const f=fixture(t); await f.send(); const pending=f.store.recoveries.active()[0]!;
  const queued=f.store.recoveries.queue(pending.id,pending.dueAt+1)!;
  f.registry.enqueueControllerRecovery({...queued.origin,purpose:'controller-recovery',controllerRecoveryId:queued.id},queued.taskId!,harnessText('manager.controller_recovery'));
  await f.manager.close();
  f.setRun(async turn=>{assert.equal(turn.event?.kind,'recovery'); await turn.onPublicMessage!('final answer');});
  await f.restart(); await until(()=>f.manager.isIdle());
  assert.equal(f.turns.length,2); assert.equal(f.store.recoveries.get(queued.id)!.state,'done');
});

test('鉴权失败和投递结果未知不自动恢复，恢复轮也不能用静默冒充已回复', async t => {
  const f=fixture(t); f.setRun(async()=>{throw new Error('401 unauthorized');}); await f.send(); assert.equal(f.store.recoveries.active().length,0);
  f.setRun(async()=>{throw new Error('502 upstream');}); await f.send('network');
  f.setRun(async()=>{}); await f.poll(); assert.equal(f.store.recoveries.active()[0]!.attempts,1);
  f.setRun(async turn=>{await turn.onPublicMessage!('final answer');}); f.setFailDelivery(true); await f.poll();
  assert.equal(f.store.recoveries.active().length,0);
  assert.equal(f.turns.length,4);
});

test('进程崩溃时正在执行的恢复结果未知，不重放；仅pending与queued保留', () => {
  const db=new DatabaseSync(':memory:'), journal=new ControllerRecoveryJournal(db);
  try {
    const origin={conversationId:'main',userId:'owner',channelId:'dm',originMessageId:'original',nativeId:'native',agent:'codex' as const,cwd:process.cwd()};
    const row=journal.schedule(origin,'failure',0), queued=journal.queue(row.id,30000)!;
    journal.start(row.id,queued.taskId!); journal.recover(40000);
    assert.equal(journal.get(row.id)!.state,'exhausted');
    for(const message of ['401 unauthorized','403 forbidden','413 Payload Too Large','invalid model','credential missing']) assert.equal(retryableControllerFailure(new Error(message)),false);
    for(const message of ['502 upstream','Claude 主控失败：error_during_execution','ETIMEDOUT']) assert.equal(retryableControllerFailure(new Error(message)),true);
  } finally { db.close(); }
});

for (const failure of ['502 report stream interrupted','主控本轮协调调用过多，已停止继续派发。']) test(`助手结果汇报中断可恢复且不重跑助手：${failure}`, async t => {
  const f=fixture(t);
  f.setRun(async turn=>{await turn.onPublicMessage!('original reply');}); await f.send();
  const source=f.store.getMessage('original')!, parent=f.store.getConversation(source.conversationId!)!;
  const context=f.registry.createContext({conversationId:parent.id,userId:'owner',channelId:'dm',originMessageId:source.id,nativeId:parent.nativeId,agent:parent.agent,cwd:parent.cwd});
  const {taskId}=f.registry.register(JSON.parse((await import('node:fs')).readFileSync(context.contextPath,'utf8')),'finished worker');
  f.registry.acceptObservedResult(taskId,'completed','already completed execution evidence'); f.registry.closeContext(context.contextId);
  f.setRun(async()=>{throw new Error(failure);});
  f.manager.completionAvailable(); await until(()=>f.manager.isIdle());
  const row=f.store.recoveries.active()[0]!; assert(row); assert.equal(row.origin.originMessageId,source.id);
  f.setRun(async turn=>{assert.equal(turn.event?.kind,'recovery'); assert(turn.bridgeFeedback?.records.some(r=>r.workerResultKnown===true)); await turn.onPublicMessage!('final answer');});
  await f.poll(); assert.equal(f.store.recoveries.get(row.id)!.state,'done');
  assert.equal(f.registry.completionForTask(taskId)!.status,'completed');
});

test('五次冷却严格从20秒起按1.5倍递增，未到期不启动', () => {
  const db=new DatabaseSync(':memory:'), journal=new ControllerRecoveryJournal(db);
  try {
    assert.deepEqual([0,1,2,3,4].map(recoveryBackoffMs),[20000,30000,45000,67500,101250]);
    const origin={conversationId:'main',userId:'owner',channelId:'dm',originMessageId:'original',nativeId:'native',agent:'codex' as const,cwd:process.cwd()};
    const first=journal.schedule(origin,'backoff-failure',0); assert.equal(first.dueAt,20000);
    for(let attempt=1;attempt<=5;attempt++){
      const pending=journal.get(first.id)!;
      assert.equal(journal.queue(first.id,pending.dueAt-1),null);
      const queued=journal.queue(first.id,pending.dueAt)!; assert.equal(queued.attempts,attempt);
      journal.start(first.id,queued.taskId!); journal.finish(first.id,queued.taskId!,false,true,pending.dueAt+100);
      const next=journal.get(first.id)!;
      assert.equal(next.state,attempt<5?'pending':'exhausted');
      if(attempt<5)assert.equal(next.dueAt,pending.dueAt+100+recoveryBackoffMs(attempt));
    }
  } finally { db.close(); }
});

test('助手的413失败结果只作为汇报证据，不触发主控自动恢复', async t => {
  const f=fixture(t); f.setRun(async turn=>{await turn.onPublicMessage!('final answer');}); await f.send();
  const source=f.store.getMessage('original')!, parent=f.store.getConversation(source.conversationId!)!;
  const context=f.registry.createContext({conversationId:parent.id,userId:'owner',channelId:'dm',originMessageId:source.id,nativeId:parent.nativeId,agent:parent.agent,cwd:parent.cwd});
  const {taskId}=f.registry.register(JSON.parse((await import('node:fs')).readFileSync(context.contextPath,'utf8')),'worker image check');
  f.registry.acceptObservedResult(taskId,'failed','413 Payload Too Large while imageView'); f.registry.closeContext(context.contextId);
  f.manager.completionAvailable(); await until(()=>f.manager.isIdle());
  assert.equal(f.turns.length,2); assert.equal(f.turns[1]!.event?.kind,'worker-result');
  assert.equal(f.store.recoveries.active().length,0);
  await f.manager.pollControllerRecovery(Date.now()+1e9); assert.equal(f.turns.length,2);
});

for (const succeeds of [true,false]) test(`定时唤醒中断进入同一恢复链，保留任务且中间静默：${succeeds}`, async t => {
  const f=fixture(t); f.setRun(async turn=>{await turn.onPublicMessage!('original reply');}); await f.send();
  const source=f.store.getMessage('original')!, parent=f.store.getConversation(source.conversationId!)!;
  const context=f.registry.createContext({conversationId:parent.id,userId:'owner',channelId:'dm',originMessageId:source.id,nativeId:parent.nativeId,agent:parent.agent,cwd:parent.cwd,purpose:'schedule',scheduleKind:'controller'});
  const {taskId}=f.registry.register(JSON.parse((await import('node:fs')).readFileSync(context.contextPath,'utf8')),'定时自唤醒 · 检查交付');
  f.registry.acceptObservedResult(taskId,'completed','检查已交付版本并继续验收'); f.registry.closeContext(context.contextId);
  f.setRun(async()=>{throw new Error('Claude 主控失败：error_during_execution');});
  const before=f.sent.length;
  f.manager.completionAvailable(); await until(()=>f.manager.isIdle());
  const pending=f.store.recoveries.active()[0]!; assert(pending);
  assert.equal(f.sent.length,before+1); assert(f.sent.at(-1)!.includes('第1/5次'));
  assert(f.sent.at(-1)!.includes('定时自唤醒')); assert(f.sent.at(-1)!.includes('来源：定时唤醒'));
  await f.restart();
  f.setRun(async turn=>{
    assert.equal(turn.event?.kind,'recovery'); assert(turn.text.includes('检查已交付版本并继续验收'));
    if(succeeds) await turn.onPublicMessage!('final answer'); else throw new Error('502 upstream');
  });
  for(let attempt=1;attempt<=(succeeds?1:5);attempt++){
    await f.poll();
    assert.equal(f.sent.length,before+1+(succeeds||attempt===5?1:0));
  }
  assert.equal(f.store.recoveries.get(pending.id)!.state,succeeds?'done':'exhausted');
  if(!succeeds){assert(f.sent.at(-1)!.includes('第5/5次恢复失败'));assert(f.sent.at(-1)!.includes('来源：定时唤醒'));}
  assert.equal(f.registry.completionForTask(taskId)!.status,'completed');
  assert.equal(f.turns.filter(turn=>turn.event?.kind==='wake').length,1);
});
