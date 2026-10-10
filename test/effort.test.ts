import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/agents/codex.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import type { AgentTurn } from '../src/types.js';

const cli = String.raw`
const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin});
const trace=x=>fs.appendFileSync(process.env.TRACE,JSON.stringify(x)+'\n'); trace({args:process.argv.slice(2)});
const send=x=>process.stdout.write(JSON.stringify(x)+'\n'); let effort=null;
rl.on('close',()=>process.exit(0));
rl.on('line',line=>{const m=JSON.parse(line);trace(m);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='config/read')send({id:m.id,result:{config:{model_provider:'test',model_reasoning_effort:'medium'}}});
if(m.method==='thread/resume')send({id:m.id,result:{thread:{id:'same'},modelProvider:'test',model:'known',reasoningEffort:'medium'}});
if(m.method==='thread/read')send({id:m.id,result:{thread:{id:'same',reasoningEffort:effort}}});
if(m.method==='turn/start'){effort=m.params.effort;send({id:m.id,result:{turn:{id:'t'}}});send({method:'turn/completed',params:{threadId:'same',turn:{id:'t',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'ok'}]}}});}
if(m.type==='user'){send({type:'system',subtype:'init',session_id:'same',model:'known'});send({type:'result',subtype:'success',session_id:'same',result:'ok'});}
});`;

for (const agent of ['codex', 'claude'] as const) test(`${agent} validates effort and forwards native resume without fabricating Claude confirmation`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-effort-'));
  const script = join(dir, 'cli.cjs'), trace = join(dir, 'trace.jsonl'); writeFileSync(script, cli);
  const adapter = agent === 'codex' ? new CodexAdapter({ command: process.execPath, args: [script] }, { ...process.env, TRACE: trace })
    : new ClaudeAdapter({ command: process.execPath, args: [script] }, { ...process.env, TRACE: trace });
  adapter.getModelInfo = async () => ({ defaultModel: 'known', models: [{ id: 'known', displayName: 'Known', supportedEfforts: agent === 'codex' ? ['xhigh'] : ['high'] }] });
  const reports: (string | null)[] = [];
  const turn: AgentTurn = { conversation: { id: 'bridge', userId: 'u', agent, nativeId: 'same', model: 'known', effort: agent === 'codex' ? 'xhigh' : 'high', cwd: dir, title: '', createdAt: '', updatedAt: '' },
    text: 'test', imagePaths: [], signal: new AbortController().signal, onProgress: () => {}, onReasoningEffort: e => reports.push(e) };
  try {
    const result = await adapter.run(turn); assert.equal(result.nativeId, 'same');
    const records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (agent === 'codex') {
      assert.equal(records.find(m => m.method === 'turn/start').params.effort, 'xhigh');
      assert.equal(records.find(m => m.method === 'thread/resume').params.threadId, 'same');
      assert.deepEqual(reports, [null, 'xhigh']);
    } else {
      const args = records[0].args; assert.equal(args[args.indexOf('--effort') + 1], 'high');
      assert.equal(args[args.indexOf('--resume') + 1], 'same'); assert.deepEqual(reports, [null]);
    }
    turn.conversation.effort = agent === 'codex' ? 'high' : 'xhigh';
    await assert.rejects(adapter.run(turn), /不支持/);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('Claude 原生默认不提交 effort，也不依赖模型强度元数据查询', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-claude-default-effort-'));
  const script = join(dir, 'cli.cjs'), trace = join(dir, 'trace.jsonl'); writeFileSync(script, cli);
  const adapter = new ClaudeAdapter({ command: process.execPath, args: [script] }, { ...process.env, TRACE: trace });
  adapter.getModelInfo = async () => { throw new Error('默认强度不应发起元数据查询'); };
  const turn: AgentTurn = { conversation: { id: 'bridge', userId: 'u', agent: 'claude', nativeId: 'same', model: 'haiku', effort: null, cwd: dir, title: '', createdAt: '', updatedAt: '' },
    text: 'test', imagePaths: [], signal: new AbortController().signal, onProgress: () => {} };
  try {
    assert.equal((await adapter.run(turn)).nativeId, 'same');
    const records = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)); const args = records[0].args;
    assert.equal(args.includes('--effort'), false); assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    assert.equal(args[args.indexOf('--resume') + 1], 'same'); assert.equal(records.some(item => item.type === 'user'), true);
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});
