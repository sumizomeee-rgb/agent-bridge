import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEffortReporter, formatEffortEvidence, normalizeEffortCapability, observedClaudeEffort, validateEffort } from '../src/effort.js';
import { replyHeader } from '../src/reply.js';
import { workerOverview, type WorkerOverview } from '../src/overview.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import type { AgentName, AgentTurn, EffortMetadata } from '../src/types.js';

const unknown = { status: 'unknown' as const, levels: [] as [], source: 'test-native', modelId: 'alias' };
const evidence = (patch: Partial<EffortMetadata> = {}): EffortMetadata => ({ requested: null, actual: null, configuration: null, capability: unknown, ...patch });
for (const agent of ['codex', 'claude'] as const) test(`${agent} reply and worker summary use the same factual effort precedence`, () => {
  const cases: Array<[EffortMetadata, string]> = [
    [evidence(), 'CLI 默认 · 未回报'],
    [evidence({ requested: 'high' }), '高〔指定〕'],
    [evidence({ configuration: { value: 'xhigh', source: 'user-settings' } }), '极高〔CLI 配置〕'],
    [evidence({ configuration: { value: 'high', source: 'environment' } }), '高〔环境配置〕'],
    [evidence({ configuration: { value: 'high', source: 'argument' } }), '高〔启动参数〕'],
    [evidence({ configuration: { value: 'xhigh', source: 'user-settings', applied: false, reason: 'not passed' } }), 'CLI 默认 · 配置未采用'],
    [evidence({ capability: { ...unknown, status: 'unsupported' } }), '不适用'],
    [evidence({ actual: 'low', requested: 'high', configuration: { value: 'xhigh', source: 'user-settings' } }), '低'],
  ];
  for (const [metadata, expected] of cases) {
    assert.equal(formatEffortEvidence(metadata), expected);
    const header = replyHeader({ agent, conversationId: 'c', nativeId: 'native-1234' }, null, 'provider-model', 'stale-high', metadata);
    assert.equal(header, `[${agent === 'codex' ? 'Codex' : 'Claude'} · provider-model · ${expected} · 1234]`);
    const worker: WorkerOverview = { workerId: 'w', conversationId: 'c', targetId: 'local', targetLabel: '桥电脑', agent, title: 'task', model: 'provider-model', effort: 'stale-high', nativeId: 'native-1234', effortMetadata: metadata, status: 'completed', running: false, queued: 0, startedAt: null };
    assert(workerOverview([worker], 'current').blocks[0]!.text.includes(`provider-model · ${expected} · w`));
  }
});

test('fresh effort reporters retain separate immutable axes and never reuse prior conversation actual effort', () => {
  const snapshots: EffortMetadata[] = [], actual: unknown[] = [], configured: unknown[] = [];
  const turn: AgentTurn = { conversation: { id: 'c', userId: 'u', agent: 'claude', nativeId: 'n', cwd: '.', title: '', createdAt: '', updatedAt: '', actualEffort: 'old-high' }, text: 'test', imagePaths: [], signal: new AbortController().signal, onProgress() {}, onEffortMetadata: value => snapshots.push(value), onReasoningEffort: value => actual.push(value), onEffortConfiguration: value => configured.push(value) };
  const report = createEffortReporter(turn, 'claude'); report(); const first = snapshots[0]!;
  assert.equal(first.actual, null); report({ configuration: { value: 'high', source: 'environment' } }); assert.equal(first.configuration, null);
  report({ actual: 'low' }); report({ actual: 'low' }); assert.deepEqual(actual, [null, 'low']); assert.deepEqual(configured, [null, { value: 'high', source: 'environment' }]);
  snapshots[1]!.configuration!.value = 'mutated'; assert.equal(report().configuration?.value, 'high');
  const again = createEffortReporter(turn, 'claude'); assert.equal(again().actual, null);
});

test('effort capability levels come only from the selected backend adapter and are not cross-mapped', async () => {
  const capability = normalizeEffortCapability('claude', ['low', 'xhigh'], { source: 'cli-models', modelId: 'custom' }); assert.equal(capability.status, 'supported');
  const target: AgentTurn['conversation'] = { id: 'c', userId: 'u', agent: 'claude', nativeId: null, model: 'custom', cwd: '.', title: '', createdAt: '', updatedAt: '' };
  const adapter = { async run(): Promise<never> { throw Error('no generation'); }, async close() {}, async interrupt() {}, async getModelInfo() { return { defaultModel: 'custom', models: [{ id: 'custom', displayName: 'Custom', effortCapability: capability }] }; } };
  assert.equal((await validateEffort(adapter, target, 'xhigh')).status, 'supported'); await assert.rejects(validateEffort(adapter, target, 'ultra'), /不支持 ultra/);
});

test('Claude only observes explicit response effort and never infers a level from model names or thinking', () => {
  assert.equal(observedClaudeEffort({ type: 'system', subtype: 'init', model: 'haiku', effortLevel: 'high' }), undefined);
  assert.equal(observedClaudeEffort({ type: 'assistant', parent_tool_use_id: 'child', message: { output_config: { effort: 'high' } } }), undefined);
  assert.equal(observedClaudeEffort({ type: 'assistant', message: { content: [{ type: 'thinking' }], output_config: { effort: 'medium' } } }), 'medium');
  assert.equal(observedClaudeEffort({ type: 'stream_event', event: { type: 'message_start', message: { output_config: { effort: 'low' } } } }), 'low');
  assert.equal(observedClaudeEffort({ type: 'assistant', message: { output_config: { effort: 'high\n@all' } } }), undefined);
});

const fakeCli = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});const send=x=>console.log(JSON.stringify(x));
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='config/read')send({id:m.id,result:{config:{model_provider:'test',model_reasoning_effort:'high'}}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native'},modelProvider:'test',model:'provider-model',reasoningEffort:'low'}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'t'}}});send({method:'turn/completed',params:{threadId:'native',turn:{id:'t',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'ok'}]}}});}
if(m.type==='user'){send({type:'system',subtype:'init',session_id:'native',model:'provider-model',supportsEffort:false});send({type:'result',subtype:'success',session_id:'native',result:'ok'});}
});rl.on('close',()=>process.exit(0));`;
for (const agent of ['codex', 'claude'] as const) test(`${agent} adapter reports launch configuration separately from native observation without a default capability probe`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-effort-metadata-'));
  try {
    const home = join(root, 'home'); mkdirSync(home); writeFileSync(join(home, 'settings.json'), '{"effortLevel":"high"}'); const script = join(root, 'cli.cjs'); writeFileSync(script, fakeCli);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: home }, command = { command: process.execPath, args: [script] };
    const adapter = agent === 'codex' ? new CodexAdapter(command, env) : new ClaudeAdapter(command, env); adapter.getModelInfo = async () => { throw Error('default must not probe'); };
    const snapshots: EffortMetadata[] = [], native: unknown[] = [];
    const turn: AgentTurn = { conversation: { id: 'c', userId: 'u', agent, nativeId: null, model: 'alias', cwd: root, title: '', createdAt: '', updatedAt: '' }, text: 'test', imagePaths: [], signal: new AbortController().signal, onProgress() {}, onEffortMetadata: value => snapshots.push(value), onReasoningEffort: value => native.push(value) };
    try { await adapter.run(turn); } finally { await adapter.close(); }
    const final = snapshots.at(-1)!; assert.equal(final.configuration?.value, 'high'); assert.equal(final.requested, null);
    if (agent === 'codex') { assert.equal(final.configuration?.source, 'session-settings'); assert.equal(final.actual, 'low'); assert.deepEqual(native, [null, 'low']); }
    else { assert.equal(final.configuration?.source, 'user-settings'); assert.equal(final.actual, null); assert.equal(final.capability.status, 'unsupported'); assert.deepEqual(native, [null]); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
