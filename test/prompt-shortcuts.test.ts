import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { readPromptShortcuts } from '../src/prompt-shortcuts.js';
import { SessionManager } from '../src/manager.js';
import { SessionStore } from '../src/store.js';
import { NumberedChoices } from '../src/numbered-choices.js';
import { slashText, GROUP_SLASH_COMMANDS } from '../src/slash.js';
import type { AgentAdapter, AgentTurn, BridgeConfig } from '../src/types.js';
import { ownTemporaryDirectory } from './temp-directory.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error('等待快捷提示词回合超时'); await delay(5); }
}

test('number selections bind the displayed order; changed lists or a fresh process never remap', () => {
  const list = new NumberedChoices<string>();
  assert.throws(() => list.select('a', 1, ['x']), /未查看/);
  list.remember('a', ['x', 'y']); assert.equal(list.select('a', 2, ['x', 'y']), 'y');
  assert.throws(() => list.select('a', 1, ['y', 'x']), /已变化/);
  assert.throws(() => list.select('a', 1, ['x', 'y']), /未查看/);
  list.remember('a', ['x']); assert.throws(() => list.select('b', 1, ['x']), /未查看/);
});

test('workspace shortcuts are shared, read live, queued as literal owner text, deduplicated and survive manager recreation', async t => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-shortcuts-')), 'bridge-shortcuts-');
  const path = join(root, 'bridge-prompts.json');
  const save = (text: string) => writeFileSync(path, JSON.stringify({ '1': { name: '继续', text }, '8': { name: '另一个', text: '固定编号' } }));
  save('原始目标\n**直接干活**');
  const turns: AgentTurn[] = [], replies: string[] = [], releases: Array<() => void> = [];
  const adapter: AgentAdapter = { async run(turn) {
    turns.push(turn); await new Promise<void>(resolve => releases.push(resolve));
    return { nativeId: 'native-test', text: '已完成', processStopped: true };
  }, async interrupt() { releases.splice(0).forEach(resolve => resolve()); }, async close() {} };
  const config: BridgeConfig = { workspace: root, contextWorkspace: root, dataDir: join(root, 'teto'), token: '',
    allowedUserIds: ['owner'], defaultAgent: 'codex', controllerMode: true, proxyUrl: null,
    maxImageBytes: 100, attachmentsDir: root, logsDir: root,
    commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } };
  const make = (config: BridgeConfig) => new SessionManager(config, { codex: adapter, claude: adapter }, { async sendText(_c, text) { replies.push(text); } }, { mergeDelayMs: 0 });
  let teto = make(config), miku = make({ ...config, dataDir: join(root, 'miku') });
  t.after(async () => { releases.splice(0).forEach(resolve => resolve()); await teto.close(); await miku.close(); });
  const send = (manager: SessionManager, id: string, text: string, userId = 'owner') => manager.handle({ id, text, userId, channelId: 'dm', imagePaths: [] });
  await send(teto, 'list', '/prompt'); assert.equal(turns.length, 0); assert(replies.at(-1)!.includes('8. 另一个'));
  await send(teto, 'unauthorized', '/prompt 1', 'other'); assert.equal(turns.length, 0);
  await send(teto, 'first', '/prompt 1'); await until(() => turns.length === 1);
  assert(turns[0]!.text.includes('原始目标\n**直接干活**'));
  await send(teto, 'first', '/prompt 1'); assert.equal(turns.length, 1);
  save('/stop'); // Saved prompts are messages, never re-parsed as bridge commands.
  await send(teto, 'queued', '/prompt 1'); assert.equal(turns.length, 1);
  releases.shift()!(); await until(() => turns.length === 2); assert(turns[1]!.text.includes('/stop'));
  releases.shift()!(); await until(() => !teto.controllerActivity(turns[1]!.conversation.id).running);
  const store = new SessionStore(config.dataDir);
  try { assert.equal(store.getMessage('queued')!.text, '/stop'); } finally { store.close(); }
  await teto.close(); teto = make(config);
  save('更新后的正文'); await send(miku, 'miku-live', '/prompt 1'); await until(() => turns.length === 3);
  assert(turns[2]!.text.includes('更新后的正文')); releases.shift()!();
  await send(teto, 'restarted', '/prompt 1'); await until(() => turns.length === 4);
  assert(turns[3]!.text.includes('更新后的正文')); releases.shift()!();
  await until(() => !teto.controllerActivity(turns[3]!.conversation.id).running);
  await send(teto, 'bad', '/prompt 2'); assert(replies.some(text => text.includes('没有编号 2')));
  writeFileSync(path, '{'); await send(teto, 'bad-json', '/prompt 1'); assert(replies.some(text => text.includes('读取失败')));
  assert.equal(turns.length, 4);
  assert.deepEqual(slashText({ name: 'prompt', options: [{ type: 3, name: 'number', value: '1' }] }), { text: '/prompt 1' });
  assert(!GROUP_SLASH_COMMANDS.some(c => c.name === 'prompt'));
});

test('prompt 1 template retains user wording and malformed entries cannot silently become messages', () => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-shortcuts-')), 'bridge-shortcuts-');
  const template = readFileSync(new URL('../../workspace-template/bridge-prompts.json', import.meta.url), 'utf8');
  writeFileSync(join(root, 'bridge-prompts.json'), template);
  assert(readPromptShortcuts(root)[0]!.text.endsWith('不要回复承诺，直接调用工具干活。**'));
  writeFileSync(join(root, 'bridge-prompts.json'), JSON.stringify({ '0': { name: 'bad', text: 'x' } }));
  assert.throws(() => readPromptShortcuts(root), /固定正整数/);
});
