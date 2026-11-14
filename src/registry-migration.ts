import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, lstatSync, statSync, readlinkSync, symlinkSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { readJson, selectProfile, profileScope, type BotProfile } from './profiles.js';
import { readWorkspaceRegistry } from './registry.js';
import { prepareControllerStateMigration } from './controller-state-migration.js';

export interface RegistryMigrationBinding {
  botId:string;controllerId:string;profile:string;ownerPrincipalId:string;ownerUserId:string;
  sourceDataDir:string;controllerDataDir:string;channelDataDir:string;
}
export interface RegistryMigrationContext {
  sourceHostDir:string;targetHostDir:string;finalHostDir:string;bindings:RegistryMigrationBinding[];
}
export interface RegistryMigrationBootProof { dataDir:string;jobId:string;workerId:string;hostBootAt:string;lastUpdatedAt:string;execution:'local';preservedStatus:'uncertain' }
export interface RegistryMigrationOptions {
  configPath:string;workspaceRoot?:string;hostBootAt?:string;controllerIds?:Record<string,string>;owners?:Record<string,string>;
  dryRun?:boolean;migrateHost?:(context:RegistryMigrationContext)=>void;
}
export interface RegistryMigrationPlan {
  version:4;dryRun:boolean;configPath:string;workspaceRoot:string;sourceHostDir:string;targetHostDir:string;
  bindings:RegistryMigrationBinding[];startupControllers:string[];blockers:string[];warnings:string[];
  applied?:boolean;manifestPath?:string;hostRebootProofs:RegistryMigrationBootProof[];
}
export interface RegistryPathMapping {from:string;to:string}
const pathKeys=new Set(['cwd','path','root','home','dataDir','attachmentsDir','logsDir','registryDir','contextPath','ticketPath','ticket_path','context_path','rollout_path','transcriptPath','completionFile','exitFile','resultFile','imagePaths','images_json','attachmentPaths','helperPath','nodePath','remoteRoot','sshConfig','browserRoot','browserProfile','profileDir','userDataDir','profileHome','sqliteHome','localPath','localPaths','outputPath','inputPath','launchDir','privateRoot','dataRoot','sessionDir','codexHome','claudeHome','args']);
const ownerKeys=new Set(['userId','user_id','ownerUserId','owner_user_id']);
const sourceKeys=new Set(['source','original','source_json']);
const channelFiles=new Set(['ingress.sqlite','feishu-outbox.sqlite','lifecycle.sqlite']);
const channelDirectories=new Set(['attachments']);
const transientFiles=new Set(['bridge.pid.json','supervisor.pid.json','stop.request','drain-stop.request','disabled']);
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
function inside(root:string,path:string):string|null{
  if(!isAbsolute(path))return null;const suffix=relative(root,path);
  return suffix===''||suffix!=='..'&&!suffix.startsWith('..'+sep)&&!isAbsolute(suffix)?suffix:null;
}
/** Relocate program path fields and canonical business owners; provenance/text/signatures remain unchanged. */
export function relocateRegistryValue(value:unknown,mappings:RegistryPathMapping[],principalUsers:Record<string,string>,key='',sourceEvidence=false):unknown{
  sourceEvidence ||= sourceKeys.has(key);
  if(typeof value==='string'){
    if(!sourceEvidence&&ownerKeys.has(key)&&principalUsers[value])return principalUsers[value];
    if(pathKeys.has(key))for(const mapping of mappings){const suffix=inside(mapping.from,value);if(suffix!==null)return join(mapping.to,suffix);}
    return value;
  }
  if(Array.isArray(value))return value.map(item=>relocateRegistryValue(item,mappings,principalUsers,key,sourceEvidence));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,relocateRegistryValue(item,mappings,principalUsers,name,sourceEvidence)]));
  return value;
}
function stopped(path:string):boolean{
  if(!existsSync(path))return true;const raw=readJson(path),pid=Number(raw.pid);
  if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('停止证明PID无效：'+path);
  try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}
}
function table(db:DatabaseSync,name:string):boolean{return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function sourceBlockers(dataDir:string,hostBootAt:string|undefined,warnings:string[],proofs:RegistryMigrationBootProof[]):string[]{
  const blockers:string[]=[];
  for(const file of ['bridge.pid.json','supervisor.pid.json'])if(!stopped(join(dataDir,file)))blockers.push('桥或监督进程仍在运行：'+file);
  const controller=join(dataDir,'controller.sqlite');
  if(existsSync(controller)){const db=new DatabaseSync(controller,{readOnly:true});try{
    if(table(db,'controller_jobs'))for(const row of db.prepare('SELECT id,status,value_json FROM controller_jobs').all()){
      const job=JSON.parse(String(row.value_json));
      if(row.status==='uncertain'&&job.processStopped===undefined&&hostBootAt&&table(db,'controller_workers')&&typeof job.workerId==='string'){
        const saved=db.prepare('SELECT value_json FROM controller_workers WHERE id=?').get(job.workerId),worker=saved?JSON.parse(String(saved.value_json)):null;
        const last=Date.parse(job.updatedAt),boot=Date.parse(hostBootAt),created=Date.parse(job.createdAt),started=job.startedAt===undefined?created:Date.parse(job.startedAt);
        if(worker&&worker.id===job.workerId&&(worker.target===undefined||worker.target&&worker.target.transport==='local')&&Number.isFinite(last)&&Number.isFinite(created)&&Number.isFinite(started)&&last<boot&&created<boot&&started<boot){
          proofs.push({dataDir,jobId:String(row.id),workerId:job.workerId,hostBootAt,lastUpdatedAt:job.updatedAt,execution:'local',preservedStatus:'uncertain'});
          warnings.push('旧本地执行早于已核实的宿主启动时间，旧进程不可能存活；任务结果仍待核对：'+row.id);continue;
        }
      }
      if(row.status==='running'||job.processStopped===false||row.status==='uncertain'&&job.processStopped!==true)blockers.push('执行停止尚未确认：'+row.id);
    }
  }finally{db.close();}}
  return blockers;
}
function safeCopyDirectory(source:string,target:string):void{
  const stat=lstatSync(source);if(stat.isSymbolicLink())throw new Error('迁移拒绝跟随目录联接或符号链接：'+source);
  if(stat.isDirectory()){mkdirSync(target,{recursive:true});for(const name of readdirSync(source))safeCopyDirectory(join(source,name),join(target,name));}
  else if(stat.isFile()){mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target);}else throw new Error('不支持的迁移文件类型：'+source);
}
async function copyRuntime(source:string,target:string,mappings:RegistryPathMapping[]=[]):Promise<void>{
  const stat=lstatSync(source);if(stat.isSymbolicLink()){
    const original=resolve(dirname(source),readlinkSync(source)),kind=statSync(source).isDirectory();
    const destination=relocateRegistryValue(original,mappings,{},'path') as string;
    mkdirSync(dirname(target),{recursive:true});symlinkSync(destination,target,kind?(process.platform==='win32'?'junction':'dir'):'file');return;
  }
  if(stat.isDirectory()){mkdirSync(target,{recursive:true});for(const name of readdirSync(source))await copyRuntime(join(source,name),join(target,name),mappings);}
  else if(stat.isFile()){
    if(/\.sqlite-(wal|shm)$/.test(source))return;
    mkdirSync(dirname(target),{recursive:true});
    if(source.endsWith('.sqlite')){const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,target);}finally{db.close();}}
    else copyFileSync(source,target);
  }else throw new Error('不支持的运行数据类型：'+source);
}
function rewriteDatabase(path:string,mappings:RegistryPathMapping[],users:Record<string,string>):void{
  const db=new DatabaseSync(path);try{
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    const controllerState=Object.keys(users).length?prepareControllerStateMigration(db,users):undefined;
    for(const schema of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
      const name=String(schema.name);if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('不支持的数据库表名');
      const columns=db.prepare('PRAGMA table_info('+name+')').all();
      const withoutRowid=/WITHOUT\s+ROWID/i.test(String(schema.sql)),keys=withoutRowid?columns.filter(c=>Number(c.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(c=>String(c.name)):['__migration_rowid'];
      for(const row of db.prepare('SELECT '+(withoutRowid?'':'rowid AS __migration_rowid,')+'* FROM '+name).all()){
        const changes:Array<[string,SQLInputValue]>=[];
        for(const column of columns){const key=String(column.name),value=row[key];if(typeof value!=='string')continue;
          let next:unknown=value;
          try{next=JSON.stringify(relocateRegistryValue(JSON.parse(value),mappings,users,key));}catch{next=relocateRegistryValue(value,mappings,users,key);}
          if(next!==value)changes.push([key,next as SQLInputValue]);
        }
        if(changes.length)db.prepare('UPDATE '+name+' SET '+changes.map(([key])=>'"'+key+'"=?').join(',')+' WHERE '+keys.map(key=>key==='__migration_rowid'?'rowid=?':'"'+key+'"=?').join(' AND '))
          .run(...changes.map(([,value])=>value),...keys.map(key=>row[key] as SQLInputValue));
      }
    }
    controllerState?.apply();
    const check=db.prepare('PRAGMA integrity_check').get();if(Object.values(check??{})[0]!=='ok')throw new Error('迁移后的数据库完整性校验失败');
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}
function rewriteFiles(root:string,mappings:RegistryPathMapping[],users:Record<string,string>):void{
  for(const name of readdirSync(root)){const path=join(root,name),stat=lstatSync(path);if(stat.isSymbolicLink())continue;
    if(stat.isDirectory())rewriteFiles(path,mappings,users);
    else if(name.endsWith('.sqlite'))rewriteDatabase(path,mappings,users);
    else if(name.endsWith('.json')||name.endsWith('.jsonl')){
      const bytes=readFileSync(path),source=bytes.toString('utf8').replace(/^\uFEFF/,'');let next:string;
      try{next=name.endsWith('.jsonl')?source.split(/\r?\n/).map(line=>line.trim()?JSON.stringify(relocateRegistryValue(JSON.parse(line),mappings,users)):line).join(source.includes('\r\n')?'\r\n':'\n')
        :json(relocateRegistryValue(JSON.parse(source),mappings,users));}catch{continue;}
      if(source!==next)writeFileSync(path,next,'utf8');
    }
  }
}
function controllerId(profile:BotProfile,botId:string,configured?:string):string{
  const candidate=configured??profile.aliases?.find(alias=>/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(alias))?.toLowerCase()??'controller-'+createHash('sha256').update(botId).digest('hex').slice(0,12);
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(candidate))throw new Error('无效的目标主控ID：'+candidate);return candidate;
}
/** One-shot offline semantic migration. Source material remains available for post-start verification/recycling. */
export async function migrateWorkspaceRegistry(options:RegistryMigrationOptions):Promise<RegistryMigrationPlan>{
  const configPath=resolve(options.configPath),configBytes=readFileSync(configPath),raw=readJson(configPath);
  if(options.hostBootAt!==undefined&&(!/^\d{4}-\d{2}-\d{2}T/.test(options.hostBootAt)||!Number.isFinite(Date.parse(options.hostBootAt))||Date.parse(options.hostBootAt)>Date.now()))throw new Error('hostBootAt必须是已核实且不晚于当前时间的ISO启动时间');
  if(raw.version!==3)throw new Error('一次性登记迁移只接受version:3；新运行时不回退旧配置');
  const project=dirname(dirname(configPath));
  const startupProfiles=raw.startupProfiles as string[];
  if(!Array.isArray(startupProfiles)||!startupProfiles.length)throw new Error('旧启动集合无效');
  const names=[...new Set([...startupProfiles,...((raw.registeredProfiles??[]) as string[])])];
  const profiles=names.map(name=>selectProfile(raw,configPath,name));
  const defaultWorkspaces=[...new Set(profiles.filter(p=>startupProfiles.includes(p.name)).map(p=>resolve(project,p.workspace??join(String(raw.workspaceRoot??'.local/workspaces'),p.platform,p.applicationId!))))];
  if(!options.workspaceRoot&&defaultWorkspaces.length!==1)throw new Error('旧工作区不唯一，请明确指定新的workspaceRoot');
  const workspaceRoot=resolve(options.workspaceRoot??defaultWorkspaces[0]!),registryRoot=join(workspaceRoot,'bridge-registry');
  const sourceHostDir=resolve(project,String(raw.dataDir??'.local/data')),targetHostDir=join(workspaceRoot,'bridge-local','host');
  const principals=JSON.parse(JSON.stringify(raw.principals??[])) as Array<{id:string;accounts:Record<string,string>}>;
  const bindings=profiles.map(profile=>{
    const botId=profileScope(profile).slice(0,-1),id=controllerId(profile,botId,options.controllerIds?.[botId]);
    let principal=principals.find(p=>profile.ownerPrincipalId?p.id===profile.ownerPrincipalId:p.accounts[botId]);
    const owner=options.owners?.[botId]??principal?.accounts[botId]??(profile.allowedUserIds.length===1?profile.allowedUserIds[0]:undefined);
    if(!owner||!profile.allowedUserIds.includes(owner))throw new Error('无法确认旧主控owner，请明确提供：'+botId);
    if(!principal){principal={id:profile.ownerPrincipalId??id+'-owner',accounts:{[botId]:owner}};principals.push(principal);}
    if(principal.accounts[botId]!==owner)throw new Error('旧owner与principal映射冲突：'+botId);
    return {botId,controllerId:id,profile:profile.name,ownerPrincipalId:principal.id,ownerUserId:botId+'|'+owner,
      sourceDataDir:join(sourceHostDir,'bots',profile.platform,profile.applicationId!),controllerDataDir:join(registryRoot,'controllers',id,'data'),
      channelDataDir:join(registryRoot,'channels',profile.platform==='feishu'?'lark':'discord','bots',profile.applicationId!,'data')};
  });
  if(new Set(bindings.map(b=>b.controllerId)).size!==bindings.length)throw new Error('目标主控ID重复，请提供明确映射');
  const warnings:string[]=[],hostRebootProofs:RegistryMigrationBootProof[]=[];
  const blockers=sourceBlockers(sourceHostDir,options.hostBootAt,warnings,hostRebootProofs);
  for(const binding of bindings){if(existsSync(binding.sourceDataDir))blockers.push(...sourceBlockers(binding.sourceDataDir,options.hostBootAt,warnings,hostRebootProofs));
    for(const target of [binding.controllerDataDir,binding.channelDataDir])if(existsSync(target)&&readdirSync(target).length)blockers.push('目标运行目录已有内容：'+target);}
  if(existsSync(join(registryRoot,'config.json')))blockers.push('目标工作区登记已存在，拒绝覆盖');
  if(existsSync(targetHostDir)&&readdirSync(targetHostDir).length)blockers.push('目标宿主目录已有内容，拒绝覆盖');
  const startupControllers=startupProfiles.map(name=>bindings.find(b=>b.profile===name)!.controllerId);
  const plan:RegistryMigrationPlan={version:4,dryRun:options.dryRun!==false,configPath,workspaceRoot,sourceHostDir,targetHostDir,bindings,startupControllers,blockers,warnings,hostRebootProofs};
  if(plan.dryRun)return plan;if(blockers.length)throw new Error('迁移阻断：'+blockers.join('；'));
  if(existsSync(join(sourceHostDir,'host.sqlite'))&&!options.migrateHost)throw new Error('存在宿主数据库，必须提供主控归属迁移钩子');
  const migrationId=randomUUID(),stage=join(workspaceRoot,'bridge-local','.registry-migration-'+migrationId),stageRegistry=join(stage,'bridge-registry'),stageHost=join(stage,'host');
  mkdirSync(stageRegistry,{recursive:true});mkdirSync(stageHost,{recursive:true});
  const mappings:RegistryPathMapping[]=[...bindings.flatMap(binding=>[
    {from:join(binding.sourceDataDir,'attachments'),to:join(binding.channelDataDir,'attachments')},
    ...[...channelFiles].map(file=>({from:join(binding.sourceDataDir,file),to:join(binding.channelDataDir,file)})),
    {from:binding.sourceDataDir,to:binding.controllerDataDir},
  ]),{from:sourceHostDir,to:targetHostDir},{from:join(workspaceRoot,'bridge-remote-agents'),to:join(workspaceRoot,'bridge-computers')},
    {from:join(workspaceRoot,'.local','browser'),to:join(workspaceRoot,'bridge-local','browser')}].sort((a,b)=>b.from.length-a.from.length);
  const principalUsers=Object.fromEntries(principals.flatMap(principal=>Object.entries(principal.accounts).map(([bot,user])=>[bot+'|'+user,'principal:'+principal.id])));
  const installed:Array<{target:string;staged:string}>=[],changedDocuments:Array<{path:string;bytes:Buffer}>=[];
  let configCommitted=false;
  try{
    if(existsSync(sourceHostDir))for(const name of readdirSync(sourceHostDir)){if(name==='bots'||transientFiles.has(name)||/\.sqlite-(wal|shm)$/.test(name))continue;await copyRuntime(join(sourceHostDir,name),join(stageHost,name),mappings);}
    rewriteFiles(stageHost,mappings,{});
    for(const [index,binding] of bindings.entries()){
      const profile=profiles[index]!,controllerDir=join(stageRegistry,'controllers',binding.controllerId),channelDir=join(stageRegistry,'channels',profile.platform==='feishu'?'lark':'discord','bots',profile.applicationId!);
      mkdirSync(join(controllerDir,'data'),{recursive:true});mkdirSync(join(channelDir,'data'),{recursive:true});
      if(existsSync(binding.sourceDataDir))for(const name of readdirSync(binding.sourceDataDir)){
        if(transientFiles.has(name)||/\.sqlite-(wal|shm)$/.test(name))continue;
        const target=join(channelFiles.has(name)||channelDirectories.has(name)?channelDir:controllerDir,'data',name);
        await copyRuntime(join(binding.sourceDataDir,name),target,mappings);
      }
      rewriteFiles(join(controllerDir,'data'),mappings,principalUsers);rewriteFiles(join(channelDir,'data'),mappings,{});
      const explicitWorkspace=profile.workspace===undefined?workspaceRoot:resolve(project,profile.workspace),workingCwd=resolve(project,profile.workingCwd??String(raw.workingCwd??explicitWorkspace));
      writeFileSync(join(controllerDir,'config.json'),json({version:1,id:binding.controllerId,aliases:profile.aliases??[],ownerPrincipalId:binding.ownerPrincipalId,backend:{kind:'native',agent:profile.defaultAgent??raw.defaultAgent??'codex'},
        channelId:binding.botId,...(explicitWorkspace!==workspaceRoot?{workspace:explicitWorkspace}:{}),...(workingCwd!==explicitWorkspace?{workingCwd}:{}),wait:{responseMs:null},...(profile.network?{network:profile.network}:{})}));
      writeFileSync(join(channelDir,'config.json'),json({version:1,id:binding.botId,profile:profile.name,platform:profile.platform,applicationId:profile.applicationId,allowedUserIds:profile.allowedUserIds,...(profile.network?{network:profile.network}:{}),...(profile.features?{features:profile.features}:{})}));
      writeFileSync(join(channelDir,'credentials.json'),json({version:1,...(profile.platform==='feishu'?{appSecret:profile.appSecret}:{token:profile.token})}),{mode:0o600});
      const logs=resolve(project,'.local/logs',profile.platform,profile.applicationId!);if(existsSync(logs)){await copyRuntime(logs,join(channelDir,'data','logs'),mappings);}
    }
    for(const [platform,file] of [['lark','lark.md'],['discord','discord.md']]){
      const destination=join(stageRegistry,'channels',platform!);mkdirSync(join(destination,'bots'),{recursive:true});
      const source=join(workspaceRoot,'bridge-chat-platforms',file!);if(existsSync(source))copyFileSync(source,join(destination,'README.md'));
      else writeFileSync(join(destination,'README.md'),'# '+platform+' 渠道\n\n渠道登记、凭据与收发状态按 Bot 应用 ID 隔离。\n');
    }
    writeFileSync(join(stageRegistry,'config.json'),json({version:4,startupControllers,controllers:bindings.map(b=>b.controllerId),channels:bindings.map(b=>b.botId),principals,spaces:raw.spaces??[]}));
    // Validate the staged registry in its own root; final absolute paths are supplied by the runtime loader after commit.
    const stageRoot=join(stage,'validation');mkdirSync(stageRoot,{recursive:true});renameSync(stageRegistry,join(stageRoot,'bridge-registry'));
    readWorkspaceRegistry(stageRoot);renameSync(join(stageRoot,'bridge-registry'),stageRegistry);
    options.migrateHost?.({sourceHostDir,targetHostDir:stageHost,finalHostDir:targetHostDir,bindings});
    const computers=join(workspaceRoot,'bridge-remote-agents');if(existsSync(computers)){if(existsSync(join(workspaceRoot,'bridge-computers')))throw new Error('新旧电脑登记同时存在，拒绝猜测');safeCopyDirectory(computers,join(stage,'bridge-computers'));rewriteFiles(join(stage,'bridge-computers'),mappings,{});}
    const browser=join(workspaceRoot,'.local','browser');if(existsSync(browser)){if(existsSync(join(workspaceRoot,'bridge-local','browser')))throw new Error('新旧浏览器数据同时存在，拒绝覆盖');await copyRuntime(browser,join(stage,'browser'),mappings);rewriteFiles(join(stage,'browser'),mappings,{});}
    if(!readFileSync(configPath).equals(configBytes))throw new Error('迁移期间bootstrap配置变化，取消切换');
    const install=(staged:string,target:string)=>{if(existsSync(target)){if(readdirSync(target).length)throw new Error('目标目录在迁移期间产生内容：'+target);renameSync(target,join(stage,'empty-'+installed.length));}mkdirSync(dirname(target),{recursive:true});renameSync(staged,target);installed.push({target,staged});};
    // Empty skeleton roots may already exist; populated registry roots must not be merged by guesswork.
    if(existsSync(registryRoot)&&readdirSync(registryRoot).length)throw new Error('目标登记根已有内容，请先核对骨架与迁移计划');
    install(stageRegistry,registryRoot);install(stageHost,targetHostDir);
    if(existsSync(join(stage,'bridge-computers')))install(join(stage,'bridge-computers'),join(workspaceRoot,'bridge-computers'));
    if(existsSync(join(stage,'browser')))install(join(stage,'browser'),join(workspaceRoot,'bridge-local','browser'));
    for(const name of ['README.md','MEMORY.md']){const path=join(workspaceRoot,name);if(!existsSync(path))continue;const bytes=readFileSync(path),text=bytes.toString('utf8'),next=text.replaceAll('bridge-remote-agents','bridge-computers').replaceAll('bridge-chat-platforms/lark.md','bridge-registry/channels/lark/README.md').replaceAll('bridge-chat-platforms/discord.md','bridge-registry/channels/discord/README.md');
      if(next!==text){changedDocuments.push({path,bytes});writeFileSync(path,next);}}
    const common={...raw,version:4,workspaceRoot};for(const key of ['startupProfiles','registeredProfiles','startupProfile','bots','token','appSecret','applicationId','principals','spaces','dataDir','workspace','logsDir','attachmentsDir'])delete (common as Record<string,unknown>)[key];
    const temporary=configPath+'.registry-'+migrationId;writeFileSync(temporary,json(common));renameSync(temporary,configPath);configCommitted=true;
    const manifestPath=join(targetHostDir,'registry-migration.json');
    writeFileSync(manifestPath,json({version:4,migrationId,status:'complete',at:new Date().toISOString(),sourceHostDir,workspaceRoot,bindings,hostRebootProofs,sourceMaterialsRetained:true}));
    return {...plan,applied:true,manifestPath};
  }catch(error){
    if(configCommitted)writeFileSync(configPath,configBytes);
    for(const document of changedDocuments)writeFileSync(document.path,document.bytes);
    for(const item of installed.reverse())if(existsSync(item.target)){mkdirSync(dirname(item.staged),{recursive:true});renameSync(item.target,item.staged);}
    writeFileSync(join(stage,'failed.json'),json({migrationId,error:error instanceof Error?error.message:'迁移失败',at:new Date().toISOString()}));throw error;
  }
}
