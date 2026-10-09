import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runTaskCli } from '../src/task-cli.js';
import { TaskRegistry, TaskService, signTaskCompletion, type TaskTicket, type SignedTaskCompletion } from '../src/tasks.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-task-cli-test-'));
  const registry = new TaskRegistry(dir);
  const context = registry.createContext({ conversationId: 'parent', nativeId: 'native', userId: 'user', channelId: 'dm',
    originMessageId: 'message', cwd: dir, agent: 'codex' });
  return { dir, registry, context, env: { BRIDGE_TASK_CONTEXT: context.contextPath } };
}

test('a later turn cancels an earlier task immediately, clears counts and deduplicates late results', async () => {
  const { dir, registry, context, env } = fixture();
  const service = new TaskService(registry);
  try {
    const task = runTaskCli(['register', '--title', 'old worker', '--exit-file', join(dir, 'absent.exit')], env) as { taskId: string; ticketPath: string };
    registry.closeContext(context.contextId);
    const next = registry.createContext({ conversationId: 'parent', nativeId: 'native', userId: 'user', channelId: 'dm',
      originMessageId: 'later-message', cwd: dir, agent: 'codex' });
    const laterEnv = { BRIDGE_TASK_CONTEXT: next.contextPath };
    const result = runTaskCli(['cancel', '--task-id', task.taskId, '--text', 'worker verified stopped'], laterEnv) as { status: string; externalWorkerStopped: boolean };
    assert.equal(result.status, 'cancelled');
    assert.equal(result.externalWorkerStopped, false);
    assert.equal(registry.activeCount('parent'), 0);
    assert.equal(registry.watchingTasks().length, 0);
    const event = registry.getNextEvent()!;
    assert.equal(event.originMessageId, 'message');
    assert.equal(event.status, 'cancelled');
    runTaskCli(['cancel', '--task-id', task.taskId], laterEnv);
    const ticket = JSON.parse(readFileSync(task.ticketPath, 'utf8')) as TaskTicket;
    assert.equal(registry.acceptReceipt(signTaskCompletion(ticket, 'completed', 'late result')), false);
    assert.equal(registry.queuedEvents().length, 1);
    await service.poll();
    assert.equal(registry.activeCount('parent'), 0);
    assert.throws(() => runTaskCli(['cancel', '--task-id', task.taskId], env), /本轮已结束/);
  } finally { await service.close(); registry.close(); }
});

test('cancel rejects forged contexts and other users, sessions, channels, agents or workspaces', () => {
  const { dir, registry, context, env } = fixture();
  try {
    const task = runTaskCli(['register', '--title', 'owned'], env) as { taskId: string };
    const origin = { conversationId: 'parent', nativeId: 'native', userId: 'user', channelId: 'dm',
      originMessageId: 'next', cwd: dir, agent: 'codex' as const };
    for (const change of [{ conversationId: 'other' }, { userId: 'other' }, { channelId: 'other' },
      { cwd: join(dir, 'other') }, { agent: 'claude' as const }]) {
      const other = registry.createContext({ ...origin, ...change });
      assert.throws(() => runTaskCli(['cancel', '--task-id', task.taskId], { BRIDGE_TASK_CONTEXT: other.contextPath }), /不属于当前父会话/);
    }
    const forged = join(dir, 'forged-cancel.json');
    writeFileSync(forged, JSON.stringify({ ...JSON.parse(readFileSync(context.contextPath, 'utf8')), token: 'wrong' }));
    assert.throws(() => runTaskCli(['cancel', '--task-id', task.taskId], { BRIDGE_TASK_CONTEXT: forged }), /身份无效/);
    assert.equal(registry.activeCount('parent'), 1);
    assert.equal(registry.queuedEvents().length, 0);
  } finally { registry.close(); }
});

test('CLI automatically binds registration, permits watch setup after turn closes, and completes via scoped ticket', () => {
  const { dir, registry, context, env } = fixture();
  try {
    const task = runTaskCli(['register', '--title', 'SSH check'], env) as { taskId: string; ticketPath: string };
    registry.closeContext(context.contextId);
    const completionFile = join(dir, 'complete.json');
    runTaskCli(['watch', '--task-id', task.taskId, '--completion-file', completionFile], env);
    runTaskCli(['complete', '--ticket', task.ticketPath, '--output', completionFile, '--status', 'completed', '--text', 'sum=50'], {});
    registry.acceptReceipt(JSON.parse(readFileSync(completionFile, 'utf8')) as SignedTaskCompletion);
    assert.equal((runTaskCli(['status', '--task-id', task.taskId], env) as { status: string }).status, 'completed');
    assert.equal(registry.getNextEvent()!.nativeId, 'native');
    assert.throws(() => runTaskCli(['register', '--title', 'late'], env), /本轮已结束/);
  } finally { registry.close(); }
});

test('CLI rejects missing, forged or cross-parent context and unknown parameters without orphaning invalid watches', () => {
  const { dir, registry, context, env } = fixture();
  try {
    assert.throws(() => runTaskCli(['register', '--title', 'x'], {}), /BRIDGE_TASK_CONTEXT/);
    assert.throws(() => runTaskCli(['register', '--title', 'x', '--native-id', 'spoof'], env), /未知参数/);
    assert.throws(() => runTaskCli(['register', '--title', 'x', '--completion-file', 'relative'], env), /绝对路径/);
    assert.equal(registry.activeCount('parent'), 0);
    const task = runTaskCli(['register', '--title', 'x'], env) as { taskId: string };
    const forged = join(dir, 'forged.json');
    writeFileSync(forged, JSON.stringify({ ...JSON.parse(readFileSync(context.contextPath, 'utf8')), token: 'wrong' }));
    assert.throws(() => runTaskCli(['status', '--task-id', task.taskId], { BRIDGE_TASK_CONTEXT: forged }), /身份无效/);
  } finally { registry.close(); }
});

test('CLI bounded result completion preserves raw payload signature across PowerShell-compatible JSON envelope', () => {
  const { dir, registry, env } = fixture();
  try {
    const task = runTaskCli(['register', '--title', 'x'], env) as { taskId: string; ticketPath: string };
    const result = join(dir, 'large.txt'); const completion = join(dir, 'done.json');
    writeFileSync(result, '中文 "quote" \n'.repeat(10000));
    runTaskCli(['complete', '--ticket', task.ticketPath, '--output', completion, '--status', 'failed', '--result-file', result], {});
    const receipt = JSON.parse(readFileSync(completion, 'utf8')) as SignedTaskCompletion;
    assert.ok(Buffer.byteLength(receipt.payload) < 20 * 1024);
    assert.equal(registry.acceptReceipt(receipt), true);
    assert.match(registry.getNextEvent()!.text, /截断/);
  } finally { registry.close(); }
});

test('Windows PowerShell completion helper signs Chinese and quoted results interoperably', { skip: process.platform !== 'win32' }, () => {
  const { dir, registry, env } = fixture();
  try {
    const task = runTaskCli(['register', '--title', '中文远程任务'], env) as { taskId: string; ticketPath: string };
    const resultFile = join(dir, '中文结果.txt'); const completion = join(dir, '签名回执.json');
    const result = '工位检查完成：5 行，总和 50。\n包含 "引号" 和 Unicode ✅';
    writeFileSync(resultFile, result, 'utf8');
    const helper = fileURLToPath(new URL('../../scripts/task-complete.ps1', import.meta.url));
    const child = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-TicketPath', task.ticketPath, '-OutputPath', completion, '-Status', 'completed', '-ResultFile', resultFile],
    { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    registry.acceptReceipt(JSON.parse(readFileSync(completion, 'utf8')) as SignedTaskCompletion);
    assert.ok(registry.getNextEvent()!.text.includes(result));
  } finally { registry.close(); }
});
