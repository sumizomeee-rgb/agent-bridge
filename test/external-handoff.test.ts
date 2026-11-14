import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalControllerAdapter } from '../src/controller/external.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { ControllerRuntime } from '../src/controller/runtime.js';
import { TaskRegistry, type TaskContextFile } from '../src/tasks.js';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-external-handoff-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'README.md'), '# Main\n{{include:bridge/controller-protocol}}');
  writeFileSync(join(workspace, 'MEMORY.md'), 'owner context');
  const config: BridgeConfig = { controllerId:'dot', controllerBackend:{kind:'external',endpointId:'dot-cloud'},
    controllerMode:true, token:'fake', allowedUserIds:['owner'], defaultAgent:'codex', workspace,
    contextWorkspace:workspace, proxyUrl:null, commands:{codex:{command:'fake',args:[]},claude:{command:'fake',args:[]}},
    dataDir:join(root,'data'),logsDir:join(root,'logs'),attachmentsDir:join(root,'attachments'),maxImageBytes:100 };
  const initial = new SessionStore(config.dataDir);
  const source = initial.createConversation('owner','external',workspace,{controllerMode:true});
  initial.saveNativeId(source.id,'real-session-a'); initial.setActive('owner',source.id); initial.close();
  const components: {manager:SessionManager;runtime:ControllerRuntime;tasks:TaskRegistry;adapter:ExternalControllerAdapter}[]=[];
  const open = (failRebind=false,failPause=false) => {
    const tasks=new TaskRegistry(config.dataDir);
    const fake:AgentAdapter={async run(){throw new Error('no native agent in this test');},async interrupt(){},async close(){}};
    let calls=0;
    const adapter=new ExternalControllerAdapter(config,async()=>{calls++;return {evidence:'retained'};});
    const runtime=new ControllerRuntime(config,{codex:fake,claude:fake},tasks,{onCompletion(){},pollIntervalMs:60_000});
    const manager=new SessionManager(config,{codex:fake,claude:fake,external:adapter},{async sendText(){}},{
      taskRegistry:tasks,onCommitExternalHandoff:id=>adapter.commitHandoff(id),
      onCompleteExternalHandoff:(id,conversationId)=>adapter.completeHandoff(id,conversationId),
      onRebindSwitch:async(from,to)=>{if(failRebind)throw new Error('simulated crash between binding and task ledger');await runtime.rebindConversation(from,to);},
      onPauseSwitch:async from=>{await runtime.pauseConversation(from.id);if(failPause){failPause=false;throw new Error('pause interrupted');}},onResumeSwitch:from=>runtime.resumeConversation(from.id),
      mergeDelayMs:0,
    });
    const item={manager,runtime,tasks,adapter,calls:()=>calls};components.push(item);return item;
  };
  t.after(async()=>{for(const item of components){await item.manager.close();await item.runtime.close();try{item.tasks.close();}catch{ /* already closed by restart test */ }}rmSync(root,{recursive:true,force:true});});
  return {root,config,source,open};
}

test('external session handoff creates a new bridge conversation and rebinds real pending task results',async t=>{
  const f=fixture(t),c=f.open(),old=c.adapter.connect('instance-a','real-session-a');
  const created=c.tasks.createContext({conversationId:f.source.id,userId:'owner',agent:'external',nativeId:'real-session-a',cwd:f.config.workspace,channelId:'controller:dot',originMessageId:'original-input'});
  const task=c.tasks.register(JSON.parse(readFileSync(created.contextPath,'utf8')) as TaskContextFile,'existing task');
  c.tasks.acceptObservedResult(task.taskId,'completed','existing result');
  const evidence=c.tasks.completionForTask(task.taskId)!.text;
  const request=()=>c.adapter.handoff(old.lease,'real-session-a','instance-b','real-session-b',
    (id,previous,next)=>c.manager.handoffExternalSession(id,'owner',previous,next));
  const result=await request() as {lease:string;conversationId:string;sessionId:string};
  assert.notEqual(result.conversationId,f.source.id);assert.equal(result.sessionId,'real-session-b');
  assert.equal(c.manager.currentConversation('owner')?.id,result.conversationId);
  assert.equal(c.manager.currentConversation('owner')?.nativeId,'real-session-b');
  assert.equal(c.tasks.completionForTask(task.taskId)?.conversationId,result.conversationId);
  assert.equal(c.tasks.completionForTask(task.taskId)?.nativeId,'real-session-b');
  assert.equal(c.tasks.completionForTask(task.taskId)?.text,evidence);
  assert.throws(()=>c.adapter.events(old.lease),/失效/);
  const duplicate=await request() as {lease:string;conversationId:string;duplicate:boolean};
  assert.equal(duplicate.lease,result.lease);assert.equal(duplicate.conversationId,result.conversationId);assert.equal(duplicate.duplicate,true);
  assert.equal((c.adapter.status().binding as {sessionId:string}).sessionId,'real-session-b');
});

test('external handoff committing journal resumes across restart without losing the original result',async t=>{
  const f=fixture(t),first=f.open(true),old=first.adapter.connect('instance-a','real-session-a');
  const created=first.tasks.createContext({conversationId:f.source.id,userId:'owner',agent:'external',nativeId:'real-session-a',cwd:f.config.workspace,channelId:'controller:dot',originMessageId:'original-input'});
  const task=first.tasks.register(JSON.parse(readFileSync(created.contextPath,'utf8')) as TaskContextFile,'pending result');
  first.tasks.acceptObservedResult(task.taskId,'completed','keep this evidence');
  const evidence=first.tasks.completionForTask(task.taskId)!.text;
  await assert.rejects(first.adapter.handoff(old.lease,'real-session-a','instance-b','real-session-b',
    (id,previous,next)=>first.manager.handoffExternalSession(id,'owner',previous,next)),/simulated crash/);
  assert.equal(first.manager.currentConversation('owner')?.id,f.source.id);
  assert.equal((first.adapter.status().binding as {sessionId:string}).sessionId,'real-session-b');
  await first.manager.close();await first.runtime.close();first.tasks.close();
  const second=f.open();await second.manager.recover();
  const active=second.manager.currentConversation('owner')!;
  assert.notEqual(active.id,f.source.id);assert.equal(active.nativeId,'real-session-b');
  assert.equal(second.tasks.completionForTask(task.taskId)?.conversationId,active.id);
  assert.equal(second.tasks.completionForTask(task.taskId)?.text,evidence);
  const repeated=await second.adapter.handoff(old.lease,'real-session-a','instance-b','real-session-b',
    (id,previous,next)=>second.manager.handoffExternalSession(id,'owner',previous,next)) as {conversationId:string};
  assert.equal(repeated.conversationId,active.id);
});


test('active external handoff requeues original input in the new session and preserves call idempotency',async t=>{
  const f=fixture(t),c=f.open(),binding=c.adapter.connect('instance-a','real-session-a');
  await c.manager.handle({id:'original-handoff-input',userId:'owner',channelId:'controller:dot',text:'actual original goal',imagePaths:[]});
  for(let i=0;i<50&&!c.adapter.isWaiting(f.source.id);i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(c.adapter.isWaiting(f.source.id),true);
  const before=(c.adapter.status().decisions as {id:string;conversationId:string;status:string}[]).find(d=>d.conversationId===f.source.id)!;
  c.adapter.accept(binding.lease,before.id);
  const first=await c.adapter.call(binding.lease,before.id,'stable-business-call','bridge_start_worker',{prompt:'same goal'});
  assert.equal(c.calls(),1);
  const handoff=await c.adapter.handoff(binding.lease,'real-session-a','instance-b','real-session-b',
    (id,previous,next)=>c.manager.handoffExternalSession(id,'owner',previous,next)) as {lease:string;conversationId:string};
  for(let i=0;i<50&&!c.adapter.isWaiting(handoff.conversationId);i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(c.adapter.isWaiting(handoff.conversationId),true);
  const after=(c.adapter.status().decisions as {id:string;conversationId:string;status:string}[]).find(d=>d.conversationId===handoff.conversationId)!;
  assert.notEqual(after.id,before.id);c.adapter.accept(handoff.lease,after.id);
  assert.deepEqual(await c.adapter.call(handoff.lease,after.id,'stable-business-call','bridge_start_worker',{prompt:'same goal'}),first);
  assert.equal(c.calls(),1,'handoff must not repeat an already recorded tool side effect');
  assert.equal((c.adapter.status({decisionId:before.id,callId:'stable-business-call'}).call as any).status,'done');
  await c.adapter.finish(handoff.lease,after.id);
});


test('handoff interrupted before a committing journal resumes the original schedules and can retry',async t=>{
  const f=fixture(t),c=f.open(false,true),binding=c.adapter.connect('instance-a','real-session-a');
  const retry=()=>c.adapter.handoff(binding.lease,'real-session-a','instance-b','real-session-b',
    (id,previous,next)=>c.manager.handoffExternalSession(id,'owner',previous,next));
  await assert.rejects(retry(),/pause interrupted/);
  assert.equal(c.runtime.store.isConversationPaused(f.source.id),false);
  assert.equal(c.manager.currentConversation('owner')?.id,f.source.id);
  assert.equal((c.adapter.status().binding as {lease:string}).lease,binding.lease);
  const result=await retry() as {conversationId:string};assert.notEqual(result.conversationId,f.source.id);
});
