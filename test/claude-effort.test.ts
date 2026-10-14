import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeEffortConfiguration } from '../src/agents/claude-effort.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { workerOverview, type WorkerOverview } from '../src/overview.js';
import type { AgentTurn, EffortConfiguration } from '../src/types.js';

test('Claude launch records execution-host configuration separately from native effort and never changes defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-effort-evidence-'));
  try {
    const home = join(root, 'home'), cwd = join(root, 'project');
    mkdirSync(home); mkdirSync(cwd); writeFileSync(join(home, 'settings.json'), '{"effortLevel":"xhigh"}');
    const cli = join(root, 'cli.cjs');
    writeFileSync(cli, `const r=require('node:readline').createInterface({input:process.stdin});
      if(process.argv.includes('--effort'))process.exit(9);
      r.on('line',()=>{console.log(JSON.stringify({type:'system',subtype:'init',session_id:'native',model:'deepseek-v4.1-flash'}));
      console.log(JSON.stringify({type:'result',subtype:'success',session_id:'native',result:'ok'}));process.exit(0)});`);
    const adapter = new ClaudeAdapter({ command: process.execPath, args: [cli] }, { CLAUDE_CONFIG_DIR: home });
    let snapshot: EffortConfiguration | null = null; const actual: Array<string | null> = [];
    const turn: AgentTurn = { conversation: { id: 'c', userId: 'u', agent: 'claude', nativeId: null, cwd, model: 'haiku', title: '', createdAt: '', updatedAt: '' },
      text: 'read only', imagePaths: [], signal: new AbortController().signal, onProgress: () => {},
      onEffortConfiguration: value => { snapshot = value; }, onReasoningEffort: value => actual.push(value) };
    try { await adapter.run(turn); } finally { await adapter.close(); }
    assert.deepEqual(snapshot, { value: 'xhigh', source: 'user-settings' });
    assert.deepEqual(actual, [null]);
    writeFileSync(join(home, 'settings.json'), '{"effortLevel":"low"}');
    assert.deepEqual(snapshot, { value: 'xhigh', source: 'user-settings' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude configuration evidence follows explicit launch inputs and project scopes without inventing a default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-effort-scopes-'));
  try {
    const home = join(root, 'home'), cwd = join(root, 'repo'), child = join(cwd, 'src');
    mkdirSync(home); mkdirSync(child, { recursive: true }); mkdirSync(join(cwd, '.git')); mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(home, 'settings.json'), '{"effortLevel":"medium"}');
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{"effortLevel":"high"}');
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{"effortLevel":"low"}');
    const env = { CLAUDE_CONFIG_DIR: home }, command = { command: 'claude', args: [] };
    assert.deepEqual(await claudeEffortConfiguration(command, env, child, null), { value: 'low', source: 'local-settings' });
    assert.deepEqual(await claudeEffortConfiguration({ ...command, args: ['--setting-sources', 'user'] }, env, child, null), { value: 'medium', source: 'user-settings' });
    assert.deepEqual(await claudeEffortConfiguration(command, { ...env, CLAUDE_CODE_EFFORT_LEVEL: 'high' }, child, null), { value: 'high', source: 'environment' });
    assert.deepEqual(await claudeEffortConfiguration(command, { ...env, CLAUDE_CODE_EFFORT_LEVEL: 'high' }, child, 'low'), { value: 'low', source: 'argument' });
    assert.equal(await claudeEffortConfiguration({ ...command, args: ['--setting-sources', ''] }, env, child, null), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Worker presentation distinguishes native confirmation, launch configuration, request, and historical missing evidence', () => {
  const item = { workerId: 'w', conversationId: 'c', targetId: 'workstation', targetLabel: '工位', agent: 'claude' as const,
    title: 'test', model: 'deepseek-v4.1-flash', effort: null, nativeId: 'n', status: 'completed' as const, running: false, queued: 0, startedAt: null };
  const text = (changes: Partial<WorkerOverview>) =>
    workerOverview([{ ...item, ...changes }], 'current').blocks.map(block => 'text' in block ? block.text : '').join('\n');
  assert.match(text({ effortConfiguration: { value: 'xhigh', source: 'user-settings' } }), /极高〔CLI 配置〕/);
  assert.match(text({ requestedEffort: 'high' }), /高〔指定〕/);
  assert.match(text({}), /CLI 默认 · 未回报/);
  assert.match(text({ effort: 'low', effortConfiguration: { value: 'xhigh', source: 'user-settings' } }), /flash · 低 ·/);
});
