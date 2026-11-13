import type { DatabaseSync } from 'node:sqlite';
import type { AgentInput } from '../types.js';
import { harnessText } from '../harness.js';

export interface PendingInputScope { conversationId: string; userId: string; channelId: string }
export interface PendingControllerInput {
  id: string; speaker: '用户' | '助手' | '定时'; occurredAt: string; input: AgentInput[];
}
/** Failed input content is independent of bounded automatic recovery attempts. */
export class PendingControllerInputs {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS controller_pending_inputs (
      conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      id TEXT NOT NULL, occurred_at TEXT NOT NULL, value_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(conversation_id,id)
    )`);
  }
  remember(scope: PendingInputScope, messages: PendingControllerInput[]): void {
    const insert=this.db.prepare('INSERT OR IGNORE INTO controller_pending_inputs(conversation_id,user_id,channel_id,id,occurred_at,value_json) VALUES(?,?,?,?,?,?)');
    for(const message of messages) insert.run(scope.conversationId,scope.userId,scope.channelId,message.id,message.occurredAt,JSON.stringify(message));
  }
  read(scope: PendingInputScope): PendingControllerInput[] {
    return this.db.prepare("SELECT value_json FROM controller_pending_inputs WHERE conversation_id=? AND user_id=? AND channel_id=? AND state='pending' ORDER BY occurred_at,rowid")
      .all(scope.conversationId,scope.userId,scope.channelId).map(row=>JSON.parse(String(row.value_json)));
  }
  acknowledge(scope: PendingInputScope, ids: string[]): void {
    const remove=this.db.prepare('DELETE FROM controller_pending_inputs WHERE conversation_id=? AND user_id=? AND channel_id=? AND id=?');
    for(const id of ids) remove.run(scope.conversationId,scope.userId,scope.channelId,id);
  }
  hold(scope: PendingInputScope, ids: string[]): void {
    const update=this.db.prepare("UPDATE controller_pending_inputs SET state='uncertain' WHERE conversation_id=? AND user_id=? AND channel_id=? AND id=?");
    for(const id of ids) update.run(scope.conversationId,scope.userId,scope.channelId,id);
  }
  clear(conversationId: string): void { this.db.prepare('DELETE FROM controller_pending_inputs WHERE conversation_id=?').run(conversationId); }
}

export function pendingInputMessages(messages: PendingControllerInput[]): AgentInput[] {
  const ordered=[...new Map(messages.map(message=>[message.id,message])).values()]
    .sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
  return [{type:'text',text:harnessText('manager.controller_recovery')},...ordered.flatMap(message=>[
    {type:'text' as const,text:message.speaker+'：'+message.input.filter(part=>part.type==='text').map(part=>part.text).join('\n')},
    ...message.input.filter(part=>part.type==='localImage'),
  ])];
}
