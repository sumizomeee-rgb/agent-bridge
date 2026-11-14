import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readWorkspaceRegistry } from './registry.js';
import { relocateRegistryValue, validateFrozenHandoffArtifacts, type RegistryPathMapping, type RegistryMigrationBinding } from './registry-migration.js';

export interface ControllerArtifactRepairOptions {
  sourceDataDir:string;controllerDataDir:string;users:Record<string,string>;pathMappings:RegistryPathMapping[];dryRun?:boolean;
}
export interface ControllerArtifactRepairReport { version:1;dryRun:boolean;sourceDataDir:string;controllerDataDir:string;files:string[];scheduleIds:string[];receiptIds:string[];applied:boolean }
const canonical=(value:unknown):string=>JSON.stringify(sort(value));
function sort(value:unknown):unknown {return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sort(item)])):value;}
function bytes(path:string):Buffer {if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('修复材料必须是普通文件：'+path);return readFileSync(path);}
function parsed(value:Buffer):any {return JSON.parse(value.toString('utf8').replace(/^\uFEFF/,''));}
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
function descendants(root:string):string[] {
  if(!existsSync(root))return[];if(lstatSync(root).isSymbolicLink())throw new Error('修复目录不得是链接');
  return readdirSync(root,{withFileTypes:true}).filter(entry=>{if(entry.isSymbolicLink())throw new Error('修复目录不得含链接');return entry.isDirectory();}).map(entry=>entry.name);
}
/** Offline, evidence-based repair of the known v4 migration defect; no runtime fallback or database replacement. */
export function repairControllerMigrationArtifacts(options:ControllerArtifactRepairOptions):ControllerArtifactRepairReport {
 const sourceDataDir=resolve(options.sourceDataDir),controllerDataDir=resolve(options.controllerDataDir);
 if(sourceDataDir===controllerDataDir)throw new Error('修复源与目标必须不同');
 validateFrozenHandoffArtifacts(sourceDataDir);
 const files:Array<{path:string;before:Buffer;after:Buffer}>=[],schedules:Array<{table:'controller_schedules'|'controller_calls';column:'value_json'|'result_json';id:string;before:string;after:string}>=[];
 const transform=(value:unknown,legacy=false)=>relocateRegistryValue(value,options.pathMappings,options.users,'',false,legacy);
 const plan=(source:string,target:string,frozen=false)=>{
  const original=bytes(source),before=bytes(target),value=parsed(original),next=frozen?original:encode(transform(value));
  const actual=canonical(parsed(before));
  if(![canonical(value),canonical(transform(value)),canonical(transform(value,true))].includes(actual))throw new Error('目标材料存在无法由旧迁移解释的变更，未覆盖：'+target);
  if(!before.equals(next))files.push({path:target,before,after:next});
 };
 const switchRoot=join(sourceDataDir,'agent-switches');
 if(existsSync(switchRoot)){
  if(lstatSync(switchRoot).isSymbolicLink())throw new Error('切换日志目录不得是链接');
  for(const name of readdirSync(switchRoot).filter(name=>/^[a-f0-9-]{36}\.json$/i.test(name)))plan(join(switchRoot,name),join(controllerDataDir,'agent-switches',name));
 }
 for(const id of descendants(join(sourceDataDir,'session-handoffs'))){
  const original=join(sourceDataDir,'session-handoffs',id),target=join(controllerDataDir,'session-handoffs',id);
  if(!existsSync(join(original,'manifest.json')))continue;
  plan(join(original,'source.json'),join(target,'source.json'),true);
  plan(join(original,'manifest.json'),join(target,'manifest.json'));
  if(existsSync(join(original,'context.md'))&&!bytes(join(original,'context.md')).equals(bytes(join(target,'context.md'))))throw new Error('续接摘要已有变化，未覆盖：'+target);
 }
 const sourceDb=join(sourceDataDir,'controller.sqlite'),targetDb=join(controllerDataDir,'controller.sqlite');
 const has=(db:DatabaseSync,table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
 if(existsSync(sourceDb)&&existsSync(targetDb)){
  const old=new DatabaseSync(sourceDb,{readOnly:true}),current=new DatabaseSync(targetDb,{readOnly:true});try{
   for(const [table,column] of [['controller_schedules','value_json'],['controller_calls','result_json']] as const){
    if(!has(old,table)||!has(current,table))continue;
    const originals=new Map(old.prepare('SELECT id,'+column+' FROM '+table).all().map(row=>[String(row.id),parsed(Buffer.from(String(row[column])))]));
    const routed=(value:any)=>value&&['botId','principalId','conversationId','messageId','userId','channelId'].every(key=>typeof value[key]==='string')&&Number.isSafeInteger(value.generation);
    for(const row of current.prepare('SELECT id,'+column+' FROM '+table).all()){
     const value=parsed(Buffer.from(String(row[column]))),original=originals.get(String(row.id));let changed=false;
     const visit=(item:any,saved:any):void=>{
      if(!item||typeof item!=='object')return;
      const source=item.message?.source;
      if(routed(source)&&options.users[source.userId]){
       const oldSource=saved?.message?.source;if(!routed(oldSource))throw new Error('定时来源缺少可核实的原始记录：'+row.id);
       const expected=(transform({source:oldSource}) as {source:Record<string,unknown>}).source;
       if(![canonical(oldSource),canonical((transform({source:oldSource},true) as {source:unknown}).source),canonical(expected)].includes(canonical(source)))throw new Error('定时来源已有独立变更，未覆盖：'+row.id);
       if(expected.userId!==options.users[source.userId])throw new Error('定时来源未能解析到新业务owner');
       item.message.source.userId=expected.userId;changed=true;
      }
      if(Array.isArray(item))item.forEach((entry,index)=>visit(entry,saved?.[index]));
      else for(const [key,entry] of Object.entries(item))if(!['source','original','source_json'].includes(key))visit(entry,saved?.[key]);
     };
     visit(value,original);
     if(changed)schedules.push({table,column,id:String(row.id),before:String(row[column]),after:JSON.stringify(value)});
    }
   }
  }finally{old.close();current.close();}
 }
 const report:ControllerArtifactRepairReport={version:1,dryRun:options.dryRun!==false,sourceDataDir,controllerDataDir,files:files.map(file=>file.path),scheduleIds:schedules.filter(value=>value.table==='controller_schedules').map(value=>value.id),receiptIds:schedules.filter(value=>value.table==='controller_calls').map(value=>value.id),applied:false};
 if(report.dryRun)return report;
 const changed:Array<{path:string;before:Buffer}>=[];let db:DatabaseSync|undefined;
 const atomic=(path:string,value:Buffer)=>{const temporary=path+'.artifact-repair-'+randomUUID();writeFileSync(temporary,value,{flag:'wx',mode:0o600});renameSync(temporary,path);};
 try{
  if(schedules.length){db=new DatabaseSync(targetDb);db.exec('BEGIN IMMEDIATE');for(const change of schedules){if(db.prepare('SELECT '+change.column+' FROM '+change.table+' WHERE id=?').get(change.id)?.[change.column]!==change.before)throw new Error('修复期间定时记录发生变化');db.prepare('UPDATE '+change.table+' SET '+change.column+'=? WHERE id=?').run(change.after,change.id);}}
  for(const file of files){if(!bytes(file.path).equals(file.before))throw new Error('修复期间材料发生变化：'+file.path);atomic(file.path,file.after);changed.push(file);}
  db?.exec('COMMIT');return{...report,applied:true};
 }catch(error){try{db?.exec('ROLLBACK');}catch{}for(const file of changed.reverse())atomic(file.path,file.before);throw error;}finally{db?.close();}
}

/** Uses the successful migration manifest as the explicit old-to-new directory proof. */
export function repairWorkspaceRegistryArtifacts(options:{workspaceRoot:string;dryRun?:boolean}):ControllerArtifactRepairReport[]{
 const registry=readWorkspaceRegistry(options.workspaceRoot),manifest=parsed(bytes(join(registry.hostDataDir,'registry-migration.json')));
 if(manifest.version!==4||manifest.status!=='complete'||resolve(manifest.workspaceRoot)!==registry.workspaceRoot||!Array.isArray(manifest.bindings))throw new Error('缺少已完成的一次性迁移清单');
 for(const name of ['bridge.pid.json','supervisor.pid.json']){const path=join(registry.hostDataDir,name);if(existsSync(path)){const proof=parsed(bytes(path));try{process.kill(Number(proof.pid),0);throw new Error('宿主仍在运行，拒绝离线材料修复');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}}
 const bindings=manifest.bindings as RegistryMigrationBinding[],users=Object.fromEntries(registry.principals.flatMap(principal=>Object.entries(principal.accounts).map(([bot,user])=>[bot+'|'+user,'principal:'+principal.id])));
 const mappings:RegistryPathMapping[]=[...bindings.flatMap(binding=>[{from:join(binding.sourceDataDir,'attachments'),to:join(binding.channelDataDir,'attachments')},{from:binding.sourceDataDir,to:binding.controllerDataDir}]),{from:manifest.sourceHostDir,to:registry.hostDataDir},{from:join(registry.workspaceRoot,'bridge-remote-agents'),to:join(registry.workspaceRoot,'bridge-computers')},{from:join(registry.workspaceRoot,'.local','browser'),to:join(registry.workspaceRoot,'bridge-local','browser')}].sort((a,b)=>b.from.length-a.from.length);
 const repaired=bindings.map(binding=>{
  const controller=registry.controllers.find(controller=>controller.id===binding.controllerId),suffix=relative(resolve(manifest.sourceHostDir),resolve(binding.sourceDataDir));
  if(!controller||controller.dataDir!==binding.controllerDataDir||suffix==='..'||suffix.startsWith('..'+sep)||isAbsolute(suffix))throw new Error('材料来源或目标不属于登记的迁移范围');
  return repairControllerMigrationArtifacts({sourceDataDir:binding.sourceDataDir,controllerDataDir:controller.dataDir,users,pathMappings:mappings,dryRun:true});
 });
 if(options.dryRun!==false)return repaired;
 return bindings.map(binding=>repairControllerMigrationArtifacts({sourceDataDir:binding.sourceDataDir,controllerDataDir:binding.controllerDataDir,users,pathMappings:mappings,dryRun:false}));
}
