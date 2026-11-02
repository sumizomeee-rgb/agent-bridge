import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredFileLimit, FILE_LIMITS } from '../src/attachment-limits.js';
import { loadHostConfig } from '../src/config.js';
import { collectOutgoingPaths } from '../src/artifacts.js';
import { FeishuTransport } from '../src/feishu.js';

test('platform defaults, legacy override and per-platform override resolve before preparation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-file-limits-'));
  let transport: FeishuTransport | undefined;
  t.after(async () => { await transport?.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'bots', 'feishu'), { recursive: true });
  await writeFile(join(root, 'bots', 'feishu', 'test.json'), JSON.stringify({
    applicationId: 'cli_test', appSecret: 'test-only', allowedUserIds: ['ou_owner'],
  }));
  const path = join(root, 'config.json');
  const base = { version: 3, startupProfiles: ['feishu/test'], dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'),
    commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } };
  const load = async (extra = {}) => {
    await writeFile(path, JSON.stringify({ ...base, ...extra }));
    return loadHostConfig(['--config', path], false).configs[0]!;
  };
  assert.equal((await load()).maxFileBytes, 30_000_000);
  assert.equal((await load({ maxFileBytes: 1024 })).maxFileBytes, 1024);
  const config = await load({ maxFileBytes: 20 * 1024 * 1024, maxFileBytesByPlatform: { feishu: 30_000_000 } });
  assert.equal(config.maxFileBytes, 30_000_000);
  await assert.rejects(load({ maxFileBytesByPlatform: { feishu: 30_000_001 } }), /maxFileBytes/);
  assert.equal(configuredFileLimit('discord'), 20 * 1024 * 1024);
  assert.throws(() => configuredFileLimit('discord', 24 * 1024 * 1024 + 1), /maxFileBytes/);

  const file = join(root, 'boundary.zip');
  const handle = await open(file, 'w');
  try { await handle.truncate(FILE_LIMITS.feishu.maxBytes); } finally { await handle.close(); }
  const prepared = await collectOutgoingPaths([file], root, config.maxImageBytes, config.maxFileBytes);
  assert.equal(prepared.files[0]!.data.length, 30_000_000);
  let uploads = 0, fileMessages = 0;
  const bridge = new FeishuTransport(config, async () => {}, { fetch: (async (url: unknown, options: any) => {
    const path = new URL(String(url)).pathname;
    if (path.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'test-only', expire: 3600 }));
    if (path.endsWith('/files')) {
      uploads++;
      assert.equal(options.body.get('file').size, 30_000_000);
      return new Response(JSON.stringify({ code: 0, data: { file_key: 'file_test' } }));
    }
    if (JSON.parse(options.body).msg_type === 'file') fileMessages++;
    return new Response(JSON.stringify({ code: 0, data: {} }));
  }) as any });
  transport = bridge;
  await bridge.sendText('oc_chat', '', { files: prepared.files });
  assert.equal(uploads, 1); assert.equal(fileMessages, 1);
  await assert.rejects(bridge.sendText('oc_chat', '', { files: [{ filename: 'large.zip', contentType: 'application/zip', data: Buffer.alloc(30_000_001) }] }), /超过限额/);
  assert.equal(uploads, 1);
  const larger = await open(file, 'r+');
  try { await larger.truncate(30_000_001); } finally { await larger.close(); }
  await assert.rejects(collectOutgoingPaths([file], root, config.maxImageBytes, config.maxFileBytes), /大小上限/);
});
