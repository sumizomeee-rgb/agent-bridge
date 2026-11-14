import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerCoordinator, createControllerCoordinationState, type ControllerDecisionPort } from '../src/controller/coordinator.js';
import { ControllerContextRenderer } from '../src/controller/context.js';
import { deferred } from '../src/agents/process.js';
import type { AgentTurn } from '../src/types.js';

function turn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return { conversation: { id:'session',userId:'owner',agent:'codex',nativeId:'native',title:'test',cwd:process.cwd(),createdAt:'now',updatedAt:'now' },
    text:'goal',imagePaths:[],signal:new AbortController().signal,onProgress(){}, ...overrides };
}
function port(): ControllerDecisionPort {
  return { resetDecision(){}, async continueDecision(){},async continuePrivate(){},result(){return{nativeId:'session',text:'',controlledOutput:true};} };
}

test('channel-less decisions share call dedupe and require explicit protocol completion',async()=>{
  let calls=0;const coordinator=new ControllerCoordinator({invokeTool:async()=>{calls++;return {workers:[]};}});
  const active=createControllerCoordinationState(turn({deliveryRequirement:'none'}));
  const first=coordinator.invoke(active,'bridge_list_workers',{},'same-call'),again=coordinator.invoke(active,'bridge_list_workers',{},'same-call');
  assert.deepEqual(await first,await again);assert.equal(calls,1);assert.equal(active.completed.settled,false);
  await assert.rejects(coordinator.invoke(active,'bridge_list_workers',{details:true},'same-call'),/参数不一致/);
  assert.equal(await coordinator.finish(active,port()),'completed');assert.equal((await active.completed.promise).controlledOutput,true);
  await assert.rejects(coordinator.invoke(active,'bridge_list_workers',{},'late-call'),/已封闭/);
  await coordinator.invoke(active,'bridge_list_workers',{},'same-call');assert.equal(calls,1);
});

test('ordinary private decision still rejects missing final delivery',async()=>{
  const coordinator=new ControllerCoordinator({invokeTool:async()=>({})});
  const active=createControllerCoordinationState(turn());
  await assert.rejects(coordinator.finish(active,port()),/没有通过公开通道/);
});

test('channel-less silent terminal can finish without inventing a private channel',async()=>{
  const coordinator=new ControllerCoordinator({invokeTool:async()=>({})});
  const active=createControllerCoordinationState(turn({deliveryRequirement:'none'}));
  assert.deepEqual(await coordinator.invoke(active,'bridge_silent',{},'silent'),{silent:true});
  await coordinator.finish(active,port());assert.equal(active.silent,true);
});

test('private input reassessment keeps old actions paused and updates the same logical turn once',async()=>{
  let checks=0,calls=0,continued=0,published=0;
  const coordinator=new ControllerCoordinator({invokeTool:async()=>{calls++;return {accepted:true};}});
  const active=createControllerCoordinationState(turn({onPrivateInputCheck:async()=>{
    checks++;return{refreshRequired:true,input:{version:1,messages:[{id:'latest',userId:'owner',channelId:'dm',text:'new goal',imagePaths:[]}]}};
  },onPublicMessage:async()=>{published++;}}));
  assert.equal((await coordinator.invoke(active,'bridge_start_worker',{prompt:'old goal'},'old') as {performed:boolean}).performed,false);
  assert.equal((await coordinator.invoke(active,'bridge_start_worker',{prompt:'still old'},'old-late') as {performed:boolean}).performed,false);
  assert.equal(calls,0);assert.equal(checks,1);
  const boundary=port();boundary.continuePrivate=async input=>{continued++;assert(input.some(part=>part.type==='text'&&part.text.includes('new goal')));};
  assert.equal(await coordinator.finish(active,boundary),'continued');assert.equal(active.turn.text,'new goal');
  await coordinator.invoke(active,'bridge_start_worker',{prompt:'new goal'},'new');assert.equal(calls,1);
  await coordinator.invoke(active,'bridge_send_user',{text:'done'},'final');
  assert.equal(await coordinator.finish(active,boundary),'completed');assert.equal(continued,1);assert.equal(published,1);
});

test('a final publication waits for admitted management receipts and can correct before any send',async()=>{
  const work=deferred<unknown>();let published=0;
  const coordinator=new ControllerCoordinator({invokeTool:async()=>work.promise});
  const active=createControllerCoordinationState(turn({onPublicMessage:async()=>{published++;}}));
  const management=coordinator.invoke(active,'bridge_list_workers',{},'management');
  const final=coordinator.invoke(active,'bridge_send_user',{text:'too early'},'early');
  work.resolve({workers:[]});await management;await assert.rejects(final,/工具返回之前/);assert.equal(published,0);
  await coordinator.invoke(active,'bridge_send_user',{text:'after receipt'},'corrected');
  await coordinator.finish(active,port());assert.equal(published,1);
});

test('shared runtime context does not fabricate private delivery for a channel-less controller',()=>{
  const renderer=new ControllerContextRenderer({identity:{controllerId:'external-one',aliases:['external']}}),state={};
  const value=renderer.runtime(turn({deliveryRequirement:'none'}),state);
  assert(value.includes('"area":"none"'));assert(value.includes('"controllerId":"external-one"'));assert(!value.includes('current-private'));assert(!value.includes('"targetId":"private"'));
});

test('checklist cadence counts accepted logical decisions and is shared across port types',()=>{
  const renderer=new ControllerContextRenderer();
  const abandoned=renderer.begin(turn({taskChecklist:'tasks'}));assert.equal(abandoned.turn.taskChecklist,'tasks');
  for(let index=1;index<=4;index++){
    const current=renderer.begin(turn({taskChecklist:'tasks'}));assert.equal(current.turn.taskChecklist,index===1||index===4?'tasks':undefined);current.acknowledge();current.acknowledge();
  }
});

test('channel-less completion never enters private reply recovery and parallel finishes share the boundary', async () => {
  const pending = deferred<void>(); let continued = 0, results = 0;
  const coordinator = new ControllerCoordinator({ invokeTool: async () => ({}) });
  const active = createControllerCoordinationState(turn({ deliveryRequirement: 'none', controllerRecovery: true }));
  active.deliveryPromise = pending.promise;
  const boundary = port(); boundary.continueDecision = async () => { continued++; };
  boundary.result = () => { results++; return { nativeId: 'session', text: '', controlledOutput: true }; };
  const first = coordinator.finish(active, boundary), second = coordinator.finish(active, boundary);
  assert.equal(first, second); assert.equal(active.completed.settled, false);
  pending.resolve(); await first; await second; await active.completed.promise;
  assert.equal(continued, 0); assert.equal(results, 1);
});

test('channel-less finish waits admitted management before completing its decision', async () => {
  const pending = deferred<unknown>();
  const coordinator = new ControllerCoordinator({ invokeTool: async () => pending.promise });
  const active = createControllerCoordinationState(turn({ deliveryRequirement: 'none' }));
  const call = coordinator.invoke(active, 'bridge_list_workers', {}, 'pending-management');
  const finishing = coordinator.finish(active, port());
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(active.completed.settled, false);
  pending.resolve({ workers: [] }); await call; await finishing; assert.equal(active.completed.settled, true);
});
