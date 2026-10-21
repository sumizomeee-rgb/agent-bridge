import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeishuTransport } from '../src/feishu.js';
import { FEISHU_RETRY_WINDOW_MS, FeishuOutbox } from '../src/feishu-outbox.js';
import { errorEvidence } from '../src/delivery-errors.js';
import type { BridgeConfig } from '../src/types.js';

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-feishu-delivery-'));
  const transports: FeishuTransport[] = [];
  t.after(async () => { for (const transport of transports) await transport.close(); rmSync(root, { force: true, recursive: true }); });
  const config = { dataDir: root, applicationId: 'app_test', appSecret: 'private-secret', proxyUrl: null, maxImageBytes: 10 * 1024 * 1024 } as BridgeConfig;
  const make = (http: (...args: any[]) => any, logger?: (message: string) => void) => {
    const transport = new FeishuTransport(config, async () => {}, { fetch: http as any, logger }); transports.push(transport); return transport;
  };
  return { root, make };
}
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
const auth = () => new Response(JSON.stringify({ code: 0, tenant_access_token: 'private-token' }));
function networkFailure() { return new TypeError('fetch failed private-token https://user:private-secret@example.invalid/?secret=private-token', { cause: Object.assign(new Error('socket private-token'), { code: 'ECONNRESET' }) }); }

test('Feishu lost acknowledgement retries the identical persisted UUID and body, and retains the receipt', async t => {
  const { root, make } = setup(t), sent: string[] = [], accepted = new Map<string, string>();
  const bridge = make(async (url, options) => {
    if (String(url).includes('/auth/')) return auth();
    const body = String(options.body); sent.push(body); const uuid = JSON.parse(body).uuid;
    if (!accepted.has(uuid)) { accepted.set(uuid, 'om_delivered'); throw networkFailure(); }
    return ok({ message_id: accepted.get(uuid) });
  });
  await bridge.sendText('oc_chat', 'hello', { deliveryKey: 'publication-1' });
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); assert.equal(accepted.size, 1);
  const db = new DatabaseSync(join(root, 'feishu-outbox.sqlite'), { readOnly: true });
  try { const row = db.prepare('SELECT * FROM parts').get()!; assert.equal(row.state, 'delivered'); assert.equal(row.message_id, 'om_delivered'); assert.equal(row.attempts, 2); assert.equal(row.payload, sent[0]); }
  finally { db.close(); }
  await bridge.close();
  const restored = make(async () => { throw new Error('no network expected'); });
  await restored.sendText('oc_chat', 'hello', { deliveryKey: 'publication-1' });
  await assert.rejects(restored.sendText('oc_chat', 'changed', { deliveryKey: 'publication-1' }), /内容已变化/);
});

test('Feishu caps retries, preserves network cause without secrets, and never replays an uncertain batch', async t => {
  const { root, make } = setup(t); let sends = 0;
  const bridge = make(async url => { if (String(url).includes('/auth/')) return auth(); sends++; throw networkFailure(); });
  let failure: unknown;
  await assert.rejects(bridge.sendText('oc_chat', 'report', { deliveryKey: 'uncertain-1' }), error => { failure = error; return true; });
  assert.equal(sends, 2); const evidence = errorEvidence(failure);
  assert.match(evidence, /ECONNRESET/); assert.match(evidence, /"stage":"request"/); assert(!evidence.includes('private-')); assert(!evidence.includes('secret='));
  const db = new DatabaseSync(join(root, 'feishu-outbox.sqlite'), { readOnly: true });
  try { const batch = db.prepare('SELECT * FROM batches').get()!, part = db.prepare('SELECT * FROM parts').get()!;
    assert.equal(batch.state, 'uncertain'); assert.equal(part.state, 'uncertain'); assert.match(String(part.error), /ECONNRESET/); assert(!String(part.error).includes('private-')); }
  finally { db.close(); }
  await bridge.close();
  const restored = make(async () => { sends++; throw new Error('must not send'); });
  await assert.rejects(restored.sendText('oc_chat', 'report', { deliveryKey: 'uncertain-1' }), /旧投递尚未确认/); assert.equal(sends, 2);
});

test('Feishu keeps FIFO and assigns independent durable UUIDs to chunks and attachment messages', async t => {
  const { root, make } = setup(t), bodies: any[] = []; let uploads = 0;
  const bridge = make(async (url, options) => {
    if (String(url).includes('/auth/')) return auth();
    if (String(url).includes('/files')) { uploads++; return ok({ file_key: 'file_uploaded' }); }
    const body = JSON.parse(options.body); bodies.push(body); return ok({ message_id: 'om_' + bodies.length });
  });
  await Promise.all([
    bridge.sendText('oc_chat', 'a'.repeat(25000), { deliveryKey: 'multi', files: [{ filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('attachment-content') }] }),
    bridge.sendText('oc_chat', 'last', { deliveryKey: 'next' }),
  ]);
  assert.deepEqual(bodies.map(body => body.msg_type), ['text', 'text', 'file', 'text']); assert.equal(JSON.parse(bodies.at(-1).content).text, 'last');
  assert.equal(new Set(bodies.map(body => body.uuid)).size, 4); assert.equal(uploads, 1);
  const db = new DatabaseSync(join(root, 'feishu-outbox.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM parts').get()!.count, 4); assert(!JSON.stringify(db.prepare('SELECT * FROM parts').all()).includes('attachment-content')); }
  finally { db.close(); }
});

test('Feishu cancellation never retries and HTTP diagnostics omit bodies and query values', async t => {
  const { make } = setup(t), controller = new AbortController(); let sends = 0;
  const bridge = make(async url => { if (String(url).includes('/auth/')) return auth(); sends++; controller.abort(); throw networkFailure(); });
  await assert.rejects(bridge.sendText('oc_chat', 'cancel', { signal: controller.signal })); assert.equal(sends, 1);
  const failed = make(async url => String(url).includes('/auth/') ? auth() : new Response(JSON.stringify({ code: 230001, msg: 'private-secret' }), { status: 403, headers: { 'x-tt-logid': 'request-123' } }));
  await assert.rejects(failed.sendText('oc_chat', 'deny'), error => {
    const evidence = errorEvidence(error); assert.match(evidence, /230001/); assert.match(evidence, /request-123/); assert.match(evidence, /403/); assert(!evidence.includes('private-secret')); assert(!evidence.includes('receive_id_type')); return true;
  });
});

test('Feishu durable retry claims expire before the documented one hour deduplication window', t => {
  const root = mkdtempSync(join(tmpdir(), 'feishu-outbox-window-')), outbox = new FeishuOutbox(root);
  t.after(() => { outbox.close(); rmSync(root, { force: true, recursive: true }); });
  const batch = outbox.begin('oc_chat', 'old', 'fingerprint'), part = outbox.register(batch.id, 0, { content: 'report' });
  assert.equal(outbox.claim(part, 1000), true); assert.equal(outbox.claim(part, 1000 + FEISHU_RETRY_WINDOW_MS), false); assert.equal(part.attempts, 1);
  assert.throws(() => outbox.begin('oc_chat', 'old', 'fingerprint'), /旧投递尚未确认/);
});

test('Feishu partial attachment failure retains delivered prefix and restart never uploads or sends it again', async t => {
  const { root, make } = setup(t); let texts = 0, uploads = 0, fileSends = 0;
  const bridge = make(async (url, options) => {
    if (String(url).includes('/auth/')) return auth();
    if (String(url).includes('/files')) { uploads++; return ok({ file_key: 'file_partial' }); }
    if (JSON.parse(options.body).msg_type === 'text') { texts++; return ok({ message_id: 'om_prefix' }); }
    fileSends++; throw networkFailure();
  });
  const reply = { deliveryKey: 'partial', files: [{ filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('partial-file-content') }] };
  await assert.rejects(bridge.sendText('oc_chat', 'saved prefix', reply)); assert.equal(texts, 1); assert.equal(uploads, 1); assert.equal(fileSends, 2);
  const db = new DatabaseSync(join(root, 'feishu-outbox.sqlite'), { readOnly: true });
  try { const parts = db.prepare('SELECT * FROM parts ORDER BY part_index').all(); assert.equal(parts[0]!.message_id, 'om_prefix'); assert.equal(parts[0]!.state, 'delivered'); assert.equal(parts[1]!.state, 'uncertain'); }
  finally { db.close(); }
  await bridge.close(); const restored = make(async () => { throw new Error('must not upload or send'); });
  await assert.rejects(restored.sendText('oc_chat', 'saved prefix', reply), /旧投递尚未确认/);
});

test('Feishu cancellation during retry delay prevents a second send, and unknown cause labels are redacted', async t => {
  const { make } = setup(t), controller = new AbortController(); let sends = 0;
  const bridge = make(async url => {
    if (String(url).includes('/auth/')) return auth(); sends++; setTimeout(() => controller.abort(), 10); throw networkFailure();
  });
  await assert.rejects(bridge.sendText('oc_chat', 'stop', { signal: controller.signal })); assert.equal(sends, 1);
  const evidence = errorEvidence(Object.assign(new Error('private-secret'), { name: 'private-secret', code: 'private-secret', cause: { name: 'private-token', code: 'ECONNRESET', message: 'private-token' } }));
  assert(!evidence.includes('private-')); assert.match(evidence, /ECONNRESET/);
});
