import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TaskOrigin } from './tasks.js';

export interface DispatchFailureScope {
  botId: string; conversationId: string; userId: string; channelId: string; nativeId: string | null; groupKey: string;
}
export interface DispatchFailureRecord extends DispatchFailureScope {
  id: string; tool: string; title: string; reason: string; sourceId: string; callId: string;
  origin: TaskOrigin; createdAt: number; handledAt: number | null; note?: string;
  targetId?: string; cwd?: string; workerId?: string;
  autoState: 'active' | 'paused' | 'inactive'; reminders: number; nextAt: number;
  reviewTaskId?: string; notified?: boolean; notificationState?: 'sending'|'unknown';
}
export interface DispatchFailureView {
  id: string; tool: string; title: string; reason: string; createdAt: number; handled: boolean;
  autoState: DispatchFailureRecord['autoState']; reminders: number; note?: string;
  sourceId: string; originMessageId: string; targetId?: string; cwd?: string; workerId?: string;
}
export interface DispatchFailureBatch { records: DispatchFailureView[]; remaining: number }
export const dispatchFailureTools = new Set(['bridge_list_dispatch_failures','bridge_ack_dispatch_failure']);
export const dispatchFailureOperations = new Set(['bridge_start_worker','bridge_continue_worker','bridge_schedule_worker']);
const scopeKey = (s: DispatchFailureScope) => JSON.stringify([s.botId,s.conversationId,s.userId,s.channelId,s.nativeId,s.groupKey]);
const view = (r: DispatchFailureRecord): DispatchFailureView => ({id:r.id,tool:r.tool,title:r.title,reason:r.reason,
  createdAt:r.createdAt,handled:r.handledAt!==null,autoState:r.autoState,reminders:r.reminders,...(r.note?{note:r.note}:{}),
  sourceId:r.sourceId,originMessageId:r.origin.originMessageId,...(r.targetId?{targetId:r.targetId}:{}),...(r.cwd?{cwd:r.cwd}:{}),...(r.workerId?{workerId:r.workerId}:{})});

/** A red dot is an explicit disposition record, independent of feedback delivery or worker status. */
export class DispatchFailureJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS dispatch_failures(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,conversation_id TEXT NOT NULL,value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dispatch_failure_scope ON dispatch_failures(scope_key);`);
  }
  recoverNotifications():void {for(const r of this.rows())if(r.notificationState==='sending'){r.notificationState='unknown';this.write(r);}}
  private write(r:DispatchFailureRecord):void {
    this.db.prepare('INSERT INTO dispatch_failures(id,scope_key,conversation_id,value_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json')
      .run(r.id,scopeKey(r),r.conversationId,JSON.stringify(r));
  }
  private rows():DispatchFailureRecord[] {
    return this.db.prepare('SELECT value_json FROM dispatch_failures ORDER BY rowid').all().map(r=>JSON.parse(String(r.value_json)) as DispatchFailureRecord);
  }
  record(scope:DispatchFailureScope,origin:TaskOrigin,sourceId:string,callId:string|undefined,tool:string,title:string,reason:string,now:number,facts:Pick<DispatchFailureRecord,'targetId'|'cwd'|'workerId'>={}):DispatchFailureRecord {
    const stable=callId??randomUUID(),id=createHash('sha256').update(JSON.stringify([scopeKey(scope),sourceId,stable,tool])).digest('hex');
    const old=this.get(id);if(old)return old;
    const r:DispatchFailureRecord={...scope,...facts,id,origin,sourceId,callId:stable,tool,title:title.slice(0,160),reason:reason.slice(0,1200),
      createdAt:now,handledAt:null,autoState:'active',reminders:0,nextAt:now+30000};this.write(r);return r;
  }
  get(id:string):DispatchFailureRecord|null {const r=this.db.prepare('SELECT value_json FROM dispatch_failures WHERE id=?').get(id);return r?JSON.parse(String(r.value_json)) as DispatchFailureRecord:null;}
  read(scope:DispatchFailureScope,includeHandled=false,limit=8):DispatchFailureBatch {
    const rows=this.db.prepare('SELECT value_json FROM dispatch_failures WHERE scope_key=? ORDER BY rowid').all(scopeKey(scope))
      .map(r=>JSON.parse(String(r.value_json)) as DispatchFailureRecord).filter(r=>includeHandled||r.handledAt===null);
    return{records:rows.slice(0,limit).map(view),remaining:Math.max(0,rows.length-limit)};
  }
  ack(scope:DispatchFailureScope,id:string,note:string|undefined,now:number):{id:string;handled:true} {
    const r=this.get(id);if(!r||scopeKey(r)!==scopeKey(scope))throw new Error('失败记录不存在或不属于当前主控及聊天。');
    if(r.handledAt===null){r.handledAt=now;r.note=note;r.autoState='inactive';delete r.reviewTaskId;this.write(r);}return{id,handled:true};
  }
  deactivate(conversationId:string):void {for(const r of this.rows())if(r.conversationId===conversationId&&r.handledAt===null){r.autoState='inactive';delete r.reviewTaskId;this.write(r);}}
  deactivateReview(taskId:string):void {for(const r of this.pendingReview(taskId)){r.autoState='inactive';delete r.reviewTaskId;this.write(r);}}
  deactivateScope(scope:DispatchFailureScope):void {for(const r of this.rows())if(scopeKey(r)===scopeKey(scope)&&r.handledAt===null){r.autoState='inactive';delete r.reviewTaskId;this.write(r);}}
  releaseReview(taskId:string,now:number):void {for(const r of this.pendingReview(taskId)){delete r.reviewTaskId;r.nextAt=now+30000;this.write(r);}}
  hasWork():boolean {return this.rows().some(r=>r.handledAt===null&&(r.autoState==='active'||r.autoState==='paused'&&!r.notified&&!r.notificationState));}
  due(now:number):DispatchFailureRecord[][] {
    const groups=new Map<string,DispatchFailureRecord[]>();
    for(const r of this.rows())if(r.handledAt===null&&r.autoState==='active'&&r.nextAt<=now){const key=scopeKey(r);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(r);}
    return[...groups.values()];
  }
  pendingReview(taskId:string):DispatchFailureRecord[] {return this.rows().filter(r=>r.reviewTaskId===taskId&&r.handledAt===null&&r.autoState==='active');}
  assign(records:DispatchFailureRecord[],taskId:string):void {for(const original of records){const r=this.get(original.id);if(r&&r.handledAt===null&&r.autoState==='active'){r.reviewTaskId=taskId;this.write(r);}}}
  reminded(taskId:string,now:number):void {
    for(const r of this.pendingReview(taskId)){delete r.reviewTaskId;r.reminders++;r.nextAt=now+30000;if(r.reminders>=3)r.autoState='paused';this.write(r);}
  }
  pendingNotifications():DispatchFailureRecord[][] {
    const groups=new Map<string,DispatchFailureRecord[]>();
    for(const r of this.rows())if(r.handledAt===null&&r.autoState==='paused'&&!r.notified&&!r.notificationState){const key=scopeKey(r);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(r);}
    return[...groups.values()];
  }
  notification(records:DispatchFailureRecord[],state:'sending'|'delivered'|'unknown'|'retry'):void {
    for(const input of records){const r=this.get(input.id);if(!r||r.handledAt!==null||r.autoState!=='paused')continue;
      if(state==='delivered'){r.notified=true;delete r.notificationState;}else if(state==='retry')delete r.notificationState;else r.notificationState=state;this.write(r);}
  }
}
