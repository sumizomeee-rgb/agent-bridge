import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceDocuments } from '../src/controller/workspace-documents.js';
import { controllerDocuments } from '../src/controller/documents.js';

test('workspace rules are complete UTF-8 originals, including the last rule after the old summary budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-rules-'));
  try {
    const plain = '# Bridge\r\n- Delegate the goal, not invented procedures.\r\n';
    const readme = plain + '{{include:bridge/controller-protocol}}\n{{include:bridge/tool-index}}\n{{include:workspace/MEMORY.md}}';
    const memory = '# 用户偏好\r\n' + Array.from({ length: 80 }, (_, i) => `- 规则${i}：保持用户约定，不得遗漏。\r\n`).join('') + '- 工位优先 Client／Lua；流程遵循 MyHaruSkills\r\n';
    writeFileSync(join(root, 'README.md'), readme); writeFileSync(join(root, 'MEMORY.md'), '\uFEFF' + memory);
    const result = workspaceDocuments(root);
    assert.deepEqual(result.errors, []); assert.equal(result.files.length, 2);
    assert.ok(result.text.includes(plain)); assert.ok(result.text.includes(memory));
    assert.ok(result.text.includes('规则79')); assert.ok(result.text.includes('Client／Lua'));
    assert.equal(workspaceDocuments(root).text, result.text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('missing or oversized files are reported explicitly without partial text or directory scanning', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-rules-'));
  try {
    writeFileSync(join(root, 'README.md'), 'unrelated'.repeat(10000));
    const result = workspaceDocuments(root);
    assert.equal(result.errors.length, 1); assert.equal(result.files.length, 0);
    assert.ok(result.text.includes('未完整载入')); assert.ok(!result.text.includes('unrelated'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('external clients receive protocol and tools without loading shared workspace behavior or owner memory', () => {
  const root = mkdtempSync(join(tmpdir(), 'client-rules-'));
  try {
    writeFileSync(join(root, 'README.md'), 'BUTLER_BEHAVIOR_ONLY');
    writeFileSync(join(root, 'MEMORY.md'), 'OWNER_MEMORY_ONLY');
    const result = controllerDocuments(root, { agent: 'external' });
    assert.equal(result.kind, 'client-protocol');
    assert.deepEqual(result.errors, []); assert.deepEqual(result.files, []);
    assert.match(result.text, /accept、call、finish/);
    assert.match(result.text, /bridge_help/); assert.match(result.text, /bridge_search_chat_history/);
    assert.doesNotMatch(result.text, /BUTLER_BEHAVIOR_ONLY|OWNER_MEMORY_ONLY|DONE|优先回复/);
    assert.deepEqual(controllerDocuments(join(root, 'missing'), { agent: 'external' }), result);
    writeFileSync(join(root, 'README.md'), '{{include:bridge/controller-protocol}}\n{{include:bridge/tool-index}}\n{{include:workspace/MEMORY.md}}');
    const native = controllerDocuments(root, { agent: 'claude' });
    assert.equal(native.kind, 'workspace'); assert.match(native.text, /OWNER_MEMORY_ONLY/);
    assert.equal(native.text, workspaceDocuments(root, { agent: 'claude' }).text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
