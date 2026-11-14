import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionHandoffs } from '../src/controller/handoff.js';
import { relocateRegistryValue } from '../src/registry-migration.js';
import { repairControllerMigrationArtifacts } from '../src/registry-artifact-repair.js';
import type { Conversation } from '../src/types.js';
function fixture(t:import('node:test').TestContext){
 const root=mkdtempSync(join(tmpdir(),'registry-artifact-repair-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,'old'),target=join(root,'v4'),user='feishu:cli_test|ou_owner',next='principal:owner',users={[user]:next},mappings=[{from:source,to:target}];
 mkdirSync(join(source,'agent-switches'),{recursive:true});
 const a:Conversation={id:'11111111-1111-1111-1111-111111111111',userId:user,agent:'codex',nativeId:null,cwd:join(source,'work'),title:'source',createdAt:'2026-01-01',updatedAt:'2026-01-01'},b={...a,id:'22222222-2222-2222-2222-222222222222',agent:'claude' as const};
 writeFileSync(join(source,'agent-switches',b.id+'.json'),JSON.stringify({version:1,phase:'committed',source:a,target:b}));
 const handoffs=new SessionHandoffs(source);handoffs.prepare(a,b,'channel',[{role:'user',text:'Frozen raw owner '+user,at:'2026-01-01'}],[]);
 const directory=join(source,'session-handoffs',b.id),frozen=readFileSync(join(directory,'source.json')),manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
 const context=Buffer.from('verified continuation\r\n');writeFileSync(join(directory,'context.md'),context);manifest.contextHash=createHash('sha256').update(context).digest('hex');manifest.status='ready';writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));
 const rawSource={messageId:'original',userId:user,channelId:'channel',authorType:'user'};
 const routed={botId:'feishu:cli_test',principalId:'owner',conversationId:a.id,generation:3,messageId:'original',userId:user,channelId:'channel'};
 const scheduled={id:'plan',kind:'message',origin:{userId:user},status:'pending',message:{source:routed,target:{channelId:'channel'}},raw:{source:rawSource},original:{userId:user}};
 const db=new DatabaseSync(join(source,'controller.sqlite'));db.exec('CREATE TABLE controller_schedules(id TEXT PRIMARY KEY,status TEXT,value_json TEXT);CREATE TABLE controller_calls(id TEXT PRIMARY KEY,fingerprint TEXT,result_json TEXT);');
 db.prepare('INSERT INTO controller_schedules VALUES(?,?,?)').run('plan','pending',JSON.stringify(scheduled));db.prepare('INSERT INTO controller_calls VALUES(?,?,?)').run('receipt','unchanged-fingerprint',JSON.stringify({plan:scheduled,source:rawSource}));db.close();
 cpSync(source,target,{recursive:true});
 const legacy=(value:unknown)=>relocateRegistryValue(value,mappings,users,'',false,true);
 for(const path of [join(target,'agent-switches',b.id+'.json'),join(target,'session-handoffs',b.id,'manifest.json'),join(target,'session-handoffs',b.id,'source.json')])writeFileSync(path,JSON.stringify(legacy(JSON.parse(readFileSync(path,'utf8'))),null,2)+'\n');
 const current=new DatabaseSync(join(target,'controller.sqlite'));const broken=legacy(scheduled) as typeof scheduled;broken.status='cancelled';
 current.prepare('UPDATE controller_schedules SET status=?,value_json=?').run('cancelled',JSON.stringify({...broken,newlyRecorded:'keep'}));current.prepare('UPDATE controller_calls SET result_json=?').run(JSON.stringify(legacy({plan:scheduled,source:rawSource})));current.close();
 return{source,target,user,next,users,mappings,b,frozen,context,options:{sourceDataDir:source,controllerDataDir:target,users,pathMappings:mappings}};
}
test('offline v4 repair restores verified frozen bytes and precise business owners while preserving current DB state and raw sources',t=>{
 const f=fixture(t),preview=repairControllerMigrationArtifacts(f.options);assert.equal(preview.files.length,3);assert.deepEqual(preview.scheduleIds,['plan']);assert.deepEqual(preview.receiptIds,['receipt']);
 assert.notDeepEqual(readFileSync(join(f.target,'session-handoffs',f.b.id,'source.json')),f.frozen);
 const result=repairControllerMigrationArtifacts({...f.options,dryRun:false});assert.equal(result.applied,true);
 assert.deepEqual(readFileSync(join(f.target,'session-handoffs',f.b.id,'source.json')),f.frozen);assert.deepEqual(readFileSync(join(f.target,'session-handoffs',f.b.id,'context.md')),f.context);
 const journal=JSON.parse(readFileSync(join(f.target,'agent-switches',f.b.id+'.json'),'utf8'));assert.equal(journal.source.userId,f.next);assert.equal(journal.target.userId,f.next);
 const handoff=new SessionHandoffs(f.target);assert(handoff.prompt({id:f.b.id,userId:f.next,cwd:join(f.target,'work')},'channel'));
 const db=new DatabaseSync(join(f.target,'controller.sqlite'),{readOnly:true}),row=db.prepare('SELECT * FROM controller_schedules').get()!,plan=JSON.parse(String(row.value_json));
 assert.equal(row.status,'cancelled');assert.equal(plan.status,'cancelled');assert.equal(plan.newlyRecorded,'keep');assert.equal(plan.message.source.userId,f.next);assert.equal(plan.raw.source.userId,f.user);assert.equal(plan.original.userId,f.user);
 const receipt=db.prepare('SELECT * FROM controller_calls').get()!,body=JSON.parse(String(receipt.result_json));assert.equal(receipt.fingerprint,'unchanged-fingerprint');assert.equal(body.plan.message.source.userId,f.next);assert.equal(body.source.userId,f.user);db.close();
 const repeat=repairControllerMigrationArtifacts({...f.options,dryRun:false});assert.equal(repeat.files.length,0);assert.equal(repeat.scheduleIds.length,0);assert.equal(repeat.receiptIds.length,0);
});
test('repair rejects unexplained target edits rather than refreshing a hash to approve changed evidence',t=>{
 const f=fixture(t),path=join(f.target,'session-handoffs',f.b.id,'source.json'),changed=JSON.parse(readFileSync(path,'utf8'));changed.messages[0].text='unapproved modified evidence';writeFileSync(path,JSON.stringify(changed));
 assert.throws(()=>repairControllerMigrationArtifacts({...f.options,dryRun:false}),/无法由旧迁移解释/);assert.equal(JSON.parse(readFileSync(path,'utf8')).messages[0].text,'unapproved modified evidence');
});
test('repair requires the retained original snapshot to match its original manifest hash',t=>{
 const f=fixture(t);writeFileSync(join(f.source,'session-handoffs',f.b.id,'source.json'),'{}');
 assert.throws(()=>repairControllerMigrationArtifacts({...f.options,dryRun:false}),/原续接快照校验失败/);
});
