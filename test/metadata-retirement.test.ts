import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CodexAdapter} from '../src/agents/codex.js';
import {ClaudeAdapter} from '../src/agents/claude.js';
import {MetadataProbes} from '../src/agents/metadata.js';
import {AgentProcessStopError,deferred,type JsonObject,type AgentStopEvidence} from '../src/agents/process.js';
import {ownTemporaryDirectory} from './temp-directory.js';

const directory=()=>ownTemporaryDirectory(mkdtempSync(join(tmpdir(),'bridge-metadata-retirement-')),'bridge-metadata-retirement-');
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){for(let n=0;n<3000;n++){if(check())return;await tick();}assert.fail('探测收尾状态未到达');}
class Probe {
  listeners=new Set<(message:JsonObject)=>void>();failures=new Set<(error:Error)=>void>();writes:JsonObject[]=[];modes:boolean[]=[];
  gate=deferred<void>(); stopped=false;
  onMessage(fn:(message:JsonObject)=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  onFailure(fn:(error:Error)=>void){this.failures.add(fn);return()=>{this.failures.delete(fn);};}
  write(message:JsonObject){
    this.writes.push(message);const send=(value:JsonObject)=>queueMicrotask(()=>this.listeners.forEach(fn=>fn(value)));
    if(message.method==='initialize')send({id:message.id,result:{}});
    if(message.method==='config/read')send({id:message.id,result:{config:{model:'fixture'}}});
    if(message.method==='model/list')send({id:message.id,result:{data:[{model:'fixture',displayName:'Fixture'}]}});
    if(message.type==='control_request')send({type:'control_response',response:{request_id:'bridge-models',subtype:'success',response:{model:'fixture',models:[{value:'fixture',displayName:'Fixture'}]}}});
  }
  endInput(){}
  confirmStopped(){return this.stopped;}
  get stopEvidence():AgentStopEvidence{return{pid:19,graceful:true,exitObserved:this.stopped,closeObserved:this.stopped,exitCode:this.stopped?0:null,signalCode:null,taskkillAttempted:false,taskkillExitCode:null,durationMs:0,phaseMs:{},completion:this.stopped?'graceful-exit':'pending'};}
  async stop(graceful=false){this.modes.push(graceful);if(graceful){await this.gate.promise;if(!this.stopped)throw new AgentProcessStopError(19,undefined,undefined,this.stopEvidence);}else{this.stopped=true;this.gate.resolve();}}
}
for(const backend of ['codex','claude']as const)test(`${backend} 模型目录先返回，探测退出超时在后台回收，不取消用户消息或启动生成`,async()=>{
  const home=directory(),probes:Probe[]=[];
  const make=()=>{const probe=new Probe();probes.push(probe);return probe;};
  const command={command:'never-launch',args:[]};
  const adapter=backend==='codex'?new CodexAdapter(command,{USERPROFILE:home},make):new ClaudeAdapter(command,{USERPROFILE:home},undefined,make);
  try{
    let returned=false;const request=adapter.getModelInfo(home).then(value=>{returned=true;return value;});
    await until(()=>returned);const result=await request;
    assert.equal(result.defaultModel,'fixture');assert.deepEqual(probes[0]!.modes,[true]);assert.equal(probes[0]!.stopped,false);
    assert.equal(probes[0]!.listeners.size,0);assert.equal(probes[0]!.failures.size,0);
    // 在第一条探测正常收尾期间，另一次目录查询不能打断它。
    const second=await adapter.getModelInfo(home);assert.equal(second.defaultModel,'fixture');assert.equal(probes.length,2);
    assert.deepEqual(probes[0]!.modes,[true]);
    probes[0]!.gate.resolve();await until(()=>probes[0]!.stopped);
    assert.deepEqual(probes[0]!.modes,[true,false]);
    assert(probes.flatMap(probe=>probe.writes).every(message=>message.type!=='user'&&!['turn/start','thread/start','thread/resume'].includes(String(message.method))));
  }finally{await adapter.close();}
});

test('Codex 元数据环境隔离 MCP/hooks，保留模型线路与认证，进程退出前不删除临时 home',async()=>{
  const home=directory();mkdirSync(join(home,'.codex'));
  const config='model="fixture"\nmodel_provider="gateway"\n[model_providers.gateway]\nname="gateway"\nbase_url="https://example.invalid/v1"\n[mcp_servers.unrelated]\ncommand="never-launch"\n[features]\nhooks=true\n';
  writeFileSync(join(home,'.codex/config.toml'),config);writeFileSync(join(home,'.codex/auth.json'),'{}');
  let isolated='';const probe=new Probe();
  const adapter=new CodexAdapter({command:'never-launch',args:[]},{USERPROFILE:home},(_command,args,_cwd,env)=>{
    isolated=env.CODEX_HOME!;assert.notEqual(isolated,join(home,'.codex'));
    const copied=readFileSync(join(isolated,'config.toml'),'utf8');assert(copied.includes('gateway'));assert(!copied.includes('never-launch'));assert(copied.includes('hooks = false'));
    assert.equal(readFileSync(join(isolated,'auth.json'),'utf8'),'{}');assert(args.includes('mcp_servers={}'));return probe;
  });
  try{
    await adapter.getModelInfo(home);assert(existsSync(isolated));assert.equal(readFileSync(join(home,'.codex/config.toml'),'utf8'),config);
    await adapter.close();assert(!existsSync(isolated));
  }finally{await adapter.close();}
});

test('成功探测的停止失败仍持有进程，不因已有元数据丢失回收责任',async()=>{
  const probes=new MetadataProbes(),probe=new Probe();let cleaned=0,allowStop=false;
  probe.stop=async(graceful=false)=>{probe.modes.push(graceful);if(!allowStop)throw new AgentProcessStopError(19);probe.stopped=true;};
  probes.track(probe,()=>{cleaned++;});probes.complete(probe);await tick();await tick();
  assert.equal(cleaned,0);await assert.rejects(async()=>{await probes.prepare();});assert.equal(cleaned,0);
  allowStop=true;await probes.close();assert.equal(cleaned,1);assert.equal(probe.stopped,true);
});

test('关闭探测期间迟到的真实退出证明覆盖早先的停止超时，不遗留假失败',async()=>{
  const probes=new MetadataProbes(),probe=new Probe();let cleaned=0;
  probe.stop=async(graceful=false)=>{
    if(graceful){await probe.gate.promise;return;}
    setImmediate(()=>{probe.stopped=true;probe.gate.resolve();});
    throw new AgentProcessStopError(19);
  };
  probes.track(probe,()=>{cleaned++;});probes.complete(probe);
  await probes.close();assert.equal(cleaned,1);assert.equal(probe.stopped,true);
});

const native=String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
fs.writeFileSync(path.join(process.cwd(),'metadata-pid.json'),JSON.stringify({pid:process.pid}));
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='config/read')send({id:m.id,result:{config:{model:'fixture'}}});
 if(m.method==='model/list')send({id:m.id,result:{data:[{model:'fixture',displayName:'Fixture'}]}});
 if(m.type==='control_request')send({type:'control_response',response:{request_id:'bridge-models',subtype:'success',response:{model:'fixture',models:[]}}});
});
setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000).unref();
`;
for(const backend of ['codex','claude']as const)test(`${backend} 真实进程模型回执立即可用，仍活着的无生成探测可由适配器独立回收`,async()=>{
  const home=directory(),script=join(home,'metadata.cjs');writeFileSync(script,native);
  const command={command:process.execPath,args:[script]},env={USERPROFILE:home};
  const adapter=backend==='codex'?new CodexAdapter(command,env):new ClaudeAdapter(command,env);
  try{
    const info=await adapter.getModelInfo(home);assert.equal(info.defaultModel,'fixture');
    const pid=JSON.parse(readFileSync(join(home,'metadata-pid.json'),'utf8')).pid;process.kill(pid,0);
    await adapter.close();assert.throws(()=>process.kill(pid,0));
  }finally{await adapter.close();}
});
