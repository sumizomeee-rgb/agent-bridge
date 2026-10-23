import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { AgentProcessStopError, JsonLineProcess, type JsonObject } from '../src/agents/process.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
test('Windows 收尾 helper 冷启动超过五秒仍等待握手并核实原树退出', { skip: process.platform !== 'win32' }, async () => {
  const transport = new JsonLineProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, [], process.cwd(), {}, script =>
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('Start-Sleep -Seconds 6;\n' + script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  try {
    await transport.stop(false);
    assert.equal(transport.confirmStopped(), true); assert.equal(transport.stopEvidence.taskkillAttempted, true);
    assert.equal(transport.stopEvidence.taskkillExitCode, 0); assert(transport.stopEvidence.phaseMs.treeKill! > 5000);
  } finally { if (transport.child.exitCode === null && transport.child.signalCode === null) transport.child.kill(); }
});

for (const authorized of [false, true]) test(`Windows 收尾失败只在未授权 tree kill 时允许重试（已授权=${authorized}）`, { skip: process.platform !== 'win32' }, async () => {
  let helpers = 0;
  const transport = new JsonLineProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, [], process.cwd(), {}, script => {
    helpers++;
    if (helpers > 1) return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const simulation = authorized
      ? "process.stdout.write('READY\\n');process.stdin.once('data',()=>process.stdout.write('ATTEMPT\\nEXIT:1\\n',()=>process.exit(0)))"
      : "process.stdout.write('FAILED\\n',()=>process.exit(0))";
    return spawn(process.execPath, ['-e', simulation], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  });
  try {
    await pause(100);
    const first = transport.stop(false); await assert.rejects(first, AgentProcessStopError);
    assert.equal(transport.stopEvidence.taskkillAttempted, authorized);
    assert.equal(transport.confirmStopped(), false);
    assert.equal(transport.canRetryStop(), !authorized);
    if (authorized) {
      assert.equal(transport.stop(false), first); await assert.rejects(first, AgentProcessStopError); assert.equal(helpers, 1);
    } else {
      const second = transport.stop(false); assert.notEqual(second, first); assert.equal(transport.stop(false), second);
      await second; assert.equal(helpers, 2); assert.equal(transport.confirmStopped(), true);
      assert.equal(transport.stopEvidence.taskkillExitCode, 0); assert.equal(transport.stopEvidence.completion, 'tree-stop');
    }
  } finally {
    if (transport.child.exitCode === null && transport.child.signalCode === null) transport.child.kill();
  }
});

test('Claude 模型目录保留用户模型认证环境，同时隔离 MCP、hooks 和会话写入，始终没有 user 输入', async () => {
  const messages = new Set<(message: JsonObject) => void>(), written: JsonObject[] = [];
  const env = { ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_MODEL: 'gateway-fixture', ANTHROPIC_AUTH_TOKEN: 'fixture-only' };
  const command = { command: 'never-spawn', args: ['physical-wrapper'] };
  const adapter = new ClaudeAdapter(command, env, undefined, (actual, args, _cwd, actualEnv) => {
    assert.equal(actual, command); assert.equal(actualEnv, env);
    for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--no-chrome']) assert(args.includes(flag));
    assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]!), { mcpServers: {} });
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]!), { disableAllHooks: true });
    return {
      onMessage(fn) { messages.add(fn); return () => { messages.delete(fn); }; }, onFailure() { return () => {}; },
      write(m) { written.push(m); queueMicrotask(() => messages.forEach(fn => fn({ type: 'control_response', response: { request_id: 'bridge-models', subtype: 'success', response: { models: [] } } }))); },
      endInput() {}, async stop() {}, confirmStopped() { return true; },
    };
  });
  try {
    assert.equal((await adapter.getModelInfo('.')).defaultModel, 'gateway-fixture');
    assert.equal(written.length, 1); assert.equal(written[0]!.type, 'control_request'); assert.equal(messages.size, 0);
  } finally { await adapter.close(); }
});

for (const source of ['inline', 'file'] as const) test(`Claude 模型探测保留启动参数 ${source} settings 中的模型及认证配置`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-metadata-settings-'));
  const settings = { env: { ANTHROPIC_AUTH_TOKEN: 'fixture-only', ANTHROPIC_BASE_URL: 'https://fixture.invalid' }, model: 'fixture-model', disableAllHooks: false };
  writeFileSync(join(root, 'session.json'), JSON.stringify(settings));
  const original = source === 'inline' ? JSON.stringify(settings) : 'session.json';
  const messages = new Set<(message: JsonObject) => void>();
  const adapter = new ClaudeAdapter({ command: 'never-spawn', args: source === 'inline' ? ['--settings=' + original] : ['--settings', original] }, {}, undefined, (_command, args) => {
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]!), { ...settings, disableAllHooks: true });
    return { onMessage(fn) { messages.add(fn); return () => { messages.delete(fn); }; }, onFailure() { return () => {}; }, endInput() {}, async stop() {},
      write() { queueMicrotask(() => messages.forEach(fn => fn({ type: 'control_response', response: { request_id: 'bridge-models', subtype: 'success', response: {} } }))); }, confirmStopped() { return true; } };
  });
  try { await adapter.getModelInfo(root); } finally { await adapter.close(); rmSync(root, { recursive: true, force: true }); }
});
