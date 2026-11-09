import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiveIncomingFiles, incomingFileLimits } from '../src/incoming-files.js';
import { prepareIncomingMessage } from '../src/forwarded.js';
import { FeishuTransport } from '../src/feishu.js';
import { DiscordTransport } from '../src/discord.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-intake-'));
  const config: BridgeConfig = { token: 'test-token', appSecret: 'test-secret', applicationId: 'cli_test', allowedUserIds: ['u'],
    defaultAgent: 'codex', workspace: root, dataDir: root, logsDir: root, attachmentsDir: join(root, 'attachments'),
    proxyUrl: null, commands: { codex: { command: 'unused', args: [] }, claude: { command: 'unused', args: [] } }, maxImageBytes: 1024 };
  const message: IncomingDM = { id: '123', userId: 'u', channelId: 'c', text: '看这个文件', attachments: [
    { id: 'file_one', filename: '../../report.pdf', url: 'https://cdn.discordapp.com/attachments/123/456/report.pdf', size: 4, content_type: 'application/pdf' },
  ] };
  return { root, config, message, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

for (const platform of ['discord', 'feishu'] as const) test(platform + ' downloads a user file through the actual intake path and supplies metadata, not its body', async () => {
  const f = fixture(); let transport: FeishuTransport | DiscordTransport | undefined;
  try {
    const requests: { url: string; headers: unknown }[] = [];
    const http = (async (url: unknown, options: any) => {
      requests.push({ url: String(url), headers: options?.headers });
      if (String(url).includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'test-only-token', expire: 7200 }));
      return new Response('DATA');
    }) as any;
    if (platform === 'feishu') {
      Object.assign(f.message.attachments[0]!, { resourceKey: 'file_one', messageId: 'om_source' });
      transport = new FeishuTransport({ ...f.config, platform }, async () => {}, { fetch: http });
    } else transport = new DiscordTransport(f.config, async () => {}, { fetch: http });
    const content = await prepareIncomingMessage(transport, f.message);
    assert.equal(content.imagePaths.length, 0); assert.ok(content.text.startsWith('看这个文件'));
    assert.ok(content.text.includes('\n\n【本轮用户文件'));
    assert.ok(content.text.includes('../../report.pdf')); assert.ok(!content.text.includes('DATA')); assert.ok(!content.text.includes('https://'));
    const saved = readdirSync(f.config.attachmentsDir); assert.equal(saved.length, 1); assert.match(saved[0]!, /^[a-f0-9-]{36}\.pdf$/);
    assert.equal(readFileSync(join(f.config.attachmentsDir, saved[0]!), 'utf8'), 'DATA');
    if (platform === 'discord') assert.equal(requests[0]!.headers, undefined);
    else assert.ok(requests.some(r => r.url.includes('/resources/file_one?type=file')));
  } finally { await transport?.close(); f.cleanup(); }
});

test('actual streamed size and aggregate limits clean up partial and previously saved files', async () => {
  const f = fixture();
  try {
    f.config.incomingAttachmentLimits = { maxFileBytes: 5, maxTotalBytes: 8, maxAttachments: 10 };
    f.message.attachments.push({ ...f.message.attachments[0]!, id: 'two' });
    await assert.rejects(receiveIncomingFiles(f.config, f.message, [], async () => new Response('12345')), /超过/);
    assert.deepEqual(readdirSync(f.config.attachmentsDir), []);
    f.message.attachments.pop();
    await assert.rejects(receiveIncomingFiles(f.config, f.message, [], async () => new Response('123456')), /实际大小/);
    assert.deepEqual(readdirSync(f.config.attachmentsDir), []);
    f.message.attachments[0]!.size = 6;
    await assert.rejects(receiveIncomingFiles(f.config, f.message, [], async () => { assert.fail('oversize declarations must not download'); }), /声明大小/);
  } finally { f.cleanup(); }
});

test('images share the message budget and count; failed intake removes prepared images', async () => {
  const f = fixture();
  try {
    const image = join(f.root, 'image.png'); writeFileSync(image, '123456');
    f.config.incomingAttachmentLimits = { maxFileBytes: 5, maxTotalBytes: 8, maxAttachments: 1 };
    await assert.rejects(receiveIncomingFiles(f.config, f.message, [image], async () => { assert.fail('aggregate declaration exceeds budget'); }), /声明大小/);
    await assert.rejects(prepareIncomingMessage({ downloadImages: async () => [image], downloadFiles: async () => { throw new Error('附件接收失败：测试'); } }, f.message), /附件接收失败/);
    assert.equal(readdirSync(f.root).includes('image.png'), false);
    f.message.attachments.push({ ...f.message.attachments[0]!, id: 'extra' });
    await assert.rejects(receiveIncomingFiles(f.config, f.message, [], async () => { assert.fail(); }), /数量/);
  } finally { f.cleanup(); }
});

test('receive limits default independently from outgoing limits and validate overrides', () => {
  assert.deepEqual(incomingFileLimits(), { maxFileBytes: 104857600, maxTotalBytes: 209715200, maxAttachments: 10 });
  assert.equal(incomingFileLimits({ maxFileBytes: 10 }).maxFileBytes, 10);
  for (const value of [{ maxAttachments: 0 }, { maxFileBytes: 300000000 }, { unknown: 1 }, { maxTotalBytes: 1 }]) assert.throws(() => incomingFileLimits(value));
});

test('Discord file download rejects off-platform redirects without fetching them', async () => {
  const f = fixture(); const urls: string[] = [];
  const transport = new DiscordTransport(f.config, async () => {}, { fetch: (async (url: unknown) => {
    urls.push(String(url)); return new Response(null, { status: 302, headers: { location: 'https://example.com/private' } });
  }) as any });
  try {
    await assert.rejects(prepareIncomingMessage(transport, f.message), /附件接收失败/); assert.equal(urls.length, 1);
  } finally { await transport.close(); f.cleanup(); }
});
