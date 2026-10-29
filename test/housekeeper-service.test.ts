import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HousekeeperService, type HousekeeperCallbacks } from '../src/housekeeper/service.js';
import type { HousekeeperRun, HousekeeperState } from '../src/housekeeper/store.js';
import type { TransactionSourceOptions, TransactionSnapshot } from '../src/housekeeper/sources.js';
import type { ControllerJob } from '../src/controller/runtime-types.js';
import type { BridgeConfig, BridgeMessage, Conversation } from '../src/types.js';
import type { TaskCompletionEvent } from '../src/tasks.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const clockStart = Date.parse('2026-10-30T00:00:00Z');
function snapshot(options: TransactionSourceOptions, rows = 1, hasMore = false, tag = 'r1', status: 'ok'|'empty'|'partial'|'error' = rows ? 'ok' : 'empty'): TransactionSnapshot {
  const body = { version: 1 as const, trust: 'source_material' as const, window: { start: options.enabledAt, end: options.cutoff! },
    sources: [{id:'feishu',site:'feishu',label:'飞书',status,records: rows ? [{identity:'message',scope:'chat',revision:tag,operation:'upsert' as const,
      occurredAt:'2026-10-30T00:00:00Z',publishedAt:'2026-10-30T00:00:00Z',text:'source body',source:{file:'sources/feishu/batch/records.json',recordIndex:1,itemId:'item'}}] : [],
      coverage:{filesRead:1,rawRecords:rows,selectedRecords:rows,filteredRecords:0,duplicateRecords:0,skippedBeforeWindow:0,pendingBatches:hasMore?1:0,
        unreadRecords:hasMore?null:0,knownUnreadRecords:0,latestPublishedAt:null,warnings:[]}}] };
  return {...body,recordCount:rows,hasMore,nextCursor:{version:1,enabledAt:options.enabledAt,sources:{feishu:{batches:{},revisions:{['a'.repeat(64)]:tag}}}},text:JSON.stringify(body)};
}
function fixture() {
  const root=ownTemporaryDirectory(mkdtempSync(join(tmpdir(),'housekeeper-service-')),'housekeeper-service-');
  const config:BridgeConfig={token:'',allowedUserIds:['owner','other'],ownerUserId:'owner',defaultAgent:'codex',workspace:root,dataDir:root,
    logsDir:root,attachmentsDir:root,proxyUrl:null,maxImageBytes:100,commands:{codex:{command:'codex',args:[]},claude:{command:'claude',args:[]}}};
  let now=clockStart, paused=false, current:Conversation={id:'controller-1',userId:'owner',agent:'codex',nativeId:'native-1',model:'gpt-6-astra',effort:'low',
    controllerMode:true,cwd:root,title:'Production controller',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
  let makeSnapshot=(options:TransactionSourceOptions)=>snapshot(options), scanError:Error|undefined, dispatchError:Error|undefined;
  const scans:Array<{root:string;options:TransactionSourceOptions}>=[],dispatches:Array<{runId:string;state:HousekeeperState;prompt:string;workerId:string;jobId:string}>=[];
  const jobs=new Map<string,ControllerJob>(),events=new Map<string,{state:string|null;processed:boolean;safeToRetry?:true}>(),envelopes=new Map<string,TaskCompletionEvent>(),cancelled:string[]=[],retired:string[]=[],notifications:string[]=[],errors:unknown[]=[],reroutes:HousekeeperRun[]=[];
  let wakes=0,recoveryCalls=0,recovered:{workerId:string;jobId:string}|null=null;
  const callbacks:HousekeeperCallbacks={
    active:()=>current,
    scan:async(path,options)=>{scans.push({root:path,options});if(scanError)throw scanError;return makeSnapshot(options);},
    dispatch:async(runId,state,prompt)=>{
      if(dispatchError)throw dispatchError;
      const workerId=`worker-${dispatches.length+1}`,jobId=`job-${dispatches.length+1}`;
      const origin={conversationId:current.id,userId:state.userId,channelId:state.channelId,originMessageId:state.authorizationMessageId,agent:current.agent,nativeId:current.nativeId,cwd:root,purpose:'housekeeper' as const};
      jobs.set(jobId,{id:jobId,workerId,origin,prompt,imagePaths:[],status:'running',taskId:jobId,result:null,cancelReason:null,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()});
      dispatches.push({runId,state:structuredClone(state),prompt,workerId,jobId});return{workerId,jobId};
    },
    job:id=>jobs.get(id)??null,eventForJob:id=>[...envelopes.values()].find(e=>e.taskId===id)??null,cancel:async id=>{cancelled.push(id);for(const job of jobs.values())if(job.workerId===id){job.processStopped=true;if(job.status==='running')job.status='cancelled';}},event:id=>events.get(id)??{state:null,processed:false},
    reroute:async run=>{reroutes.push(structuredClone(run));const eventId=`rerouted-${reroutes.length}`,taskId=`rerouted-task-${reroutes.length}`;events.set(eventId,{state:'queued',processed:false});return{eventId,taskId,conversationId:current.id};},
    retireEvent:id=>{retired.push(id);events.set(id,{state:'retired',processed:true});},wake:()=>{wakes++;},
    notify:async(_state,text)=>{notifications.push(text);},onError:error=>{errors.push(error);},isPaused:()=>paused,now:()=>now,
  };
  // Optional recovery callback is assigned separately while keeping test fixtures compatible with its final signature.
  Object.assign(callbacks,{recoverRun:()=>{recoveryCalls++;return recovered;}});
  let service=new HousekeeperService(config,callbacks);
  const message=(userId='owner',id='enable-1'):BridgeMessage=>({id,userId,channelId:'private-owner',text:'/housekeeper on'} as BridgeMessage);
  const completion=(overrides:Partial<TaskCompletionEvent>={}):TaskCompletionEvent=>{
    const state=service.store.read()!,run=state.run!,job=jobs.get(run.jobId!)!;
    const event:TaskCompletionEvent={...job.origin,id:`event-${run.jobId}`,taskId:run.jobId!,title:'Summary',text:'Summary with evidence',status:'completed',wakeAllowed:true,...overrides};
    if(event.status==='completed'){job.status='completed';job.result=event.text;job.processStopped=true;job.nativeResult={nativeId:'reader-native',text:event.text,processStopped:true};}
    events.set(event.id,{state:'queued',processed:false});envelopes.set(event.id,event);return event;
  };
  return {config,callbacks,scans,dispatches,jobs,events,cancelled,retired,notifications,errors,reroutes,message,completion,
    get service(){return service;},get current(){return current;},get wakes(){return wakes;},get recoveryCalls(){return recoveryCalls;},
    advance(ms:number){now+=ms;},setActive(value:Partial<Conversation>){current={...current,...value};},setPaused(value:boolean){paused=value;},
    setScan(value:(options:TransactionSourceOptions)=>TransactionSnapshot){makeSnapshot=value;},setScanError(value:Error|undefined){scanError=value;},setDispatchError(value:Error|undefined){dispatchError=value;},
    setRecovered(value:{workerId:string;jobId:string}|null){recovered=value;},
    async reopen(){await service.close();service=new HousekeeperService(config,callbacks);},async close(){await service.close();}};
}

test('housekeeper defaults off, requires the owner and opens an immediate fixed twenty-minute interval',async t=>{
  const f=fixture();t.after(()=>f.close());f.setScan(o=>snapshot(o,0));
  await f.service.poll();assert.equal(f.scans.length,0);assert.match(f.service.status(),/关闭.*默认/);
  assert.match(await f.service.command(f.message('other'),'on'),/主人/);assert.equal(f.service.store.read(),null);
  assert.match(await f.service.command(f.message(),'on'),/20分钟/);
  const enabled=f.service.store.read()!;assert.equal(enabled.nextAt,enabled.enabledAt);assert.equal(enabled.intervalMinutes,20);
  await f.service.poll();assert.equal(f.scans.length,1);assert.equal(f.dispatches.length,0);
  const acknowledged=f.service.store.read()!;assert(acknowledged.cursor);assert.equal(acknowledged.nextAt,'2026-10-30T00:20:00.000Z');
  f.advance(19*60000);await f.service.poll();assert.equal(f.scans.length,1);
  f.advance(60000);await f.service.poll();assert.equal(f.scans.length,2);
  assert.equal(f.scans[1]!.options.enabledAt,enabled.enabledAt);assert.deepEqual(f.scans[1]!.options.cursor,acknowledged.cursor);
});

test('repeated on preserves progress and epoch, off cancels only its own summary worker',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const before=f.service.store.read()!;f.advance(60000);
  await f.service.command(f.message('owner','enable-2'),'on');const after=f.service.store.read()!;
  assert.equal(after.epoch,before.epoch);assert.equal(after.enabledAt,before.enabledAt);assert.equal(after.authorizationMessageId,'enable-1');
  assert.deepEqual(after.run,before.run);assert.equal(f.dispatches.length,1);
  await f.service.command(f.message(),'off');assert.deepEqual(f.cancelled,['worker-1']);
  assert.equal(f.service.store.read()!.enabled,false);f.advance(60*60000);await f.service.poll();assert.equal(f.dispatches.length,1);
  assert.equal(f.current.id,'controller-1');assert.equal(f.current.nativeId,'native-1');
  await f.service.command(f.message('owner','enable-3'),'on');assert.notEqual(f.service.store.read()!.epoch,before.epoch);
});

test('summary input is frozen, one run is in flight and cursor waits for actual controller processing',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');
  await Promise.all([f.service.poll(),f.service.poll(),f.service.poll()]);assert.equal(f.scans.length,1);assert.equal(f.dispatches.length,1);
  const run=f.service.store.read()!.run!;assert.equal(run.phase,'worker');
  const input=readFileSync(run.inputPath,'utf8');assert.equal(JSON.parse(input).sources[0].records[0].text,'source body');
  assert(f.dispatches[0]!.prompt.includes(run.inputPath));assert(f.dispatches[0]!.prompt.includes(input));assert.equal(f.service.store.read()!.cursor,undefined);
  const event=f.completion();assert.equal(f.service.acceptCompletion(event),true);assert.equal(f.service.validEvent(event),true);
  assert.match(f.service.eventText(event),/Summary with evidence/);
  await f.service.poll();assert.equal(f.service.store.read()!.cursor,undefined);assert(f.wakes>0);
  f.events.set(event.id,{state:'processing',processed:false});await f.service.poll();assert.equal(f.service.store.read()!.cursor,undefined);
  f.events.set(event.id,{state:'processed',processed:true});await f.service.poll();
  const done=f.service.store.read()!;assert.deepEqual(done.cursor,run.snapshot.nextCursor);assert.equal(done.run,undefined);assert.equal(done.failures,0);
  assert.equal(f.service.validEvent(event),false);assert.equal(f.current.nativeId,'native-1');
});

test('failed scans and failed workers never acknowledge source progress or block the controller',async t=>{
  const f=fixture();t.after(()=>f.close());f.setScanError(new Error('Hash mismatch'));await f.service.command(f.message(),'on');await f.service.poll();
  assert.equal(f.service.store.read()!.cursor,undefined);assert.equal(f.service.store.read()!.failures,1);assert.equal(f.dispatches.length,0);
  f.setScanError(undefined);f.advance(20*60000);await f.service.poll();assert.equal(f.dispatches.length,1);
  f.jobs.get('job-1')!.status='failed';f.jobs.get('job-1')!.processStopped=true;await f.service.poll();
  assert.equal(f.service.store.read()!.cursor,undefined);assert.equal(f.service.store.read()!.run,undefined);
  assert.equal(f.current.nativeId,'native-1');assert.equal(f.cancelled.length,0);
});

test('source errors stay visible; empty partial pages acknowledge technical progress and promptly continue',async t=>{
  const f=fixture();t.after(()=>f.close());let page=0;
  f.setScan(o=>page++===0?snapshot(o,0,true,'page1','partial'):snapshot(o,1,false,'page2'));
  await f.service.command(f.message(),'on');await f.service.poll();
  assert.equal(f.dispatches.length,0);assert.equal(f.service.store.read()!.cursor!.sources.feishu!.revisions['a'.repeat(64)],'page1');
  assert.equal(f.service.store.read()!.nextAt,'2026-10-30T00:00:01.000Z');
  f.advance(1000);await f.service.poll();assert.equal(f.dispatches.length,1);
  assert.equal(f.scans[1]!.options.cursor!.sources.feishu!.revisions['a'.repeat(64)],'page1');
  const event=f.completion();f.service.acceptCompletion(event);f.events.set(event.id,{state:'processed',processed:true});await f.service.poll();
  assert.equal(f.service.store.read()!.cursor!.sources.feishu!.revisions['a'.repeat(64)],'page2');
});

test('hasMore runs the next bounded page shortly after controller acknowledgement',async t=>{
  const f=fixture();t.after(()=>f.close());f.setScan(o=>snapshot(o,1,true,'page1','partial'));
  await f.service.command(f.message(),'on');await f.service.poll();
  const event=f.completion();f.service.acceptCompletion(event);f.events.set(event.id,{state:'processed',processed:true});
  await f.service.poll();assert.equal(f.service.store.read()!.nextAt,'2026-10-30T00:00:01.000Z');
  await f.service.poll();assert.equal(f.dispatches.length,1);f.advance(1000);await f.service.poll();assert.equal(f.dispatches.length,2);
});

test('worker uncertainty is held without replay and only one user notice is produced',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  f.jobs.get('job-1')!.status='uncertain';await f.service.poll();
  assert.equal(f.service.store.read()!.run!.phase,'uncertain');assert.equal(f.service.store.read()!.cursor,undefined);
  assert.equal(f.notifications.length,1);f.advance(2*60*60000);await f.service.poll();assert.equal(f.dispatches.length,1);assert.equal(f.notifications.length,1);
});

test('summary uncertainty never replays controller effects; a clean new controller can receive a retained unprocessed summary',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const event=f.completion();f.service.acceptCompletion(event);f.events.set(event.id,{state:'delivered',processed:false});
  f.setActive({id:'controller-2',nativeId:'native-2'});await f.service.poll();
  assert.equal(f.reroutes.length,1);assert.equal(f.dispatches.length,1);assert.equal(f.service.store.read()!.run!.eventConversationId,'controller-2');
  const rebound=f.service.store.read()!.run!;f.events.set(rebound.eventId!,{state:'uncertain',processed:false});await f.service.poll();
  assert.equal(f.service.store.read()!.run!.phase,'uncertain');assert.equal(f.service.store.read()!.cursor,undefined);
  f.setActive({id:'controller-3',nativeId:'native-3'});await f.service.poll();assert.equal(f.reroutes.length,1);
});

test('restart preserves switch and worker identity, and preparing recovery looks up an existing dispatch before starting another',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const original=f.service.store.read()!,run=original.run!;
  await f.reopen();assert.equal(f.service.store.read()!.epoch,original.epoch);await f.service.poll();assert.equal(f.dispatches.length,1);
  const preparing=f.service.store.read()!;preparing.run!.phase='preparing';delete preparing.run!.workerId;delete preparing.run!.jobId;f.service.store.save(preparing);
  f.setRecovered({workerId:run.workerId!,jobId:run.jobId!});await f.reopen();await f.service.poll();
  assert(f.recoveryCalls>0);assert.equal(f.dispatches.length,1);assert.equal(f.service.store.read()!.run!.jobId,run.jobId);
  assert.equal(f.current.id,'controller-1');
});

test('pause/drain and absent native controller do not start work; malformed commands do not change state',async t=>{
  const f=fixture();t.after(()=>f.close());assert.match(await f.service.command(f.message(),'on extra'),/用法/);assert.equal(f.service.store.read(),null);
  await f.service.command(f.message(),'on');f.setPaused(true);await f.service.poll();assert.equal(f.scans.length,0);
  f.setPaused(false);f.setActive({nativeId:null});await f.service.poll();assert.equal(f.scans.length,0);
  f.setActive({nativeId:'native-1'});f.service.beginDrain();await f.service.poll();assert.equal(f.scans.length,0);
});

test('completion envelopes are scoped to the owner, enable epoch and exact job',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const good=f.completion();for(const changed of [{userId:'other'},{channelId:'other-chat'},{originMessageId:'old-command'},{purpose:undefined},{taskId:'other-job'}])
    assert.equal(f.service.acceptCompletion({...good,...changed}),false);
  assert.equal(f.service.acceptCompletion(good),true);await f.service.command(f.message(),'off');assert.equal(f.service.validEvent(good),false);
});

test('a completed worker is recovered from its queued event or saved summary without another dispatch',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  f.jobs.get('job-1')!.status='completed';f.jobs.get('job-1')!.result='Durable summary';
  const event=f.completion();await f.service.poll();
  assert.equal(f.service.store.read()!.run!.phase,'summary');assert.equal(f.service.store.read()!.run!.eventId,event.id);
  assert.equal(f.dispatches.length,1);assert.equal(f.reroutes.length,0);
  const g=fixture();t.after(()=>g.close());await g.service.command(g.message(),'on');await g.service.poll();
  g.jobs.get('job-1')!.status='completed';g.jobs.get('job-1')!.processStopped=true;g.jobs.get('job-1')!.result='Saved result without original event';await g.reopen();await g.service.poll();
  assert.equal(g.service.store.read()!.run!.phase,'summary');assert.equal(g.service.store.read()!.run!.summary,'Saved result without original event');
  assert.equal(g.reroutes.length,1);assert.equal(g.dispatches.length,1);assert.equal(g.service.store.read()!.cursor,undefined);
});

test('late completion cannot attach to a preparing run before its exact job is recovered',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const stale=f.completion(),value=f.service.store.read()!;
  value.run!.phase='preparing';delete value.run!.jobId;delete value.run!.workerId;f.service.store.save(value);
  assert.equal(f.service.acceptCompletion(stale),false);assert.equal(f.service.store.read()!.run!.phase,'preparing');
});

test('disabling during a scan discards its candidate cursor and prevents dispatch',async t=>{
  const f=fixture();t.after(()=>f.close());let complete!:(value:TransactionSnapshot)=>void,observed!:()=>void;
  const reached=new Promise<void>(resolve=>{observed=resolve;});
  f.callbacks.scan=async(_root,options)=>{observed();return new Promise<TransactionSnapshot>(resolve=>{complete=resolve;});};
  await f.service.command(f.message(),'on');const pending=f.service.poll();await reached;
  await f.service.command(f.message(),'off');
  complete(snapshot({enabledAt:new Date(clockStart).toISOString(),cutoff:new Date(clockStart).toISOString()}));await pending;
  assert.equal(f.dispatches.length,0);assert.equal(f.service.store.read()!.enabled,false);assert.equal(f.service.store.read()!.cursor,undefined);
});

test('failed cancellation keeps the disabled run identity and refuses reopening until runtime proves exit',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const original=f.service.store.read()!,run=original.run!;
  f.callbacks.cancel=async id=>{f.cancelled.push(id);throw Object.assign(new Error('Still running'),{processStillRunning:true});};
  await assert.rejects(f.service.command(f.message(),'off'),/Still running/);
  assert.equal(f.service.store.read()!.enabled,false);assert.equal(f.service.store.read()!.run!.jobId,run.jobId);
  await f.reopen();assert.match(await f.service.command(f.message('owner','enable-2'),'on'),/保持关闭/);
  assert.equal(f.service.store.read()!.epoch,original.epoch);assert.equal(f.dispatches.length,1);
  // Neither a terminal job label nor an incomplete native result is process-exit proof.
  const job=f.jobs.get(run.jobId!)!;job.status='completed';job.nativeResult={nativeId:'reader-native',text:'Result',processStopped:false};
  assert.match(await f.service.command(f.message(),'on'),/保持关闭/);
  job.processStopped=true;
  assert.match(await f.service.command(f.message('owner','enable-3'),'on'),/已开启/);
  assert.notEqual(f.service.store.read()!.epoch,original.epoch);assert.equal(f.current.nativeId,'native-1');
});

test('off also requests cancellation for an uncertain reader and can retry after the switch is already disabled',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  f.jobs.get('job-1')!.status='uncertain';f.jobs.get('job-1')!.processStopped=false;await f.service.poll();
  assert.equal(f.service.store.read()!.run!.phase,'uncertain');
  await f.service.command(f.message(),'off');await f.service.command(f.message(),'off');
  assert.deepEqual(f.cancelled,['worker-1','worker-1']);assert.equal(f.service.store.read()!.enabled,false);
  assert.equal(f.service.store.read()!.run!.jobId,'job-1');assert.equal(f.current.id,'controller-1');
});

test('off during dispatch preserves its late handle even when cancellation fails and on cannot race the submission',async t=>{
  const f=fixture();t.after(()=>f.close());const dispatch=f.callbacks.dispatch;
  let release!:()=>void,observed!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{observed=resolve;});
  f.callbacks.dispatch=async(...args)=>{const handle=await dispatch(...args);observed();await gate;return handle;};
  f.callbacks.cancel=async()=>{throw new Error('Exit unknown');};
  await f.service.command(f.message(),'on');const pending=f.service.poll();await reached;
  await f.service.command(f.message(),'off');assert.match(await f.service.command(f.message(),'on'),/保持关闭/);
  assert.equal(f.service.store.read()!.run!.phase,'preparing');release();await pending;
  const saved=f.service.store.read()!;assert.equal(saved.enabled,false);assert.equal(saved.run!.jobId,'job-1');assert.equal(saved.run!.workerId,'worker-1');
  assert.match(await f.service.command(f.message(),'on'),/保持关闭/);assert.equal(f.dispatches.length,1);
  f.jobs.get('job-1')!.processStopped=true;await f.service.command(f.message(),'on');assert.equal(f.service.store.read()!.enabled,true);
});

test('reopening recovers a preparing dispatch identity instead of dropping it, but a proven unsubmitted preparation can reopen',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const state=f.service.store.read()!;state.enabled=false;state.run!.phase='preparing';delete state.run!.jobId;delete state.run!.workerId;f.service.store.save(state);
  await f.reopen();f.setRecovered({workerId:'worker-1',jobId:'job-1'});
  assert.match(await f.service.command(f.message(),'on'),/保持关闭/);
  assert.equal(f.service.store.read()!.run!.jobId,'job-1');assert.equal(f.service.store.read()!.epoch,state.epoch);
  f.jobs.get('job-1')!.processStopped=true;await f.service.command(f.message(),'on');assert.notEqual(f.service.store.read()!.epoch,state.epoch);
  const g=fixture();t.after(()=>g.close());await g.service.command(g.message(),'on');await g.service.poll();
  const unsubmitted=g.service.store.read()!;unsubmitted.enabled=false;unsubmitted.run!.phase='preparing';delete unsubmitted.run!.jobId;delete unsubmitted.run!.workerId;g.service.store.save(unsubmitted);
  g.jobs.clear();await g.reopen();await g.service.command(g.message(),'on');assert.equal(g.service.store.read()!.enabled,true);assert.equal(g.dispatches.length,1);
});

test('failed completion for an uncertain runtime job never drops identity; confirmed exit permits delayed retry of the same frozen input',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const before=f.service.store.read()!.run!,body=readFileSync(before.inputPath,'utf8'),job=f.jobs.get('job-1')!;
  job.status='uncertain';job.processStopped=false;
  assert.equal(f.service.acceptCompletion(f.completion({status:'failed',text:'Process still running'})),true);
  assert.equal(f.service.store.read()!.run!.phase,'uncertain');assert.equal(f.service.store.read()!.run!.uncertainty,'worker');
  assert.equal(f.service.store.read()!.run!.jobId,'job-1');assert.equal(f.service.store.read()!.cursor,undefined);
  f.advance(60*60000);await f.service.poll();assert.equal(f.dispatches.length,1);
  job.status='failed';job.processStopped=true;await f.service.poll();assert(f.service.store.read()!.run!.retryAt);
  f.advance(20*60000-1);await f.service.poll();assert.equal(f.dispatches.length,1);
  f.advance(1);await f.service.poll();assert.equal(f.dispatches.length,2);assert.equal(f.scans.length,1);
  const retry=f.service.store.read()!.run!;assert.notEqual(retry.id,before.id);assert.equal(readFileSync(retry.inputPath,'utf8'),body);
  assert.equal(f.service.store.read()!.cursor,undefined);assert.equal(f.current.nativeId,'native-1');
});

test('failed or cancelled job labels without stop evidence are retained, while an old native result supplies compatible exit proof',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  f.jobs.get('job-1')!.status='failed';await f.service.poll();assert.equal(f.service.store.read()!.run!.phase,'uncertain');
  await f.service.command(f.message(),'off');delete f.jobs.get('job-1')!.processStopped;
  f.jobs.get('job-1')!.nativeResult={nativeId:'old-adapter',text:'Completed old adapter result'};
  await f.service.command(f.message(),'on');assert.equal(f.service.store.read()!.enabled,true);
});

test('processed summary waits silently for its reader CLI retirement before acknowledgement and another page',async t=>{
  const f=fixture();t.after(()=>f.close());f.setScan(o=>snapshot(o,1,true));await f.service.command(f.message(),'on');await f.service.poll();
  const event=f.completion(),job=f.jobs.get('job-1')!;job.processStopped=false;job.nativeResult!.processStopped=false;
  f.service.acceptCompletion(event);f.events.set(event.id,{state:'delivered',processed:true});await f.service.poll();
  f.advance(40*60000);await f.service.poll();assert.equal(f.service.store.read()!.cursor,undefined);assert.equal(f.service.store.read()!.run!.phase,'summary');
  assert.equal(f.dispatches.length,1);assert.equal(f.notifications.length,0);assert.equal(f.current.nativeId,'native-1');
  job.processStopped=true;await f.service.poll();assert(f.service.store.read()!.cursor);assert.equal(f.service.store.read()!.run,undefined);
  f.advance(1000);await f.service.poll();assert.equal(f.dispatches.length,2);
});

test('proven unsubmitted controller preparation retries only the retained summary after twenty minutes and across restart',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const event=f.completion();f.service.acceptCompletion(event);const original=f.service.store.read()!.run!;
  f.events.set(event.id,{state:'uncertain',processed:false,safeToRetry:true});await f.service.poll();
  const waiting=f.service.store.read()!;assert.equal(waiting.run!.phase,'summary');assert.equal(waiting.run!.summary,original.summary);
  assert.equal(waiting.run!.retryAt,'2026-10-30T00:20:00.000Z');assert.equal(waiting.cursor,undefined);
  await f.reopen();f.advance(20*60000-1);await f.service.poll();assert.equal(f.reroutes.length,0);
  f.advance(1);await f.service.poll();assert.equal(f.reroutes.length,1);assert.equal(f.dispatches.length,1);assert.equal(f.scans.length,1);
  assert.deepEqual(f.retired,[event.id]);const retried=f.service.store.read()!.run!;assert.equal(retried.retryAt,undefined);
  assert.equal(retried.summary,original.summary);assert.deepEqual(retried.snapshot,original.snapshot);
  f.events.set(retried.eventId!,{state:'delivered',processed:true});await f.service.poll();assert(f.service.store.read()!.cursor);
});

test('failed safe summary reroute keeps its retry marker so retiring the old event cannot falsely acknowledge input',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const event=f.completion();f.service.acceptCompletion(event);f.events.set(event.id,{state:'uncertain',processed:false,safeToRetry:true});await f.service.poll();
  const reroute=f.callbacks.reroute;f.callbacks.reroute=async()=>{throw new Error('Controller temporarily unavailable');};
  f.advance(20*60000);await f.service.poll();assert.equal(f.service.store.read()!.cursor,undefined);assert.equal(f.service.store.read()!.run!.retryAt,'2026-10-30T00:40:00.000Z');
  await f.service.poll();assert.equal(f.service.store.read()!.cursor,undefined);assert.equal(f.dispatches.length,1);
  f.callbacks.reroute=reroute;f.advance(20*60000);await f.service.poll();assert.equal(f.reroutes.length,1);assert.equal(f.dispatches.length,1);
});

test('a delayed failed reader envelope cannot make a handed-off summary eligible for reader-only replay',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const event=f.completion();f.service.acceptCompletion(event);f.events.set(event.id,{state:'processing',processed:false});
  f.jobs.get('job-1')!.status='failed';f.jobs.get('job-1')!.processStopped=true;
  f.service.acceptCompletion({...event,id:'late-failed',status:'failed',text:'Delayed cleanup failure'});
  assert.equal(f.service.store.read()!.run!.phase,'uncertain');assert.equal(f.service.store.read()!.run!.uncertainty,'controller');
  f.advance(20*60000);await f.service.poll();f.advance(20*60000);await f.service.poll();
  assert.equal(f.dispatches.length,1);assert.equal(f.reroutes.length,0);assert.equal(f.service.store.read()!.cursor,undefined);
});

test('repeated unsubmitted summary delivery failures notify once per reason after the third failure',async t=>{
  const f=fixture();t.after(()=>f.close());await f.service.command(f.message(),'on');await f.service.poll();
  const event=f.completion();f.service.acceptCompletion(event);f.events.set(event.id,{state:'uncertain',processed:false,safeToRetry:true});await f.service.poll();
  f.callbacks.reroute=async()=>{throw new Error('Repeated metadata preparation failure');};
  f.advance(20*60000);await f.service.poll();assert.equal(f.service.store.read()!.failures,2);assert.equal(f.notifications.length,0);
  f.advance(20*60000);await f.service.poll();assert.equal(f.service.store.read()!.failures,3);assert.equal(f.notifications.length,1);
  assert.match(f.notifications[0]!,/Repeated metadata preparation failure/);assert.match(f.notifications[0]!,/主控仍可正常使用/);
  await f.reopen();f.advance(20*60000);await f.service.poll();assert.equal(f.service.store.read()!.failures,4);assert.equal(f.notifications.length,1);
  assert.equal(f.service.store.read()!.run!.phase,'summary');assert.equal(f.service.store.read()!.cursor,undefined);assert.equal(f.dispatches.length,1);
});

test('summary dispatch embeds the complete frozen three-platform body within the UTF-8 prompt budget',async t=>{
  const f=fixture();t.after(()=>f.close());
  f.setScan(options=>{
    assert.equal(options.limits?.maxChars,36000);
    const value=snapshot(options),platforms=['feishu','chatgpt','bilibili'];
    value.sources=platforms.map(site=>({...structuredClone(value.sources[0]!),id:site,site,
      records:[{...structuredClone(value.sources[0]!.records[0]!),identity:site+'-record',text:site+'正文'+ '中'.repeat(10500)}]}));
    value.recordCount=platforms.length;
    value.text=JSON.stringify({version:value.version,trust:value.trust,window:value.window,sources:value.sources});
    assert(value.text.length<=options.limits!.maxChars!);return value;
  });
  await f.service.command(f.message(),'on');await f.service.poll();
  const run=f.service.store.read()!.run!,prompt=f.dispatches[0]!.prompt,input=readFileSync(run.inputPath,'utf8');
  assert.equal(input,run.snapshot.text);assert(prompt.includes(input),'冻结JSON应直接完整交给摘要助手，无需Shell读文件');
  assert.deepEqual(JSON.parse(input).sources.map((source:{site:string})=>source.site),['feishu','chatgpt','bilibili']);
  assert(Buffer.byteLength(prompt,'utf8')<=128*1024,'中文正文与职责提示共同遵守派工UTF-8字节上限');
  assert.equal(f.service.store.read()!.cursor,undefined);
});
