import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { TaskRegistry, type TaskCompletionEvent, type TaskContextFile } from '../src/tasks.js';
import { DeliveryPreparationError } from '../src/delivery-errors.js';
import type { AgentAdapter, AgentTurn, BridgeConfig, BridgeMessage } from '../src/types.js';
import type { DispatchFailureBatch } from '../src/dispatch-failures.js';
import { ownTemporaryDirectory } from './temp-directory.js';

async function until(check:()=>boolean):Promise<void>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('失败红点测试等待超时');await setTimeout(2);}}
let serial=100000000000000000n;
function fixture(t:TestContext,botId='test-bot'){
  const root=ownTemporaryDirectory(mkdtempSync(join(tmpdir(),'dispatch-failures-')),'dispatch-failures-');
  const config:BridgeConfig={token:'secret-token',botId,ownerUserId:'owner',allowedUserIds:['owner'],defaultAgent:'codex',controllerMode:true,workspace:root,dataDir:root,
    logsDir:root,attachmentsDir:root,proxyUrl:null,maxImageBytes:10,commands:{codex:{command:'fake',args:[]},claude:{command:'fake',args:[]}}};
  const tasks=new TaskRegistry(root),store=new SessionStore(root),calls:AgentTurn[]=[],sent:Array<{channel:string;text:string}>=[],forwarded:TaskCompletionEvent[]=[];
  let handler:((turn:AgentTurn)=>void|Promise<void>)|undefined,sendError:Error|undefined;
  const adapter:AgentAdapter={async run(turn){calls.push(turn);const nativeId=turn.conversation.nativeId??'native-'+turn.conversation.id;turn.onNativeId?.(nativeId);
    await handler?.(turn);
    if(!turn.event)await turn.onPublicMessage?.('正常确认：让助手查，稍后回报。',[],'final-'+calls.length);
    else if(turn.groupContext)await turn.onSilent?.();
    return{nativeId,text:'',controlledOutput:true};},async interrupt(){},async close(){}};
  const options={mergeDelayMs:0,taskRegistry:tasks,onGroupTurnStart:async()=>'',onGroupTurnFinished:async()=>{},onGroupSilent:async()=>{},
    onGroupCompletion:async(event:TaskCompletionEvent)=>{forwarded.push(event);return 'queued' as const;}};
  const sink={async sendText(channel:string,text:string){if(sendError)throw sendError;sent.push({channel,text});}};
  let manager=new SessionManager(config,{codex:adapter,claude:adapter},sink,options);
  const message=(text:string,groupContext?:AgentTurn['groupContext'],channelId=groupContext?.originChannelId??'dm-owner'):BridgeMessage=>({id:String(++serial),userId:'owner',channelId,text,imagePaths:[],...(groupContext?{groupContext}:{})});
  const send=async(text:string,callback?:typeof handler,group?:AgentTurn['groupContext'],channel?:string)=>{handler=callback;await manager.handle(message(text,group,channel));await until(()=>manager.isIdle());handler=undefined;};
  const failure=(turn:AgentTurn,call='failed-call',title='原目标')=>{
    const result=manager.recordDispatchFailure(turn,'bridge_start_worker',{title,targetId:'workstation',cwd:'F:\\HaruTrunk\\Client'},call,new Error('ENOENT: missing cwd; secret-token'))!;
    const id=/ID：([a-f0-9]{64})/.exec(result)![1]!;return{id,result};
  };
  t.after(async()=>{await manager.close();store.close();tasks.close();});
  return{config,tasks,store,calls,sent,forwarded,message,send,failure,get manager(){return manager;},
    setHandler(value:typeof handler){handler=value;},setSendError(value:Error|undefined){sendError=value;},
    async reopen(){await manager.close();manager=new SessionManager(config,{codex:adapter,claude:adapter},sink,options);await manager.recover();},
    async poll(offset=31000){await manager.pollDispatchFailures(Date.now()+offset);await until(()=>manager.isIdle());}};
}

test('09:59 regression: synchronous dispatch failure plus normal acknowledgement and DONE leaves a durable red dot',async t=>{
  const f=fixture(t);let id='';await f.send('查一下',turn=>{const first=f.failure(turn);id=first.id;assert(!first.result.includes('secret-token'));assert.match(first.result,/不能证明助手是否已建立或提交/);
    assert.equal(f.failure(turn).id,id,'same source/call must deduplicate');});
  const row=f.store.dispatchFailures.get(id)!;assert.equal(row.handledAt,null);assert.equal(row.origin.originMessageId,row.sourceId);assert.equal(row.cwd,'F:\\HaruTrunk\\Client');
  assert.equal(row.targetId,'workstation');assert.equal(f.tasks.queuedEvents().length,0);assert.equal(f.calls.length,1);
  let listed:DispatchFailureBatch|undefined;await f.send('看一下',turn=>{listed=f.manager.invokeDispatchFailureTool(turn,'bridge_list_dispatch_failures',{}) as DispatchFailureBatch;});
  assert.equal(listed!.records.length,1);assert.equal(f.store.dispatchFailures.get(id)!.handledAt,null,'reading and responding do not acknowledge');
  await f.poll();assert.equal(f.calls.length,3);assert.equal(f.calls[2]!.event?.kind,'wake');assert.equal(f.calls[2]!.dispatchFailures!.records[0]!.id,id);
  assert.equal(f.store.dispatchFailures.get(id)!.reminders,1);assert.equal(f.store.dispatchFailures.get(id)!.handledAt,null);
});

test('empty failures and ordinary registered/running assistants never cause a red-dot wake',async t=>{
  const f=fixture(t);await f.send('hello');const active=f.manager.currentConversation('owner')!;
  const ctx=f.tasks.createContext({conversationId:active.id,userId:'owner',channelId:'dm-owner',originMessageId:f.calls[0]!.source!.messageId,nativeId:active.nativeId,agent:'codex',cwd:active.cwd});
  const capability=JSON.parse(readFileSync(ctx.contextPath,'utf8')) as TaskContextFile,task=f.tasks.register(capability,'normal engineering assistant');
  assert.equal(f.tasks.getTask(task.taskId)!.status,'registered');await f.poll();
  f.tasks.setWatch(capability,task.taskId,{completionFile:join(f.config.dataDir,'not-yet-finished.json')});assert.equal(f.tasks.getTask(task.taskId)!.status,'running');
  await f.poll(90000);assert.equal(f.calls.length,1);assert.equal(f.tasks.queuedEvents().length,0);f.tasks.closeContext(ctx.contextId);
});

test('only explicit acknowledgement clears the record; handled history survives restart',async t=>{
  const f=fixture(t);let id='';await f.send('fail',turn=>{id=f.failure(turn).id;});
  await f.send('处理',turn=>{const result=f.manager.invokeDispatchFailureTool(turn,'bridge_ack_dispatch_failure',{id,note:'已核对并重新安排'}) as {handled:boolean};assert.equal(result.handled,true);});
  const handled=f.store.dispatchFailures.get(id)!.handledAt;assert(handled);
  await f.reopen();await f.poll();assert.equal(f.calls.length,2);assert.equal(f.store.dispatchFailures.get(id)!.handledAt,handled);
  await f.send('history',turn=>{const pending=f.manager.invokeDispatchFailureTool(turn,'bridge_list_dispatch_failures',{}) as DispatchFailureBatch;assert.equal(pending.records.length,0);
    const history=f.manager.invokeDispatchFailureTool(turn,'bridge_list_dispatch_failures',{includeHandled:true}) as DispatchFailureBatch;assert.equal(history.records[0]!.handled,true);});
});

test('busy controller is not interrupted or run concurrently and due failures merge into one idle review',async t=>{
  const f=fixture(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let id='';
  f.setHandler(async turn=>{id=f.failure(turn,'one','first').id;f.failure(turn,'two','second');await gate;});
  await f.manager.handle(f.message('busy'));await until(()=>!!id);
  await f.manager.pollDispatchFailures(Date.now()+90000);assert.equal(f.calls.length,1);assert.equal(f.tasks.queuedEvents().length,0);
  release();await until(()=>f.manager.isIdle());f.setHandler(undefined);await f.poll();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.dispatchFailures!.records.length,2);assert.equal(f.tasks.queuedEvents().length,0);
});

test('restart retains pending progress and three reminders without ack pause the item with one confirmed DM notification',async t=>{
  const f=fixture(t);let id='';await f.send('fail',turn=>{id=f.failure(turn).id;});await f.reopen();
  for(let n=0;n<3;n++)await f.poll(31000+n*31000);
  const paused=f.store.dispatchFailures.get(id)!;assert.equal(paused.reminders,3);assert.equal(paused.autoState,'paused');assert.equal(paused.handledAt,null);
  const calls=f.calls.length,before=f.sent.length;await f.poll(200000);assert.equal(f.sent.length,before+1);assert.equal(f.sent.at(-1)!.channel,'dm-owner');
  await f.reopen();await f.poll(300000);assert.equal(f.calls.length,calls);assert.equal(f.sent.length,before+1);assert.equal(f.store.dispatchFailures.get(id)!.notified,true);
});

test('known-unsent pause notice retries, unknown delivery never blindly resends',async t=>{
  const f=fixture(t);let id='';await f.send('fail',turn=>{id=f.failure(turn).id;});for(let n=0;n<3;n++)await f.poll(31000+n*31000);
  f.setSendError(new DeliveryPreparationError('known not sent'));await f.poll(200000);assert.equal(f.store.dispatchFailures.get(id)!.notified,undefined);
  assert.equal(f.store.dispatchFailures.get(id)!.notificationState,undefined);
  f.setSendError(Object.assign(new Error('send acknowledgement lost'),{deliveryUncertain:true}));await f.poll(210000);
  assert.equal(f.store.dispatchFailures.get(id)!.notificationState,'unknown');const sent=f.sent.length;
  f.setSendError(undefined);await f.reopen();await f.poll(250000);assert.equal(f.sent.length,sent);
});

test('/stop and /new leave unresolved history but disable the old execution authority and review wake',async t=>{
  const f=fixture(t);let first='';await f.send('fail',turn=>{first=f.failure(turn).id;});
  await f.manager.handle(f.message('/stop'));await until(()=>f.manager.isIdle());await f.poll();
  assert.equal(f.store.dispatchFailures.get(first)!.autoState,'inactive');assert.equal(f.store.dispatchFailures.get(first)!.handledAt,null);assert.equal(f.calls.length,1);
  let second='';await f.send('new failure',turn=>{second=f.failure(turn,'new-call').id;});
  await f.manager.handle(f.message('/new'));await until(()=>f.manager.isIdle());await f.poll();
  assert.equal(f.store.dispatchFailures.get(second)!.autoState,'inactive');assert.equal(f.store.dispatchFailures.get(second)!.handledAt,null);
  assert.equal(f.calls.filter(c=>c.event?.kind==='wake').length,0);
});

test('scope isolation covers bots, private channels and distinct group roots; queued group review cleared by ack never reaches a model',async t=>{
  const f=fixture(t),other=fixture(t,'other-bot');
  const group=(rootId:string):NonNullable<AgentTurn['groupContext']>=>({eventId:'initial-'+rootId,rootId,botId:'test-bot',spaceId:'space',generation:1,bindingEpoch:1,originChannelId:'group-channel',principalId:'principal',scene:''});
  let id='';await f.send('group failure',turn=>{id=f.failure(turn).id;},group('root-a'));
  await f.send('other group',turn=>{assert.equal(turn.dispatchFailures!.records.length,0);assert.throws(()=>f.manager.invokeDispatchFailureTool(turn,'bridge_ack_dispatch_failure',{id}),/不属于/);},group('root-b'));
  await other.send('other bot',turn=>{assert.throws(()=>other.manager.invokeDispatchFailureTool(turn,'bridge_ack_dispatch_failure',{id}),/不存在/);});
  await f.poll();assert.equal(f.forwarded.length,1);assert.equal(f.store.dispatchFailures.get(id)!.reminders,0,'Host enqueue is not an LLM reminder');
  const event=f.forwarded[0]!;await f.send('ack before queued model',turn=>{f.manager.invokeDispatchFailureTool(turn,'bridge_ack_dispatch_failure',{id});},group('root-a'));
  const before=f.calls.length;
  await f.manager.handleHostEvent(f.message(event.text,{...group('root-a'),eventId:'host-review',eventKind:'wake',dispatchFailureReviewId:event.taskId}),'wake');
  await until(()=>f.manager.isIdle());assert.equal(f.calls.length,before);assert.equal(f.store.dispatchFailures.get(id)!.reminders,0);
});

test('group review only counts on manager.run and sends a pause notice to an existing owner DM, never the group',async t=>{
  const f=fixture(t);const group:NonNullable<AgentTurn['groupContext']>={eventId:'human-group',rootId:'root',botId:'test-bot',spaceId:'space',generation:1,bindingEpoch:1,originChannelId:'group-channel',principalId:'principal',scene:''};
  await f.send('establish owner DM');let id='';await f.send('group failure',turn=>{id=f.failure(turn).id;},group);
  for(let n=0;n<3;n++){
    await f.poll(31000+n*31000);const event=f.forwarded.at(-1)!;
    await f.manager.handleHostEvent(f.message(event.text,{...group,eventId:'host-'+n,eventKind:'wake',dispatchFailureReviewId:event.taskId}),'wake');await until(()=>f.manager.isIdle());
  }
  assert.equal(f.store.dispatchFailures.get(id)!.reminders,3);const before=f.sent.length;await f.poll(200000);
  assert.equal(f.sent.length,before+1);assert.equal(f.sent.at(-1)!.channel,'dm-owner');
});

test('forged review IDs do not wake a model, and abort/invalid source does not create a new red dot',async t=>{
  const f=fixture(t);await f.send('start');const group:NonNullable<AgentTurn['groupContext']>={eventId:'forged-event',rootId:'root',botId:'test-bot',spaceId:'space',generation:1,bindingEpoch:1,originChannelId:'group',principalId:'principal',scene:'',eventKind:'wake',dispatchFailureReviewId:'forged-review'};
  const before=f.calls.length;await f.manager.handleHostEvent(f.message('not trusted',group),'wake');await until(()=>f.manager.isIdle());assert.equal(f.calls.length,before);
  const old=f.calls[0]!;assert.equal(f.manager.recordDispatchFailure(old,'bridge_start_worker',{},'stale',new Error('late failure')),undefined);
  assert.equal(f.store.dispatchFailures.hasWork(),false);
});

test('a missing task capability file cannot suppress a failure already tied to the active authenticated inbox',async t=>{
  const f=fixture(t);let id='';await f.send('bad capability',turn=>{turn.taskContextPath=join(f.config.dataDir,'missing-context.json');id=f.failure(turn).id;});
  assert.equal(f.store.dispatchFailures.get(id)!.handledAt,null);await f.poll();assert.equal(f.store.dispatchFailures.get(id)!.reminders,1);
});

test('a real worker-progress event remains a trusted failure source even when its capability file is unavailable',async t=>{
  const f=fixture(t);await f.send('start task');const active=f.manager.currentConversation('owner')!;
  const ctx=f.tasks.createContext({conversationId:active.id,userId:'owner',channelId:'dm-owner',originMessageId:f.calls[0]!.source!.messageId,nativeId:active.nativeId,agent:'codex',cwd:active.cwd});
  const task=f.tasks.register(JSON.parse(readFileSync(ctx.contextPath,'utf8')) as TaskContextFile,'observed engineering worker');
  assert(f.tasks.observeTask(task.taskId,'tool-wait','真实工具仍在运行，需主控判断'));
  let id='';f.setHandler(turn=>{if(turn.event?.kind==='worker-progress'){turn.taskContextPath=join(f.config.dataDir,'missing-observation-context.json');id=f.failure(turn).id;}});
  f.manager.completionAvailable();await until(()=>!!id&&f.manager.isIdle());f.setHandler(undefined);
  const row=f.store.dispatchFailures.get(id)!;assert.equal(row.origin.originMessageId,f.calls[0]!.source!.messageId);
  assert.equal(row.sourceId,f.calls[1]!.source!.messageId);assert.equal(row.handledAt,null);await f.poll();assert.equal(f.store.dispatchFailures.get(id)!.reminders,1);
});

test('a Host-cancelled queued review stops automatic reminders without pretending the original failure was handled',async t=>{
  const f=fixture(t),group:NonNullable<AgentTurn['groupContext']>={eventId:'owner-group',rootId:'budget-root',botId:'test-bot',spaceId:'space',generation:1,bindingEpoch:1,originChannelId:'group-channel',principalId:'principal',scene:''};
  let id='';await f.send('group failure',turn=>{id=f.failure(turn).id;},group);await f.poll();const event=f.forwarded[0]!;
  assert.equal(f.store.dispatchFailures.get(id)!.reminders,0);
  f.manager.invalidateDispatchFailureReview(event.taskId);await f.poll(200000);
  assert.equal(f.forwarded.length,1);assert.equal(f.calls.length,1);assert.equal(f.store.dispatchFailures.get(id)!.autoState,'inactive');
  assert.equal(f.store.dispatchFailures.get(id)!.handledAt,null);
});
