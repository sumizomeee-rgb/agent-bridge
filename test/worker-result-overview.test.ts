import test from 'node:test';
import assert from 'node:assert/strict';
import { isActiveWorker, workerOverview, type WorkerOverview } from '../src/overview.js';
import { presentationText } from '../src/presentation.js';

const blocked: WorkerOverview = { workerId: 'worker-report', conversationId: 'parent', targetId: 'local', targetLabel: '桥电脑',
  agent: 'codex', title: '核对现场', model: null, effort: null, nativeId: null, status: 'uncertain',
  running: false, queued: 0, startedAt: null, blocked: true, statusReason: '程序退出未确认' };

test('待核对助手分别展示已保存报告与退出证据，保持业务核对锁可见', () => {
  for (const details of [false, true]) for (const [evidence, expected] of [
    [{ resultKnown: true, processStopped: false }, '报告已保存；退出待确认'],
    [{ resultKnown: true, processStopped: true }, '报告已保存；退出已确认，结果待核对'],
    [{ resultKnown: true }, '报告已保存；退出待确认'],
    [{ processStopped: true }, '退出已确认，结果待核对'],
  ] as const) {
    const item = { ...blocked, ...evidence };
    const text = presentationText(workerOverview([item], 'current', 0, details));
    assert(text.includes(expected));
    assert.match(text, /待核对1个/);
    assert(!text.includes('程序退出未确认'));
    assert(!text.includes('✅ 已完成'));
    assert.equal(isActiveWorker(item), true);
    assert.equal(item.blocked, true);
  }
});

test('旧助手无新证据时保留原核对原因，正常结果不引入核对提示', () => {
  assert.match(presentationText(workerOverview([blocked], 'current')), /需核对：程序退出未确认/);
  const completed = { ...blocked, status: 'completed' as const, blocked: false, statusReason: undefined,
    resultKnown: true, processStopped: true };
  const text = presentationText(workerOverview([completed], 'current'));
  assert.match(text, /✅ 已完成/);
  assert(!text.includes('结果待核对'));
});
