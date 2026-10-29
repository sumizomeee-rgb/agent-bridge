import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerWorkerReport, mentionsPolicyDenial } from '../src/controller/worker-report.js';

test('normalization keeps denial facts, scope and instructions while original evidence stays intact', () => {
  const raw = 'Codex: BLOCKED by policy；本次未执行。Do not retry through another tool. 范围未知。';
  const shown = controllerWorkerReport(raw);
  assert(mentionsPolicyDenial(raw));
  assert.doesNotMatch(shown, /blocked by policy/i);
  assert.equal(shown, 'Codex: 本次工具调用被拒绝；本次未执行。Do not retry through another tool. 范围未知。');
  assert.match(raw, /BLOCKED by policy/);
  assert.equal(controllerWorkerReport('原结果：成功。\r\n'), '原结果：成功。\r\n');
  assert.equal(mentionsPolicyDenial('unblocked by policy'), false);
});
