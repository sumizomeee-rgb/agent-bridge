import type { KnowledgeScope } from '../controller-knowledge.js';
import type { BridgePlatform } from '../types.js';

export const chatHistoryTools = new Set(['bridge_search_chat_history', 'bridge_read_chat_history']);

/** Produced from an admitted turn, never from tool arguments. */
export interface HistoryCaller {
  controllerId: string;
  principalId: string;
  botId?: string;
  platform?: BridgePlatform;
  spaceId?: string;
}

export interface HistoryEndpoint {
  controllerId: string;
  principalId: string;
  platform?: BridgePlatform;
  userId: string;
  authorized: boolean;
  routes: readonly { userId: string; channelId: string; private: boolean }[];
  query(scope: KnowledgeScope, name: string, input: Record<string, unknown>): unknown;
}

/** One history query path for every controller port; persistence stays in its existing journal. */
export class ControllerHistoryService {
  constructor(private readonly resolve: (id: string) => HistoryEndpoint | undefined) {}

  query(caller: HistoryCaller, name: string, args: Record<string, unknown>,
    own: (input: Record<string, unknown>) => unknown): unknown {
    if (!chatHistoryTools.has(name)) throw new Error('跨主控仅支持只读聊天历史查询。');
    const { targetBotId, ...input } = args;
    if (targetBotId === undefined) return own(input);
    if (typeof targetBotId !== 'string' || !targetBotId.trim() || targetBotId.length > 200 || targetBotId.includes('\0'))
      throw new Error('targetBotId为空或超过限制。');
    if (targetBotId === caller.controllerId || targetBotId === caller.botId) return own(input);
    if (caller.spaceId !== undefined) throw new Error('其他主控的私聊历史只能在负责人私聊中查询。');
    const target = this.resolve(targetBotId);
    if (!target || !target.authorized || target.principalId !== caller.principalId
      || caller.platform !== undefined && caller.platform !== target.platform)
      throw new Error('目标须为同一负责人名下的已登记主控；渠道入口还须为同平台。');
    const route = target.routes.filter(value => value.private && value.userId === target.userId).at(-1);
    if (!route) throw new Error('目标主控尚无该负责人的已保存私聊记录。');
    const result = target.query({ userId: target.userId, channelId: route.channelId, historyBotId: targetBotId }, name, input);
    return { targetBotId, ...(result as Record<string, unknown>) };
  }
}
