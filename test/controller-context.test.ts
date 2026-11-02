import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controllerEntryTools, controllerToolHelp, controllerToolIndex, resolveControllerTool } from '../src/controller/tools/entry.js';
import { controllerToolsForCommunication } from '../src/controller/tools/catalog.js';
import { codexDynamicTools } from '../src/controller/agents/codex/dynamic-tools.js';
import { createClaudeMcpServer } from '../src/controller/agents/claude/mcp.js';
import { workspaceDocuments } from '../src/controller/workspace-documents.js';

const references = '{{include:bridge/controller-protocol}}\n{{include:bridge/agent-instructions}}\n{{include:bridge/tool-index}}\n{{include:workspace/MEMORY.md}}';
test('both CLI declarations expose only help/call; help expands the same enabled command registry', async t => {
  assert.deepEqual(codexDynamicTools(false).map(tool => tool.name), ['bridge_help', 'bridge_call']);
  assert.deepEqual(controllerEntryTools.map(tool => tool.name), ['bridge_help', 'bridge_call']);
  const index = controllerToolIndex(false);
  assert.equal(index.length, 34); assert.equal(controllerToolIndex(true).length, 37);
  for (const command of controllerToolsForCommunication(false)) {
    assert.deepEqual(controllerToolHelp(command.name, false), command);
    assert.equal(index.find(tool => tool.name === command.name)?.description.includes('\n'), false);
  }
  const root = mkdtempSync(join(tmpdir(), 'bridge-entry-mcp-'));
  const calls: string[] = [];
  const {server, token} = createClaudeMcpServer({dataDir: root, invoke: async (name, args, matched) => { matched(); calls.push(name); return {name, args}; }});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, {recursive:true,force:true}); });
  const address=server.address(); assert.ok(address && typeof address==='object');
  const rpc=async (method: string, params?: unknown) => (await fetch(`http://127.0.0.1:${address.port}/${token}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json() as Promise<{result:{tools?:{name:string}[]}}>;
  assert.deepEqual((await rpc('tools/list')).result.tools?.map(tool=>tool.name), ['bridge_help','bridge_call']);
  await rpc('tools/call',{name:'bridge_help',arguments:{command:'bridge_start_worker'}});
  assert.deepEqual(calls,['bridge_help']);
});

test('generic invocation validates complete nested arguments and disabled tools without performing work', () => {
  const args={title:'只读测试',prompt:'只返回事实',targetId:'local',assistant:{kind:'ordinary',agent:'codex',model:'gpt-6-luna'}};
  const resolved=resolveControllerTool('bridge_call',{command:'bridge_start_worker',arguments:args},false);
  assert.equal(resolved.name,'bridge_start_worker'); assert.equal(resolved.args,args);
  for(const [command, value] of [
    ['bridge_start_worker',{title:'缺少 prompt'}],
    ['bridge_start_worker',{...args,assistant:{kind:'ordinary',agent:'unknown'}}],
    ['bridge_schedule_worker',{...args,afterSeconds:-1}],
    ['bridge_update_tasks',{changes:[{id:'task',expectedVersion:-1}]}],
    ['bridge_list_tasks',{limit:100}],
    ['bridge_send_message',{targetId:'private',text:'ok',finish:'false'}],
    ['bridge_send_bot',{targetBotId:'other',text:'no'}],
    ['bridge_call',{}],
  ] as const) assert.throws(()=>resolveControllerTool('bridge_call',{command,arguments:value},false));
  assert.throws(()=>resolveControllerTool('bridge_help',{command:1},false));
  assert.throws(()=>controllerToolHelp('bridge_send_bot',false),/未启用/);
  assert.throws(()=>resolveControllerTool('bridge_call',{command:'bridge_start_collaboration',arguments:{targetId:'group',targetBotId:'other',mode:'internal',text:'no'}},false));
  assert.deepEqual(resolveControllerTool('bridge_list_workers',{details:true},false),{name:'bridge_list_workers',args:{details:true}},'legacy native calls preserve their existing compatibility path');
});

test('README alone declares all fixed content and owner data cannot expand another template', () => {
  const root=mkdtempSync(join(tmpdir(),'bridge-context-'));
  try {
    const readme='# 唯一入口\r\n桥={{bridge_root}}\r\n工作区={{workspace_root}}\r\n'+references;
    const memory='# 用户原文\r\n{{include:bridge/tool-index}}\r\n{{bridge_root}}\r\n结尾规则';
    writeFileSync(join(root,'README.md'),readme);writeFileSync(join(root,'MEMORY.md'),memory);
    for(const agent of ['codex','claude'] as const){
      const result=workspaceDocuments(root,{agent,internalBotCommunicationEnabled:false});
      assert.deepEqual(result.errors,[]);assert.equal(result.files.length,2);
      assert.ok(result.text.endsWith(memory));assert.equal(result.text.split('`bridge_start_worker`').length-1,1);
      assert.ok(result.text.includes(root));assert.doesNotMatch(result.text,/Worker model:|Only bridge management tools/);
    }
    const second=join(root,'迁移 空格');mkdirSync(second);
    writeFileSync(join(second,'README.md'),readme);writeFileSync(join(second,'MEMORY.md'),'另一份用户上下文');
    assert.equal(readFileSync(join(root,'README.md'),'utf8'),readFileSync(join(second,'README.md'),'utf8'));
    const moved=workspaceDocuments(second,{internalBotCommunicationEnabled:false});
    assert.ok(moved.text.includes(second));assert.ok(moved.text.endsWith('另一份用户上下文'));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('unknown, duplicate, missing, malformed and oversized includes report incomplete context without fallback injection', () => {
  const root=mkdtempSync(join(tmpdir(),'bridge-context-invalid-'));
  try {
    writeFileSync(join(root,'MEMORY.md'),'OWNER_ONLY');
    for(const readme of ['legacy README',references+'\n{{include:workspace/../../secret}}',references+'\n{{include:workspace/MEMORY.md}}']){
      writeFileSync(join(root,'README.md'),readme);
      const result=workspaceDocuments(root);assert.ok(result.errors.length);assert.match(result.text,/未完整载入/);
      if(readme==='legacy README')assert.ok(!result.text.includes('OWNER_ONLY'));
    }
    writeFileSync(join(root,'README.md'),references);
    for(const memory of [Buffer.from([0xff,0xff]),Buffer.from('x'.repeat(65537))]){
      writeFileSync(join(root,'MEMORY.md'),memory);assert.ok(workspaceDocuments(root).errors.length);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
