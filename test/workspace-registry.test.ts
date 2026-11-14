import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceRegistry } from '../src/registry.js';
function fixture(t:import('node:test').TestContext){
 const root=mkdtempSync(join(tmpdir(),'bridge-registry-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const write=(name:string,value:unknown)=>{const path=join(root,'bridge-registry',name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 const index={version:4,startupControllers:['teto','headless'],controllers:['teto','headless'],channels:['feishu:cli_test'],principals:[{id:'owner',accounts:{'feishu:cli_test':'ou_owner'}}],spaces:[]};
 const controller={version:1,id:'teto',aliases:['Teto'],ownerPrincipalId:'owner',backend:{kind:'native',agent:'codex'},channelId:'feishu:cli_test',network:{proxyPort:7898},wait:{responseMs:null}};
 const channel={version:1,id:'feishu:cli_test',profile:'feishu/test',platform:'feishu',applicationId:'cli_test',allowedUserIds:['ou_owner'],network:{proxyPort:null}};
 write('config.json',index);write('controllers/teto/config.json',controller);write('controllers/headless/config.json',{version:1,id:'headless',aliases:['External'],ownerPrincipalId:'owner',backend:{kind:'external',endpointId:'proxy'},wait:{responseMs:86400000}});
 write('channels/lark/bots/cli_test/config.json',channel);write('channels/lark/bots/cli_test/credentials.json',{version:1,appSecret:'fixture-private-value'});
 return{root,write,index,controller,channel};
}
test('stable controllers select optional channels, default workspace and independent network',t=>{
 const f=fixture(t),registry=readWorkspaceRegistry(f.root);
 assert.equal(registry.controllers[0]!.id,'teto');assert.equal(registry.controllers[0]!.workspace,f.root);
 assert.equal(registry.controllers[0]!.network!.proxyPort,7898);assert.equal(registry.channels[0]!.network!.proxyPort,null);
 assert.equal(registry.controllers[1]!.channelId,undefined);assert.equal(registry.controllers[1]!.wait.responseMs,86400000);
 assert.equal(registry.controllers[0]!.dataDir,join(f.root,'bridge-registry/controllers/teto/data'));
 assert.equal(registry.channels[0]!.dataDir,join(f.root,'bridge-registry/channels/lark/bots/cli_test/data'));
 assert.equal(registry.hostDataDir,join(f.root,'bridge-local/host'));
});
test('old index versions, overlapping aliases and duplicated channel bindings are rejected',t=>{
 const f=fixture(t);f.write('config.json',{...f.index,version:3});assert.throws(()=>readWorkspaceRegistry(f.root),/version:4/);
 f.write('config.json',f.index);f.write('controllers/headless/config.json',{...f.controller,id:'headless',aliases:['teto']});assert.throws(()=>readWorkspaceRegistry(f.root),/别名重复|遮蔽/);
 f.write('controllers/headless/config.json',{...f.controller,id:'headless',aliases:['second']});assert.throws(()=>readWorkspaceRegistry(f.root),/重复绑定/);
});
test('channel config cannot own controller selection and credentials are separate',t=>{
 const f=fixture(t);f.write('channels/lark/bots/cli_test/config.json',{...f.channel,defaultAgent:'claude'});assert.throws(()=>readWorkspaceRegistry(f.root),/不能持有主控/);
 f.write('channels/lark/bots/cli_test/config.json',f.channel);f.write('channels/lark/bots/cli_test/credentials.json',{version:1});assert.throws(()=>readWorkspaceRegistry(f.root),/凭据缺失/);
});
