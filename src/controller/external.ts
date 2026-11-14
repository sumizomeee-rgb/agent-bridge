import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig } from '../types.js';
import { ControllerCoordinator, createControllerCoordinationState, canonicalControllerJSON, type ControllerCoordinationState, type ControllerDecisionPort } from './coordinator.js';
import { ControllerContextRenderer } from './context.js';
import { workspaceDocuments } from './workspace-documents.js';

export class ExternalControllerSuspended extends Error {
  constructor() { super('External controller waiting persisted'); this.name='ExternalControllerSuspended'; }
}
interface Binding { instanceId:string; sessionId:string; generation:number; lease:string }
interface Decision { id:string; sourceId:string; conversationId:string; generation:number; status:string; deadline:number|null; input:unknown; coordination?:Record<string,unknown>; result?:AgentResult;
  turnFacts?:Pick<AgentTurn,'source'|'text'|'input'|'imagePaths'|'chatScene'> }
interface LiveDecision { decision:Decision; state:ControllerCoordinationState; busy:number; port:ControllerDecisionPort }
type Invoke = (turn:AgentTurn,name:string,args:Record<string,unknown>,id?:string)=>Promise<unknown>;
const valid=(value:unknown,label:string):string=>{if(typeof value!=='string'||!value.trim()||value.length>512||/[\r\n\0]/.test(value))throw new Error(label+'无效');return value;};

/** Durable Agent port. It neither implements a chat platform nor owns execution workers. */
export class ExternalControllerAdapter implements AgentAdapter {
  private database?:DatabaseSync;
  private readonly active=new Map<string,LiveDecision>();
  private readonly calls=new Map<string,Promise<unknown>>();
  private readonly coordinator:ControllerCoordinator;
  private readonly context:ControllerContextRenderer;
  private closing=false;
  constructor(private readonly config:BridgeConfig,invoke:Invoke) {
    this.coordinator=new ControllerCoordinator({invokeTool:invoke,internalBotCommunicationEnabled:config.internalBotCommunicationEnabled});
    this.context=new ControllerContextRenderer({defaultModels:config.defaultModels,internalBotCommunicationEnabled:config.internalBotCommunicationEnabled,
      identity:{controllerId:config.controllerId,botId:config.botId,aliases:config.aliases??[]}});
  }
  private db():DatabaseSync {
    if(this.config.controllerBackend?.kind!=='external')throw new Error('此主控未登记外部Agent');
    if(!this.database){mkdirSync(this.config.dataDir,{recursive:true});this.database=new DatabaseSync(join(this.config.dataDir,'external.sqlite'));
      this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS external_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS external_decisions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,conversation_id TEXT NOT NULL,value_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS external_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS external_calls(id TEXT PRIMARY KEY,signature TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT);
      `);}
    return this.database;
  }
  private binding():Binding|null {const row=this.db().prepare('SELECT value_json FROM external_binding WHERE singleton=1').get();return row?JSON.parse(String(row.value_json)):null;}
  private transaction<T>(operation:()=>T):T {
    const db=this.db();db.exec('BEGIN IMMEDIATE');
    try{const result=operation();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }
  private snapshot(live:LiveDecision):void {
    const state=live.state;
    live.decision.turnFacts={source:state.turn.source,text:state.turn.text,input:state.turn.input,imagePaths:state.turn.imagePaths,chatScene:state.turn.chatScene};
    live.decision.coordination={toolCalls:state.toolCalls,helpCalls:state.helpCalls,publicCalls:state.publicCalls,
      silent:state.silent,restartAccepted:state.restartAccepted,sealed:state.sealed,
      sceneRefreshPending:state.sceneRefreshPending,sceneReassessmentStarted:state.sceneReassessmentStarted,
      privateFinalCallId:state.privateFinalCallId,replyRecovery:state.replyRecovery,collaborationCompleted:state.collaborationCompleted};
    this.save(live.decision);
  }
  private save(value:Decision):void {this.db().prepare('INSERT INTO external_decisions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(value.id,value.sourceId,value.conversationId,JSON.stringify(value));}
  private emit(id:string,payload:unknown):void {this.db().prepare('INSERT OR IGNORE INTO external_events(id,payload_json) VALUES(?,?)').run(id,JSON.stringify(payload));}
  connect(instanceId:string,sessionId:string):Binding {
    instanceId=valid(instanceId,'instanceId');sessionId=valid(sessionId,'sessionId');
    if(this.closing)throw new Error('主控端口正在关闭');
    if([...this.active.values()].some(live=>live.busy>0))throw new Error('仍有在途工具调用，暂不能更换外部实例');
    const previous=this.binding();
    if(previous?.instanceId===instanceId&&previous.sessionId===sessionId)return previous;
    if([...this.active.values()].some(live=>live.state.turn.conversation.nativeId&&live.state.turn.conversation.nativeId!==sessionId))
      throw new Error('当前主控会话已经绑定真实外部 Session；更换 Session 请先新建主控会话');
    const binding={instanceId,sessionId,generation:(previous?.generation??0)+1,lease:randomUUID()};
    this.db().prepare('INSERT INTO external_binding VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET value_json=excluded.value_json').run(JSON.stringify(binding));
    for(const live of this.active.values()) {
      live.decision.generation=binding.generation;this.save(live.decision);
      live.state.turn.conversation.nativeId=sessionId;live.state.turn.onNativeId?.(sessionId);
      this.emit(live.decision.id+':binding:'+binding.generation,{kind:'decision',...live.decision});
    }
    return binding;
  }
  events(lease:string,after=0):unknown[] {
    this.authorize(lease);
    return this.db().prepare('SELECT sequence,payload_json FROM external_events WHERE sequence>? ORDER BY sequence LIMIT 100').all(after)
      .map(row=>({sequence:Number(row.sequence),...JSON.parse(String(row.payload_json))}));
  }
  private authorize(lease:string,decisionId?:string):LiveDecision|undefined {
    const binding=this.binding();if(!binding||binding.lease!==lease)throw new Error('外部实例已失效或未认证');
    if(!decisionId)return undefined;
    const live=[...this.active.values()].find(item=>item.decision.id===decisionId);
    if(!live||live.decision.generation!==binding.generation||!['queued','accepted'].includes(live.decision.status))throw new Error('决策已退休、撤销或尚未恢复');
    if(live.decision.deadline!==null&&Date.now()>live.decision.deadline)throw new Error('主控响应等待已到期；已派助手不受影响，需核对后重新激活');
    return live;
  }
  accept(lease:string,id:string):void {
    const live=this.authorize(lease,id)!;live.decision.status='accepted';this.save(live.decision);
    const binding=this.binding()!;live.state.turn.conversation.nativeId=binding.sessionId;live.state.turn.onNativeId?.(binding.sessionId);
    live.state.turn.onReady?.();live.state.turn.onControllerState?.({phase:'accepted',submission:'accepted',attempt:1});
  }
  async call(lease:string,id:string,callId:string,name:string,args:Record<string,unknown>):Promise<unknown> {
    const live=this.authorize(lease,id)!;if(live.decision.status!=='accepted')throw new Error('先确认接收本次决策');
    valid(callId,'callId');const key=JSON.stringify([live.decision.sourceId,callId]);
    const signature=createHash('sha256').update(canonicalControllerJSON([name,args])).digest('hex');
    const row=this.db().prepare('SELECT * FROM external_calls WHERE id=?').get(key);
    if(row){if(row.signature!==signature)throw new Error('同一调用ID的参数不一致');const running=this.calls.get(key);if(running)return running;
      if(row.status==='rejected')throw new Error(String(JSON.parse(String(row.result_json)).error));
      if(row.status!=='done')return {status:'unknown',message:'已有调用结果未确认，请核对已有操作，不要重发副作用'};
      return JSON.parse(String(row.result_json));}
    this.db().prepare("INSERT INTO external_calls VALUES(?,?,'running',NULL)").run(key,signature);
    live.busy++;
    const work=this.coordinator.invoke(live.state,name,args,callId).then(result=>{
      this.transaction(()=>{
        this.snapshot(live);
        this.db().prepare("UPDATE external_calls SET status='done',result_json=? WHERE id=?").run(JSON.stringify(result??null),key);
        this.emit('tool:'+key,{kind:'tool-result',decisionId:id,callId,result});
      });return result;
    },error=>{this.snapshot(live);this.db().prepare("UPDATE external_calls SET status='rejected',result_json=? WHERE id=?").run(JSON.stringify({error:error instanceof Error?error.message:String(error)}),key);throw error;}).finally(()=>{live.busy--;this.calls.delete(key);});
    this.calls.set(key,work);return work;
  }
  async finish(lease:string,id:string):Promise<unknown> {
    this.authorize(lease);
    const saved=this.db().prepare('SELECT value_json FROM external_decisions WHERE id=?').get(id);
    if(saved){const decision=JSON.parse(String(saved.value_json)) as Decision;
      if(decision.status==='completed'&&decision.generation===this.binding()!.generation)return {status:'completed'};
    }
    const live=this.authorize(lease,id)!;if(live.decision.status!=='accepted')throw new Error('先确认接收本次决策');
    live.busy++;try{const status=await this.coordinator.finish(live.state,live.port);this.snapshot(live);return {status};}finally{live.busy--;}
  }
  async run(original:AgentTurn):Promise<AgentResult> {
    if(this.closing)throw new ExternalControllerSuspended();
    const deliveryRequirement=original.deliveryRequirement??(this.config.botId?'private':'none');
    const {turn,acknowledge}=this.context.begin({...original,deliveryRequirement});
    const state=createControllerCoordinationState(turn),binding=this.binding();
    if(binding&&turn.conversation.nativeId&&turn.conversation.nativeId!==binding.sessionId)
      throw new Error('外部 Session 与当前主控会话不一致，请接回原 Session 或新建会话');
    const sourceId=turn.source?.messageId;if(!sourceId)throw new Error('外部轮次缺少可信来源ID');
    const old=this.db().prepare("SELECT value_json FROM external_decisions WHERE source_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 1").get(sourceId,turn.conversation.id);
    const previous=old?JSON.parse(String(old.value_json)) as Decision:null;
    if(previous?.status==='completed'&&previous.result){acknowledge();return previous.result;}
    if(previous?.status==='cancelled')throw new Error('原外部主控决策已撤销，不自动重做');
    if(previous?.status==='expired'||previous?.status==='failed')throw new Error('原外部主控决策已结束，结果保留，不自动重做');
    const decision:Decision=previous&&['queued','accepted'].includes(previous.status)?previous:{id:randomUUID(),sourceId,conversationId:turn.conversation.id,generation:binding?.generation??0,status:'queued',deadline:this.config.responseWaitMs==null?null:Date.now()+this.config.responseWaitMs,input:null};
    if(previous?.coordination)Object.assign(state,previous.coordination);
    if(previous?.turnFacts){
      const facts=previous.turnFacts;
      if(facts.source?.userId!==turn.source?.userId||facts.source?.channelId!==turn.source?.channelId)
        throw new Error('外部主控续判的消息归属不一致');
      state.turn={...state.turn,...facts};
    }
    const live:LiveDecision={decision,state,busy:0,port:null!};
    const exportInput=(input=state.turn.input??[{type:'text',text:state.turn.text}])=>({input,context:this.context.runtime(state.turn,{model:undefined,effort:undefined},true),
      fixedContext:workspaceDocuments(this.config.contextWorkspace??this.config.workspace,{agent:'external',internalBotCommunicationEnabled:this.config.internalBotCommunicationEnabled}),source:state.turn.source});
    const continueDecision=(input:unknown)=>{
      this.transaction(()=>{
        live.decision.status='superseded';this.save(live.decision);
        live.decision={...live.decision,id:randomUUID(),status:'queued',input};this.snapshot(live);this.emit(live.decision.id,{kind:'decision',...live.decision});
      });
    };
    live.port={resetDecision(){state.inFlightTools.clear();state.toolCalls=0;state.publicCalls=0;state.sealed=false;},
      continueDecision:async(_kind,evidence)=>continueDecision(exportInput([{type:'text',text:evidence}])),
      continuePrivate:async input=>continueDecision(exportInput(input)),
      result:()=>{const current=this.binding();if(!current)throw new Error('外部Agent尚未注册真实会话');return {nativeId:current.sessionId,text:'',controlledOutput:true};}};
    decision.generation=binding?.generation??decision.generation;decision.input=exportInput((previous?.input as {input?:AgentTurn['input']}|null)?.input);this.save(decision);this.active.set(turn.conversation.id,live);
    this.emit(previous ? decision.id+':resume:'+randomUUID() : decision.id,{kind:'decision',...decision});
    if(binding){turn.conversation.nativeId=binding.sessionId;turn.onNativeId?.(binding.sessionId);}
    const abort=()=>{live.decision.status='cancelled';this.save(live.decision);state.completed.reject(new Error('外部主控轮次已撤销'));};
    turn.signal.addEventListener('abort',abort,{once:true});
    let deadlineTimer:ReturnType<typeof setTimeout>|undefined;
    const expire=()=>{
      if(live.decision.deadline===null)return;
      const remaining=live.decision.deadline-Date.now();
      if(remaining>0){deadlineTimer=setTimeout(expire,Math.min(remaining,2_147_483_647));deadlineTimer.unref();return;}
      live.decision.status='expired';this.snapshot(live);state.completed.reject(new Error('外部主控响应等待已到期；执行助手状态保留，请核对后继续'));
    };
    expire();if(turn.signal.aborted)abort();
    try{const result=await state.completed.promise;acknowledge();this.transaction(()=>{
      live.decision.status='completed';live.decision.result=result;this.snapshot(live);
      this.emit('complete:'+live.decision.id,{kind:'completed',decisionId:live.decision.id,generation:live.decision.generation,result});
    });return result;}
    catch(error){
      if(!(error instanceof ExternalControllerSuspended)&&!['cancelled','expired'].includes(live.decision.status)){
        live.decision.status='failed';this.snapshot(live);
      }
      throw error;
    }
    finally{if(deadlineTimer)clearTimeout(deadlineTimer);turn.signal.removeEventListener('abort',abort);this.active.delete(turn.conversation.id);}
  }
  isWaiting(id:string):boolean {const live=this.active.get(id);return !!live&&live.busy===0;}
  async suspend(id:string):Promise<void> {const live=this.active.get(id);if(live&&live.busy===0)live.state.completed.reject(new ExternalControllerSuspended());}
  async interrupt(id:string):Promise<void> {const live=this.active.get(id);if(live){live.decision.status='cancelled';this.save(live.decision);live.state.completed.reject(new Error('外部主控轮次已撤销'));}}
  async confirmStopped(id:string):Promise<boolean> {return !this.active.has(id);}
  async close():Promise<void> {this.closing=true;for(const id of this.active.keys())await this.suspend(id);await Promise.allSettled(this.calls.values());this.database?.close();this.database=undefined;}
}
