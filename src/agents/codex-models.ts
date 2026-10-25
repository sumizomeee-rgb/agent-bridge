import { normalizeEffortCapability } from '../effort.js';
import type { AgentModelInfo } from '../types.js';
import { isObject, type JsonRpcClient } from './process.js';

/** 只查询已初始化的连接；不创建线程、提交输入或管理其进程。 */
export async function readCodexModelInfo(rpc: Pick<JsonRpcClient, 'request'>, cwd: string): Promise<AgentModelInfo> {
  const configured = await rpc.request('config/read', { includeLayers: false, cwd }, 15_000);
  const config = isObject(configured.config) ? configured.config : {};
  const models: AgentModelInfo['models'] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 15_000);
    if (!Array.isArray(page.data)) throw new Error('Codex 模型目录格式不正确。');
    for (const value of page.data) {
      if (!isObject(value) || typeof value.model !== 'string' || !value.model || value.hidden === true) continue;
      if (!models.some(model => model.id === value.model)) models.push({
        id: value.model, displayName: typeof value.displayName === 'string' ? value.displayName : value.model,
        description: typeof value.description === 'string' ? value.description : '', isDefault: value.isDefault === true,
        effortCapability: normalizeEffortCapability('codex', Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts.map(item => isObject(item) ? item.reasoningEffort : null) : undefined, { source: 'codex-model-list', modelId: value.model }),
        ...(Array.isArray(value.supportedReasoningEfforts) ? { supportedEfforts: value.supportedReasoningEfforts.filter(isObject).map(item => item.reasoningEffort).filter((item): item is string => typeof item === 'string') } : {}),
      });
    }
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error('Codex 模型目录分页异常。');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { models, source: 'codex-model-list', defaultModel: typeof config.model === 'string' && config.model ? config.model : models.find(model => model.isDefault)?.id ?? null };
}
