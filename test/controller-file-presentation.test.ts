import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownTemporaryDirectory } from './temp-directory.js';
import { invokeControllerFileTool } from '../src/controller/files.js';
import { compactControllerReceipt } from '../src/controller/tool-receipt.js';
import { codexToolContent, mcpToolContent } from '../src/controller/image-content.js';
import { createClaudeMcpServer } from '../src/controller/agents/claude/mcp.js';

const fixture = () => ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'compact-file-')), 'compact-file-');
const read = (path: string, extra = {}) => invokeControllerFileTool('bridge_read_file', { path, ...extra }, new AbortController().signal) as Promise<any>;
const render = (value: unknown) => compactControllerReceipt('bridge_read_file', value) as string;

test('compact presentation preserves source whitespace, line coordinates, revision and continuation without repeated JSON fields', async () => {
  const path = join(fixture(), 'notes.txt');
  writeFileSync(path, '  中文 "quoted" \\ path\t\r\n\r\n第三行  \r\n');
  const page = await read(path, { maxLines: 2 }), before = JSON.stringify(page), text = render(page);
  assert.equal(JSON.stringify(page), before);
  assert.ok(text.includes('1|  中文 "quoted" \\ path\t\n2|\n'));
  assert.ok(text.includes(page.sha256)); assert.ok(text.includes('startLine=3, startColumn=1'));
  assert.equal(text.split(JSON.stringify(path)).length, 2);
  assert.doesNotMatch(text, /"resolvedPath"|"startColumn"|"text":|"lines":/);
  const next = await read(path, { ...page.next, expectedSha256: page.sha256 });
  assert.ok(render(next).includes('3|第三行  \n')); assert.match(render(next), /已到文件末尾/);
  writeFileSync(path, '后来纠正');
  await assert.rejects(read(path, { ...page.next, expectedSha256: page.sha256 }), /文件已变化/);
});

test('long Unicode line continues at exact column and empty pages remain explicit', async () => {
  const path = join(fixture(), 'long.txt'), source = 'x'.repeat(7999) + '😀尾'; writeFileSync(path, source);
  const first = await read(path), second = await read(path, { ...first.next, expectedSha256: first.sha256 });
  assert.equal(first.lines[0].text + second.lines[0].text, source);
  assert.ok(render(second).includes('1:8000|😀尾'));
  assert.match(render(await read(path, { startLine: 10 })), /本页为空/);
  writeFileSync(path, ''); assert.match(render(await read(path)), /总行数：0/);
  const warning = render({ ...first, resolvedPath: path + '.target', changedDuringRead: true });
  assert.match(warning, /实际路径：/); assert.match(warning, /读取期间文件发生变化/);
});

test('Codex gets a JSON-decodable string while Claude gets native text, without content loss', async () => {
  const path = join(fixture(), 'report.md'); writeFileSync(path, '# 标题\n正文\t"quote"\\end');
  const text = render(await read(path));
  assert.equal(JSON.parse(codexToolContent(text)[0]!.text!), text);
  assert.equal(mcpToolContent(text)[0]!.text, text);
});

test('Claude MCP HTTP delivers the compact file result as real multiline text', async t => {
  const dir = fixture(), path = join(dir, 'notes.txt'); writeFileSync(path, '首行\n次行');
  const { server, token } = createClaudeMcpServer({ dataDir: dir, invoke: async (_name, _args, matched) => { matched(); return render(await read(path)); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/${token}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_call', arguments: { command: 'bridge_read_file', arguments: { path } } } }) });
  const body = await response.json() as any;
  assert.ok(body.result.content[0].text.includes('\n1|首行\n2|次行\n'));
  assert.equal(body.result.content[0].type, 'text');
});
