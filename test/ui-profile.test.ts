import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { computerOverview, workerOverview, type ComputerOverview } from '../src/overview.js';
import { feishuPresentationCards } from '../src/presentation.js';
import { slashText } from '../src/slash.js';

test('代理属于启动 Profile；Discord 可指定端口，飞书直连且不继承公共旧字段', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-profile-network-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bots/discord'), { recursive: true }); mkdirSync(join(root, 'bots/feishu'), { recursive: true });
  const common = { version: 2, startupProfile: 'discord/default', workspace: root, dataDir: root, commands: {
    codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } };
  const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify(common));
  writeFileSync(join(root, 'bots/discord/default.json'), JSON.stringify({ applicationId: '123456789012345678', token: 'secret', allowedUserIds: ['123456789012345679'], network: { proxyPort: 7898 } }));
  const feishu = { applicationId: 'cli_personal', appSecret: 'secret', allowedUserIds: ['ou_owner'], network: { proxyPort: null } };
  writeFileSync(join(root, 'bots/feishu/default.json'), JSON.stringify(feishu));
  assert.equal(loadConfig(['--config', path], false).proxyUrl, 'http://127.0.0.1:7898');
  assert.equal(loadConfig(['--config', path, '--profile', 'feishu/default'], false).proxyUrl, null);
  assert.equal(loadConfig(['--config', path, '--profile', 'feishu/default', '--proxy-port', '7899'], false).proxyUrl, 'http://127.0.0.1:7899');
  writeFileSync(path, JSON.stringify({ ...common, proxyPort: 7898 })); assert.throws(() => loadConfig(['--config', path], false), /启动 Profile/);
  writeFileSync(path, JSON.stringify(common));
  for (const port of [0, 65536, '7898', 1.5]) {
    writeFileSync(join(root, 'bots/feishu/default.json'), JSON.stringify({ ...feishu, network: { proxyPort: port } }));
    assert.throws(() => loadConfig(['--config', path, '--profile', 'feishu/default'], false), /代理端口/);
  }
});
test('电脑默认按就绪排序，逐行标记 CLI，不把未知或登记状态当成可用', () => {
  const items: ComputerOverview[] = [
    { targetId: 'offline', label: '家里本机', transport: 'ssh', connection: 'unreachable', checkedAt: null, agents: [{ agent: 'codex', cli: 'unknown' }] },
    { targetId: 'maybe', label: '待确认电脑', transport: 'ssh', connection: 'unknown', checkedAt: null, agents: [{ agent: 'codex', cli: 'ready' }] },
    { targetId: 'ready', label: '工位', transport: 'ssh', connection: 'connected', checkedAt: null, agents: [{ agent: 'codex', cli: 'ready' }, { agent: 'claude', cli: 'unavailable' }] },
  ];
  const view = computerOverview(items); const text = view.blocks.map(block => block.text).join('\n');
  assert.match(view.blocks[1]!.text, /^✅ 1\. 工位\nCodex：✅ 可派发\nClaude Code：❌ 不可用$/);
  assert.match(view.blocks[2]!.text, /Codex：⚠️ 待确认/); assert.match(view.blocks[3]!.text, /Codex：❌ 不可用/);
  assert(!text.includes('执行器 hello') && !text.includes('检查时间') && !text.includes('模型实测'));
  assert.match(computerOverview(items, true).blocks[0]!.text, /执行器 hello/);
  const card = feishuPresentationCards(view)[0]!;
  for (const element of (card.body as any).elements.filter((item: any) => item.tag === 'div')) assert.equal(element.text.tag, 'plain_text');
  assert((card.body as any).elements.some((item: any) => item.text?.content.includes('工位\nCodex：')));
});
test('助手默认三行，长回执和完整内部 ID 只在 details 展示', () => {
  const worker = { workerId: '12345678-1234-1234-1234-123456789012', conversationId: 'parent', targetId: 'workstation', targetLabel: '工位', agent: 'codex' as const,
    title: '只读理解工作区', model: 'gpt-6.1-sol', effort: 'xhigh', nativeId: 'NATIVE_FULL_PRIVATE', status: 'completed' as const, running: false, queued: 0,
    startedAt: '2026-10-14T10:00:00Z', endedAt: '2026-10-14T10:01:21Z', lastResultPreview: 'LONG_RESULT_BODY'.repeat(20) };
  const brief = workerOverview([worker], 'current').blocks[0]!.text;
  assert.equal(brief.split('\n').length, 3); assert.match(brief, /^1\. 工位 · Codex · 6\.1-sol · 极高 · 12345678\n✅ 已完成 · 1分21秒\n任务：只读理解工作区$/);
  assert(!brief.includes(worker.nativeId) && !brief.includes(worker.workerId) && !brief.includes('LONG_RESULT_BODY'));
  const detail = workerOverview([worker], 'current', Date.now(), true).blocks[0]!.text;
  assert(detail.includes(worker.nativeId) && detail.includes(worker.workerId) && detail.includes('LONG_RESULT_BODY'));
});
test('原生菜单 details 映射到同一文字命令，不另起平台清单', () => {
  assert.deepEqual(slashText({ name: 'workers', options: [{ name: 'scope', type: 3, value: 'all' }, { name: 'details', type: 5, value: true }] }), { text: '/workers all details' });
  assert.deepEqual(slashText({ name: 'computers', options: [{ name: 'refresh', type: 5, value: false }, { name: 'details', type: 5, value: true }] }), { text: '/computers cached details' });
});
