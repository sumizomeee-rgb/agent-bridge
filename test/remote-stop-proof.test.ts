import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteAgentAdapter } from '../src/remote/adapter.js';
import type { RemoteJob, ExecutionTargetBinding } from '../src/remote/types.js';
import type { BridgeConfig } from '../src/types.js';

const command = { command: 'never-launched', args: [] };
const config: BridgeConfig = { token: 'unused', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: '.', proxyUrl: null,
  commands: { codex: command, claude: command }, dataDir: '.', attachmentsDir: '.', logsDir: '.', maxImageBytes: 1 };
const binding: ExecutionTargetBinding = { id: 'remote', label: 'Remote', transport: 'ssh', agent: 'codex', agentCommand: command, cwd: '.' };

test('a fresh remote adapter confirms a supplied persisted dispatch only by matching read-only exit evidence', async () => {
  const calls: Array<{ method: string; args: unknown }> = [];
  let job: RemoteJob = { dispatchId: 'old-dispatch', workerId: 'old-worker', status: 'uncertain', stopped: true,
    nativeId: 'native', ready: false, createdAt: 'now', updatedAt: 'now' };
  const adapter = new RemoteAgentAdapter(binding, config, { clientFactory: () => ({
    async request<T>(method: string, args: unknown) { calls.push({ method, args }); return job as T; }, async close() {},
  }) });
  try {
    assert.equal(await adapter.confirmStopped('old-worker'), false); assert.equal(calls.length, 0);
    assert.equal(await adapter.confirmStopped('old-worker', 'old-dispatch'), true);
    assert.deepEqual(calls, [{ method: 'query', args: { dispatchId: 'old-dispatch' } }]);
    for (const invalid of [{ dispatchId: 'other-dispatch' }, { workerId: 'other-worker' }, { stopped: undefined }, { stopped: false }, { status: 'running' as const }]) {
      const previous = job; job = { ...job, ...invalid };
      assert.equal(await adapter.confirmStopped('old-worker', 'old-dispatch'), false); job = previous;
    }
    assert.ok(calls.every(call => call.method === 'query')); assert.equal(job.status, 'uncertain');
  } finally { await adapter.close(); }
});
test('ordinary stopped uncertain results preserve native reports without claiming the process still runs', async () => {
  const { RemoteResultUncertain } = await import('../src/remote/types.js');
  const { completedResultFromError } = await import('../src/agents/process.js');
  const report = { nativeId: 'complete-native', text: 'Original report; feature acceptance remains incomplete.' }, methods: string[] = [];
  const adapter = new RemoteAgentAdapter({ ...binding, expectedHostname: 'test-host' }, config, { clientFactory: () => ({
    async request<T>(method: string) {
      methods.push(method);
      if (method === 'hello') return { hostname: 'test-host', version: 1, engines: ['codex'] } as T;
      assert.equal(method, 'query');
      return { dispatchId: 'old-dispatch', workerId: 'old-worker', status: 'uncertain', stopped: true, result: report } as T;
    }, async close() {},
  }) });
  try {
    await assert.rejects(adapter.run({ recovering: true, dispatchId: 'old-dispatch', conversation: { id: 'old-worker', userId: 'owner', agent: 'codex',
      nativeId: report.nativeId, title: 'old', cwd: '.', createdAt: '', updatedAt: '' }, text: 'must not submit', imagePaths: [],
      signal: new AbortController().signal, onProgress() {} }), error => {
      assert(error instanceof RemoteResultUncertain); assert.equal(error.resultUncertain, true); assert.equal('processStillRunning' in error, false);
      assert.deepEqual(completedResultFromError(error), report); return true;
    });
    assert.deepEqual(methods, ['hello', 'query']);
  } finally { await adapter.close(); }
});