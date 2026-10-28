import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SessionHandoffs } from '../src/controller/handoff.js';
import { SessionStore } from '../src/store.js';
import type { Conversation } from '../src/types.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-handoff-'));
  const source: Conversation = { id: 'old-parent', userId: 'owner', agent: 'codex', nativeId: 'native-old',
    cwd: root, title: 'old', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const target = { ...source, id: 'new-parent', nativeId: null };
  const handoffs = new SessionHandoffs(root);
  const directory = join(root, 'session-handoffs', target.id);
  function transcript(agent: 'codex' | 'claude', rows: unknown[]) {
    const path = join(root, 'controller-homes', agent, source.id, agent === 'codex' ? 'sessions' : 'projects', 'project');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'native-old.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\nPARTIAL');
  }
  return { root, source, target, handoffs, directory, transcript, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const at = '2026-10-01T00:00:00Z';
function codex(type: string, values: object) { return { timestamp: at, type: 'response_item', payload: { type, ...values } }; }

test('handoff reads only delivered public replies, supports Code Mode, and excludes adjacent private tool input', () => {
  const f = fixture();
  try {
    f.transcript('codex', [
      codex('custom_tool_call', { name: 'exec', call_id: 'ok', input: 'text(await tools.bridge_send_user({"text":"只接上目标，保留纠正"})); text(await tools.bridge_start_worker({prompt:"PRIVATE_AFTER"}));' }),
      codex('custom_tool_call_output', { call_id: 'ok', output: JSON.stringify([{ type: 'input_text', text: '{"delivered":true}' }]) }),
      codex('custom_tool_call', { name: 'exec', call_id: 'unconfirmed', input: 'await tools.bridge_send_user({text:"NOT_DELIVERED"})' }),
      codex('function_call', { name: 'bridge_send_user', call_id: 'failed', arguments: '{"text":"FAILED_REPLY"}' }),
      codex('function_call_output', { call_id: 'failed', output: '{"delivered":false}' }),
      codex('message', { role: 'assistant', content: [{ type: 'output_text', text: 'DONE PRIVATE_REASONING' }] }),
    ]);
    f.handoffs.prepare(f.source, f.target, 'dm', [{ role: 'user', text: '纠正：必须卸载后重装', at }], []);
    const contents = readFileSync(join(f.directory, 'source.json'), 'utf8');
    assert.match(contents, /只接上目标，保留纠正/); assert.match(contents, /必须卸载后重装/);
    for (const secret of ['PRIVATE_AFTER', 'NOT_DELIVERED', 'FAILED_REPLY', 'PRIVATE_REASONING', 'DONE']) assert(!contents.includes(secret));
    const prompt = f.handoffs.prompt(f.target, 'dm');
    assert.match(prompt, /只读桥提供的旧会话材料/); assert.match(prompt, /硬上限3000/); assert.match(prompt, /不自动续做/);
  } finally { f.cleanup(); }
});

test('Claude native tool-use and confirmed tool-result provide public conversation evidence', () => {
  const f = fixture(); f.source.agent = 'claude'; f.target.agent = 'claude';
  try {
    f.transcript('claude', [
      { timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'mcp__bridge_controller__bridge_send_user', input: { text: 'CLAUDE_PUBLIC' } }] } },
      { timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '{"delivered":true}' }] }] } },
    ]);
    f.handoffs.prepare(f.source, f.target, 'dm', [], []);
    assert.match(readFileSync(join(f.directory, 'source.json'), 'utf8'), /CLAUDE_PUBLIC/);
  } finally { f.cleanup(); }
});

test('summary is bounded, privately persisted, scoped to user/chat/workspace, and never changes MEMORY', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'MEMORY.md'), 'USER_MEMORY');
    f.handoffs.prepare(f.source, f.target, 'dm', [], []);
    for (const owner of [{ ...f.target, userId: 'other' }, { ...f.target, cwd: 'other' }]) assert.throws(() => f.handoffs.get(owner, 'dm'), /不匹配/);
    assert.throws(() => f.handoffs.prompt(f.target, 'other'), /不匹配/);
    assert.throws(() => f.handoffs.prepare({ ...f.source, userId: 'other' }, f.target, 'dm', [], []), /跨用户/);
    assert.throws(() => f.handoffs.finish(f.target, 'dm', JSON.stringify({ workspaceContext: 'context', continuation: '字'.repeat(3001) })), /字数上限/);
    assert.equal(existsSync(join(f.directory, 'context.md')), false);
    const text = f.handoffs.finish(f.target, 'dm', JSON.stringify({ workspaceContext: '稳定约定', continuation: '待办：用户确认后执行。'.repeat(10) }));
    assert.match(text, /历史会话交接摘要/); assert.match(text, /不自动重派/);
    assert.match(readFileSync(join(f.directory, 'context.md'), 'utf8'), /待办/);
    assert.equal(new SessionHandoffs(f.root).get(f.target, 'dm')!.status, 'ready');
    assert.equal(readFileSync(join(f.root, 'MEMORY.md'), 'utf8'), 'USER_MEMORY');
    writeFileSync(join(f.directory, 'source.json'), '{}');
    assert.throws(() => f.handoffs.prompt(f.target, 'dm'), /已改变/);
    assert.throws(() => f.handoffs.finish(f.target, 'dm', '{}'), /已改变/);
    assert.equal(f.handoffs.get({ ...f.target, id: 'fresh-parent' }), null);
  } finally { f.cleanup(); }
});

test('public journal stores only delivered bodies in exact user and channel scope, including after reopening', () => {
  const f = fixture(); let store = new SessionStore(f.root);
  try {
    const parent = store.createConversation('owner', 'codex', f.root);
    store.addMessage({ id: 'human', userId: 'owner', channelId: 'dm', text: 'REAL_INPUT', imagePaths: [] }, parent.id, 'completed');
    for (const [id, channel, state] of [['yes', 'dm', 'delivered'], ['no', 'dm', 'uncertain'], ['foreign', 'other', 'delivered']] as const) {
      store.claimPublicMessage(id, parent.id, 'native', channel, id, id + '_BODY'); store.finishPublicMessage(id, state);
    }
    store.close(); store = new SessionStore(f.root);
    const history = store.handoffHistory(parent.id, 'owner', 'dm');
    assert.deepEqual(history.map(item => item.text).sort(), ['REAL_INPUT', 'yes_BODY']);
    assert.throws(() => store.handoffHistory(parent.id, 'other', 'dm'), /其他用户/);
  } finally { store.close(); f.cleanup(); }
});

test('repeated continuation retains its compact prior context, and an explicit retry retains failed source evidence', () => {
  const f = fixture();
  try {
    f.handoffs.prepare(f.source, f.target, 'dm', [{ role: 'user', at, text: 'ORIGINAL_CORRECTION' }], []);
    const retry = { ...f.target, id: 'retry-parent' };
    f.handoffs.fail(f.target, 'dm', 'invalid summary');
    f.handoffs.prepare(f.target, retry, 'dm', [], []);
    assert.match(readFileSync(join(f.root, 'session-handoffs', retry.id, 'source.json'), 'utf8'), /ORIGINAL_CORRECTION/);
    f.handoffs.finish(retry, 'dm', JSON.stringify({ workspaceContext: 'context', continuation: 'PERSISTED_DECISIONS' }));
    const next = { ...retry, id: 'next-parent' };
    f.handoffs.prepare(retry, next, 'dm', [{ role: 'user', at, text: 'NEW_WORK' }], []);
    const snapshot = JSON.parse(readFileSync(join(f.root, 'session-handoffs', next.id, 'source.json'), 'utf8'));
    assert.match(snapshot.priorContext, /PERSISTED_DECISIONS/);
    assert.equal(snapshot.messages.at(-1).text, 'NEW_WORK');
  } finally { f.cleanup(); }
});
