import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runConfigured } from './configured-live.mjs';
import { verifyParity } from './parity.mjs';

const {values}=parseArgs({options:{root:{type:'string'},'production-root':{type:'string'},config:{type:'string'},agent:{type:'string',default:'both'},targets:{type:'string',default:'local'}}});
assert(values.root && values['production-root'], 'Explicit candidate and production roots required');
assert(['both','codex','claude'].includes(values.agent));
const root=resolve(values.root),productionRoot=resolve(values['production-root']);
assert.notEqual(root,productionRoot,'Candidate must be isolated');
const configPath=resolve(values.config??join(productionRoot,'.local/config.json'));
const runDir=join(root,'.local/controller-lab','context-'+new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(runDir,{recursive:true});
const evidence={version:1,mode:'context-live',startedAt:new Date().toISOString(),runDir,status:'running',cases:[],sourceWorkspaceHashes:{},scope:{productionConfig:'read-only',history:'fresh isolated journals',delivery:'isolated platform sink',controllerModels:'gpt-6-luna xhigh / haiku xhigh',workers:'actual saved defaults and explicitly selected ordinary test models'}};
const save=()=>writeFileSync(join(runDir,'report.json'),JSON.stringify(evidence,null,2));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const originals=new Map();const privateCopies=[];
try {
  const {loadHostConfig}=await import(pathToFileURL(join(productionRoot,'dist/src/config.js')));
  const host=loadHostConfig(['--config',configPath],false);
  const parity=await verifyParity({root,sourceRoot:root,runDir});evidence.parity=parity.evidence;save();
  const {workspaceDocuments}=await import(pathToFileURL(join(root,'dist/src/controller/workspace-documents.js')));
  const {codexDynamicTools}=await import(pathToFileURL(join(root,'dist/src/controller/agents/codex/dynamic-tools.js')));
  for(const agent of values.agent==='both'?['codex','claude']:[values.agent]){
    const source=host.configs.find(c=>c.defaultAgent===agent);assert(source,'Configured backend missing: '+agent);
    const sourceWorkspace=source.contextWorkspace??source.workspace, context=join(runDir,'context-'+agent);
    mkdirSync(context,{recursive:true});
    const copy=(sourceFile,targetFile)=>{
      const info=lstatSync(sourceFile);assert(!info.isSymbolicLink(),'Context copy must not traverse links');
      if(info.isDirectory()){mkdirSync(targetFile,{recursive:true});for(const child of readdirSync(sourceFile))copy(join(sourceFile,child),join(targetFile,child));return;}
      assert(info.isFile()&&info.size<=2*1024*1024,'Unexpected context file');mkdirSync(dirname(targetFile),{recursive:true});
      const bytes=readFileSync(sourceFile);originals.set(sourceFile,sha(bytes));copyFileSync(sourceFile,targetFile);
      if(sourceFile.includes('bridge-agent-presets')&&sourceFile.includes('private'))privateCopies.push(targetFile);
    };
    for(const name of ['MEMORY.md','bridge-computers','bridge-agent-presets','bridge-capabilities','bridge-registry/channels/lark/README.md','bridge-registry/channels/discord/README.md','bridge-prompts.json']){
      const sourceFile=join(sourceWorkspace,name);if(existsSync(sourceFile))copy(sourceFile,join(context,name));
    }
    copyFileSync(join(root,'workspace-template/README.md'),join(context,'README.md'));
    const assembled=workspaceDocuments(context,{agent,internalBotCommunicationEnabled:host.internalBotCommunicationEnabled});assert.deepEqual(assembled.errors,[]);
    const definitions=codexDynamicTools(host.internalBotCommunicationEnabled);
    evidence.sourceWorkspaceHashes[agent]={readme:sha(readFileSync(join(root,'workspace-template/README.md'))),memory:sha(readFileSync(join(context,'MEMORY.md'))),baseCharacters:assembled.text.length,entryCharacters:JSON.stringify(definitions).length,fixedCharacters:assembled.text.length+JSON.stringify(definitions).length};save();
    await runConfigured({root,runDir,configPath,agent,evidence,save,sourceConfigRoot:productionRoot,contextWorkspace:context,exerciseNew:true,exerciseMessages:true,targets:values.targets.split(','),controllerModel:agent==='codex'?'gpt-6-luna':'haiku',controllerEffort:'xhigh'});
  }
  for(const [file,hash]of originals)assert.equal(sha(readFileSync(file)),hash,'Production context changed during testing');
  parity.assertUnchanged();evidence.parity.unchangedAtEnd=true;
  evidence.status=evidence.cases.length>0&&evidence.cases.every(c=>c.status==='passed')?'passed':'failed';
} catch(error){evidence.status='failed';evidence.error={name:error.name,message:String(error.message).slice(0,500)};}
finally {
  // Only copies made by this run; never delete a production source or follow links.
  for(const file of privateCopies)if(file.startsWith(runDir+'\\')||file.startsWith(runDir+'/')){if(existsSync(file)&&!lstatSync(file).isSymbolicLink())unlinkSync(file);}
  evidence.finishedAt=new Date().toISOString();save();
  console.log(JSON.stringify({status:evidence.status,cases:evidence.cases.map(c=>({name:c.name,status:c.status,error:c.error})),report:join(runDir,'report.json')}));
  if(evidence.status!=='passed')process.exitCode=1;
}
