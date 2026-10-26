import assert from 'node:assert/strict';
import test from 'node:test';
import { ControllerRuntime } from '../src/controller/runtime.js';

test('overview keeps stopped/result semantics and aggregates supplements once across worker history', () => {
  const origin = { userId: 'owner', channelId: 'dm', conversationId: 'parent' };
  const workers = Array.from({ length: 80 }, (_, i) => ({ id: `worker-${i}`, origin, agent: 'codex' }));
  const calls = { jobs: 0, supplements: 0 };
  const runtime = Object.create(ControllerRuntime.prototype) as ControllerRuntime;
  Object.assign(runtime, { store: {
    workers: (parent: string) => { assert.equal(parent, 'parent'); return workers; },
    jobs: (id: string) => { calls.jobs++; return [{ status: 'completed', nativeResult: { text: 'saved' }, processStopped: id !== 'worker-0', result: 'saved' }]; },
    supplements: () => { calls.supplements++; return [{ workerId: 'worker-0', status: 'pending' }, { workerId: 'worker-0', status: 'completed' }, { workerId: 'worker-1', status: 'uncertain' }]; },
  } });
  const result = runtime.queryWorkerOverview({ id: 'parent', userId: 'owner' } as any);
  assert.equal(result.length, 80);
  assert.equal(result[0]!.status, 'retiring');
  assert.equal(result[0]!.resultKnown, true);
  assert.equal(result[0]!.processStopped, false);
  assert.equal(result[1]!.status, 'completed');
  assert.equal(result[0]!.unresolvedSupplements, 1);
  assert.equal(result[1]!.unresolvedSupplements, 1);
  assert.equal(result[2]!.unresolvedSupplements, 0);
  assert.equal(calls.jobs, workers.length);
  assert.equal(calls.supplements, 1);
});
