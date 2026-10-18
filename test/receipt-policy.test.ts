import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowMessageReceipts } from '../src/receipt-policy.js';

test('消息表情规则跨平台共用，仅主控普通私聊省略，缺少正文的旧调用兼容', () => {
  for (const text of ['hello', '', '只是提到 /status，不是命令']) {
    assert.equal(shouldShowMessageReceipts({ controllerMode: true }, { text }), false);
    assert.equal(shouldShowMessageReceipts({ controllerMode: false }, { text }), true);
    assert.equal(shouldShowMessageReceipts({}, { text }), true);
    assert.equal(shouldShowMessageReceipts({ controllerMode: true }, { text, isGroup: true }), true);
    assert.equal(shouldShowMessageReceipts({ controllerMode: true }, { text, space: { kind: 'group' } }), true);
  }
  for (const text of ['/status', '/STOP', '/unknown', 'new chat', '新会话', '新聊天']) {
    assert.equal(shouldShowMessageReceipts({ controllerMode: true }, { text }), true, text);
  }
  assert.equal(shouldShowMessageReceipts({ controllerMode: true }, {}), true);
  assert.equal(shouldShowMessageReceipts({ controllerMode: true }, { isGroup: false }), true);
});
