import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DurableIngress } from '../src/ingress.js';
import type { IncomingDM } from '../src/types.js';

async function until(check: () => boolean): Promise<void> { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw new Error('ingress drain timeout'); await delay(5); } }
const message = (id: string): IncomingDM => ({ id, userId: '111', channelId: '222', text: `human-${id}`, attachments: [] });

test('排空暂停当前准备与已排队准备，incoming只持久保存，重开后按原顺序恢复一次', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-ingress-')); const entered: string[] = []; const accepted = new Set<string>();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: id => accepted.has(id),
    handle: async msg => { entered.push(msg.id); await gate; } });
  t.after(async () => { await ingress.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-ingress-')); rmSync(root, { recursive: true, force: true }); });
  ingress.start(); await ingress.receive(message('101')); await until(() => entered.length === 1);
  await ingress.receive(message('102')); ingress.pause(); await ingress.receive(message('103')); release(); await ingress.whenIdle();
  assert.deepEqual(entered, ['101']);
  for (const id of ['101', '102', '103']) assert.equal(ingress.getMessage(id)!.state, 'received', `${id}不能误标accepted`);
  await ingress.close();
  ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: id => accepted.has(id), handle: async msg => { entered.push(msg.id); accepted.add(msg.id); } });
  ingress.start(); await ingress.whenIdle();
  assert.deepEqual(entered, ['101', '101', '102', '103']);
  for (const id of ['101', '102', '103']) assert.equal(ingress.getMessage(id)!.state, 'accepted');
});

test('准备中出错遇到pause保留received，不发重启错误私信；recover结束不唤醒暂停队列', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-ingress-')); let reject!: (error: Error) => void; const errors: unknown[] = [];
  let entered = false; const gate = new Promise<void>((_resolve, no) => { reject = no; });
  const ingress = new DurableIngress(root, { allowedUserIds: ['111'], hasMessage: () => false,
    handle: async () => { entered = true; await gate; }, onError: (_message, error) => errors.push(error) });
  t.after(async () => { await ingress.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-ingress-')); rmSync(root, { recursive: true, force: true }); });
  ingress.start(); await ingress.receive(message('101')); await until(() => entered); ingress.pause(); reject(new Error('download aborted'));
  await ingress.whenIdle(); assert.equal(ingress.getMessage('101')!.state, 'received'); assert.deepEqual(errors, []);
  await ingress.recover(async () => ({ messages: [message('102')], oldestId: '101', newestId: '102', hasMore: false }));
  assert.equal(ingress.getMessage('102')!.state, 'received'); assert.equal(ingress.getMessage('101')!.state, 'received');
});

test('drain期间新READY后的消息不推进已核对游标，重启补取断线缺口再按序执行', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-ingress-')); const entered: string[] = []; const accepted = new Set<string>();
  const options = { allowedUserIds: ['111'], hasMessage: (id: string) => accepted.has(id),
    handle: async (msg: IncomingDM) => { entered.push(msg.id); accepted.add(msg.id); } };
  let ingress = new DurableIngress(root, options);
  t.after(async () => { await ingress.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(basename(root).startsWith('bridge-restart-ingress-')); rmSync(root, { recursive: true, force: true }); });
  ingress.seedChannel({ userId: '111', channelId: '222', cursor: '100' }); ingress.start();
  await ingress.receive(message('101')); await ingress.whenIdle();
  assert.equal(ingress.knownChannels()[0]!.cursor, '101', '正常在线收件仍推进已核对游标');
  ingress.pause();
  // Simulate a fresh READY after an outage: main defers history recovery while draining.
  // Only the newest Gateway message arrives; 102/103 must still be backfilled later.
  ingress.capture(message('104'));
  assert.equal(ingress.getMessage('104')!.state, 'received');
  assert.equal(ingress.knownChannels()[0]!.cursor, '101', 'pause不能越过尚未补取的断线消息');
  assert.deepEqual(entered, ['101']); await ingress.close();
  ingress = new DurableIngress(root, options);
  assert.equal(ingress.knownChannels()[0]!.cursor, '101', '旧核对边界必须跨重启保留');
  await ingress.recover(async () => ({ messages: ['104','103','102','101'].map(message), oldestId: '101', newestId: '104', hasMore: false }));
  assert.equal(ingress.getMessage('102')!.state, 'received'); assert.equal(ingress.getMessage('103')!.state, 'received');
  ingress.start(); await ingress.whenIdle();
  assert.deepEqual(entered, ['101','102','103','104']); assert.equal(ingress.knownChannels()[0]!.cursor, '104');
  for (const id of ['102','103','104']) assert.equal(ingress.getMessage(id)!.state, 'accepted');
});
