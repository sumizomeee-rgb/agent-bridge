import type { BridgePresentation } from './presentation.js';

/** 程序通知统一短前缀；业务分支只选择语义，不拼接平台样式。 */
export const BRIDGE_NOTICE_PREFIX = '【桥】';
export const BRIDGE_NOTICE_COPY = {
  workerInputFailed: { title: '补充未送达', tone: 'error', text: '未自动排队。' },
  workerInputUncertain: { title: '补充发送待核对', tone: 'error', text: '未自动重发。' },
  resultDeliveryFailed: { title: '汇报发送失败', tone: 'error', text: '结果已保存。' },
  resultPreparationFailed: { title: '汇报准备失败', tone: 'error', text: '结果已保存。' },
  resultDeliveryUncertain: { title: '汇报发送待核对', tone: 'error', text: '结果已保存。' },
  summaryFailed: { title: '汇总失败', tone: 'error', text: '助手结果已保存。' },
  wakeFailed: { title: '唤醒失败', tone: 'error', text: '本次唤醒未完成，请核对状态。' },
  wakePreparationFailed: { title: '唤醒失败', tone: 'error', text: '本次未提交给主控。' },
  wakeStopped: { title: '唤醒已停止', tone: 'warning', text: '本次唤醒已停止。' },
  controllerDeliveryUncertain: { title: '回复投递待核对', tone: 'error', text: '回复可能已送达，但尚未取得确认；未自动重发。' },
  controllerSubmissionUnknown: { title: '主控接收待核对', tone: 'error', text: '消息已尝试提交，但未能确认接收或结果；未自动重发。' },
  controllerExecutionInterrupted: { title: '本轮中断，会话可继续', tone: 'error', text: '主控已接收原消息，但本轮未完成回复。异常已记录，主控下一轮会收到并核对已有操作；你可以直接发消息继续，无需重启。本次未自动重试。' },
  controllerPreparationFailed: { title: '主控准备失败', tone: 'error', text: '本轮未提交给主控。' },
  controllerStopUnconfirmed: { title: '退出待确认', tone: 'error', text: '主控进程退出未确认，请核对状态。' },
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
