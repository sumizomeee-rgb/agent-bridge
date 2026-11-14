import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateWorkspaceRegistry, relocateRegistryValue } from '../src/registry-migration.js';
import { readWorkspaceRegistry } from '../src/registry.js';
function fixture(t:import('node:test').TestContext){
 const root=mkdtempSync(join(tmpdir(),'bridge-registry-migration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=join(root,'project'),workspace=join(root,'workspace'),source=join(project,'.local/data'),bot=join(source,'bots/feishu/cli_test'),configPath=join(project,'.local/config.json');
 const write=(path:string,value:unknown)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value));};
 write(configPath,{version:3,startupProfile:'feishu/test',bots:[],token:'legacy-root-placeholder',appSecret:'legacy-root-placeholder',applicationId:'cli_test',startupProfiles:['feishu/test'],registeredProfiles:['feishu/test'],workspaceRoot:'.local/workspaces',dataDir:'.local/data',defaultAgent:'codex',commands:{codex:{command:process.execPath,args:[]},claude:{command:process.execPath,args:[]}},principals:[{id:'owner',accounts:{'feishu:cli_test':'ou_owner'}}],spaces:[]});
 write(join(project,'.local/bots/feishu/test.json'),{platform:'feishu',applicationId:'cli_test',appSecret:'private-test-secret',allowedUserIds:['ou_owner'],workspace,defaultAgent:'codex',aliases:['Teto'],ownerPrincipalId:'owner',network:{proxyPort:7898}});
 mkdirSync(bot,{recursive:true});const originalUser='feishu:cli_test|ou_owner';
 const db=new DatabaseSync(join(bot,'bridge.sqlite'));db.exec('CREATE TABLE inbox(id TEXT PRIMARY KEY,user_id TEXT,channel_id TEXT,text TEXT,source_json TEXT,images_json TEXT)');
 db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?)').run('original',originalUser,'feishu:cli_test|oc_test','original text '+bot,JSON.stringify({userId:originalUser,messageId:'original'}),JSON.stringify([join(bot,'attachments/image.png')]));db.close();
 const controller=new DatabaseSync(join(bot,'controller.sqlite'));controller.exec('CREATE TABLE controller_jobs(id TEXT PRIMARY KEY,status TEXT,value_json TEXT)');
 controller.prepare('INSERT INTO controller_jobs VALUES(?,?,?)').run('job','completed',JSON.stringify({id:'job',origin:{userId:originalUser,channelId:'feishu:cli_test|oc_chat',originMessageId:'original'},contextPath:join(bot,'contexts/context.json'),processStopped:true}));controller.close();
 const ingress=new DatabaseSync(join(bot,'ingress.sqlite'));ingress.exec('CREATE TABLE incoming(user_id TEXT,payload TEXT)');ingress.prepare('INSERT INTO incoming VALUES(?,?)').run(originalUser,JSON.stringify({userId:originalUser}));ingress.close();
 write(join(bot,'contexts/context.json'),{registryDir:bot,token:'retain-token',origin:{userId:originalUser},source:{userId:originalUser}});
 write(join(bot,'attachments/image.png'),'image-fixture');write(join(workspace,'bridge-remote-agents/registry.json'),{version:1,targets:[]});
 write(join(workspace,'bridge-chat-platforms/lark.md'),'# Existing channel guide');write(join(workspace,'.local/browser/state.json'),{path:join(workspace,'.local/browser/data')});
 write(join(workspace,'README.md'),'Existing manual paragraph.\r\nbridge-remote-agents/ and bridge-chat-platforms/lark.md\r\n');
 return{project,workspace,source,bot,configPath,write,originalUser};
}
test('one-shot migration separates channel data, keeps provenance, relocates runtime paths and preserves source',async t=>{
 const f=fixture(t),options={configPath:f.configPath,controllerIds:{'feishu:cli_test':'teto'}};
 const preview=await migrateWorkspaceRegistry(options);assert.equal(preview.dryRun,true);assert(!JSON.stringify(preview).includes('private-test-secret'));assert(!existsSync(join(f.workspace,'bridge-registry/config.json')));
 const result=await migrateWorkspaceRegistry({...options,dryRun:false});assert.equal(result.applied,true);
 const registry=readWorkspaceRegistry(f.workspace),binding=result.bindings[0]!;assert.equal(registry.controllers[0]!.id,'teto');assert.equal(registry.controllers[0]!.network!.proxyPort,7898);
 const db=new DatabaseSync(join(binding.controllerDataDir,'bridge.sqlite'),{readOnly:true});const row=db.prepare('SELECT * FROM inbox').get()!;db.close();
 assert.equal(row.user_id,'principal:owner');assert.equal(JSON.parse(String(row.source_json)).userId,f.originalUser);assert.equal(row.text,'original text '+f.bot);
 assert.deepEqual(JSON.parse(String(row.images_json)),[join(binding.channelDataDir,'attachments/image.png')]);
 const data=JSON.parse(readFileSync(join(binding.controllerDataDir,'contexts/context.json'),'utf8'));assert.equal(data.registryDir,binding.controllerDataDir);assert.equal(data.origin.userId,'principal:owner');assert.equal(data.source.userId,f.originalUser);assert.equal(data.token,'retain-token');
 const channel=new DatabaseSync(join(binding.channelDataDir,'ingress.sqlite'),{readOnly:true});assert.equal(channel.prepare('SELECT user_id FROM incoming').get()!.user_id,f.originalUser);channel.close();
 assert(existsSync(join(binding.channelDataDir,'attachments/image.png')));assert(existsSync(join(f.bot,'bridge.sqlite')));
 assert.equal(JSON.parse(readFileSync(f.configPath,'utf8')).version,4);assert(!('startupProfiles' in JSON.parse(readFileSync(f.configPath,'utf8'))));
 for(const key of ['startupProfile','bots','token','appSecret','applicationId'])assert(!(key in JSON.parse(readFileSync(f.configPath,'utf8'))),'legacy bootstrap key survived: '+key);
 assert.equal(readFileSync(join(f.workspace,'README.md'),'utf8'),'Existing manual paragraph.\r\nbridge-computers/ and bridge-registry/channels/lark/README.md\r\n');
 assert(existsSync(join(f.workspace,'bridge-computers/registry.json')));assert(existsSync(join(f.workspace,'bridge-local/browser/state.json')));
});
test('host migration hook runs on staged host DB and failure leaves old installation usable',async t=>{
 const f=fixture(t),original=readFileSync(f.configPath);const db=new DatabaseSync(join(f.source,'host.sqlite'));db.exec('CREATE TABLE host_test(id TEXT)');db.close();
 await assert.rejects(migrateWorkspaceRegistry({configPath:f.configPath,dryRun:false,migrateHost:context=>{assert(context.targetHostDir!==context.finalHostDir);assert(existsSync(join(context.targetHostDir,'host.sqlite')));throw new Error('isolated-hook-failure');}}),/isolated-hook-failure/);
 assert.deepEqual(readFileSync(f.configPath),original);assert(!existsSync(join(f.workspace,'bridge-registry/config.json')));assert(existsSync(join(f.bot,'bridge.sqlite')));
});
test('an active host blocks apply rather than migrating in-flight work',async t=>{
 const f=fixture(t);f.write(join(f.source,'bridge.pid.json'),{pid:process.pid});
 const result=await migrateWorkspaceRegistry({configPath:f.configPath});assert(result.blockers.some(v=>v.includes('仍在运行')));
 await assert.rejects(migrateWorkspaceRegistry({configPath:f.configPath,dryRun:false}),/迁移阻断/);
});
test('relocation keeps message IDs, tokens, original source and text intact',()=>{
 const old=join(tmpdir(),'old-root'),next=join(tmpdir(),'new-root'),user='feishu:cli_x|ou_x';
 const value={userId:user,origin:{userId:user},source:{userId:user},original:{userId:user},text:user+' '+old,messageId:user,token:user,path:join(old,'file'),imagePaths:[join(old,'img')]};
 const result=relocateRegistryValue(value,[{from:old,to:next}],{[user]:'principal:owner'}) as typeof value;
 assert.equal(result.userId,'principal:owner');assert.equal(result.origin.userId,'principal:owner');assert.equal(result.source.userId,user);assert.equal(result.original.userId,user);
 assert.equal(result.text,value.text);assert.equal(result.token,user);assert.equal(result.messageId,user);assert.equal(result.path,join(next,'file'));assert.deepEqual(result.imagePaths,[join(next,'img')]);
});

test('native history junctions are preserved as links without cloning their contents',async t=>{
 const f=fixture(t),history=join(f.project,'native-history'),home=join(f.bot,'controller-homes/codex/example');
 mkdirSync(history,{recursive:true});mkdirSync(home,{recursive:true});f.write(join(history,'session.json'),{text:'native transcript unchanged'});
 symlinkSync(history,join(home,'sessions'),process.platform==='win32'?'junction':'dir');
 const result=await migrateWorkspaceRegistry({configPath:f.configPath,dryRun:false});
 assert.equal(realpathSync(join(result.bindings[0]!.controllerDataDir,'controller-homes/codex/example/sessions')),realpathSync(history));
 assert.equal(readFileSync(join(history,'session.json'),'utf8'),JSON.stringify({text:'native transcript unchanged'}));
});

test('an explicit verified host reboot only releases old local uncertain process blockers and preserves reconciliation state',async t=>{
 const f=fixture(t),boot=new Date(Date.now()-86400000).toISOString(),before=new Date(Date.now()-2*86400000).toISOString();
 const db=new DatabaseSync(join(f.bot,'controller.sqlite'));db.exec('CREATE TABLE controller_workers(id TEXT PRIMARY KEY,value_json TEXT NOT NULL)');
 const job={id:'old-local',workerId:'local-worker',createdAt:before,updatedAt:before,status:'uncertain'};
 db.prepare('INSERT INTO controller_workers VALUES(?,?)').run(job.workerId,JSON.stringify({id:job.workerId,blocked:true}));
 db.prepare('INSERT INTO controller_jobs VALUES(?,?,?)').run(job.id,'uncertain',JSON.stringify(job));db.close();
 assert((await migrateWorkspaceRegistry({configPath:f.configPath})).blockers.some(value=>value.includes(job.id)));
 const plan=await migrateWorkspaceRegistry({configPath:f.configPath,hostBootAt:boot});assert.equal(plan.blockers.length,0);assert.equal(plan.hostRebootProofs[0]!.jobId,job.id);assert(plan.warnings.some(value=>value.includes('任务结果仍待核对')));
 const result=await migrateWorkspaceRegistry({configPath:f.configPath,hostBootAt:boot,dryRun:false});
 const saved=new DatabaseSync(join(result.bindings[0]!.controllerDataDir,'controller.sqlite'),{readOnly:true});
 assert.deepEqual(JSON.parse(String(saved.prepare('SELECT value_json FROM controller_jobs WHERE id=?').get(job.id)!.value_json)),job);
 assert.equal(JSON.parse(String(saved.prepare('SELECT value_json FROM controller_workers WHERE id=?').get(job.workerId)!.value_json)).blocked,true);saved.close();
 const manifest=JSON.parse(readFileSync(result.manifestPath!,'utf8'));assert.equal(manifest.hostRebootProofs[0].hostBootAt,boot);
});

test('a bridge-machine reboot cannot prove a remote execution stopped or release a later resumed local job',async t=>{
 const f=fixture(t),boot=new Date(Date.now()-86400000).toISOString(),before=new Date(Date.now()-2*86400000).toISOString();
 const db=new DatabaseSync(join(f.bot,'controller.sqlite'));db.exec('CREATE TABLE controller_workers(id TEXT PRIMARY KEY,value_json TEXT NOT NULL)');
 const old={id:'remote-old',workerId:'remote-worker',createdAt:before,updatedAt:before};
 db.prepare('INSERT INTO controller_workers VALUES(?,?)').run(old.workerId,JSON.stringify({id:old.workerId,target:{transport:'ssh',id:'station'}}));
 db.prepare('INSERT INTO controller_jobs VALUES(?,?,?)').run(old.id,'uncertain',JSON.stringify(old));
 const recent={id:'local-resumed',workerId:'local-worker',createdAt:before,updatedAt:new Date().toISOString()};
 db.prepare('INSERT INTO controller_workers VALUES(?,?)').run(recent.workerId,JSON.stringify({id:recent.workerId,target:{transport:'local',id:'local'}}));
 db.prepare('INSERT INTO controller_jobs VALUES(?,?,?)').run(recent.id,'uncertain',JSON.stringify(recent));db.close();
 const plan=await migrateWorkspaceRegistry({configPath:f.configPath,hostBootAt:boot});assert.equal(plan.hostRebootProofs.length,0);
 assert(plan.blockers.some(value=>value.includes(old.id)));assert(plan.blockers.some(value=>value.includes(recent.id)));
});
