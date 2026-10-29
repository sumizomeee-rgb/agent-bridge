import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownTemporaryDirectory } from './temp-directory.js';
import { invokeControllerFileTool } from '../src/controller/files.js';

const fixture = () => ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'controller-files-')), 'controller-files-');
const call = (name: string, args: unknown, signal = new AbortController().signal) => invokeControllerFileTool(name, args, signal) as Promise<any>;

test('文件快读保持原文，按行分页并校验文件版本', async () => {
  const root = fixture(), path = join(root, 'notes.txt'), bytes = Buffer.from('\ufeff第一行\r\n第二行\r\n第三行\r\n'); writeFileSync(path, bytes);
  const first = await call('bridge_read_file', { path, maxLines: 2 });
  assert.deepEqual(first.lines, [{ line: 1, startColumn: 1, text: '第一行' }, { line: 2, startColumn: 1, text: '第二行' }]);
  assert.equal(first.totalLines, 3); assert.equal(first.changedDuringRead, false); assert.equal(first.truncated, true);
  const next = await call('bridge_read_file', { path, ...first.next, expectedSha256: first.sha256 });
  assert.deepEqual(next.lines, [{ line: 3, startColumn: 1, text: '第三行' }]); assert.equal(next.next, null);
  assert.deepEqual(readFileSync(path), bytes);
  writeFileSync(path, '后来纠正'); await assert.rejects(call('bridge_read_file', { path, ...first.next, expectedSha256: first.sha256 }), /文件已变化/);
});

test('文件快读截断长行仍能无损续读，空文件与越过末尾返回空页', async () => {
  const path = join(fixture(), 'long.txt'), text = 'x'.repeat(7999) + '😀' + '尾'.repeat(20); writeFileSync(path, text);
  const first = await call('bridge_read_file', { path });
  assert.equal(first.lines[0].text.length, 7999); assert.deepEqual(first.next, { startLine: 1, startColumn: 8000 });
  const second = await call('bridge_read_file', { path, ...first.next, expectedSha256: first.sha256 });
  assert.equal(first.lines[0].text + second.lines[0].text, text); assert.equal(second.truncated, false);
  assert.deepEqual((await call('bridge_read_file', { path, startLine: 100 })).lines, []);
  writeFileSync(path, ''); const empty = await call('bridge_read_file', { path }); assert.equal(empty.totalLines, 0); assert.equal(empty.next, null);
});

test('文本编码严格解码，支持 Unicode BOM 和显式旧编码', async () => {
  const path = join(fixture(), 'encoding.txt');
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]), Buffer.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87])]) {
    writeFileSync(path, bytes); assert.equal((await call('bridge_read_file', { path })).lines[0].text, '中文');
  }
  writeFileSync(path, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  await assert.rejects(call('bridge_read_file', { path }), /解码/);
  assert.equal((await call('bridge_read_file', { path, encoding: 'gb18030' })).lines[0].text, '中文');
  await assert.rejects(call('bridge_read_file', { path, encoding: ['utf-8'] }), /编码/);
});

test('拒绝二进制、大文件、非文件和错误参数，不隐式执行内容', async () => {
  const root = fixture(), path = join(root, 'data');
  for (const content of [Buffer.from([0, 1, 2]), Buffer.from('%PDF-1.7'), Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    writeFileSync(path, content); await assert.rejects(call('bridge_read_file', { path }), /文本|2 MiB/);
  }
  await assert.rejects(call('bridge_read_file', { path: root }), /普通文件/);
  await assert.rejects(call('bridge_read_file', { path: join(root, 'missing') }), /ENOENT/);
  for (const input of [{ path: 'relative.txt' }, { path, maxLines: 201 }, { path, startLine: 0 }, { path, command: 'run' }]) await assert.rejects(call('bridge_read_file', input));
  await assert.rejects(call('bridge_write_file', { path }), /未知/);
  await assert.rejects(call('bridge_read_file', { path }, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
});

test('单层目录分页稳定，不展开子目录，游标不能跨目录或跨版本', async () => {
  const root = fixture(), child = join(root, 'c-dir'); mkdirSync(child); writeFileSync(join(child, 'not-top-level.txt'), 'hidden');
  writeFileSync(join(root, 'b.txt'), 'b'); writeFileSync(join(root, 'a.txt'), 'a');
  const first = await call('bridge_list_directory', { path: root, limit: 2 });
  assert.deepEqual(first.entries, [{ name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }]); assert.equal(first.totalEntries, 3);
  const second = await call('bridge_list_directory', { path: root, cursor: first.nextCursor });
  assert.deepEqual(second.entries, [{ name: 'c-dir', type: 'directory' }]); assert.equal(second.hasMore, false); assert.equal(second.nextCursor, null);
  await assert.rejects(call('bridge_list_directory', { path: child, cursor: first.nextCursor }), /游标/);
  writeFileSync(join(root, 'd.txt'), 'd'); utimesSync(root, new Date(), new Date(Date.now() + 2000));
  await assert.rejects(call('bridge_list_directory', { path: root, cursor: first.nextCursor }), /游标/);
  await assert.rejects(call('bridge_list_directory', { path: root, limit: 101 }));
  await assert.rejects(call('bridge_list_directory', { path: join(root, 'a.txt') }), /目录/);
});
