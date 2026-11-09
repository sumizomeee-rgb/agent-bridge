import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { ownTemporaryDirectory } from './temp-directory.js';
import { invokeControllerFileTool } from '../src/controller/files.js';
import { ControllerImageResult, codexToolContent, mcpToolContent, pngImage } from '../src/controller/image-content.js';
import { createClaudeMcpServer } from '../src/controller/agents/claude/mcp.js';

const root = tmpdir();
function chunk(name: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length);
  result.write(name, 4); data.copy(result, 8); result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result;
}
function png(width = 1, height = 1, raw = Buffer.from([0, 255, 0, 0])) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const call = (path: string, extra = {}) => invokeControllerFileTool('bridge_read_file', { path, ...extra }, new AbortController().signal);

test('PNG 原生输出保留字节和证据；普通对象不能伪装成视觉内容', async () => {
  const dir = ownTemporaryDirectory(mkdtempSync(join(root, 'image-test-')), 'image-test-'), path = join(dir, 'sample.bin'), bytes = png();
  writeFileSync(path, bytes); const value = await call(path); assert.ok(value instanceof ControllerImageResult);
  assert.deepEqual(readFileSync(path), bytes); assert.equal(value.metadata.width, 1);
  assert.equal(mcpToolContent(value)[1]!.type, 'image'); assert.equal(codexToolContent(value)[1]!.type, 'inputImage');
  assert.deepEqual(Buffer.from(value.data, 'base64'), bytes);
  assert.equal(codexToolContent({ type: 'image', data: value.data }).length, 1);
  for (const extra of [{maxLines:1}, {encoding:'auto'}, {startLine:1}, {expectedSha256:'a'.repeat(64)}]) await assert.rejects(call(path, extra));
  writeFileSync(path, '文本'); assert.equal(codexToolContent(await call(path)).length, 1);
});

test('PNG 拒绝 CRC 损坏、截断、尾随数据、异常尺寸和解压数据', () => {
  const valid = png(); const corrupted = Buffer.from(valid); corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  for (const bytes of [corrupted, valid.subarray(0, -1), Buffer.concat([valid, Buffer.from('secret')]), png(8193), png(8000, 8000), png(1,1,Buffer.from([5,0,0,0])), png(1,1,Buffer.alloc(100))]) assert.throws(() => pngImage(bytes));
  assert.equal(pngImage(Buffer.from('ordinary text')), undefined);
});

test('MCP HTTP 真正返回 image 块而不是序列化图片对象', async t => {
  const dir = ownTemporaryDirectory(mkdtempSync(join(root, 'mcp-image-test-')), 'mcp-image-test-'), path = join(dir, 'sample.png'); writeFileSync(path, png());
  const { server, token } = createClaudeMcpServer({dataDir:dir, invoke:async (_name, _args, matched) => { matched(); return call(path); }});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/${token}`, {method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge_call',arguments:{command:'bridge_read_file',arguments:{path}}}})});
  const body = await response.json() as any; assert.equal(body.result.content[1].type, 'image'); assert.equal(body.result.content[1].mimeType, 'image/png'); assert.deepEqual(Buffer.from(body.result.content[1].data,'base64'),png());
});

test('不支持的格式明确拒绝；目录链接解析为实际只读文件，不写入源文件', async () => {
  const dir = ownTemporaryDirectory(mkdtempSync(join(root, 'image-test-')), 'image-test-');
  const target = join(dir,'target'); mkdirSync(target);
  const path = join(target,'sample.png'); writeFileSync(path,png());
  for (const [name, bytes] of [['bad.png', Buffer.from('not an image')], ['a.jpg', Buffer.from([255,216,255,224])], ['a.webp', Buffer.from('RIFF1234WEBP')], ['a.gif', Buffer.from('GIF89a')]] as const) {
    const file = join(dir,name); writeFileSync(file,bytes); await assert.rejects(call(file), /图片损坏或格式不受支持/);
  }
  const link = join(dir,'link'); symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
  const result = await call(join(link,'sample.png')); assert.ok(result instanceof ControllerImageResult);
  assert.equal(result.metadata.resolvedPath,path); assert.deepEqual(readFileSync(path),png());
  await assert.rejects(call(link), /普通文件/);
});
