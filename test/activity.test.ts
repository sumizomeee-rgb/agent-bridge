import assert from 'node:assert/strict';
import test from 'node:test';
import { observeActivity } from '../src/agents/activity.js';
import type { AgentActivity, AgentExecutionProgress } from '../src/types.js';

test('native activity strips payloads and duplicate tool starts retain the original timestamp', () => {
  const event = { at: '2026-10-12T10:00:00Z', type: 'tool-started', itemId: 'tool-1', toolName: 'Bash',
    command: 'PRIVATE COMMAND', arguments: { token: 'SECRET' }, output: 'PRIVATE OUTPUT' } as AgentActivity;
  const progress = observeActivity(undefined, event)!;
  assert.equal(progress.stage, 'tool'); assert.equal(progress.sequence, 1);
  assert.equal(JSON.stringify(progress).includes('PRIVATE'), false); assert.equal(JSON.stringify(progress).includes('SECRET'), false);
  assert.equal(observeActivity(progress, { ...event, at: '2026-10-12T10:08:00Z' }), progress);
  const after = observeActivity(progress, { at: '2026-10-12T10:09:00Z', type: 'tool-completed', itemId: 'tool-1', toolName: 'Bash', status: 'failed' })!;
  assert.equal(after.activeTools.length, 0); assert.equal(after.lastTool!.status, 'failed');
  assert.equal(observeActivity(after, { at: '2026-10-12T10:10:00Z', type: 'tool-completed', itemId: 'tool-1', toolName: 'Bash' }), after);
});

test('reasoning or messages do not pretend that a still-running native tool has completed', () => {
  let progress = observeActivity(undefined, { at: '2026-10-12T10:00:00Z', type: 'tool-started', itemId: 'a', toolName: 'browser' })!;
  progress = observeActivity(progress, { at: '2026-10-12T10:01:00Z', type: 'reasoning' })!;
  progress = observeActivity(progress, { at: '2026-10-12T10:02:00Z', type: 'message' })!;
  assert.equal(progress.stage, 'tool'); assert.equal(progress.activeTools[0]!.startedAt, '2026-10-12T10:00:00.000Z');
});

test('remote snapshots reconcile tools missed between polls without refreshing native activity times', () => {
  const first = observeActivity(undefined, { at: '2026-10-12T10:00:00Z', type: 'tool-started', itemId: 'a', toolName: 'browser' })!;
  let remote = observeActivity(first, { at: '2026-10-12T10:01:00Z', type: 'tool-started', itemId: 'b', toolName: 'upload' })!;
  remote = observeActivity(remote, { at: '2026-10-12T10:02:00Z', type: 'tool-completed', itemId: 'a', toolName: 'browser', status: 'completed' })!;
  const accepted = observeActivity(first, { ...remote.lastActivity, snapshot: remote })!;
  assert.deepEqual(accepted.activeTools, [{ itemId: 'b', toolName: 'upload', startedAt: '2026-10-12T10:01:00.000Z' }]);
  assert.equal(observeActivity(accepted, { ...remote.lastActivity, snapshot: remote }), accepted);
  assert.equal(observeActivity(accepted, { ...first.lastActivity, snapshot: first }), accepted);
});

test('unobserved and invalid native metadata cannot claim a healthy tool lifecycle', () => {
  assert.equal(observeActivity(undefined, { at: 'bad time', type: 'reasoning' }), undefined);
  assert.equal(observeActivity(undefined, { at: '2026-10-12', type: 'tool-started', toolName: 'Bash' }), undefined);
  assert.equal(observeActivity(undefined, { at: '2026-10-12', type: 'message', snapshot: {} as AgentExecutionProgress }), undefined);
  assert.equal(observeActivity(undefined, { at: '2026-10-12', type: 'message', snapshot: { observed: true, sequence: 1, activeTools: [] } as unknown as AgentExecutionProgress }), undefined);
});
