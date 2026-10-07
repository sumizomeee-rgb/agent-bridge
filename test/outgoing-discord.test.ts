import assert from 'node:assert/strict';
import type { File } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { FormData, Headers, ProxyAgent, Request, Response, type Dispatcher } from 'undici';
import { DiscordTransport } from '../src/discord.js';
import type { BridgeConfig, OutgoingFile, OutgoingImage } from '../src/types.js';

const mib = 1024 * 1024;
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function png(size = 16): Uint8Array {
  const bytes = new Uint8Array(size); bytes.set(pngHeader); return bytes;
}
function image(changes: Partial<OutgoingImage> = {}): OutgoingImage {
  return { filename: 'screenshot.png', contentType: 'image/png', data: png(), ...changes };
}

function file(changes: Partial<OutgoingFile> = {}): OutgoingFile {
  return { filename: 'report.pdf', contentType: 'application/pdf', data: new Uint8Array(Buffer.from('%PDF-1.7\nreport')), ...changes };
}
interface SentFile { field: string; filename: string; contentType: string; size: number; header: Uint8Array }
interface Sent {
  payload: Record<string, unknown>;
  files: SentFile[];
  headers: Headers;
  form?: FormData;
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}
type Handler = (sent: Sent, index: number) => Promise<Response> | Response;
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition not reached before deadline');
    await delay(5);
  }
}
function fixture(t: TestContext, configChanges: Partial<BridgeConfig> = {}) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const config: BridgeConfig = {
    token: 'fake-outgoing-token', allowedUserIds: ['111'], defaultAgent: 'codex',
    workspace: 'unused-test-workspace', proxyUrl: null,
    commands: { codex: { command: 'unused', args: [] }, claude: { command: 'unused', args: [] } },
    dataDir: 'unused', attachmentsDir: 'unused', logsDir: 'unused', maxImageBytes: 10 * mib,
    ...configChanges,
  };
  let handler: Handler | undefined;
  const transport = new DiscordTransport(config, async () => {}, {
    restBaseUrl: 'https://outgoing.test.invalid/api', logger: message => logs.push(message),
    fetch: async (input, options) => {
      assert.equal(String(input), 'https://outgoing.test.invalid/api/channels/222/messages',
        'Isolated tests must never call a real Discord endpoint');
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      const headers = new Headers(options?.headers as Record<string, string>);
      const files: SentFile[] = [];
      let payload: Record<string, unknown>;
      let form: FormData | undefined;
      if (options?.body instanceof FormData) {
        form = options.body;
        assert.equal(headers.has('content-type'), false, 'Fetch must supply the multipart boundary');
        const raw = form.get('payload_json');
        assert.equal(typeof raw, 'string');
        payload = JSON.parse(raw as string) as Record<string, unknown>;
        for (const [field, value] of form.entries()) {
          if (field === 'payload_json') continue;
          assert.notEqual(typeof value, 'string');
          const file = value as File;
          files.push({ field, filename: file.name, contentType: file.type, size: file.size,
            header: new Uint8Array(await file.slice(0, 16).arrayBuffer()) });
        }
      } else {
        assert.equal(headers.get('content-type'), 'application/json');
        payload = JSON.parse(String(options?.body)) as Record<string, unknown>;
      }
      const request: Sent = { payload, files, headers, form, dispatcher: options?.dispatcher, signal: options?.signal ?? undefined };
      sent.push(request);
      return handler ? handler(request, sent.length - 1) : new Response('{"id":"555"}', { status: 200 });
    },
  });
  t.after(() => transport.close());
  return { transport, sent, logs, config, set handler(value: Handler) { handler = value; } };
}

test('a short final reply and screenshot share one valid multipart message', async t => {
  const f = fixture(t);
  const header = '[Codex · confirmed-model · medium · …abcdef]';
  const content = `${header}\n\n截图如下。`;
  await f.transport.sendText('222', content, { repeatHeader: header, images: [image({
    filename: '工位截图.png', description: '用于检查窗口内容',
  })] });
  assert.equal(f.sent.length, 1);
  const sent = f.sent[0]!;
  assert.equal(sent.payload.content, content);
  assert.deepEqual(sent.payload.attachments, [{ id: 0, filename: '工位截图.png', description: '用于检查窗口内容' }]);
  assert.deepEqual(sent.payload.allowed_mentions, { parse: [] });
  assert.equal(sent.payload.enforce_nonce, true);
  assert.equal((sent.payload.nonce as string).length, 24);
  assert.deepEqual(sent.files, [{ field: 'files[0]', filename: '工位截图.png', contentType: 'image/png', size: 16, header: png() }]);
  assert.equal(sent.headers.get('authorization'), 'Bot fake-outgoing-token');
  // Serialize through the same Undici request implementation to verify boundary and binary parts.
  const wire = new Request('https://outgoing.test.invalid/api', { method: 'POST', headers: sent.headers, body: sent.form });
  assert.match(wire.headers.get('content-type')!, /^multipart\/form-data; boundary=/);
  const decoded = await wire.formData();
  assert.deepEqual(JSON.parse(decoded.get('payload_json') as string), sent.payload);
  const file = decoded.get('files[0]') as File;
  assert.equal(file.name, '工位截图.png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png());
  assert(!JSON.stringify(sent.payload).includes(f.config.token));
  assert.deepEqual(f.logs, []);
});

test('JPG, PNG, WebP and GIF output supports declared types and bounded byte views', async t => {
  const f = fixture(t);
  const backing = new Uint8Array(100); backing.set(png(), 40);
  const images: OutgoingImage[] = [
    image({ data: backing.subarray(40, 56) }),
    image({ filename: 'photo.JPEG', contentType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) }),
    image({ filename: 'image.webp', contentType: 'image/webp', data: new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])) }),
    image({ filename: 'animation.gif', contentType: 'image/gif', data: new Uint8Array(Buffer.from('GIF89a')) }),
  ];
  await f.transport.sendText('222', '四种图片', { images });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0]!.files.map(file => file.field), ['files[0]', 'files[1]', 'files[2]', 'files[3]']);
  assert.deepEqual(f.sent[0]!.files.map(file => file.contentType), images.map(file => file.contentType));
  assert.deepEqual(f.sent[0]!.files[0]!.header, png());
});

test('image-only output works with and without a confirmed reply header', async t => {
  const f = fixture(t);
  const header = '[Claude Code · model · 强度未知 · …123456]';
  await f.transport.sendText('222', '', { images: [image()] });
  await f.transport.sendText('222', '', { repeatHeader: header, images: [image()] });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]!.payload.content, '图片 1/1');
  assert.equal(f.sent[1]!.payload.content, `${header}\n\n图片 1/1`);
  assert(f.sent.every(message => message.files.length === 1));
});

test('text-only behavior remains JSON and empty text without images sends nothing', async t => {
  const f = fixture(t);
  await f.transport.sendText('222', '原有文字');
  await f.transport.sendText('222', '', { images: [] });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.payload.content, '原有文字');
  assert.equal(f.sent[0]!.form, undefined);
  assert.equal(f.sent[0]!.payload.attachments, undefined);
});

test('long text repeats the header, preserves emoji and uploads each picture once before the next reply', async t => {
  const f = fixture(t);
  const header = '[Codex · model · high · …abcdef ✅]';
  const prefix = `${header}\n\n`;
  const body = 'a'.repeat(1999 - prefix.length) + '😀' + 'b'.repeat(2100);
  await Promise.all([
    f.transport.sendText('222', `${prefix}${body}`, { repeatHeader: header, images: [image()] }),
    f.transport.sendText('222', 'after'),
  ]);
  const reply = f.sent.slice(0, -1);
  assert(reply.length > 1);
  assert.equal(reply.map(message => (message.payload.content as string).slice(prefix.length)).join(''), body);
  assert.equal(reply.reduce((sum, message) => sum + message.files.length, 0), 1);
  assert.equal(reply[0]!.files.length, 1);
  assert.equal(f.sent.at(-1)!.payload.content, 'after');
  for (const message of reply) {
    const content = message.payload.content as string;
    assert(content.startsWith(prefix));
    assert(content.length <= 2000);
    assert(!/[\ud800-\udbff]$/.test(content));
    assert(!/^[\udc00-\udfff]/.test(content.slice(prefix.length)));
  }
});

test('24 MiB picture batches attach to successive text chunks without repeating files', async t => {
  const f = fixture(t);
  const large = png(8 * mib);
  const images = [1, 2, 3].map(n => image({ filename: `screen${n}.png`, data: large }));
  images.push(image({ filename: 'small.png' }));
  await f.transport.sendText('222', 'x'.repeat(2001), { images });
  assert.equal(f.sent.length, 2);
  assert.equal((f.sent[0]!.payload.content as string).length, 2000);
  assert.equal(f.sent[1]!.payload.content, 'x');
  assert.deepEqual(f.sent.map(message => message.files.length), [3, 1]);
  assert.deepEqual(f.sent[1]!.payload.attachments, [{ id: 0, filename: 'small.png' }]);
  for (const message of f.sent) {
    assert(message.files.reduce((sum, file) => sum + file.size, 0) <= 24 * mib);
    assert(Buffer.byteLength(JSON.stringify(message.payload)) < 1024 * 1024, 'Multipart metadata has ample reserved space');
  }
});

test('picture batches after a short body keep the same header and get a compact batch caption', async t => {
  const f = fixture(t);
  const large = png(9 * mib);
  const header = '[Codex · model · medium · …abcdef]';
  const images = [1, 2, 3].map(n => image({ filename: `screen${n}.png`, data: large }));
  await f.transport.sendText('222', `${header}\n\n完成。`, { repeatHeader: header, images });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]!.payload.content, `${header}\n\n完成。`);
  assert.equal(f.sent[1]!.payload.content, `${header}\n\n图片 2/2`);
  assert.deepEqual(f.sent.map(message => message.files.length), [2, 1]);
});

test('a 429 rebuilds only the rejected multipart batch with the same nonce and immutable image bytes', async t => {
  const f = fixture(t);
  const large = png(9 * mib);
  const images = [1, 2, 3].map(n => image({ filename: `screen${n}.png`, data: large }));
  f.handler = (_sent, index) => {
    if (index === 0) large.fill(0);
    return index === 1 ? new Response('{"retry_after":0.005,"global":true}', { status: 429 })
      : new Response('{"id":"555"}', { status: 200 });
  };
  await f.transport.sendText('222', '图片如下', { images });
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent.map(message => message.files.map(file => file.filename)), [
    ['screen1.png', 'screen2.png'], ['screen3.png'], ['screen3.png'],
  ]);
  assert.equal(f.sent[1]!.payload.nonce, f.sent[2]!.payload.nonce);
  assert.notEqual(f.sent[0]!.payload.nonce, f.sent[1]!.payload.nonce);
  assert.notEqual(f.sent[1]!.form, f.sent[2]!.form);
  assert.deepEqual(f.sent[1]!.payload, f.sent[2]!.payload);
  assert.deepEqual(f.sent[1]!.files, f.sent[2]!.files);
  assert(f.sent.every(message => message.files.every(file => Buffer.from(file.header).subarray(0, 8).equals(pngHeader))));
});

test('failure after a successful multipart batch does not replay it and the channel queue continues', async t => {
  const f = fixture(t);
  const large = png(9 * mib);
  f.handler = (_sent, index) => new Response('{"id":"555"}', { status: index === 1 ? 403 : 200 });
  await assert.rejects(f.transport.sendText('222', '图片如下', { images: [1, 2, 3].map(n => image({
    filename: `screen${n}.png`, data: large,
  })) }), /HTTP 403/);
  assert.equal(f.sent.length, 2);
  await f.transport.sendText('222', 'next');
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2]!.payload.content, 'next');
  assert.deepEqual(f.sent.slice(0, 2).map(message => message.files.length), [2, 1]);
});

test('invalid image metadata and signatures reject before any network request', async t => {
  const f = fixture(t);
  const invalid: OutgoingImage[] = [
    ...['../screen.png', '..\\screen.png', 'C:\\screen.png', '/screen.png', ' screen.png', 'screen.png ',
      'screen.png.', 'screen\n.png', 'screen\0.png', 'screen".png', '', '.', '..'].map(filename => image({ filename })),
    image({ data: new Uint8Array() }), image({ data: new Uint8Array(16) }),
    image({ contentType: 'image/jpeg' }), image({ filename: 'screen.gif' }),
    image({ contentType: 'text/plain' as OutgoingImage['contentType'] }),
    image({ description: 'x'.repeat(1025) }), image({ description: 'unsafe\0description' }),
    image({ data: 'not bytes' as unknown as Uint8Array }),
  ];
  for (const picture of invalid) await assert.rejects(f.transport.sendText('222', 'must not send', { images: [picture] }));
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.logs, []);
});

test('all images are validated before sending the first text or valid image', async t => {
  const f = fixture(t);
  await assert.rejects(f.transport.sendText('222', 'x'.repeat(5000), { images: [image(), image({
    filename: 'broken.png', data: new Uint8Array(16),
  })] }), /图片格式/);
  assert.equal(f.sent.length, 0);
});

test('configured size and hard 10 MiB/count caps reject oversized output before sending', async t => {
  const f = fixture(t, { maxImageBytes: 32 });
  await assert.rejects(f.transport.sendText('222', 'x', { images: [image({ data: png(33) })] }), /大小/);
  await assert.rejects(f.transport.sendText('222', 'x', { images: Array.from({ length: 11 }, () => image()) }), /10 张/);
  const generous = fixture(t, { maxImageBytes: 100 * mib });
  await assert.rejects(generous.transport.sendText('222', 'x', { images: [image({ data: png(10 * mib + 1) })] }), /大小/);
  assert.equal(f.sent.length, 0); assert.equal(generous.sent.length, 0);
});

test('the exact 10 MiB boundary and ten small images are accepted', async t => {
  const f = fixture(t, { maxImageBytes: 100 * mib });
  await f.transport.sendText('222', 'boundary', { images: [image({ data: png(10 * mib) })] });
  await f.transport.sendText('222', 'ten', { images: Array.from({ length: 10 }, (_, n) => image({ filename: `screen${n}.png` })) });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]!.files[0]!.size, 10 * mib);
  assert.equal(f.sent[1]!.files.length, 10);
});

test('an ambiguous upload network failure is not automatically retried or logged with credentials', async t => {
  const f = fixture(t);
  f.handler = () => { throw new Error('isolated upload connection failed'); };
  await assert.rejects(f.transport.sendText('222', 'image', { images: [image()] }), /isolated upload connection failed/);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.logs, []);
});

test('multipart uploads use the explicit REST proxy and closing rejects subsequent image sends', async t => {
  const f = fixture(t, { proxyUrl: 'http://127.0.0.1:7898' });
  await f.transport.sendText('222', 'proxy image', { images: [image()] });
  assert(f.sent[0]!.dispatcher instanceof ProxyAgent);
  assert(f.sent[0]!.signal instanceof AbortSignal);
  await f.transport.close();
  await assert.rejects(f.transport.sendText('222', '', { images: [image()] }), /已关闭/);
  assert.equal(f.sent.length, 1);
});

test('image-only batch captions respect the text limit even with a long explicit header', async t => {
  const f = fixture(t);
  const header = 'h'.repeat(1995);
  await f.transport.sendText('222', '', { repeatHeader: header, images: [image()] });
  const content = f.sent[0]!.payload.content as string;
  assert(content.startsWith(`${header}\n\n`));
  assert(content.length <= 2000);
});

test('cancelling a queued picture reply returns promptly without sending it or losing channel order', async t => {
  const f = fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.handler = async (_sent, index) => {
    if (index === 0) await blocked;
    return new Response('{"id":"555"}', { status: 200 });
  };
  const first = f.transport.sendText('222', 'first upload', { images: [image()] });
  await eventually(() => f.sent.length === 1);
  const controller = new AbortController();
  const cancelled = f.transport.sendText('222', 'cancelled picture', { images: [image()], signal: controller.signal });
  const rejection = assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
  controller.abort();
  await rejection;
  // Even after the cancelled caller returns, a later reply must wait for the first upload.
  const after = f.transport.sendText('222', 'after');
  await delay(30);
  assert.equal(f.sent.length, 1);
  release();
  await Promise.all([first, after]);
  assert.deepEqual(f.sent.map(message => message.payload.content), ['first upload', 'after']);
});

test('cancelling during the second picture batch 429 wait prevents its retry and every remaining batch', async t => {
  const f = fixture(t);
  const large = png(9 * mib);
  const controller = new AbortController();
  f.handler = (_sent, index) => index === 1
    ? new Response('{"retry_after":0.12,"global":false}', { status: 429 })
    : new Response('{"id":"555"}', { status: 200 });
  const reply = f.transport.sendText('222', 'six pictures', { signal: controller.signal,
    images: Array.from({ length: 6 }, (_, n) => image({ filename: `screen${n}.png`, data: large })),
  });
  const rejection = assert.rejects(reply, error => error instanceof Error && error.name === 'AbortError');
  await eventually(() => f.sent.length === 2);
  await delay(20); // The response has been parsed and the channel is in its retry wait.
  controller.abort();
  await rejection;
  await delay(160);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(message => message.files.map(file => file.filename)), [
    ['screen0.png', 'screen1.png'], ['screen2.png', 'screen3.png'],
  ]);
  await f.transport.sendText('222', 'next');
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2]!.payload.content, 'next');
});

test('cancelling an active multipart upload reaches its HTTP signal and no further segment is sent', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  let uploadAborted = false;
  f.handler = sent => new Promise<Response>((_resolve, reject) => {
    assert(sent.signal);
    const abort = () => { uploadAborted = true; reject(sent.signal!.reason); };
    sent.signal.addEventListener('abort', abort, { once: true });
    if (sent.signal.aborted) abort();
  });
  const reply = f.transport.sendText('222', 'x'.repeat(2001), { images: [image()], signal: controller.signal });
  const rejection = assert.rejects(reply, error => error instanceof Error && error.name === 'AbortError');
  await eventually(() => f.sent.length === 1);
  controller.abort();
  await rejection;
  await eventually(() => uploadAborted);
  await delay(20);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.signal!.aborted, true);
});

test('PDF and ZIP files share one multipart reply with accurate MIME and binary payloads', async t => {
  const f = fixture(t);
  const files = [file({ description: '导出的报告' }), file({ filename: 'source.zip', contentType: 'application/zip',
    data: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80]),
  })];
  await f.transport.sendText('222', '文件如下。', { files });
  assert.equal(f.sent.length, 1);
  const sent = f.sent[0]!;
  assert.equal(sent.payload.content, '文件如下。');
  assert.deepEqual(sent.payload.attachments, [{ id: 0, filename: 'report.pdf', description: '导出的报告' },
    { id: 1, filename: 'source.zip' }]);
  assert.deepEqual(sent.files.map(attachment => attachment.contentType), ['application/pdf', 'application/zip']);
  const wire = new Request('https://outgoing.test.invalid/api', { method: 'POST', headers: sent.headers, body: sent.form });
  const decoded = await wire.formData();
  for (const [index, attachment] of files.entries()) {
    const actual = decoded.get(`files[${index}]`) as File;
    assert.equal(actual.name, attachment.filename);
    assert.equal(actual.type, attachment.contentType);
    assert.deepEqual(new Uint8Array(await actual.arrayBuffer()), attachment.data);
  }
  assert.deepEqual(sent.payload.allowed_mentions, { parse: [] });
  assert(!JSON.stringify(sent.payload).includes(f.config.token));
});

test('ordinary files accept empty bytes and do not require an image or document signature', async t => {
  const f = fixture(t);
  const header = '[Codex · model · medium · …abcdef]';
  await f.transport.sendText('222', '', { repeatHeader: header, files: [
    file({ filename: 'empty.txt', contentType: 'text/plain', data: new Uint8Array() }),
    file({ filename: 'output.bin', contentType: 'application/octet-stream', data: new Uint8Array([0, 255, 7]) }),
    file({ data: new Uint8Array([1, 2, 3]) }),
  ] });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.payload.content, `${header}\n\n附件 1/1`);
  assert.deepEqual(f.sent[0]!.files.map(attachment => attachment.size), [0, 3, 3]);
  assert.deepEqual(f.sent[0]!.files.map(attachment => attachment.contentType),
    ['text/plain', 'application/octet-stream', 'application/pdf']);
});

test('mixed pictures and files share 24 MiB batches and later captions keep the header', async t => {
  const f = fixture(t);
  const header = '[Codex · model · high · …abcdef]';
  await f.transport.sendText('222', `${header}\n\n完成。`, { repeatHeader: header,
    images: [image({ data: png(8 * mib) })],
    files: [file({ data: new Uint8Array(16 * mib) }), file({ filename: 'more.zip', contentType: 'application/zip' })],
  });
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map(message => message.files.map(attachment => attachment.filename)),
    [['screenshot.png', 'report.pdf'], ['more.zip']]);
  assert.equal(f.sent[0]!.payload.content, `${header}\n\n完成。`);
  assert.equal(f.sent[1]!.payload.content, `${header}\n\n附件 2/2`);
  assert.deepEqual(f.sent[1]!.payload.attachments, [{ id: 0, filename: 'more.zip' }]);
  for (const message of f.sent) assert(message.files.reduce((total, attachment) => total + attachment.size, 0) <= 24 * mib);
});

test('invalid file names, MIME, data and descriptions reject the whole logical reply before HTTP', async t => {
  const f = fixture(t);
  const invalid: OutgoingFile[] = [
    ...['../report.pdf', '..\report.pdf', 'C:\report.pdf', '/report.pdf', ' report.pdf', 'report.pdf ',
      'report.pdf.', 'report\n.pdf', 'report\0.pdf', 'report".pdf', '', '.', '..', 'CON.pdf', 'lpt1.zip',
      'x'.repeat(201)].map(filename => file({ filename })),
    ...['', 'pdf', 'application/pdf\r\nInjected: yes', 'application/pdf; charset=utf-8', ' application/pdf',
      'application/*', 'application/' + 'x'.repeat(250)].map(contentType => file({ contentType })),
    file({ data: 'not bytes' as unknown as Uint8Array }),
    file({ contentType: 4 as unknown as string }),
    file({ description: 'x'.repeat(1025) }), file({ description: 'unsafe\0description' }),
  ];
  for (const attachment of invalid) {
    await assert.rejects(f.transport.sendText('222', 'x'.repeat(5000), { images: [image()], files: [file(), attachment] }));
  }
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.logs, []);
});

test('file size defaults to 20 MiB, configured limits apply and 24 MiB is the hard cap', async t => {
  const f = fixture(t);
  await f.transport.sendText('222', 'default boundary', { files: [file({ data: new Uint8Array(20 * mib) })] });
  await assert.rejects(f.transport.sendText('222', 'oversize', { files: [file({ data: new Uint8Array(20 * mib + 1) })] }), /大小/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.files[0]!.size, 20 * mib);
  const strict = fixture(t, { maxFileBytes: 32 });
  await assert.rejects(strict.transport.sendText('222', 'oversize', { files: [file({ data: new Uint8Array(33) })] }), /大小/);
  assert.equal(strict.sent.length, 0);
  const generous = fixture(t, { maxFileBytes: 100 * mib });
  await generous.transport.sendText('222', 'hard boundary', { files: [file({ data: new Uint8Array(24 * mib) })] });
  await assert.rejects(generous.transport.sendText('222', 'oversize', { files: [file({ data: new Uint8Array(24 * mib + 1) })] }), /大小/);
  assert.equal(generous.sent.length, 1);
  assert.equal(generous.sent[0]!.files[0]!.size, 24 * mib);
  for (const maxFileBytes of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => fixture(t, { maxFileBytes }), /maxFileBytes/);
});

test('attachment count and 100 MiB total include both images and ordinary files before sending', async t => {
  const f = fixture(t, { maxFileBytes: 24 * mib });
  await assert.rejects(f.transport.sendText('222', 'too many', {
    images: Array.from({ length: 6 }, () => image()), files: Array.from({ length: 5 }, () => file()),
  }), /10 个附件/);
  const large = new Uint8Array(21 * mib);
  await assert.rejects(f.transport.sendText('222', 'too large', {
    files: Array.from({ length: 5 }, (_, n) => file({ filename: `part${n}.zip`, contentType: 'application/zip', data: large })),
  }), /100 MiB/);
  assert.equal(f.sent.length, 0);
  await f.transport.sendText('222', 'ten', {
    images: Array.from({ length: 5 }, (_, n) => image({ filename: `screen${n}.png` })),
    files: Array.from({ length: 5 }, (_, n) => file({ filename: `part${n}.pdf` })),
  });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.files.length, 10);
});

test('queued ordinary files snapshot the exact byte view and mutable metadata before waiting', async t => {
  const f = fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.handler = async (_sent, index) => {
    if (index === 0) await blocked;
    return new Response('{"id":"555"}', { status: 200 });
  };
  const first = f.transport.sendText('222', 'first');
  await eventually(() => f.sent.length === 1);
  const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9]);
  const attachment = file({ data: backing.subarray(2, 6), description: 'original description' });
  const queued = f.transport.sendText('222', 'queued', { files: [attachment] });
  backing.fill(0); attachment.filename = 'changed.zip'; attachment.contentType = 'application/zip';
  attachment.description = 'changed description'; attachment.data = new Uint8Array([7]);
  release();
  await Promise.all([first, queued]);
  const sent = f.sent[1]!;
  assert.deepEqual(sent.payload.attachments, [{ id: 0, filename: 'report.pdf', description: 'original description' }]);
  assert.equal(sent.files[0]!.contentType, 'application/pdf');
  assert.deepEqual(sent.files[0]!.header, new Uint8Array([1, 2, 3, 4]));
  assert.equal(sent.files[0]!.size, 4);
});

test('ordinary file 429 retries only its batch with the same nonce, rebuilt form and immutable bytes', async t => {
  const f = fixture(t);
  const bytes = new Uint8Array(13 * mib); bytes.set([1, 2, 3, 4]);
  f.handler = (_sent, index) => {
    if (index === 0) bytes.fill(0);
    return index === 1 ? new Response('{"retry_after":0.005,"global":false}', { status: 429 })
      : new Response('{"id":"555"}', { status: 200 });
  };
  await f.transport.sendText('222', 'three files', { files: [1, 2, 3].map(n => file({ filename: `part${n}.pdf`, data: bytes })) });
  assert.deepEqual(f.sent.map(message => message.files.map(attachment => attachment.filename)),
    [['part1.pdf'], ['part2.pdf'], ['part2.pdf'], ['part3.pdf']]);
  assert.equal(f.sent[1]!.payload.nonce, f.sent[2]!.payload.nonce);
  assert.notEqual(f.sent[0]!.payload.nonce, f.sent[1]!.payload.nonce);
  assert.notEqual(f.sent[1]!.form, f.sent[2]!.form);
  assert.deepEqual(f.sent[1]!.payload, f.sent[2]!.payload);
  assert.deepEqual(f.sent[1]!.files, f.sent[2]!.files);
  assert(f.sent.every(message => Buffer.from(message.files[0]!.header).subarray(0, 4).equals(Buffer.from([1, 2, 3, 4]))));
});

test('cancelling queued file-only output prevents every attachment and preserves later channel order', async t => {
  const f = fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.handler = async (_sent, index) => {
    if (index === 0) await blocked;
    return new Response('{"id":"555"}', { status: 200 });
  };
  const first = f.transport.sendText('222', 'first');
  await eventually(() => f.sent.length === 1);
  const controller = new AbortController();
  const cancelled = f.transport.sendText('222', '', { files: [file()], signal: controller.signal });
  const rejection = assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
  controller.abort(); await rejection;
  const after = f.transport.sendText('222', 'after');
  await delay(20); assert.equal(f.sent.length, 1);
  release(); await Promise.all([first, after]);
  assert.deepEqual(f.sent.map(message => message.payload.content), ['first', 'after']);
});
