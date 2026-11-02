import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownTemporaryDirectory} from './temp-directory.js';
import {ControllerRuntime} from '../src/controller/runtime.js';
import {TaskRegistry} from '../src/tasks.js';
import {DeliveryPreparationError,ScheduledMessageDeferredError} from '../src/delivery-errors.js';
import type {ControllerRuntimeCallbacks,ControllerSchedule} from '../src/controller/runtime-types.js';
import type {AgentAdapter,AgentTurn,BridgeConfig} from '../src/types.js';
function setup(t:TestContext){
 const dir=ownTemporaryDirectory(mkdtempSync(join(tmpdir(),'bridge-direct-message-')),'bridge-direct-message-');
 const registry=new TaskRegistry(dir);
 const config:BridgeConfig={token:'test',allowedUserIds:['owner'],defaultAgent:'codex',workspace:dir,dataDir:dir,logsDir:dir,attachmentsDir:dir,proxyUrl:null,maxImageBytes:100,commands:{codex:{command:'unused',args:[]},claude:{command:'unused',args:[]}}};
 const conversation={id:'parent',userId:'owner',nativeId:'native-parent',agent:'codex' as const,cwd:dir,title:'parent',createdAt:'2026-11-02',updatedAt:'2026-11-02'};
 const context=registry.createContext({conversationId:'parent',userId:'owner',nativeId:'native-parent',agent:'codex',cwd:dir,channelId:'private-channel',originMessageId:'source'});
 const abort=new AbortController();
 const turn:AgentTurn={conversation,text:'original',imagePaths:[],taskContextPath:context.contextPath,signal:abort.signal,onProgress:()=>{}};
 let now=Date.parse('2026-11-02T13:00:00Z'),modelRuns=0,wakes=0,preparations=0;
 const sent:ControllerSchedule[]=[],errors:unknown[]=[];
 const adapter:AgentAdapter={run:async()=>{modelRuns++;throw Error('Direct message must not invoke an agent');},interrupt:async()=>{},close:async()=>{}};
 const callbacks:ControllerRuntimeCallbacks={now:()=>now,pollIntervalMs:3600000,onCompletion:()=>{wakes++;},onError:error=>{errors.push(error);},
  prepareScheduledMessage:async()=>{preparations++;return{source:{botId:'bot',principalId:'person',generation:1,conversationId:'parent',userId:'owner',channelId:'private-channel',messageId:'source'},target:{id:'private',kind:'private',botId:'bot',principalId:'person',channelId:'private-channel',userId:'owner'}};},
  sendScheduledMessage:async plan=>{sent.push(plan);}};
 let runtime=new ControllerRuntime(config,{codex:adapter,claude:adapter},registry,callbacks);
 t.after(async()=>{await runtime.close();registry.close();});
 return{runtime,registry,turn,abort,sent,errors,callbacks,advance:(ms:number)=>{now+=ms;},get modelRuns(){return modelRuns;},get wakes(){return wakes;},get preparations(){return preparations;},
  restart:async()=>{await runtime.close();runtime=new ControllerRuntime(config,{codex:adapter,claude:adapter},registry,callbacks);return runtime;}};
}
const args={targetId:'private',afterSeconds:30,text:'  原文\n保留末尾空格  '};
const handle=async(f:ReturnType<typeof setup>,id='same-call')=>await f.runtime.invoke(f.turn,'bridge_schedule_message',args,id) as {scheduleId:string;kind:string};
test('fixed messages preserve text, return durable receipts, and send once without any model or wake',async t=>{
 const f=setup(t),receipt=await handle(f);
 assert.equal(receipt.kind,'message');assert.deepEqual(await handle(f),receipt);assert.equal(f.preparations,1);
 f.advance(29000);await f.runtime.poll();assert.equal(f.sent.length,0);
 f.advance(1001);await Promise.all([f.runtime.poll(),f.runtime.poll(),f.runtime.poll()]);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0]!.text,args.text);assert.equal(f.modelRuns,0);assert.equal(f.wakes,0);
 assert.equal(f.runtime.store.workers().length,0);assert.equal(f.runtime.store.getSchedule(receipt.scheduleId)?.status,'completed');
 await f.runtime.poll();assert.equal(f.sent.length,1);
});
test('concurrent due polls claim before awaiting delivery and maintenance waits for admitted sending',async t=>{
 const f=setup(t);await handle(f);let release!:()=>void;
 f.callbacks.sendScheduledMessage=()=>new Promise<void>(resolve=>{release=resolve;});
 f.advance(31000);const first=f.runtime.poll();
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 await f.runtime.poll();assert.equal(f.runtime.isIdle(),false);
 f.runtime.beginDrain();release();await first;assert.equal(f.runtime.isIdle(),true);
});
test('pending/overdue schedules survive restart; acknowledged completed schedules never resend',async t=>{
 const f=setup(t),receipt=await handle(f);f.advance(31000);
 let second=await f.restart();await second.start();assert.equal(f.sent.length,1);
 assert.equal(second.store.getSchedule(receipt.scheduleId)?.status,'completed');
 second=await f.restart();await second.start();await second.poll();assert.equal(f.sent.length,1);assert.equal(f.modelRuns,0);assert.equal(f.wakes,0);
});
test('restart reconciles an acknowledged interrupted send, and preserves unknown sends without replay',async t=>{
 for(const acknowledged of [true,false])await t.test(String(acknowledged),async t=>{
  const f=setup(t),receipt=await handle(f);const plan=f.runtime.store.getSchedule(receipt.scheduleId)!;
  plan.status='dispatching';f.runtime.store.saveSchedule(plan);f.callbacks.scheduledMessageDelivered=()=>acknowledged;
  const second=await f.restart();f.advance(31000);await second.start();await second.poll();
  assert.equal(second.store.getSchedule(plan.id)?.status,acknowledged?'completed':'uncertain');assert.equal(f.sent.length,0);assert.equal(f.wakes,0);
  if(!acknowledged){const listed=await second.invoke(f.turn,'bridge_list_schedules',{}) as {schedules:unknown[]};assert.equal(listed.schedules.length,1);}
 });
});
test('known rejection, ambiguous delivery and maintenance deferral have distinct durable outcomes',async t=>{
 for(const [error,status]of [[new DeliveryPreparationError('access revoked'),'failed'],[new Error('ack lost'),'uncertain'],[new ScheduledMessageDeferredError('draining'),'pending']]as const)await t.test(status,async t=>{
  const f=setup(t),receipt=await handle(f);let attempts=0;
  f.callbacks.sendScheduledMessage=async()=>{attempts++;throw error;};f.advance(31000);await f.runtime.poll();
  assert.equal(f.runtime.store.getSchedule(receipt.scheduleId)?.status,status);assert.equal(f.wakes,0);assert.equal(f.modelRuns,0);
  if(status==='pending'){f.callbacks.sendScheduledMessage=async()=>{attempts++;};await f.runtime.poll();assert.equal(attempts,2);}
  else{await f.runtime.poll();assert.equal(attempts,1);}
 });
});
test('query, timezone reschedule, cancel and reset apply to direct messages with the same scope',async t=>{
 const f=setup(t),receipt=await handle(f);
 await f.runtime.invoke(f.turn,'bridge_update_schedule',{scheduleId:receipt.scheduleId,dueAt:'2026-11-02T21:02:00+08:00'});
 assert.equal(f.runtime.store.getSchedule(receipt.scheduleId)?.dueAt,'2026-11-02T13:02:00.000Z');
 await f.runtime.invoke(f.turn,'bridge_cancel_schedule',{scheduleId:receipt.scheduleId});
 await f.runtime.invoke(f.turn,'bridge_cancel_schedule',{scheduleId:receipt.scheduleId});
 const another=await handle(f,'another');await f.runtime.detachConversation('parent');f.advance(300000);await f.runtime.poll();
 assert.equal(f.runtime.store.getSchedule(another.scheduleId)?.status,'cancelled');assert.equal(f.sent.length,0);
});
test('start/maintenance and backend handoff pause unattempted messages, retaining destination and text',async t=>{
 const f=setup(t),receipt=await handle(f);let ready=false;f.callbacks.canSendScheduledMessage=()=>ready;
 f.advance(31000);await f.runtime.poll();assert.equal(f.sent.length,0);
 const target={...f.turn.conversation,id:'new-parent',nativeId:'new-native',agent:'claude' as const};
 await f.runtime.rebindConversation(f.turn.conversation,target);ready=true;await f.runtime.poll();assert.equal(f.sent.length,0);
 f.runtime.resumeConversation(target.id);await f.runtime.poll();
 assert.equal(f.sent.length,1);assert.equal(f.sent[0]!.message?.source.conversationId,target.id);
 assert.equal(f.sent[0]!.message?.target.id,'private');assert.equal(f.runtime.store.getSchedule(receipt.scheduleId)?.status,'completed');
});
test('a reset while destination authorization awaits prevents a late registration',async t=>{
 const f=setup(t);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(done=>{release=done;});const started=new Promise<void>(done=>{entered=done;});
 const prepare=f.callbacks.prepareScheduledMessage!;
 f.callbacks.prepareScheduledMessage=async(turn,target)=>{entered();await gate;return prepare(turn,target);};
 const registering=handle(f);const rejected=assert.rejects(registering);
 await started;await f.runtime.detachConversation('parent');release();await rejected;assert.equal(f.runtime.store.schedules().length,0);
});
test('bad time, raw payload limits and destination failures cannot create a plan',async t=>{
 const f=setup(t);
 for(const input of [{...args,afterSeconds:0},{...args,afterSeconds:undefined},{...args,dueAt:'2026-11-02T21:00:30'}, {...args,text:' '},{...args,text:'x'.repeat(16001)},{...args,text:'a\0b'},{...args,targetId:''}])await assert.rejects(f.runtime.invoke(f.turn,'bridge_schedule_message',input));
 f.callbacks.prepareScheduledMessage=async()=>{throw new DeliveryPreparationError('unknown destination');};
 await assert.rejects(handle(f));assert.equal(f.runtime.store.schedules().length,0);assert.equal(f.modelRuns,0);
});

test('Bot alarms survive new/new-c and restart, follow the ready controller, and explicit stop cancels them',async t=>{
 const f=setup(t);let current={...f.turn.conversation};f.callbacks.currentScheduleConversation=()=>current;
 const message=await handle(f),wake=await f.runtime.invoke(f.turn,'bridge_schedule_controller',{afterSeconds:30,text:'follow up'}) as {scheduleId:string};
 await f.runtime.detachConversation(current.id);current={...current,id:'new',nativeId:'new-native'};
 await f.runtime.poll();assert.equal(f.runtime.store.getSchedule(message.scheduleId)?.origin.conversationId,'new');
 await f.runtime.detachConversation(current.id);current={...current,id:'new-c',nativeId:'new-c-native'};
 let ready=false;f.callbacks.canSendScheduledMessage=()=>ready;
 f.advance(31000);await f.runtime.poll();assert.equal(f.sent.length,0);assert.equal(f.wakes,0);
 const runtime=await f.restart();await runtime.start();assert.equal(f.sent.length,0);
 ready=true;await runtime.poll();assert.equal(f.sent.length,1);assert.equal(f.wakes,1);assert.equal(f.modelRuns,0);
 const plan=runtime.store.getSchedule(wake.scheduleId)!;assert.equal(plan.origin.conversationId,'new-c');assert.equal(plan.origin.nativeId,'new-c-native');assert.equal(plan.origin.reboundFrom?.[0]?.conversationId,'parent');
 assert.equal(f.sent[0]!.message?.source.conversationId,'new-c');assert.equal(f.sent[0]!.message?.target.channelId,'private-channel');
 const context=f.registry.createContext({...plan.origin,originMessageId:'new-owner-input'}),turn={...f.turn,conversation:current,taskContextPath:context.contextPath};
 const all=await runtime.invoke(turn,'bridge_list_schedules',{includeFinished:true}) as {schedules:unknown[]};assert.equal(all.schedules.length,2);
 const pending=await runtime.invoke(turn,'bridge_schedule_message',args) as {scheduleId:string};
 current={...current,id:'another-new',nativeId:'another-native'};
 await runtime.cancelConversation(current.id);assert.equal(runtime.store.getSchedule(pending.scheduleId)?.status,'cancelled');
});
