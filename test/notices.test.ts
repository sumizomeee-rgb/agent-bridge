import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_NOTICE_COPY, bridgeNotice, type BridgeNoticeCode } from '../src/notices.js';
import { BRIDGE_LIFECYCLE_COPY } from '../src/lifecycle.js';
import { discordPresentationPages, feishuPresentationCards, presentationText } from '../src/presentation.js';

test('程序通知集中定义短文案、级别和统一前缀，不包含具体机器人身份', () => {
  for (const code of Object.keys(BRIDGE_NOTICE_COPY) as BridgeNoticeCode[]) {
    const view = bridgeNotice(code);
    assert.match(view.title, /^【桥】/);
    assert([...view.title].length < 20);
    assert.equal(view.blocks.length, 1);
    assert([...view.blocks[0]!.text].length < 30);
    assert.equal(view.footer, undefined);
  }
  assert.equal(bridgeNotice('resultDeliveryFailed').blocks[0]!.text, '结果已保存。');
  assert.equal(bridgeNotice('controllerFailed').blocks[0]!.text, '本轮已中断，请核对现场。');
  assert.equal(bridgeNotice('summaryInterrupted').tone, 'warning');
  assert.equal(bridgeNotice('processExitUnconfirmed').tone, 'error');
  assert.equal(bridgeNotice('processExitUnconfirmed').title, '【桥】退出待确认');
  assert.equal(bridgeNotice('processExitUnconfirmed').blocks[0]!.text, '报告已保存，请核对进程。');
});

test('任务上下文限制为80个完整字符，清理不可见控制符且不改变固定文案', () => {
  const view = bridgeNotice('summaryFailed', { taskTitle: '\n' + '任务😀'.repeat(40) + '\u0000' });
  assert.equal(view.footer, '任务：' + [...'任务😀'.repeat(40)].slice(0, 80).join(''));
  assert(!view.footer!.includes('\n'));
  assert(!/[\uD800-\uDBFF]$/.test(view.footer!));
  assert.equal(view.title, '【桥】汇总失败');
  assert.equal(bridgeNotice('summaryFailed', { taskTitle: ' \r\n ' }).footer, undefined);
});

test('错误在飞书使用红卡、Discord使用红标题、纯文本只加一次错误标记', () => {
  const view = bridgeNotice('resultDeliveryUncertain');
  for (const purpose of ['status', 'reply'] as const) {
    const error = { ...view, purpose };
    assert.equal((feishuPresentationCards(error)[0]!.header as any).template, 'red');
    assert.match(discordPresentationPages(error)[0]!, /^```ansi\n\u001b\[31m【桥】/);
  }
  assert.match(presentationText(view), /^❌ 【桥】汇报发送待核对/);
  assert.equal(presentationText({ ...view, title: '❌ ' + view.title }).match(/❌/gu)?.length, 1);
  const warning = { ...bridgeNotice('summaryStopped'), purpose: 'reply' as const };
  assert.equal((feishuPresentationCards(warning)[0]!.header as any).template, 'orange');
  assert(!presentationText(warning).startsWith('❌'));
  assert.equal((feishuPresentationCards({ ...view, tone: 'success', purpose: 'reply' })[0]!.header as any).template, 'green');
  assert.equal((feishuPresentationCards({ ...view, tone: 'info', purpose: 'status' })[0]!.header as any).template, 'orange');
});

test('生命周期保持既有键名，仅标题带程序前缀', () => {
  assert.deepEqual(Object.keys(BRIDGE_LIFECYCLE_COPY), ['ready', 'restart', 'draining', 'recovering', 'failed', 'continuation']);
  for (const key of ['ready', 'restart', 'draining', 'recovering', 'failed'] as const) {
    assert.match(BRIDGE_LIFECYCLE_COPY[key], /^【桥】/);
  }
  assert.equal(BRIDGE_LIFECYCLE_COPY.continuation, '可以继续。');
});
