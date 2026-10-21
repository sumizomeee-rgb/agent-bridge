import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryDiagnostic, errorEvidence, executionErrorEvidence, FeishuRequestError } from '../src/delivery-errors.js';

test('execution evidence retains capacity, compaction and CLI exit reasons with structured causes', () => {
  const root = Object.assign(new Error('Selected model is at capacity: server_overloaded'), { code: 'EAGAIN' });
  const failure = new Error('上下文压缩失败，助手 CLI 退出未确认。', { cause: root });
  const evidence = JSON.parse(executionErrorEvidence(failure));
  assert.match(evidence.message, /压缩失败.*退出未确认/); assert.match(evidence.cause[0].message, /at capacity.*server_overloaded/); assert.equal(evidence.cause[0].code, 'EAGAIN');
  assert.equal(JSON.parse(executionErrorEvidence('native session not found')).message, 'native session not found');
  assert.equal(JSON.parse(executionErrorEvidence({ message: 'process exited with code 17', code: 17 })).code, '17');
});

test('execution evidence redacts known secrets, URLs and common credentials from every cause before truncating', () => {
  const cause = new Error('ECONNRESET https://account:proxy-password@example.invalid/path?access_token=query-secret Bearer bearer-value password="space secret" api_key=assignment-key');
  const error = new Error('capacity failure; known-sensitive-value sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuv {"refresh_token":"refresh-secret","client_secret":"client-secret"} JWT eyJabcdefghijk.abcdefghijk.abcdefghijk', { cause });
  const evidence = executionErrorEvidence(error, ['known-sensitive-value']);
  for (const secret of ['known-sensitive-value', 'proxy-password', 'example.invalid', 'query-secret', 'bearer-value', 'space secret', 'assignment-key', 'abcdefghijklmnop', 'refresh-secret', 'client-secret', 'eyJabcdefghijk']) assert(!evidence.includes(secret), secret);
  assert.match(evidence, /capacity failure/); assert.match(evidence, /ECONNRESET/);
  const other = executionErrorEvidence('failure access token=space-token ssh://user:other-secret@private-host/path');
  assert(!other.includes('space-token')); assert(!other.includes('other-secret')); assert(!other.includes('private-host'));
  const long = executionErrorEvidence(new Error('failure ' + 'x'.repeat(580) + ' password=' + 'z'.repeat(2000)));
  assert(!long.includes('zz')); assert(JSON.parse(long).message.length <= 600);
});

test('network evidence and typed Feishu errors remain strict even when execution evidence is requested', () => {
  const network = new TypeError('secret-message https://private.invalid', { cause: Object.assign(new Error('private socket'), { code: 'ECONNRESET' }) });
  assert(!errorEvidence(network).includes('secret-message')); assert(!errorEvidence(network).includes('private socket'));
  const typed = new FeishuRequestError('private-token', deliveryDiagnostic('request', 'POST', '/im/v1/messages?secret=private', network, { httpStatus: 503, requestId: 'trace-id' }));
  const strict = executionErrorEvidence(typed); assert.equal(strict, errorEvidence(typed)); assert.match(strict, /ECONNRESET/); assert(!strict.includes('private'));
});

test('execution evidence caps cyclic and deep cause chains and ignores arbitrary object payloads', () => {
  const cyclic: { message: string; cause?: unknown; request?: unknown } = { message: 'original failure', request: { token: 'must-not-copy' } }; cyclic.cause = cyclic;
  assert.equal(JSON.parse(executionErrorEvidence(cyclic)).message, 'original failure'); assert(!executionErrorEvidence(cyclic).includes('must-not-copy'));
  let deep: Error = new Error('last'); for (let index = 0; index < 20; index++) deep = new Error('layer ' + index, { cause: deep });
  const evidence = JSON.parse(executionErrorEvidence(deep)); assert.equal(evidence.cause.length, 4);
});
