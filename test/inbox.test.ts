import assert from 'node:assert/strict';
import test from 'node:test';
import { OrderedInbox } from '../src/inbox.js';

interface Message { user: string; text: string }
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('同用户的慢图片、new chat 和后续文字按收件顺序处理', async () => {
  const started = gate();
  const download = gate();
  const events: string[] = [];
  const inbox = new OrderedInbox<Message>(message => message.user, async message => {
    events.push(`start:${message.text}`);
    if (message.text === 'image') { started.release(); await download.promise; }
    events.push(`end:${message.text}`);
  });
  const first = inbox.handle({ user: 'one', text: 'image' });
  const second = inbox.handle({ user: 'one', text: 'new chat' });
  const third = inbox.handle({ user: 'one', text: 'follow-up' });
  await started.promise;
  assert.deepEqual(events, ['start:image']);
  download.release();
  await Promise.all([first, second, third]);
  assert.deepEqual(events, [
    'start:image', 'end:image', 'start:new chat', 'end:new chat', 'start:follow-up', 'end:follow-up',
  ]);
});

test('不同用户可并行，不会被另一用户图片下载阻塞', async () => {
  const started = gate();
  const download = gate();
  const events: string[] = [];
  const inbox = new OrderedInbox<Message>(message => message.user, async message => {
    events.push(`start:${message.user}`);
    if (message.user === 'slow') { started.release(); await download.promise; }
    events.push(`end:${message.user}`);
  });
  const slow = inbox.handle({ user: 'slow', text: 'image' });
  await started.promise;
  await inbox.handle({ user: 'fast', text: 'text' });
  assert.deepEqual(events, ['start:slow', 'start:fast', 'end:fast']);
  download.release();
  await slow;
  assert.equal(events.at(-1), 'end:slow');
});

test('失败返回给调用者，但不阻断同用户后续消息或复用已完成队列', async () => {
  const events: string[] = [];
  const inbox = new OrderedInbox<Message>(message => message.user, async message => {
    events.push(message.text);
    if (message.text === 'bad image') throw new Error('invalid image');
  });
  const failed = inbox.handle({ user: 'one', text: 'bad image' });
  const later = inbox.handle({ user: 'one', text: 'later text' });
  await assert.rejects(failed, /invalid image/);
  await later;
  await inbox.handle({ user: 'one', text: 'next batch' });
  assert.deepEqual(events, ['bad image', 'later text', 'next batch']);
});
