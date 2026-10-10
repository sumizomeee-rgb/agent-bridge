import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RestartJournal, RestartService, type RestartOrigin } from '../src/restart.js';

const origin: RestartOrigin = { conversationId: 'parent', userId: 'user', channelId: 'dm', originMessageId: 'human', nativeId: 'full-native-parent' };
function rootFor(t: TestContext): { root: string; closers: Array<() => void> } {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-'));
  const closers: Array<() => void> = [];
  t.after(() => { for (const close of closers) close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-')); rmSync(root, { recursive: true, force: true }); });
  return { root, closers };
}

test('重启请求快速持久返回，重复请求及重复check仅关闭一次，不派检查任务', async t => {
  const { root, closers } = rootFor(t); let idle = false; let drains = 0; let stops = 0; const presence: string[] = [];
  const service = new RestartService(root, { supervised: true, beginDrain: () => { drains++; }, isIdle: () => idle,
    shutdown: async () => { stops++; }, presence: state => presence.push(state), pollMs: 60000 });
  closers.push(() => service.close());
  const requested = await service.request(origin);
  assert.equal(requested.accepted, true); assert.equal(requested.status, 'draining');
  assert.equal(service.isDraining(), true); assert.equal(service.journal.current()!.phase, 'draining');
  const repeated = await service.request(origin); assert.equal(repeated.requestId, requested.requestId); assert.equal(repeated.duplicate, true);
  await service.check(); assert.equal(stops, 0); assert.equal(drains, 1);
  idle = true; await Promise.all([service.check(), service.check()]); await service.check();
  assert.equal(stops, 1); assert.deepEqual(presence, ['draining']); assert.equal(service.journal.current()!.phase, 'stopping');
});

test('永久请求key跨进程保留，已完成请求不再次drain；新消息可申请下一次', async t => {
  const { root, closers } = rootFor(t); const journal = new RestartJournal(root);
  const first = journal.request(origin); const together = journal.request({ ...origin, originMessageId: 'another-human' });
  assert.equal(together.requestId, first.requestId); journal.mark('stopping'); journal.supervisorExited(75);
  assert.equal(journal.current()!.phase, 'starting'); assert.equal(journal.beginRecovery(), true); journal.mark('ready'); journal.close();
  let drains = 0; const service = new RestartService(root, { supervised: true, beginDrain: () => { drains++; }, isIdle: () => false,
    shutdown: async () => { assert.fail('不能重启已完成的请求'); }, presence: () => {}, pollMs: 60000 });
  closers.push(() => service.close());
  const duplicate = await service.request(origin); assert.equal(duplicate.status, 'ready'); assert.equal(duplicate.requestId, first.requestId);
  const newlyBound = await service.request({ ...origin, nativeId: 'newly-bound-native' });
  assert.equal(newlyBound.requestId, first.requestId, '同一真实human不会因native早晚绑定而重复重启'); assert.equal(newlyBound.status, 'ready');
  assert.equal(service.isDraining(), false); assert.equal(drains, 0);
  const next = await service.request({ ...origin, originMessageId: 'new-human' });
  assert.notEqual(next.requestId, first.requestId); assert.equal(drains, 1);
});

test('启动失败记录持久保存，普通READY不误称重启；只有明确recover完成才ready', t => {
  const { root, closers } = rootFor(t); const journal = new RestartJournal(root);
  const first = journal.request(origin); journal.mark('stopping'); journal.supervisorExited(75);
  journal.supervisorExited(1); assert.equal(journal.current()!.phase, 'failed'); journal.close();
  const presence: string[] = [];
  const service = new RestartService(root, { supervised: true, beginDrain: () => {}, isIdle: () => false,
    shutdown: async () => {}, presence: state => presence.push(state) });
  closers.push(() => service.close());
  assert.equal(service.journal.current()!.requestId, first.requestId); assert.match(service.journal.current()!.error!, /退出（1）/);
  service.beginRecovery(); assert.equal(service.journal.current()!.phase, 'recovering'); assert.equal(service.journal.current()!.attempts, 1);
  service.ready(); assert.equal(service.journal.current()!.phase, 'ready');
  service.beginRecovery(); assert.equal(service.journal.current()!.attempts, 1, '已经ready不重复当重启');
  assert.deepEqual(presence, ['recovering', 'idle']);
});

test('没有监督器拒绝退出，普通stop取消pending并保持停用语义', async t => {
  const { root, closers } = rootFor(t); let drains = 0;
  const unsupervised = new RestartService(root, { supervised: false, beginDrain: () => { drains++; }, isIdle: () => true,
    shutdown: async () => { assert.fail('直接启动不可自杀'); }, presence: () => {} });
  assert.deepEqual(await unsupervised.request(origin), { accepted: false, status: 'supervisor_required' });
  assert.equal(unsupervised.journal.current(), null); unsupervised.close(); assert.equal(drains, 0);
  const service = new RestartService(root, { supervised: true, beginDrain: () => { drains++; }, isIdle: () => false,
    shutdown: async () => {}, presence: () => {}, pollMs: 60000 });
  closers.push(() => service.close()); await service.request(origin); service.cancel();
  assert.equal(service.journal.current()!.phase, 'cancelled');
  assert.equal(service.isDraining(), false); await service.check();
  assert.deepEqual(await service.request({ ...origin, originMessageId: 'late-request' }), { accepted: false, status: 'cancelled' });
  assert.equal(drains, 1, '用户stop后迟到的工具调用不能重启排空');
});
