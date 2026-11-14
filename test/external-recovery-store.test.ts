import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionStore} from '../src/store.js';
import {TaskRegistry,type TaskContextFile} from '../src/tasks.js';

test('external running input survives restart without changing native interruption semantics or other owners',()=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-external-inbox-'));let store=new SessionStore(root);
  try {
    const external=store.createConversation('owner','external',root),native=store.createConversation('owner','codex',root),other=store.createConversation('other','external',root);
    for(const [id,conversation,state] of [['external',external,'running'],['native',native,'running'],['other',other,'steering']] as const)
      store.addMessage({id,userId:conversation.userId,channelId:'source',text:id,imagePaths:[]},conversation.id,state);
    store.close();store=new SessionStore(root);
    assert.equal(store.requeueExternalRunning(['owner']),1);assert.equal(store.getMessage('external')!.state,'queued');
    assert.equal(store.getMessage('native')!.state,'running');assert.equal(store.getMessage('other')!.state,'steering');
    assert.deepEqual(store.interruptRunning(['owner']).map(item=>item.id),['native']);
    assert.equal(store.getMessage('external')!.state,'queued');assert.equal(store.requeueExternalRunning(['owner']),0);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test('external processing receipts resume durably while native results stay uncertain and suspension is idempotent',()=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-external-task-'));let tasks=new TaskRegistry(root);
  try {
    const ids:Record<string,string>={};
    for(const [id,userId,agent] of [['external','owner','external'],['native','owner','claude'],['other','other','external']] as const) {
      const created=tasks.createContext({conversationId:id,userId,agent,nativeId:'native-'+id,cwd:root,channelId:'source',originMessageId:'input-'+id});
      const context=JSON.parse(readFileSync(created.contextPath,'utf8')) as TaskContextFile;
      const registered=tasks.register(context,id);tasks.acceptObservedResult(registered.taskId,'completed','done');
      ids[id]=tasks.completionForTask(registered.taskId)!.id;assert(tasks.claimEvent(ids[id]!));
    }
    tasks.close();tasks=new TaskRegistry(root);
    assert.equal(tasks.requeueExternalProcessing(['owner']),1);assert.equal(tasks.eventState(ids.external!),'queued');
    assert.equal(tasks.eventState(ids.native!),'processing');assert.equal(tasks.eventState(ids.other!),'processing');
    assert.equal(tasks.recoverProcessingEvents(['owner']).length,1);assert.equal(tasks.eventState(ids.native!),'uncertain');
    assert(tasks.claimEvent(ids.external!));assert(tasks.suspendEvent(ids.external!));assert(!tasks.suspendEvent(ids.external!));
    assert.equal(tasks.eventState(ids.external!),'queued');
  } finally {tasks.close();rmSync(root,{recursive:true,force:true});}
});
