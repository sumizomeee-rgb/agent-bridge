import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { collectOutgoingAttachments, collectOutgoingPaths } from '../src/artifacts.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, ReplyOptions, ReplySink } from '../src/types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1kAAAAASUVORK5CYII=', 'base64');
const fileMarker = (path: string, name = '文件') => `[${name}](<${path}>)`;
const imageMarker = (path: string) => `![截图](<${path}>)`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'discord-bridge-files-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const links: string[] = [];
  const after: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const action of after) await action();
    for (const path of links) { assert.equal(dirname(path), workspace); await unlink(path); }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('discord-bridge-files-'));
    const directories = [root];
    while (directories.length) {
      const directory = directories.pop()!;
      assert(!(await lstat(directory)).isSymbolicLink());
      for (const name of await readdir(directory)) {
        const path = join(directory, name); const info = await lstat(path);
        assert(!info.isSymbolicLink());
        if (info.isDirectory()) directories.push(path);
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, links, after };
}

test('explicit controller paths classify verified images and files without Markdown parsing', async t => {
  const f = await fixture(t);
  const image = join(f.workspace, '图 [一] (`截图`).PNG'), report = join(f.workspace, '报告.txt');
  await writeFile(image, PNG); await writeFile(report, 'result');
  const result = await collectOutgoingPaths([image, report, image], f.workspace, 100);
  assert.equal(result.text, ''); assert.equal(result.images.length, 1); assert.equal(result.files.length, 1);
  assert.equal(result.images[0]!.contentType, 'image/png');
  assert.deepEqual(Buffer.from(result.images[0]!.data), PNG);
  assert.equal(result.files[0]!.filename, '报告.txt');
  // Direct mode retains its explicit file-vs-image Markdown contract.
  const direct = await collectOutgoingAttachments(fileMarker(image), f.workspace, 100);
  assert.equal(direct.images.length, 0); assert.equal(direct.files.length, 1);
});

test('explicit controller paths reject missing, relative, non-image bytes and oversized images', async t => {
  const f = await fixture(t), valid = join(f.workspace, 'valid.png'), bad = join(f.workspace, 'bad.jpg');
  await writeFile(valid, PNG); await writeFile(bad, 'not an image');
  await assert.rejects(collectOutgoingPaths([valid, join(f.workspace, 'missing.png')], f.workspace, 100), /ENOENT/);
  await assert.rejects(collectOutgoingPaths(['relative.png'], f.workspace, 100), /绝对文件路径/);
  await assert.rejects(collectOutgoingPaths([bad], f.workspace, 100), /文件内容不是/);
  await assert.rejects(collectOutgoingPaths([valid], f.workspace, PNG.length - 1), /图片大小上限/);
  assert.deepEqual(await collectOutgoingPaths([], join(f.root, 'missing-root'), 100), { text: '', images: [], files: [] });
});

test('explicit controller paths retain physical-file and directory-link checks', async t => {
  const f = await fixture(t), image = join(f.workspace, 'shot.png'); await writeFile(image, PNG);
  const alias = join(f.workspace, 'alias'); await symlink(f.workspace, alias, 'junction'); f.links.push(alias);
  await assert.rejects(collectOutgoingPaths([join(alias, 'shot.png')], f.workspace, 100), /目录包含链接/);
  await assert.rejects(collectOutgoingPaths([f.workspace], f.workspace, 100), /普通文件/);
});

test('PDF, Office, ZIP, unknown binaries and empty files preserve exact bytes and names' , async t => {
  const f = await fixture(t);
  const entries = [
    { name: '报告 (最终).pdf', data: Buffer.from('%PDF-1.7\nexample'), type: 'application/pdf' },
    { name: '表格.xlsx', data: Buffer.from([0x50, 0x4b, 3, 4, 0, 255]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { name: '说明.docx', data: Buffer.from('office'), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: '备份.zip', data: Buffer.from([0x50, 0x4b, 3, 4]), type: 'application/zip' },
    { name: 'unknown.dat', data: Buffer.from([0, 255, 0, 10]), type: 'application/octet-stream' },
    { name: 'empty.txt', data: Buffer.alloc(0), type: 'text/plain' },
  ];
  for (const entry of entries) await writeFile(join(f.workspace, entry.name), entry.data);
  await writeFile(join(f.workspace, 'unrelated.txt'), 'do not send');
  const result = await collectOutgoingAttachments(`已取到文件。\n${entries.map(entry => fileMarker(join(f.workspace, entry.name))).join('\n')}`, f.workspace, 100);
  assert.equal(result.text, '已取到文件。');
  assert.deepEqual(result.images, []);
  assert.equal(result.files.length, entries.length);
  for (const [index, entry] of entries.entries()) {
    const file = result.files[index]!;
    assert.equal(file.filename, entry.name); assert.equal(file.contentType, entry.type);
    assert.deepEqual(Buffer.from(file.data), entry.data);
    assert.deepEqual(await readFile(join(f.workspace, entry.name)), entry.data);
  }
});

test('web, relative, inline/fenced/quoted code and escaped file links remain text without reading paths', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'outside-not-read.pdf');
  const declaration = fileMarker(path);
  const text = `[网站](https://example.com/a.pdf) [参考](README.md) [邮件](mailto:example@example.com)\n`
    + `\`${declaration}\`\n~~~md\n${declaration}\n~~~\n> - ~~~md\n>   ${declaration}\n>   ~~~\n`
    + `    ${declaration}\n\\${declaration}\n\\!${declaration}\n`;
  assert.deepEqual(await collectOutgoingAttachments(text, join(f.root, 'missing'), 100), { text, images: [], files: [] });
});

test('images and ordinary files share deduplication and collision-free attachment filenames', async t => {
  const f = await fixture(t);
  const screenshot = join(f.workspace, 'shot.png'); await writeFile(screenshot, PNG);
  const first = join(f.workspace, 'first'); const second = join(f.workspace, 'second');
  await mkdir(first); await mkdir(second);
  const pdf = join(first, 'same.pdf'); const other = join(second, 'same.pdf');
  await writeFile(pdf, 'one'); await writeFile(other, 'two');
  const text = `${imageMarker(screenshot)}\n${fileMarker(screenshot)}\n${fileMarker(pdf)}\n${fileMarker(pathToFileURL(pdf).href)}\n${fileMarker(other)}`;
  const result = await collectOutgoingAttachments(text, f.workspace, 100);
  assert.equal(result.text, '');
  assert.deepEqual(result.images.map(file => file.filename), ['shot.png']);
  assert.deepEqual(result.files.map(file => file.filename), ['same.pdf', '3-same.pdf']);
});

test('ordinary source references and file-location links never read or upload referenced paths', async t => {
  const f = await fixture(t);
  const missing = join(f.root, 'outside', 'missing.py');
  const references = [
    `[源码](${missing})`, fileMarker(`${missing}:12`), fileMarker(`${missing}:12:4`),
    fileMarker(`${missing}#L12`), fileMarker(`${missing}#L12-L20`), fileMarker(`${missing}#line=12`),
  ];
  if (process.platform === 'win32') references.push(fileMarker(`/${missing.replaceAll('\\', '/')}:12`));
  const text = references.join('\n');
  assert.deepEqual(await collectOutgoingAttachments(text, join(f.root, 'nonexistent'), 100), { text, images: [], files: [] });
});

test('outside physical files upload; missing, directory and junction files prevent partial delivery', async t => {
  const f = await fixture(t);
  const image = join(f.workspace, 'good.png'); await writeFile(image, PNG);
  const privateDir = join(f.root, 'outside'); await mkdir(privateDir);
  const outside = join(privateDir, 'private.txt'); await writeFile(outside, 'private');
  const alias = join(f.workspace, 'shortcut'); await symlink(privateDir, alias, 'junction'); f.links.push(alias);
  const result = await collectOutgoingAttachments(fileMarker(outside), join(f.root, 'missing-workspace'), 100);
  assert.equal(result.files[0]!.filename, 'private.txt');
  assert.deepEqual(Buffer.from(result.files[0]!.data), Buffer.from('private'));
  await assert.rejects(collectOutgoingAttachments(fileMarker(outside), f.workspace, 100, 3), /大小上限/);
  for (const path of [join(f.workspace, 'missing.pdf'), privateDir, join(alias, 'private.txt')]) {
    await assert.rejects(collectOutgoingAttachments(`${imageMarker(image)}\n${fileMarker(path)}`, f.workspace, 100), /文件回传失败/);
  }
});

test('file size/configuration limits are checked before reading and count includes images', async t => {
  const f = await fixture(t);
  const pdf = join(f.workspace, 'small.pdf'); await writeFile(pdf, '1234');
  await assert.rejects(collectOutgoingAttachments(fileMarker(pdf), f.workspace, 100, 3), /单个文件最多 3/);
  assert.equal((await collectOutgoingAttachments(fileMarker(pdf), f.workspace, 100, 4)).files.length, 1);
  const huge = join(f.workspace, 'huge.zip'); const handle = await open(huge, 'w');
  try { await handle.truncate(20 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(collectOutgoingAttachments(fileMarker(huge), f.workspace, 100), /单个文件最多 20971520/);
  for (const limit of [0, -1, 1.5, NaN, 24 * 1024 * 1024 + 1]) {
    await assert.rejects(collectOutgoingAttachments(fileMarker(pdf), f.workspace, 100, limit), /文件大小上限/);
  }
  const image = join(f.workspace, 'image.png'); await writeFile(image, PNG);
  const files = Array.from({ length: 10 }, (_, index) => join(f.workspace, `${index}.txt`));
  for (const path of files) await writeFile(path, 'x');
  await assert.rejects(collectOutgoingAttachments(`${imageMarker(image)}\n${files.map(path => fileMarker(path)).join('\n')}`, f.workspace, 100), /最多回传 10 个/);
  await assert.rejects(collectOutgoingAttachments(fileMarker(pdf), f.workspace, 100, undefined, AbortSignal.abort()), { name: 'AbortError' });
});

class PendingAdapter implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  readonly pending: Array<(result: AgentResult) => void> = [];
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    return new Promise(resolve => this.pending.push(resolve));
  }
  finish(index: number, text: string) { this.pending[index]!({ nativeId: `native-${this.turns[index]!.conversation.id}`, text }); }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { for (let index = 0; index < this.pending.length; index++) this.finish(index, 'shutdown'); }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('file delivery test timed out'); await delay(5); }
}

async function managerFixture(t: TestContext) {
  const f = await fixture(t);
  const config: BridgeConfig = {
    token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: f.workspace, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(f.root, 'data'), attachmentsDir: join(f.root, 'attachments'), logsDir: join(f.root, 'logs'),
    maxImageBytes: 100, maxFileBytes: 100,
  };
  const adapter = new PendingAdapter(); const replies: Array<{ text: string; options?: ReplyOptions }> = [];
  let failFile = false;
  const sink: ReplySink = { async sendText(_channel, text, options) {
    if (failFile && options?.files?.length) { failFile = false; throw new Error('file upload unavailable'); }
    replies.push({ text, options });
  } };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, sink);
  f.after.push(() => manager.close());
  const message = (id: string, text = '把文件发给我') => ({ id, text, userId: 'owner', channelId: 'dm', imagePaths: [] });
  return { ...f, config, adapter, manager, replies, message, failNextFile() { failFile = true; } };
}

test('manager sends ordinary files with the reply header and continues the same native session', async t => {
  const f = await managerFixture(t);
  const path = join(f.workspace, '报告.pdf'); await writeFile(path, '%PDF-example');
  await f.manager.handle(f.message('first')); await until(() => f.adapter.turns.length === 1);
  assert.equal(f.adapter.turns[0]!.text, '把文件发给我');
  f.adapter.finish(0, fileMarker(path)); await until(() => f.replies.length === 1);
  assert.match(f.replies[0]!.text, /^\[Codex ·.*\n\n文件已附上。$/s);
  assert.equal(f.replies[0]!.options!.files![0]!.filename, '报告.pdf');
  assert(!f.replies[0]!.text.includes(path));
  await f.manager.handle(f.message('next', '再发一次')); await until(() => f.adapter.turns.length === 2);
  assert.equal(f.adapter.turns[1]!.conversation.nativeId, `native-${f.adapter.turns[0]!.conversation.id}`);
  f.adapter.finish(1, `再次附上。\n${fileMarker(path)}`); await until(() => f.replies.length === 2);
  assert(!f.replies[1]!.text.includes('✅'));
});

test('file upload failure keeps completed native state without replay or falsely marking continuity', async t => {
  const f = await managerFixture(t);
  const path = join(f.workspace, 'file.zip'); await writeFile(path, 'zip data');
  await f.manager.handle(f.message('failed')); await until(() => f.adapter.turns.length === 1);
  f.failNextFile(); f.adapter.finish(0, fileMarker(path)); await until(() => f.replies.length === 1);
  assert.match(f.replies[0]!.text, /file upload unavailable/);
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.getMessage('failed')!.state, 'completed');
    assert.equal(inspect.getActive('owner')!.nativeId, `native-${f.adapter.turns[0]!.conversation.id}`);
    assert.equal(inspect.getLastDelivery('owner', 'dm'), null);
  } finally { inspect.close(); }
  await f.manager.handle(f.message('failed')); assert.equal(f.adapter.turns.length, 1);
  await f.manager.handle(f.message('next')); await until(() => f.adapter.turns.length === 2);
  f.adapter.finish(1, fileMarker(path)); await until(() => f.replies.length === 2);
  assert(!f.replies[1]!.text.includes('✅'));
});

test('stopped file turns cannot deliver late attachments or change continuity', async t => {
  const f = await managerFixture(t);
  const path = join(f.workspace, 'file.txt'); await writeFile(path, 'text');
  await f.manager.handle(f.message('stopped')); await until(() => f.adapter.turns.length === 1);
  await f.manager.handle(f.message('stop', '/stop'));
  f.adapter.finish(0, fileMarker(path));
  await until(() => (Reflect.get(f.manager, 'workers') as Map<string, unknown>).size === 0);
  assert.equal(f.replies.length, 1); assert.match(f.replies[0]!.text, /已停止/);
  assert(f.replies.every(reply => !reply.options?.files));
});
