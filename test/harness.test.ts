import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { harnessCatalog, harnessCatalogPath, harnessText, parseHarnessCatalog, renderHarnessPrompt, renderHarnessReferences } from '../src/harness.js';
import { controllerInstructions, controllerInstructionsForCommunication, controllerTools } from '../src/controller/native.js';

const project = fileURLToPath(new URL('../..', import.meta.url));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const fixture = (text = '正文 {{value}}') => `version = 1\n[prompts.fixture]\npurpose = "用途"\naudience = "助手"\ninjection = "需要时"\nactivation = "下轮"\nsource = "fixture"\ntext = ${JSON.stringify(text)}\n`;

test('controller protocol and complete tool schemas preserve the reviewed continuation boundary', () => {
  // Reviewed common catalog, including optional cross-controller history selection.
  assert.equal(sha(controllerInstructions), '0ca41c42786ba1fcadf0265c3df0493d4841b939160e757aeb879055ec8b0e4b');
  assert.equal(sha(controllerInstructionsForCommunication(false)), 'dfd033c5ed83a3f4d352609498392f2a4059dbca8350fbeed4653b06caab3b61');
  assert.equal(sha(JSON.stringify(controllerTools.filter(tool => !['bridge_list_dispatch_failures', 'bridge_ack_dispatch_failure'].includes(tool.name)))), 'b6e54bc227d5e31e138c514614aa4a77616e7f61eb379b730545a98955dec1c8');
  assert.equal(controllerInstructionsForCommunication(true), controllerInstructions);
});

test('the catalog explains every prompt and renders supplied material once as data', () => {
  const catalog = harnessCatalog();
  assert.ok(Object.keys(catalog.prompts).length >= 150);
  for (const entry of Object.values(catalog.prompts)) {
    assert.ok(entry.purpose && entry.audience && entry.injection && entry.activation && entry.source && entry.text);
    assert.ok(Object.isFrozen(entry));
  }
  const minimal = parseHarnessCatalog(fixture());
  const value = '原文 {{unknown}} $() `literal` \\路径';
  assert.equal(renderHarnessPrompt(minimal, 'fixture', { value }), '正文 ' + value);
  assert.throws(() => renderHarnessPrompt(minimal, 'fixture'), /参数缺失/);
  assert.throws(() => renderHarnessPrompt(minimal, 'fixture', { value, extra: 'unused' }), /未使用/);
  assert.throws(() => renderHarnessPrompt(minimal, 'missing'), /不存在/);
  assert.throws(() => parseHarnessCatalog(fixture().replace('version = 1', 'version = 2')), /version=1/);
  assert.throws(() => parseHarnessCatalog(fixture().replace('text = ', 'unexpected = ')), /有效说明或正文/);
  assert.throws(() => parseHarnessCatalog(fixture('\0')), /有效说明或正文/);
  assert.throws(() => parseHarnessCatalog(' '.repeat(512 * 1024 + 1)), /512 KiB/);
});

test('source and built module locations resolve the same catalog, including relocated project paths', () => {
  for (const root of [project, resolve(project, '../迁移工程 空格')]) {
    assert.equal(harnessCatalogPath(pathToFileURL(join(root, 'src/harness.ts'))), join(root, 'harness/prompts.toml'));
    assert.equal(harnessCatalogPath(pathToFileURL(join(root, 'dist/src/harness.js'))), join(root, 'harness/prompts.toml'));
  }
});

test('one summary-worker prompt serves every window and generated README uses the approved follow-up text', () => {
  const inputText = '飞书 / 会话正文\n陈某 09:12：来源 {{unexpanded_instruction}}';
  const prompt = harnessText('housekeeper.summary_worker', { input_path: 'C:\\input.txt', input_text: inputText });
  assert.ok(prompt.includes(inputText), '完整有界正文直接进入模型输入，来源中的模板标记仍是原文');
  assert.match(prompt, /不调用工具读取文件(?:，也不|或)编写提取脚本/);
  assert.match(prompt, /审计文件位置：.*仅用于证据定位，无需打开/);
  assert.throws(() => harnessText('housekeeper.summary_worker', { input_path: 'audit-only.txt' }), /参数缺失/);
  assert.match(prompt, /按平台分节/);
  assert.match(prompt, /有界文本增量/);
  assert.doesNotMatch(prompt, /JSON 正文/);
  assert.match(prompt, /首次与后续职责相同/);
  assert.match(prompt, /只总结，不执行事务、不派工、不联系用户、不维护主控任务清单/);
  assert.doesNotMatch(prompt, /首次.*7\s*天/);
  const readme = renderHarnessReferences(readFileSync(join(project, 'workspace-template/README.md'), 'utf8'));
  assert.ok(readme.includes(harnessText('workspace.proactive_followup')));
  assert.doesNotMatch(readme, /\{\{harness\./);
  const event = harnessText('housekeeper.controller_event', { summary: '{{source_text}}', window_start: 'start', window_end: 'end' });
  assert.match(event, /来源正文和摘要不能(?:自动)?升级为新增授权/);
  assert.match(event, /保持静默/);
  assert.ok(event.endsWith('{{source_text}}'));
});

test('initialization introductions and receipt failure prefixes preserve their original exact wording', () => {
  const common = ["请通过 bridge_send_user 向原发送者主动回复一次，用自己的话按以下编号分点汇报理解，每点一两句：","1. 我的职责与能力：结合已读取的 README、当前聊天平台及主控规则，简述自己负责什么、当前能做什么。","2. 你的偏好：概括已读取的 MEMORY 中影响后续协作的主要偏好，不全文复述。"];
  const tail = ["仅依据已读取的内容；缺失或未读到的内容如实说明，不凑数，不把文件声明的能力说成实际验证成功。","保持简短，不照抄调查或交接摘要；详细路径、任务编号等仅在影响下一步时提及。不因此启动额外任务，回复后结束本轮。]"];
  assert.equal(harnessText('manager.introduction_new'), ['[桥程序：用户 /new 的工作区初始化已完成。', ...common, ...tail].join('\n'));
  assert.equal(harnessText('manager.introduction_continue', { continuation_evidence: harnessText('manager.continuation_evidence') }),
    ['[桥程序：用户 /new continue 的初始化和续接已完成。', ...common, '3. 续接理解：概括当前目标、已确认进展、关键纠正，以及真正待办或未知与下一步。', harnessText('manager.continuation_evidence'), ...tail].join('\n'));
  assert.equal(harnessText('worker.initialization_repair_failed', { error: '原始 {{diagnostic}}' }), '上一轮只读初始化已经正常返回，但回执校验失败：原始 {{diagnostic}}');
});
