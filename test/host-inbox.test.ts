import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { HostInbox } from '../src/host-inbox.js';
import type { IncomingDM } from '../src/types.js';

const message = (id: string, text = id): IncomingDM => ({
  id: `feishu:app:${id}`, userId: 'feishu:app:owner', channelId: 'feishu:app:group', text,
  attachments: [{ id: 'image', filename: 'shot.png', url: 'feishu://resource', size: 10,
    content_type: 'image/png', messageId: 'raw-message', resourceKey: 'app-specific-resource' }],
  space: { kind: 'group', spaceId: 'app-specific-group', mentionedUserIds: ['app-bot'], replyToMessageId: 'reply-id' },
});
function fixture(t: TestContext): { path: string; open: () => HostInbox } {
  const path = mkdtempSync(join(tmpdir(), 'bridge-host-inbox-test-')); const opened: HostInbox[] = [];
  t.after(() => {
    for (const inbox of opened) { try { inbox.close(); } catch { /* Deliberately reopened instances are already closed. */ } }
    assert.equal(dirname(resolve(path)), resolve(tmpdir())); assert(basename(path).startsWith('bridge-host-inbox-test-'));
    rmSync(path, { recursive: true, force: true });
  });
  return { path, open: () => { const inbox = new HostInbox(path); opened.push(inbox); return inbox; } };
}

test('host inbox preserves source metadata and deduplicates one canonical receipt without persisting interaction credentials', t => {
  const f = fixture(t); const inbox = f.open();
  const original = { ...message('one', '/new'), interaction: { id: 'interaction-one', token: 'DO-NOT-PERSIST-THIS-TOKEN', applicationId: 'app' } };
  assert.equal(inbox.capture('canonical-receipt', 'feishu:app', original, true), true);
  assert.equal(inbox.capture('canonical-receipt', 'feishu:other-app', { ...message('echo'), text: 'duplicate app observation' }, true), false);
  const saved = inbox.get('canonical-receipt')!;
  assert.equal(saved.botId, 'feishu:app'); assert.equal(saved.message.text, '/new');
  assert.equal(saved.message.interaction, undefined);
  assert.deepEqual(saved.message.attachments, original.attachments);
  assert.deepEqual(saved.message.space, original.space);
  inbox.close();
  const bytes = readFileSync(join(f.path, 'host-inbox.sqlite'));
  assert.equal(bytes.includes(Buffer.from('DO-NOT-PERSIST-THIS-TOKEN')), false);
});

test('host inbox reopens ordinary processing as pending and control processing as uncertain, retaining terminal receipts', t => {
  const f = fixture(t); const first = f.open();
  for (const [id, control] of [['ordinary', false], ['command', true], ['accepted', false], ['failed', true]] as const) {
    first.capture(id, 'feishu:app', message(id, control ? '/new' : id), control);
  }
  first.setState('ordinary', 'processing'); first.setState('command', 'processing');
  first.setState('accepted', 'accepted'); first.setState('failed', 'failed', 'failure evidence');
  first.close(); const next = f.open();
  assert.deepEqual(next.pending().map(input => input.id), ['ordinary']);
  assert.deepEqual(next.uncertain().map(input => input.id), ['command']);
  assert.equal(next.get('accepted')?.state, 'accepted'); assert.equal(next.get('failed')?.state, 'failed');
  assert.equal(next.capture('command', 'feishu:app', message('command', '/new'), true), false);
});

test('pending order and history cursors survive reopen, independently by Bot and canonical Space', t => {
  const f = fixture(t); const first = f.open();
  first.capture('received-first', 'feishu:app-a', message('first'), false);
  first.capture('received-second', 'feishu:app-b', message('second'), false);
  first.capture('received-third', 'feishu:app-a', message('third'), false);
  first.saveCursor('feishu:app-a', 'group-1', 'first-cursor');
  first.saveCursor('feishu:app-a', 'group-2', 'second-cursor');
  first.saveCursor('feishu:app-b', 'group-1', 'other-bot-cursor'); first.close();
  const next = f.open();
  assert.deepEqual(next.pending().map(input => input.id), ['received-first', 'received-second', 'received-third']);
  assert.equal(next.cursor('feishu:app-a', 'group-1'), 'first-cursor');
  assert.equal(next.cursor('feishu:app-a', 'group-2'), 'second-cursor');
  assert.equal(next.cursor('feishu:app-b', 'group-1'), 'other-bot-cursor');
});

test('receipt snapshots freeze target generations and binding epoch; valid platform cursors never regress', t => {
  const f = fixture(t); const first = f.open();
  const generations = { 'feishu:cli_a': 3 };
  first.capture('snapshot', 'feishu:cli_a', message('snapshot'), false, generations, 7);
  generations['feishu:cli_a'] = 99;
  const newer = 'feishu:cli_a|1792180000002|om_newer', older = 'feishu:cli_a|1792180000001|om_older';
  first.saveCursor('feishu:cli_a', 'group', newer); first.saveCursor('feishu:cli_a', 'group', older); first.close();
  const next = f.open();
  assert.deepEqual(next.get('snapshot')?.generations, { 'feishu:cli_a': 3 });
  assert.equal(next.get('snapshot')?.bindingEpoch, 7);
  assert.equal(next.cursor('feishu:cli_a', 'group'), newer);
});
