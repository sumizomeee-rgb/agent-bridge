import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

async function until(check:()=>boolean,diagnostic:()=>string){const end=Date.now()+12000;while(!check()){if(Date.now()>end)throw new Error('main smoke timed out: '+diagnostic());await new Promise(resolve=>setTimeout(resolve,20));}}
test('真实main无渠道启动外部API，持久输入可在维护重启后继续且不启动原生模型',async()=>{
  const root=mkdtempSync(join(tmpdir(),'bridge-main-headless-')),workspace=join(root,'workspace'),registry=join(workspace,'bridge-registry'),data=join(workspace,'bridge-local','host');
  const write=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
  write(join(root,'config.json'),{version:4,workspaceRoot:workspace,commands:{codex:{command:process.execPath,args:[]},claude:{command:process.execPath,args:[]}}});
  write(join(registry,'config.json'),{version:4,controllers:['headless'],startupControllers:['headless'],channels:[],principals:[{id:'owner',accounts:{}}],spaces:[]});
  write(join(registry,'controllers','headless','config.json'),{version:1,id:'headless',ownerPrincipalId:'owner',backend:{kind:'external',endpointId:'test-endpoint'}});
  writeFileSync(join(workspace,'README.md'),`# Shared
{{include:bridge/controller-protocol}}
{{include:bridge/tool-index}}
{{include:workspace/MEMORY.md}}`);writeFileSync(join(workspace,'MEMORY.md'),'# Owner');
  let child:ChildProcess|undefined,output='';
  const start=async()=>{output='';child=spawn(process.execPath,[fileURLToPath(new URL('../src/main.js',import.meta.url)),'--config',join(root,'config.json')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,USERPROFILE:join(root,'isolated-user-home'),HOME:join(root,'isolated-user-home')}});child.stdout!.on('data',value=>output+=value);child.stderr!.on('data',value=>output+=value);await until(()=>existsSync(join(data,'external-api.json'))&&output.includes('HOST_READY'),()=>output);return JSON.parse(readFileSync(join(data,'external-api.json'),'utf8')).controllers[0] as {url:string;token:string};};
  const stop=async()=>{writeFileSync(join(data,'drain-stop.request'),'test');await until(()=>child!.exitCode!==null,()=>output);assert.equal(child!.exitCode,0,output);assert(!existsSync(join(data,'external-api.json')));};
  const post=async(endpoint:{url:string;token:string},action:string,value:unknown)=>{const response=await fetch(endpoint.url+'/'+action,{method:'POST',headers:{authorization:'Bearer '+endpoint.token,'content-type':'application/json'},body:JSON.stringify(value)});assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<any>;};
  const events=async(endpoint:{url:string;token:string},lease:string)=>{const response=await fetch(endpoint.url+'/events?lease='+lease,{headers:{authorization:'Bearer '+endpoint.token}});assert.equal(response.status,200);return response.json() as Promise<any[]>;};
  try {
    let endpoint=await start();assert(output.includes('EXTERNAL_READY'));const binding=await post(endpoint,'connect',{instanceId:'test-client',sessionId:'external-session'});
    assert.equal((await post(endpoint,'input',{requestId:'input-one',text:'原始任务'})).status,'accepted');
    let decisions:any[]=[];for(let n=0;n<100;n++){decisions=(await events(endpoint,binding.lease)).filter(item=>item.kind==='decision');if(decisions.length)break;await new Promise(resolve=>setTimeout(resolve,20));}assert(decisions.length,output);
    const first=decisions[0];await stop();endpoint=await start();const resumed=await post(endpoint,'connect',{instanceId:'test-client',sessionId:'external-session'});
    for(let n=0;n<100;n++){decisions=(await events(endpoint,resumed.lease)).filter(item=>item.kind==='decision');if(decisions.some(item=>item.id===first.id))break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert(decisions.some(item=>item.id===first.id),'原决策应在重启后保留');
    await post(endpoint,'accept',{lease:resumed.lease,decisionId:first.id});
    await post(endpoint,'call',{lease:resumed.lease,decisionId:first.id,callId:'quiet',name:'bridge_silent',args:{}});
    assert.equal((await post(endpoint,'finish',{lease:resumed.lease,decisionId:first.id})).status,'completed');await stop();
  } finally {if(child&&child.exitCode===null){child.kill();await until(()=>child!.exitCode!==null||child!.signalCode!==null,()=>output);}rmSync(root,{recursive:true,force:true});}
});
