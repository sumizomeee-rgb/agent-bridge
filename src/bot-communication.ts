/** 仅管理跨 Bot 的后台通道，不限制直属助手、群公开交流或群静默。 */
export const internalBotCommunicationTools = new Set(['bridge_send_bot', 'bridge_propose_handoff', 'bridge_accept_handoff']);

export function assertBotCommunicationAllowed(enabled: boolean | undefined, name: string, args: Record<string, unknown>): void {
  if (enabled !== false) return;
  if (internalBotCommunicationTools.has(name) || name === 'bridge_start_collaboration' && args.mode === 'internal') {
    throw new Error('后台 Bot 互通已关闭（internalBotCommunicationEnabled=false），本次操作未执行。可在已授权群公开交流；不要把内部或私聊正文自动改发到群。');
  }
}
