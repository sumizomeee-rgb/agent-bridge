import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ExecutorMessages,executorMessageHome,executorScope} from '../src/executor-messages.js';
import {projectRoot} from '../src/config.js';
import {ExternalControllerAdapter} from '../src/controller/external.js';
import {ControllerCore,type ControllerCoreDependencies,type ControllerCoreHooks} from '../src/controller/core.js';
import type {AgentAdapter,AgentName,AgentTurn,BridgeConfig} from '../src/types.js';

async function until(check:()=>boolean){const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw new Error('Core test timed out');await new Promise(resolve=>setTimeout(resolve,5));}}
class FakeAgent implements AgentAdapter {
  turns:AgentTurn[]=[];closed=0;
  constructor(private readonly controller=false){}
  async getModelInfo(){return {defaultModel:'offline',models:[{id:'offline',displayName:'offline'}]};}
  async run(turn:AgentTurn){
    this.turns.push(turn);const nativeId=turn.conversation.nativeId ?? 'native-'+turn.conversation.id;turn.onNativeId?.(nativeId);
    if(this.controller && (!turn.event || turn.event.introductionRequested))await turn.onPublicMessage?.('主控正常回复');
    return {nativeId,text:this.controller?'':'工作区入口读取完成',...(this.controller?{controlledOutput:true}:{})};
  }
  async interrupt(){}async confirmStopped(){return true;}async close(){this.closed++;}
}
function setup(t:TestContext,agent:AgentName,withDelivery=true,externalBackend=false){
  const root=mkdtempSync(join(tmpdir(),'bridge-controller-core-'));
  const workspace=join(root,'workspace');mkdirSync(workspace,{recursive:true});
  writeFileSync(join(workspace,'README.md'),'# Core\n{{include:bridge/controller-protocol}}\n{{include:bridge/tool-index}}\n{{include:workspace/MEMORY.md}}');writeFileSync(join(workspace,'MEMORY.md'),'# Owner');
  const config:BridgeConfig={controllerId:'controller-one',controllerUserId:'principal:owner',controllerBackend:{kind:'native',agent},ownerUserId:'principal:owner',ownerPrincipalId:'owner',
    allowedUserIds:['channel-owner'],token:'',defaultAgent:agent,workspace,contextWorkspace:workspace,dataDir:join(root,'controller-data'),logsDir:join(root,'logs'),attachmentsDir:join(root,'attachments'),
    proxyUrl:null,maxImageBytes:100,controllerMode:true,defaultModels:{codex:'offline',claude:'offline'},commands:{codex:{command:'unused',args:[]},claude:{command:'unused',args:[]}}};
  if(withDelivery){config.botId='discord:123456789012345678';config.channelOwnerUserId='channel-owner';}
  if(externalBackend)config.controllerBackend={kind:'external',endpointId:'external-test'};
  const controllers={codex:new FakeAgent(true),claude:new FakeAgent(true)},execution={codex:new FakeAgent(),claude:new FakeAgent()},external=new FakeAgent(true),sent:string[]=[];
  let active:string|null=null;
  const hooks:ControllerCoreHooks={authorize:user=>user==='principal:owner',manager:{binding:{getActive:()=>active,setActive:(_user,id)=>{active=id;}}},
    invoke:(_turn,_name,args,_id,delegate)=>delegate(args),pauseGroup(){},resumeGroup(){},requestRestart:async()=>({accepted:false}),isDraining:()=>false};
  const report={version:1 as const,workspace,checkedAt:'2026-11-14',stale:false,scope:'static-prerequisites' as const,items:[],total:0,omitted:0};
  let executorMessagesCreated=0;const isolatedUserHome=join(root,'isolated-user-home');
  const dependencies:ControllerCoreDependencies={createExecutorMessages:()=>{executorMessagesCreated++;return new ExecutorMessages(projectRoot,isolatedUserHome);},createExecutionAdapters:()=>execution,createControllerAdapters:()=>controllers,createExternalAdapter:(selected,invoke)=>externalBackend?new ExternalControllerAdapter(selected,invoke):external,
    createTargetCatalog:()=>({async listTargets(){return [];},async resolveTarget(_workspace,id,selected,cwd){return {id,agent:selected,label:id,transport:'local',cwd:cwd ?? workspace,agentCommand:config.commands[selected]};},
      adapterFor:binding=>execution[binding.agent],async handoff(){throw new Error('unused');},async computerOverview(){return [];},async close(){}}),
    createHealth:()=>({async refresh(){return report;},async query(){return report;},startupSummary:()=>''})};
  const core=new ControllerCore(config,hooks,withDelivery?{async sendText(_channel,text){sent.push(text);}}:undefined,dependencies);
  t.after(async()=>{await core.close();rmSync(root,{recursive:true,force:true});});
  return {root,workspace,config,core,controllers,execution,external,sent,hooks,dependencies,isolatedUserHome,get executorMessagesCreated(){return executorMessagesCreated;}};
}
for(const agent of ['codex','claude'] as const)test(`独立核心保留${agent}主控初始化和new后的回复`,async t=>{
  const f=setup(t,agent);await f.core.start();
  const send=async(id:string,text:string)=>{await f.core.manager.handle({id,text,userId:'principal:owner',channelId:'test-delivery',imagePaths:[]});await until(()=>f.core.isIdle());};
  await send('first','首次正常工作');
  assert(f.controllers[agent].turns.length>0);assert(f.sent.some(text=>text.includes('主控正常回复')));
  const old=f.core.manager.currentConversation('principal:owner')!.id;
  await send('new','/new');await send('after-new','新会话继续');
  assert.notEqual(f.core.manager.currentConversation('principal:owner')!.id,old);
  assert.equal(f.core.config.allowedUserIds[0],'principal:owner');
  assert.equal(f.config.allowedUserIds[0],'channel-owner');
});
test('无渠道核心可独立启动、排空和关闭，不建立平台收件或生命周期库',async t=>{
  const f=setup(t,'codex',false);await f.core.start();assert(f.core.isReady());assert(f.core.isIdle());
  assert.equal(existsSync(join(f.config.dataDir,'ingress.sqlite')),false);
  assert.equal(existsSync(join(f.config.dataDir,'lifecycle.sqlite')),false);
  f.core.beginDrain();assert(f.core.isIdle());await f.core.close();assert(!f.core.isReady());
  assert.equal(f.external.closed,1);assert.equal(f.execution.codex.closed,1);assert.equal(f.execution.claude.closed,1);
});

test('Core的通信factory贯穿运行时，真实派工绑定写隔离用户目录且保留桥项目身份',async t=>{
  const f=setup(t,'codex');await f.core.start();assert.equal(f.executorMessagesCreated,0);
  await f.core.manager.handle({id:'owner-goal',userId:'principal:owner',channelId:'test-delivery',text:'核对实际派工',imagePaths:[]});
  await until(()=>f.core.isIdle());const conversation=f.core.manager.currentConversation('principal:owner')!;
  const context=f.core.tasks.createContext({conversationId:conversation.id,userId:conversation.userId,channelId:'test-delivery',
    originMessageId:'owner-goal',nativeId:conversation.nativeId,agent:conversation.agent,cwd:conversation.cwd});
  const dispatched=await f.core.controller!.invoke({conversation,source:{messageId:'owner-goal',userId:conversation.userId,channelId:'test-delivery'},
    text:'只读核对',imagePaths:[],taskContextPath:context.contextPath,signal:new AbortController().signal,onProgress(){}},
    'bridge_start_worker',{targetId:'local',title:'隔离通信绑定',prompt:'返回实际结果',agent:'codex',model:'offline'}) as {workerId:string};
  await until(()=>f.execution.codex.turns.length===1);await f.core.controller!.poll();
  await until(()=>f.executorMessagesCreated===1);
  const home=executorMessageHome(projectRoot,f.isolatedUserHome);assert(existsSync(join(home,'messages.sqlite')));
  assert(!existsSync(join(executorMessageHome(f.root,f.isolatedUserHome),'messages.sqlite')),'不能改用测试工作区作为生产执行器身份');
  const stored=new ExecutorMessages(projectRoot,f.isolatedUserHome);
  try {const binding=stored.binding(dispatched.workerId)!;assert(binding);assert.equal(binding.controllerId,'controller-one');
    assert.equal(binding.scope,executorScope('controller-one','principal:owner'));assert.equal(binding.userId,'principal:owner');}
  finally {stored.close();f.core.tasks.closeContext(context.contextId);}
});

test('外部核心等待不伪装完成，安全排空后原决策持久恢复并静默结束',async t=>{
  const f=setup(t,'codex',false,true);await f.core.start();
  const adapter=f.core.controllerAdapter('external') as ExternalControllerAdapter;
  const binding=adapter.connect('instance-one','external-session');
  await f.core.manager.handle({id:'external-input',userId:'principal:owner',channelId:'controller:controller-one',text:'原始目标',imagePaths:[]});
  await until(()=>adapter.events(binding.lease).some((value:any)=>value.kind==='decision'));
  const first=adapter.events(binding.lease).find((value:any)=>value.kind==='decision') as any;
  assert(!f.core.isIdle(),'外部等待须持久挂起后才允许安全退出');
  f.core.beginDrain();await until(()=>f.core.isIdle());await f.core.close();
  const restarted=new ControllerCore(f.config,f.hooks,undefined,f.dependencies);
  try {
    await restarted.start();const restored=restarted.controllerAdapter('external') as ExternalControllerAdapter;
    const newBinding=restored.connect('instance-one','external-session');
    await until(()=>restored.isWaiting(first.conversationId));
    const decisions=restored.events(newBinding.lease).filter((value:any)=>value.kind==='decision') as any[];
    assert(decisions.some(value=>value.id===first.id),'重启复用持久决策而非重建同一任务');
    const current=decisions.find(value=>value.id===first.id)!;restored.accept(newBinding.lease,current.id);
    await restored.call(newBinding.lease,current.id,'silent','bridge_silent',{});await restored.finish(newBinding.lease,current.id);
    await until(()=>!restored.isWaiting(first.conversationId));
    assert.equal(restarted.manager.currentConversation('principal:owner')!.agent,'external');
    assert.equal(restarted.manager.currentConversation('principal:owner')!.nativeId,'external-session');
  } finally {restarted.beginDrain();await until(()=>restarted.isIdle());await restarted.close();}
});
