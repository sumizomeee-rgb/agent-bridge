import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { RestartJournal, RestartService, type RestartOrigin } from '../src/restart.js';
import { closeResources } from '../src/shutdown.js';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';

const origin: RestartOrigin = { conversationId: 'parent', userId: 'user', channelId: 'dm', originMessageId: 'human', nativeId: 'full-native-parent' };
function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-close-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-close-')); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return root;
}
function configFor(root: string): BridgeConfig {
  return { token: '', allowedUserIds: ['user'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: root, attachmentsDir: root, logsDir: root, maxImageBytes: 1024 };
}
function adapterWithClose(close: () => Promise<void>): AgentAdapter {
  return { async run() { assert.fail('关闭测试不能生成新聊天'); }, async interrupt() {}, close };
}

test('关闭聚合继续完成所有收尾，保留每个失败的来源而不当成成功', async () => {
  const attempted: string[] = [];
  await assert.rejects(closeResources([
    { name: '主控', close: () => { attempted.push('controller'); throw new Error('unknownStop: exit not confirmed'); } },
    { name: '执行器', close: async () => { attempted.push('worker'); throw new Error('worker close failed'); } },
    { name: '数据库', close: () => { attempted.push('store'); } },
  ]), (error: unknown) => {
    assert(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.message, /主控: unknownStop/); assert.match(error.message, /执行器: worker close failed/); return true;
  });
  assert.deepEqual(attempted, ['controller', 'worker', 'store']);
});

test('manager关闭传播所有adapter失败，重复关闭保留同一失败且队列记录已落盘', async t => {
  const root = rootFor(t); let codexCloses = 0; let claudeCloses = 0;
  const manager = new SessionManager(configFor(root), {
    codex: adapterWithClose(async () => { codexCloses++; throw new Error('unknownStop codex'); }),
    claude: adapterWithClose(async () => { claudeCloses++; throw new Error('unknownStop claude'); }),
  }, { async sendText() { assert.fail('关闭失败不可发DM'); } });
  manager.beginDrain();
  await manager.handle({ id: 'saved-human', userId: 'user', channelId: 'dm', text: 'keep this for recovery', imagePaths: [] });
  const closing = manager.close(); assert.equal(manager.close(), closing);
  await assert.rejects(closing, (error: unknown) => {
    assert(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.match(error.message, /codex close: unknownStop codex/); assert.match(error.message, /claude close: unknownStop claude/); return true;
  });
  await assert.rejects(manager.close(), /unknownStop/); assert.equal(codexCloses, 1); assert.equal(claudeCloses, 1);
  const store = new SessionStore(root);
  try { assert.equal(store.getMessage('saved-human')!.state, 'queued'); }
  finally { store.close(); }
});

test('真实manager关闭失败先持久failed，再只报告76；所有关闭仍完成且不重复重启', async t => {
  const root = rootFor(t); const attempted: string[] = []; const exitCodes: number[] = []; const presence: string[] = [];
  const manager = new SessionManager(configFor(root), {
    codex: adapterWithClose(async () => { throw new Error('unknownStop: native process remains unconfirmed'); }),
    claude: adapterWithClose(async () => { attempted.push('claude'); }),
  }, { async sendText() { assert.fail('重启失败不可通知DM'); } });
  let shutdowns = 0;
  const service = new RestartService(root, {
    supervised: true, beginDrain: () => manager.beginDrain(), isIdle: () => manager.isIdle(),
    shutdown: async () => {
      shutdowns++;
      await closeResources([
        { name: '主控', close: () => manager.close() },
        { name: '后续资源', close: () => { attempted.push('remaining'); } },
      ]);
    },
    onShutdownComplete: code => {
      assert.equal(service.journal.current()!.phase, 'failed', '必须先落失败状态才能释放journal和结束进程');
      assert.match(service.journal.current()!.error!, /unknownStop/);
      exitCodes.push(code); service.close();
    },
    onPhase: state => presence.push(state), pollMs: 60000,
  });
  t.after(() => service.close());
  await service.request(origin); await Promise.all([service.check(), service.check()]); await service.check();
  assert.deepEqual(exitCodes, [76]); assert.equal(shutdowns, 1); assert.deepEqual(attempted, ['claude', 'remaining']);
  assert.deepEqual(presence, ['draining', 'failed']);
  assert.deepEqual(await service.request({ ...origin, originMessageId: 'late-human' }), { accepted: false, status: 'cancelled' });
  const journal = new RestartJournal(root);
  try {
    assert.equal(journal.current()!.phase, 'failed'); assert.match(journal.current()!.error!, /unknownStop/);
    journal.supervisorExited(76); assert.equal(journal.current()!.phase, 'failed'); assert.match(journal.current()!.error!, /unknownStop/);
  } finally { journal.close(); }
});

test('75只在最后必要关闭真正结束后报告，不提前报告重启成功', async t => {
  const root = rootFor(t); let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  let closing = false; const exitCodes: number[] = [];
  const service = new RestartService(root, {
    supervised: true, beginDrain: () => {}, isIdle: () => true,
    shutdown: async () => { closing = true; await held; },
    onShutdownComplete: code => { assert.equal(service.journal.current()!.phase, 'stopping'); exitCodes.push(code); service.close(); },
    onPhase: () => {}, pollMs: 60000,
  });
  t.after(() => { finish(); service.close(); });
  await service.request(origin); const checking = service.check();
  assert.equal(closing, true); assert.deepEqual(exitCodes, []); finish(); await checking; assert.deepEqual(exitCodes, [75]);
});

test('真实隔离supervisor收到76仅启动一次，不创建disabled并保存失败', { skip: process.platform !== 'win32' }, t => {
  const root = rootFor(t); const scripts = join(root, 'scripts'); const dataDir = join(root, '.local', 'data');
  const dist = join(root, 'dist', 'src');
  for (const dir of [scripts, dist]) mkdirSync(dir, { recursive: true });
  const supervisor = readFileSync(new URL('../../scripts/supervise.ps1', import.meta.url), 'utf8');
  const runtimeAssignment = "$runtime = Join-Path $projectRoot '.local\\runtime\\win-x64\\node.exe'";
  assert.equal(supervisor.split(runtimeAssignment).length, 2);
  // Inject only the executable path; use the production supervision/exit logic.
  writeFileSync(join(scripts, 'supervise.ps1'), supervisor.replace(runtimeAssignment, `$runtime = '${process.execPath.replace(/'/g, "''")}'`));
  copyFileSync(new URL('../src/restart.js', import.meta.url), join(dist, 'restart.js'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const countPath = join(root, 'starts.log');
  writeFileSync(join(dist, 'main.js'), `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(countPath)}, 'started\\n');\nprocess.exitCode=76;\n`);
  const journal = new RestartJournal(dataDir); journal.request(origin); journal.mark('stopping'); journal.close();
  copyFileSync(new URL('../../scripts/paths.ps1', import.meta.url), join(scripts, 'paths.ps1'));
  writeFileSync(join(root, '.local', 'config.json'), JSON.stringify({ version: 2, startupProfile: 'discord/default' }));
  const child = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, 'supervise.ps1')],
    { encoding: 'utf8', timeout: 8000, windowsHide: true });
  assert.equal(child.error, undefined, child.stderr); assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(countPath, 'utf8'), 'started\n', '不能运行第二个桥进程');
  assert.equal(existsSync(join(dataDir, 'disabled')), false, '不能混用手动stop停用标记');
  const saved = new RestartJournal(dataDir);
  try { assert.equal(saved.current()!.phase, 'failed'); assert.match(saved.current()!.error!, /退出（76）/); }
  finally { saved.close(); }
});
