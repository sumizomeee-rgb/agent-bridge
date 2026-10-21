import type { BridgePresentation } from './presentation.js';

/** 程序通知统一短前缀；业务分支只选择语义，不拼接平台样式。 */
export const BRIDGE_NOTICE_PREFIX = '【桥】';
export const BRIDGE_NOTICE_COPY = {
  resultDeliveryFailed: { title: '汇报发送失败', tone: 'error', text: '结果已保存。' },
  resultPreparationFailed: { title: '汇报准备失败', tone: 'error', text: '结果已保存。' },
  resultDeliveryUncertain: { title: '汇报发送待核对', tone: 'error', text: '结果已保存。' },
  summaryFailed: { title: '汇总失败', tone: 'error', text: '助手结果已保存。' },
  summaryStopped: { title: '汇总已停止', tone: 'warning', text: '助手结果已保存。' },
  summaryInterrupted: { title: '汇总中断', tone: 'warning', text: '结果已保存，未自动重做。' },
  controllerReplyFailed: { title: '回复发送失败', tone: 'error', text: '本轮结果已保存。' },
  controllerFailed: { title: '主控执行失败', tone: 'error', text: '本轮已中断，请核对现场。' },
  commandFailed: { title: '命令失败', tone: 'error', text: '请核对命令或查看本地记录。' },
  messageFailed: { title: '消息处理失败', tone: 'error', text: '本条消息未处理完成。' },
  turnInterrupted: { title: '本轮中断', tone: 'warning', text: '请核对结果，未自动重做。' },
  controllerReplyMissing: { title: '缺少最终回复', tone: 'error', text: '本轮未发送最终回复。' },
  parentBindingChanged: { title: '汇总未执行', tone: 'warning', text: '父会话已改变，结果已保存。' },
  processExitUnconfirmed: { title: '退出待确认', tone: 'error', text: '报告已保存，请核对进程。' },
} as const satisfies Record<string, { title: string; tone: BridgePresentation['tone']; text: string }>;

export type BridgeNoticeCode = keyof typeof BRIDGE_NOTICE_COPY;
export interface BridgeNoticeParams { taskTitle?: string }

export function bridgeNotice(code: BridgeNoticeCode, params: BridgeNoticeParams = {}): BridgePresentation {
  const copy = BRIDGE_NOTICE_COPY[code];
  const taskTitle = [...(params.taskTitle ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()].slice(0, 80).join('');
  return { title: BRIDGE_NOTICE_PREFIX + copy.title, tone: copy.tone, purpose: 'status',
    blocks: [{ kind: 'text', text: copy.text }], ...(taskTitle ? { footer: '任务：' + taskTitle } : {}) };
}
