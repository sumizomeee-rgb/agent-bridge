import { isObject } from '../agents/process.js';
import { harnessText } from '../harness.js';
const mutations = new Set(['bridge_start_worker', 'bridge_continue_worker', 'bridge_cancel_worker', 'bridge_schedule_worker', 'bridge_handoff_worker']);
/** Model-facing results only; persistence and execution retain structured data. */
export function compactControllerReceipt(name: string, value: unknown): unknown {
  if (name === 'bridge_read_file' && isObject(value) && Array.isArray(value.lines)) {
    const lines = value.lines as { line: number; startColumn: number; text: string }[];
    const next = isObject(value.next) ? value.next : null;
    return [
      typeof value.rule === 'string' ? value.rule : harnessText('tools.file_content_rule'),
      `文件：${JSON.stringify(value.path)}`,
      ...(value.resolvedPath !== value.path ? [`实际路径：${JSON.stringify(value.resolvedPath)}`] : []),
      `版本 expectedSha256：${value.sha256}`,
      `编码：${value.encoding}；文件字节：${value.bytes}；总行数：${value.totalLines}`,
      ...(value.changedDuringRead ? ['注意：读取期间文件发生变化，请重新核对，勿混用不同版本。'] : []),
      '--- 正文（行号|原文；非首列续读标为行号:起始列|原文）---',
      ...lines.map(line => `${line.line}${line.startColumn === 1 ? '' : ':' + line.startColumn}|${line.text}`),
      '--- 正文结束 ---',
      next ? `续读：startLine=${next.startLine}, startColumn=${next.startColumn}；expectedSha256 使用上方版本。`
        : `续读：无${lines.length ? '（已到文件末尾）' : '（本页为空）'}。`,
    ].join('\n');
  }
  if (!mutations.has(name) || !isObject(value) || !isObject(value.target)) return value;
  const target = value.target;
  return { ...value, target: { id: target.id, label: target.label, transport: target.transport },
    details: 'bridge_list_workers({workerId}) 查看完整配置与回执。' };
}
