import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PendingControllerInputs, pendingInputMessages, type PendingControllerInput } from '../src/controller/pending-inputs.js';
import { harnessText } from '../src/harness.js';

const scope={conversationId:'main',userId:'owner',channelId:'dm'};
const message=(id:string,occurredAt:string,text=id):PendingControllerInput=>({id,speaker:'用户',occurredAt,input:[{type:'text',text}]});
test('未完成消息按接收时间排序去重，只有一段指引，保留图片输入',()=>{
  const input=pendingInputMessages([message('later','2026-11-14T00:02:00Z'),message('first','2026-11-14T00:01:00Z'),message('later','2026-11-14T00:02:00Z'),
    {id:'image',speaker:'助手',occurredAt:'2026-11-14T00:03:00Z',input:[{type:'text',text:'成片完成'},{type:'localImage',path:'C:/preview.jpg'}]}]);
  assert.deepEqual(input,[{type:'text',text:harnessText('manager.controller_recovery')},{type:'text',text:'用户：first'},
    {type:'text',text:'用户：later'},{type:'text',text:'助手：成片完成'},{type:'localImage',path:'C:/preview.jpg'}]);
});
test('积压按会话用户与渠道隔离，确认只清本轮快照，投递未知不重新注入',()=>{
  const db=new DatabaseSync(':memory:');try{
    const journal=new PendingControllerInputs(db);journal.remember(scope,[message('first','2026-11-14T00:01:00Z')]);
    journal.remember(scope,[message('first','2026-11-14T00:01:00Z','不得覆盖原文')]);
    for(const other of [{...scope,conversationId:'other'},{...scope,userId:'other'},{...scope,channelId:'group'}])assert.equal(journal.read(other).length,0);
    const ids=journal.read(scope).map(item=>item.id);journal.remember(scope,[message('later','2026-11-14T00:02:00Z')]);
    journal.acknowledge({...scope,channelId:'other'},ids);assert.equal(journal.read(scope).length,2);
    journal.acknowledge(scope,ids);assert.deepEqual(journal.read(scope).map(item=>item.id),['later']);
    journal.hold(scope,['later']);assert.equal(journal.read(scope).length,0);
    journal.clear(scope.conversationId);assert.equal(db.prepare('SELECT count(*) total FROM controller_pending_inputs').get()!.total,0);
  }finally{db.close();}
});
