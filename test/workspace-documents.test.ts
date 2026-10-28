import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceDocuments } from '../src/controller/workspace-documents.js';

test('workspace rules are complete UTF-8 originals, including the last rule after the old summary budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-rules-'));
  try {
    const readme = '# Bridge\r\n- Delegate the goal, not invented procedures.\r\n';
    const memory = '# 用户偏好\r\n' + Array.from({ length: 80 }, (_, i) => `- 规则${i}：保持用户约定，不得遗漏。\r\n`).join('') + '- 工位优先 Client／Lua；流程遵循 MyHaruSkills\r\n';
    writeFileSync(join(root, 'README.md'), readme); writeFileSync(join(root, 'MEMORY.md'), '\uFEFF' + memory);
    const result = workspaceDocuments(root);
    assert.deepEqual(result.errors, []); assert.equal(result.files.length, 2);
    assert.ok(result.text.includes(readme)); assert.ok(result.text.includes(memory));
    assert.ok(result.text.includes('规则79')); assert.ok(result.text.includes('Client／Lua'));
    assert.equal(workspaceDocuments(root).text, result.text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('missing or oversized files are reported explicitly without partial text or directory scanning', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-rules-'));
  try {
    writeFileSync(join(root, 'README.md'), 'unrelated'.repeat(10000));
    const result = workspaceDocuments(root);
    assert.equal(result.errors.length, 2); assert.equal(result.files.length, 0);
    assert.ok(result.text.includes('未完整载入')); assert.ok(!result.text.includes('unrelated'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
