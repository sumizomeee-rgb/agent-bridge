import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, link, unlink, writeFile, open, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { collectOutgoingImages, createTurnArtifacts } from '../src/artifacts.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import type { AgentAdapter, AgentResult, AgentTurn, BridgeConfig, BridgeMessage, ReplyOptions, ReplySink } from '../src/types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1kAAAAASUVORK5CYII=', 'base64');
const marker = (path: string, alt = '截图') => `![${alt}](<${path}>)`;

async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'discord-bridge-artifacts-'));
  const links: string[] = [];
  const beforeCleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const action of beforeCleanup) await action();
    for (const path of links) {
      assert.equal(dirname(resolve(path)).startsWith(resolve(root)), true);
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert(basename(target).startsWith('discord-bridge-artifacts-'));
    const directories = [target];
    while (directories.length) {
      const directory = directories.pop()!;
      assert(!(await lstat(directory)).isSymbolicLink());
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        const info = await lstat(path);
        assert(!info.isSymbolicLink());
        if (info.isDirectory()) directories.push(path);
      }
    }
    await rm(target, { recursive: true, force: true });
  });
  return { root, links, beforeCleanup };
}

async function fixture(t: TestContext) {
  const f = await temporary(t);
  const prepared = await createTurnArtifacts(join(f.root, 'data'), 'message');
  return { ...f, ...prepared };
}

test('message IDs cannot escape the hashed per-turn output directory; empty turns create no image', async t => {
  const f = await temporary(t);
  const id = '../../outside\\..\\bad';
  const prepared = await createTurnArtifacts(join(f.root, 'data'), id);
  assert.equal(basename(prepared.directory), createHash('sha256').update(id).digest('hex'));
  assert.equal(dirname(prepared.directory), join(f.root, 'data', 'outgoing'));
  assert.deepEqual(await readdir(prepared.directory), []);
  assert(prepared.instructions.includes(prepared.directory.replaceAll('\\', '\\\\')));
  assert.match(prepared.instructions, /最终回复/);
  assert(!prepared.instructions.includes('token'));
});

test('only explicitly declared PNG images are collected; HTTP images and normal text remain', async t => {
  const f = await fixture(t);
  const wanted = join(f.directory, '图 (一).png');
  await writeFile(wanted, PNG);
  await writeFile(join(f.directory, 'private.png'), PNG);
  const remote = '![网络图](https://example.com/remote.png)';
  const reply = `检查完成。\n${marker(wanted, '游戏截图')}\n${remote}`;
  const result = await collectOutgoingImages(reply, f.directory, 100);
  assert.equal(result.text, `检查完成。\n\n${remote}`);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]!.filename, '图 (一).png');
  assert.equal(result.images[0]!.description, '游戏截图');
  assert.equal(result.images[0]!.contentType, 'image/png');
  assert.deepEqual(Buffer.from(result.images[0]!.data), PNG);
});

test('fenced, indented, inline, escaped and unclosed-code examples never upload files', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'not-accessed.png');
  const image = marker(outside);
  const text = `示例：\n\`\`\`markdown\n${image}\n\`\`\`\n~~~\n${image}\n~~~\n    ${image}\n\`${image}\`\n\\${image}\n\`\`\`\n${image}`;
  const result = await collectOutgoingImages(text, f.directory, 100);
  assert.equal(result.text, text);
  assert.deepEqual(result.images, []);
});

test('tilde and backtick code fences inside nested quotes/lists mask examples at original offsets', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'example.png'); await writeFile(path, PNG);
  const image = marker(path);
  const examples = [
    `> ~~~md\n> ${image}\n> ~~~`,
    `> > ~~~md\n> > ${image}\n> > ~~~`,
    `- ~~~md\n  ${image}\n  ~~~`,
    `- 1. ~~~md\n     ${image}\n     ~~~`,
    `> - ~~~md\n>   ${image}\n>   ~~~`,
    `- > ~~~md\n  > ${image}\n  > ~~~`,
    `> - > ~~~md\n>   > ${image}\n>   > ~~~`,
    `> \`\`\`md\n> ${image}\n> \`\`\``,
    `> ~~~md\n>     ~~~\n> ${image}\n> ~~~`,
  ];
  for (const example of examples) {
    const result = await collectOutgoingImages(example, f.directory, 100);
    assert.equal(result.text, example);
    assert.deepEqual(result.images, [], example);
  }
});

test('real images in ordinary quotes/lists and after a contained code block still upload', async t => {
  const f = await fixture(t);
  const example = join(f.directory, 'example.png');
  const first = join(f.directory, 'quoted.png');
  const second = join(f.directory, 'listed.png');
  const third = join(f.directory, 'after.png');
  for (const path of [example, first, second, third]) await writeFile(path, PNG);
  const sample = `> - ~~~md\n>   ${marker(example)}\n>   ~~~`;
  const text = `${sample}\n> ${marker(first)}\n- ${marker(second)}\n${marker(third)}`;
  const result = await collectOutgoingImages(text, f.directory, 100);
  assert.deepEqual(result.images.map(image => image.filename), ['quoted.png', 'listed.png', 'after.png']);
  assert(result.text.includes(sample));
  assert(!result.text.includes(marker(first)));
  const endedQuote = await collectOutgoingImages(`> ~~~md\n> ${marker(example)}\n${marker(third)}`, f.directory, 100);
  assert.deepEqual(endedQuote.images.map(image => image.filename), ['after.png']);
});

test('plain Markdown paths, title and duplicate declarations collect one file and remove every local marker', async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'screen.png');
  await writeFile(path, PNG);
  const result = await collectOutgoingImages(`A ![a](${path} "title") B ${marker(path, '第二次')}`, f.directory, 100);
  assert.equal(result.images.length, 1);
  assert.equal(result.text, 'A  B');
});

test('Windows slash-drive prefix is normalized only for a drive path', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const path = join(f.directory, 'screen.png');
  await writeFile(path, PNG);
  const result = await collectOutgoingImages(`![游戏截图](/${path.replaceAll('\\', '/')})`, f.directory, 100);
  assert.equal(result.images.length, 1);
  assert.equal(result.text, '');
});

test('outside, sibling-prefix and traversal destinations fail before any images are returned', async t => {
  const f = await fixture(t);
  const local = join(f.directory, 'valid.png');
  const sibling = `${f.directory}-sibling`;
  await mkdir(sibling);
  await writeFile(local, PNG);
  const outside = join(sibling, 'private.png');
  await writeFile(outside, PNG);
  await assert.rejects(collectOutgoingImages(`${marker(local)}\n${marker(outside)}`, f.directory, 100), /不在本轮产物目录/);
  await assert.rejects(collectOutgoingImages(marker(join(f.directory, '..', basename(outside))), f.directory, 100), /不在本轮产物目录/);
  await assert.rejects(collectOutgoingImages('![relative](screen.png)', f.directory, 100), /绝对文件路径/);
});

test('junction escape is refused even if the target is an otherwise valid image', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'outside');
  await mkdir(target);
  await writeFile(join(target, 'private.png'), PNG);
  const shortcut = join(f.directory, 'junction');
  await symlink(target, shortcut, 'junction');
  f.links.push(shortcut);
  await assert.rejects(collectOutgoingImages(marker(join(shortcut, 'private.png')), f.directory, 100), /链接/);
});

test('an output root that is itself a junction is refused', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'root-alias');
  await symlink(f.directory, alias, 'junction');
  f.links.push(alias);
  await assert.rejects(collectOutgoingImages(marker(join(alias, 'image.png')), alias, 100), /链接/);
});

test('hard links, directories and missing declarations are refused with a clear image failure', async t => {
  const f = await fixture(t);
  const source = join(f.root, 'private.png');
  await writeFile(source, PNG);
  const hard = join(f.directory, 'hard.png');
  await link(source, hard);
  await assert.rejects(collectOutgoingImages(marker(hard), f.directory, 100), /普通文件/);
  await assert.rejects(collectOutgoingImages(marker(f.directory), f.directory, 100), /不在本轮产物目录/);
  await assert.rejects(collectOutgoingImages(marker(join(f.directory, 'missing.png')), f.directory, 100), /图片回传失败.*ENOENT/);
});

test('signature mismatches and unsupported extensions cannot masquerade as images', async t => {
  const f = await fixture(t);
  const spoof = join(f.directory, 'spoof.png');
  await writeFile(spoof, 'this is not an image');
  await assert.rejects(collectOutgoingImages(marker(spoof), f.directory, 100), /扩展名匹配/);
  const unsupported = join(f.directory, 'vector.svg');
  await writeFile(unsupported, PNG);
  await assert.rejects(collectOutgoingImages(marker(unsupported), f.directory, 100), /PNG\/JPG\/WebP\/GIF/);
});

test('JPG, WebP and GIF signatures are accepted only under their matching extension', async t => {
  const f = await fixture(t);
  const files = [
    { name: 'image.jpeg', data: Buffer.from([255, 216, 255, 224, 0, 1]), type: 'image/jpeg' },
    { name: 'image.gif', data: Buffer.from('GIF89a123456'), type: 'image/gif' },
    { name: 'image.webp', data: Buffer.from('RIFF1234WEBP'), type: 'image/webp' },
  ];
  for (const file of files) await writeFile(join(f.directory, file.name), file.data);
  const result = await collectOutgoingImages(files.map(file => marker(join(f.directory, file.name))).join('\n'), f.directory, 100);
  assert.deepEqual(result.images.map(image => image.contentType), files.map(file => file.type));
});

test('configured byte limits and the hard 10 MiB limit are checked before large-file reads', async t => {
  const f = await fixture(t);
  const small = join(f.directory, 'small.png');
  await writeFile(small, PNG);
  await assert.rejects(collectOutgoingImages(marker(small), f.directory, PNG.length - 1), /大小上限/);
  assert.equal((await collectOutgoingImages(marker(small), f.directory, PNG.length)).images.length, 1);
  const huge = join(f.directory, 'huge.png');
  const file = await open(huge, 'w');
  try { await file.write(PNG); await file.truncate(10 * 1024 * 1024 + 1); }
  finally { await file.close(); }
  await assert.rejects(collectOutgoingImages(marker(huge), f.directory, 20 * 1024 * 1024), /单图最多 10485760/);
});

test('more than ten unique declared files fail atomically, with no directory scanning', async t => {
  const f = await fixture(t);
  const paths = Array.from({ length: 11 }, (_, index) => join(f.directory, `${index}.png`));
  for (const path of paths) await writeFile(path, PNG);
  await assert.rejects(collectOutgoingImages(paths.map(path => marker(path)).join('\n'), f.directory, 100), /最多回传 10 张/);
  assert.equal((await collectOutgoingImages(paths.slice(0, 10).map(path => marker(path)).join('\n'), f.directory, 100)).images.length, 10);
});

test('same filenames in different safe subdirectories get distinct attachment names', async t => {
  const f = await fixture(t);
  const first = join(f.directory, 'one'); const second = join(f.directory, 'two');
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, 'image.png'), PNG); await writeFile(join(second, 'image.png'), PNG);
  const result = await collectOutgoingImages(`${marker(join(first, 'image.png'))}\n${marker(join(second, 'image.png'))}`, f.directory, 100);
  assert.deepEqual(result.images.map(image => image.filename), ['image.png', '2-image.png']);
});

test('pre-cancelled collection never reads or returns the declared image', async t => {
  const f = await fixture(t);
  const signal = AbortSignal.abort();
  await assert.rejects(collectOutgoingImages(marker(join(f.directory, 'not-read.png')), f.directory, 100, signal), { name: 'AbortError' });
});

class PendingAdapter implements AgentAdapter {
  readonly turns: AgentTurn[] = [];
  readonly pending: Array<(result: AgentResult) => void> = [];
  async run(turn: AgentTurn): Promise<AgentResult> {
    this.turns.push(turn);
    turn.onNativeId?.(`native-${turn.conversation.id}`);
    return new Promise(resolve => this.pending.push(resolve));
  }
  finish(index: number, text: string) {
    this.pending[index]!({ nativeId: `native-${this.turns[index]!.conversation.id}`, text });
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> { this.pending.forEach((_, index) => this.finish(index, 'late close')); }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('等待条件超时'); await delay(5); }
}

function message(id: string, text = '请截图', imagePaths: string[] = []): BridgeMessage {
  return { id, userId: 'owner', channelId: 'dm', text, imagePaths };
}

async function managerFixture(t: TestContext) {
  const f = await temporary(t);
  const config: BridgeConfig = {
    token: 'NOT_GIVEN_TO_AGENT', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: f.root, proxyUrl: null,
    commands: { codex: { command: 'fake', args: [] }, claude: { command: 'fake', args: [] } },
    dataDir: join(f.root, 'data'), attachmentsDir: join(f.root, 'attachments'), logsDir: join(f.root, 'logs'), maxImageBytes: 100,
  };
  const adapter = new PendingAdapter();
  const replies: Array<{ text: string; options?: ReplyOptions }> = [];
  let failImage = false;
  const sink: ReplySink = { async sendText(_channel, text, options) {
    if (failImage && options?.images?.length) { failImage = false; throw new Error('attachment delivery unavailable'); }
    replies.push({ text, options });
  } };
  const manager = new SessionManager(config, { codex: adapter, claude: adapter }, sink);
  f.beforeCleanup.push(() => manager.close());
  const directory = (id: string) => join(config.dataDir, 'outgoing', createHash('sha256').update(id).digest('hex'));
  return { ...f, config, adapter, replies, manager, directory, failImageOnce() { failImage = true; } };
}

test('manager keeps original text/input images, passes instructions separately and sends images together with the reply header', async t => {
  const f = await managerFixture(t);
  const input = ['user-input.png'];
  await f.manager.handle(message('first', '用户原文', input));
  await until(() => f.adapter.turns.length === 1);
  const turn = f.adapter.turns[0]!;
  assert.equal(turn.text, '用户原文'); assert.deepEqual(turn.imagePaths, input);
  assert(turn.deliveryInstructions?.includes('最终回复'));
  assert(!turn.deliveryInstructions?.includes(f.config.token));
  const image = join(f.directory('first'), 'shot.png');
  await writeFile(image, PNG);
  f.adapter.finish(0, `已检查。\n${marker(image)}`);
  await until(() => f.replies.length === 1);
  assert.match(f.replies[0]!.text, /^\[Codex ·/);
  assert(f.replies[0]!.text.endsWith('\n\n已检查。'));
  assert(!f.replies[0]!.text.includes(image));
  assert.equal(f.replies[0]!.options!.images!.length, 1);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert(inspect.getLastDelivery('owner', 'dm')); }
  finally { inspect.close(); }
  await f.manager.close();
});

test('image delivery failure preserves native ID and completed turn without tool replay or successful continuity', async t => {
  const f = await managerFixture(t);
  await f.manager.handle(message('failed'));
  await until(() => f.adapter.turns.length === 1);
  const image = join(f.directory('failed'), 'shot.png');
  await writeFile(image, PNG);
  f.failImageOnce();
  f.adapter.finish(0, marker(image));
  await until(() => f.replies.length === 1);
  assert.match(f.replies[0]!.text, /attachment delivery unavailable/);
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.getMessage('failed')!.state, 'completed');
    assert.equal(inspect.getActive('owner')!.nativeId, `native-${f.adapter.turns[0]!.conversation.id}`);
    assert.equal(inspect.getLastDelivery('owner', 'dm'), null);
  } finally { inspect.close(); }
  await f.manager.handle(message('failed', 'duplicate')); assert.equal(f.adapter.turns.length, 1);
  await f.manager.handle(message('next', '继续'));
  await until(() => f.adapter.turns.length === 2);
  assert.equal(f.adapter.turns[1]!.conversation.nativeId, `native-${f.adapter.turns[0]!.conversation.id}`);
  f.adapter.finish(1, '继续完成');
  await until(() => f.replies.length === 2);
  assert(!f.replies[1]!.text.includes('✅'));
  await f.manager.close();
});

test('validation failure sends only a clear error, retains the completed native turn and uploads no partial images', async t => {
  const f = await managerFixture(t);
  await f.manager.handle(message('invalid'));
  await until(() => f.adapter.turns.length === 1);
  const good = join(f.directory('invalid'), 'good.png'); await writeFile(good, PNG);
  const outside = join(f.root, 'private.png'); await writeFile(outside, PNG);
  f.adapter.finish(0, `${marker(good)}\n${marker(outside)}`);
  await until(() => f.replies.length === 1);
  assert.match(f.replies[0]!.text, /图片回传失败.*不在本轮/);
  assert(!f.replies[0]!.options?.images);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getMessage('invalid')!.state, 'completed'); assert.equal(inspect.getLastDelivery('owner', 'dm'), null); }
  finally { inspect.close(); }
  await f.manager.handle(message('invalid')); assert.equal(f.adapter.turns.length, 1);
  await f.manager.close();
});

test('a stopped turn cannot deliver late image output; the next turn has a distinct output directory', async t => {
  const f = await managerFixture(t);
  await f.manager.handle(message('old'));
  await until(() => f.adapter.turns.length === 1);
  const image = join(f.directory('old'), 'old.png'); await writeFile(image, PNG);
  await f.manager.handle(message('stop', '/stop'));
  f.adapter.finish(0, marker(image));
  await f.manager.handle(message('new', '继续'));
  await until(() => f.adapter.turns.length === 2);
  assert.notEqual(f.directory('old'), f.directory('new'));
  assert.equal((await stat(f.directory('new'))).isDirectory(), true);
  f.adapter.finish(1, '本轮无需图片');
  await until(() => f.replies.length === 2);
  assert(f.replies.every(reply => !reply.options?.images));
  assert(f.replies[1]!.text.endsWith('本轮无需图片'));
  await f.manager.close();
});

test('stopping while the per-turn directory is being prepared prevents any agent invocation', async t => {
  const f = await managerFixture(t);
  await f.manager.handle(message('preparing'));
  await f.manager.handle(message('stop-prepare', '/stop'));
  await until(() => (Reflect.get(f.manager, 'workers') as Map<string, unknown>).size === 0);
  assert.equal(f.adapter.turns.length, 0);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!.text, /已停止/);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getMessage('preparing')!.state, 'cancelled'); }
  finally { inspect.close(); }
});

test('stopping during attachment reads prevents a late sink call and leaves delivery continuity unset', async t => {
  const f = await managerFixture(t);
  await f.manager.handle(message('reading'));
  await until(() => f.adapter.turns.length === 1);
  const path = join(f.directory('reading'), 'screen.png');
  await writeFile(path, PNG);
  const handle = await open(path);
  const prototype = Object.getPrototypeOf(handle) as { read: FileHandle['read'] };
  const original = prototype.read;
  await handle.close();
  let interrupted = false;
  const mock = t.mock.method(prototype, 'read', async function (this: FileHandle, ...arguments_: unknown[]) {
    mock.mock.restore();
    interrupted = true;
    await f.manager.handle(message('stop-reading', '/stop'));
    return Reflect.apply(original, this, arguments_);
  });
  f.adapter.finish(0, marker(path));
  await until(() => (Reflect.get(f.manager, 'workers') as Map<string, unknown>).size === 0);
  assert(interrupted);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!.text, /已停止当前任务，取消 1 条/);
  assert(!f.replies[0]!.options?.images);
  const inspect = new SessionStore(f.config.dataDir);
  try { assert.equal(inspect.getMessage('reading')!.state, 'completed'); assert.equal(inspect.getLastDelivery('owner', 'dm'), null); }
  finally { inspect.close(); }
});

test('/stop counts and aborts completed-model image delivery without replaying tools or committing delivery continuity', async t => {
  const f = await managerFixture(t);
  const calls: Array<{ text: string; options?: ReplyOptions }> = [];
  let held = false;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sink: ReplySink = {
    async sendText(_channel, text, options) {
      calls.push({ text, options });
      if (options?.images?.length) { held = true; await gate; options.signal?.throwIfAborted(); }
    },
  };
  const manager = new SessionManager(f.config, { codex: f.adapter, claude: f.adapter }, sink);
  f.beforeCleanup.push(async () => { release?.(); await manager.close(); });
  await manager.handle(message('sending'));
  await until(() => f.adapter.turns.length === 1);
  const path = join(f.directory('sending'), 'screen.png'); await writeFile(path, PNG);
  f.adapter.finish(0, marker(path));
  await until(() => held);
  const signal = calls[0]!.options!.signal;
  assert.equal(signal, f.adapter.turns[0]!.signal);
  assert.equal(signal!.aborted, false);
  await manager.handle(message('stop-sending', '/stop'));
  assert.equal(signal!.aborted, true);
  assert.match(calls[1]!.text, /已停止当前任务，取消 1 条/);
  await manager.handle(message('stop-again', '/stop'));
  assert.match(calls[2]!.text, /当前没有待处理任务/);
  release!();
  await until(() => (Reflect.get(manager, 'workers') as Map<string, unknown>).size === 0);
  assert.equal(calls.length, 3);
  const inspect = new SessionStore(f.config.dataDir);
  try {
    assert.equal(inspect.getMessage('sending')!.state, 'completed');
    assert.equal(inspect.getActive('owner')!.nativeId, `native-${f.adapter.turns[0]!.conversation.id}`);
    assert.equal(inspect.getLastDelivery('owner', 'dm'), null);
  } finally { inspect.close(); }
  await manager.handle(message('sending', 'duplicate')); assert.equal(f.adapter.turns.length, 1);
  await manager.close();
});
