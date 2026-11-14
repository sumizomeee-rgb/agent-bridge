import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExternalControllerAdapter } from '../src/controller/external.js';
import type { AgentTurn, BridgeConfig } from '../src/types.js';

function fixture(t:TestContext) {
  const root=mkdtempSync(join(tmpdir(),'bridge-external-'));
  const workspace=join(root,'workspace');mkdirSync(workspace);
  writeFileSync(join(workspace,'README.md'),'# Controller\n{{include:bridge/controller-protocol}}\n{{include:bridge/tool-index}}\n{{include:workspace/MEMORY.md}}');
  writeFileSync(join(workspace,'MEMORY.md'),'owner context');
  const config={controllerId:'independent',controllerBackend:{kind:'external',endpointId:'test-agent'},workspace,contextWorkspace:workspace,dataDir:join(root,'data'),responseWaitMs:86_400_000} as BridgeConfig;
  const adapters:ExternalControllerAdapter[]=[];let calls=0,published=0;
  const adapter=()=>{const value=new ExternalControllerAdapter(config,async()=>{calls++;return {accepted:true};});adapters.push(value);return value;};
  const turn=(source='source',delivery:'none'|'private'='none'):AgentTurn=>({conversation:{id:'conversation',agent:'external',nativeId:null,userId:'principal:owner',cwd:workspace,title:'test',createdAt:'now',updatedAt:'now'},
    source:{messageId:source,userId:'principal:owner',channelId:''},text:'original goal',input:[{type:'text',text:'original goal'}],imagePaths:[],signal:new AbortController().signal,onProgress(){},deliveryRequirement:delivery,
    onPublicMessage:async()=>{published++;}});
  t.after(async()=>{for(const value of adapters)await value.close();rmSync(root,{recursive:true,force:true});});
  return {adapter,turn,config,calls:()=>calls,published:()=>published};
}
function decision(adapter:ExternalControllerAdapter,lease:string):string {
  return (adapter.events(lease).filter((e:any)=>e.kind==='decision').at(-1) as {id:string}).id;
}

test('external waiting persists calls across restart and never impersonates a native CLI session',async t=>{
  const f=fixture(t),first=f.adapter(),binding=first.connect('instance','actual-external-session');
  const waiting=first.run(f.turn());const suspended=assert.rejects(waiting,{name:'ExternalControllerSuspended'});
  const id=decision(first,binding.lease);first.accept(binding.lease,id);
  assert.equal(first.isWaiting('conversation'),true);
  assert.deepEqual(await first.call(binding.lease,id,'dispatch','bridge_start_worker',{prompt:'goal'}),{accepted:true});
  const cursor=Math.max(...first.events(binding.lease).map((event:any)=>event.sequence));
  await first.suspend('conversation');await suspended;await first.close();assert.equal(f.calls(),1);
  const second=f.adapter(),resumed=second.run(f.turn()),same=second.connect('instance','actual-external-session');
  const restored=decision(second,same.lease);assert.equal(restored,id);second.accept(same.lease,restored);
  assert(second.events(same.lease,cursor).some((event:any)=>event.kind==='decision'&&event.id===id),'恢复事件必须可从旧游标之后读取');
  await second.call(same.lease,restored,'dispatch','bridge_start_worker',{prompt:'goal'});assert.equal(f.calls(),1);
  await assert.rejects(second.call(same.lease,restored,'dispatch','bridge_start_worker',{prompt:'changed'}),/参数不一致/);
  await second.finish(same.lease,restored);assert.equal((await resumed).nativeId,'actual-external-session');
  assert.deepEqual(await second.finish(same.lease,restored),{status:'completed'});
  assert(second.events(same.lease).some((event:any)=>event.kind==='completed'&&event.decisionId===restored));
});

test('external successful final delivery survives suspension and explicit finish without sending twice',async t=>{
  const f=fixture(t),first=f.adapter(),binding=first.connect('one','real-session');
  const waiting=first.run(f.turn('private','private'));const suspended=assert.rejects(waiting,{name:'ExternalControllerSuspended'});
  const id=decision(first,binding.lease);first.accept(binding.lease,id);
  await first.call(binding.lease,id,'final','bridge_send_user',{text:'done'});assert.equal(f.published(),1);
  await first.suspend('conversation');await suspended;await first.close();
  const second=f.adapter(),resumed=second.run(f.turn('private','private'));
  second.accept(binding.lease,id);await second.finish(binding.lease,id);await resumed;assert.equal(f.published(),1);
  // A crash after protocol completion but before the manager checkpoint returns the saved result.
  const replay=await second.run(f.turn('private','private'));assert.equal(replay.nativeId,'real-session');assert.equal(f.published(),1);
});

test('external instance replacement fences stale decisions and cancellation retires authority',async t=>{
  const f=fixture(t),adapter=f.adapter(),old=adapter.connect('old','old-session');
  const waiting=adapter.run(f.turn());const cancelled=assert.rejects(waiting,/撤销/);
  const id=decision(adapter,old.lease);
  assert.throws(()=>adapter.connect('new','different-session'),/先新建主控会话/);
  const current=adapter.connect('new','old-session');
  assert.throws(()=>adapter.accept(old.lease,id),/失效/);adapter.accept(current.lease,id);
  await adapter.interrupt('conversation');await cancelled;
  await assert.rejects(adapter.call(current.lease,id,'late','bridge_start_worker',{}),/退休/);
  assert.equal(await adapter.confirmStopped('conversation'),true);
});

test('external response wait expiry is a decision failure and does not cancel execution workers',async t=>{
  const f=fixture(t);f.config.responseWaitMs=10;const adapter=f.adapter();adapter.connect('instance','real-session');
  await assert.rejects(adapter.run(f.turn()),/等待已到期/);assert.equal(f.calls(),0);
});

test('external private reassessment restores updated source and attachments after restart',async t=>{
  const f=fixture(t),first=f.adapter(),binding=first.connect('instance','real-session');
  const original=f.turn('root','private');
  original.onPrivateInputCheck=async()=>({refreshRequired:true,input:{version:1,messages:[{id:'new-input',userId:'principal:owner',channelId:'',text:'new goal',imagePaths:['new-image.png']}]}});
  const waiting=first.run(original),suspended=assert.rejects(waiting,{name:'ExternalControllerSuspended'});
  const old=decision(first,binding.lease);first.accept(binding.lease,old);
  await first.call(binding.lease,old,'stale','bridge_start_worker',{prompt:'old goal'});
  assert.equal((await first.finish(binding.lease,old) as {status:string}).status,'continued');
  const next=decision(first,binding.lease);assert.notEqual(next,old);
  await first.suspend('conversation');await suspended;await first.close();
  let observed:AgentTurn|undefined;
  const second=new ExternalControllerAdapter(f.config,async turn=>{observed=turn;return {accepted:true};});
  t.after(()=>second.close());const restored=second.run(f.turn('root','private'));const cleanup=assert.rejects(restored,{name:'ExternalControllerSuspended'});
  second.accept(binding.lease,next);await second.call(binding.lease,next,'new','bridge_start_worker',{prompt:'new goal'});
  assert.equal(observed?.source?.messageId,'new-input');assert.equal(observed?.text,'new goal');assert.deepEqual(observed?.imagePaths,['new-image.png']);
  await second.suspend('conversation');await cleanup;await second.close();
});
