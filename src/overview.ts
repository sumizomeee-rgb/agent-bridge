import type { AgentName, EffortConfiguration, EffortMetadata } from './types.js';
import { formatEffortEvidence } from './effort.js';
import { discordPresentationText, type BridgePresentation } from './presentation.js';

export interface WorkCounts { running: number; queued: number }
export interface ComputerOverview {
  targetId: string; label: string; transport: 'local' | 'ssh';
  connection: 'connected' | 'unreachable' | 'unknown'; checkedAt: string | null; reason?: string;
  agents: Array<{ agent: AgentName; cli: 'ready' | 'unavailable' | 'unknown'; reason?: string }>;
}
export interface WorkerOverview {
  workerId: string; conversationId: string; conversationTitle?: string;
  targetId: string; targetLabel: string; agent: AgentName; title: string;
  presetId?: string; presetLabel?: string;
  model: string | null; effort: string | null; nativeId: string | null;
  requestedEffort?: string | null; effortConfiguration?: EffortConfiguration | null; effortMetadata?: EffortMetadata | null;
  status: 'queued' | 'running' | 'retiring' | 'completed' | 'failed' | 'cancelled' | 'uncertain' | 'idle' | 'handed-off' | 'handoff-pending';
  running: boolean; queued: number; startedAt: string | null; endedAt?: string | null;
  blocked?: boolean; ownership?: 'bridge' | 'user'; statusReason?: string;
  resultKnown?: boolean; processStopped?: boolean; archivedAt?: string; archiveReason?: string;
  lastResultPreview?: string | null; unresolvedSupplements?: number;
}

export type WorkerView = 'active' | 'history';
/** 已完成轮次的 CLI 收尾属于历史；真实运行、排队及未解决异常仍可见。 */
export const isActiveWorker = (item: WorkerOverview): boolean => item.running || item.queued > 0
  || item.status === 'failed' && item.resultKnown === true && item.processStopped === false
  || (!(item.archivedAt && item.processStopped === true) && ['queued', 'running', 'uncertain', 'handoff-pending'].includes(item.status));

const clean = (value: string, limit = 120): string => {
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/`/g, 'ˋ').replace(/@/g, '＠').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
};
function workerEffort(item: WorkerOverview): string {
  return formatEffortEvidence(item.effortMetadata ?? { actual: item.effort, requested: item.requestedEffort, configuration: item.effortConfiguration });
}
const dispatchLabel = (item: WorkerOverview): string => item.presetId ? `预设·${clean(item.presetLabel || item.presetId, 32)}` : '普通';
const agentLabel = (agent: AgentName): string => agent === 'codex' ? 'Codex' : 'Claude Code';
const checkedTime = (value: string | null): string => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未检查';
};

/** 仅识别本模块生成的总览，在完整条目之间分页，不改变普通回复。 */
export function splitOverviewMessage(text: string, limit = 2000): string[] | null {
  if (!/^```ansi\n\u001b\[33m(?:当前工作区的电脑 · 已登记\d+台|(?:当前对话|你的全部对话)的(?:直属助手 · 运行\d+个 · 等待\d+轮(?: · 待核对\d+个)?(?: · 收尾\d+个)?|历史助手 · 共\d+个))\u001b\[0m\n```(?:\n\n|$)/.test(text)) return null;
  const [heading, ...blocks] = text.split('\n\n');
  if (!heading || !heading.endsWith('\n```') || heading.length > limit) throw new Error('总览标题超过消息限制。');
  const parts: string[] = [];
  let part = heading;
  for (const block of blocks) {
    if (heading.length + 2 + block.length > limit) throw new Error('总览条目超过消息限制。');
    if (part.length + 2 + block.length > limit) { parts.push(part); part = heading; }
    part += '\n\n' + block;
  }
  parts.push(part);
  return parts;
}

function computerDetails(items: readonly ComputerOverview[]): BridgePresentation {
  const title = `当前工作区的电脑 · 已登记${items.length}台`;
  if (!items.length) return { title, tone: 'info', purpose: 'overview', blocks: [{ kind: 'text', text: '当前工作区没有登记的电脑。' }] };
  return { title, tone: 'info', purpose: 'overview', blocks: items.map((item, index) => {
    const connection = { connected: '已连接', unreachable: '连接不可用', unknown: '连接尚未确认' }[item.connection];
    const hello = item.transport === 'local' ? '本机执行器（无需 SSH hello）'
      : item.connection === 'connected' ? '已回报' : '未确认';
    const lines = [`${index + 1}. ${clean(item.label)} · ${clean(item.targetId, 64)}`,
      `${item.transport === 'local' ? '本机连接' : 'SSH 连接'}：${connection}`, `执行器 hello：${hello}`,
      `检查时间：${checkedTime(item.checkedAt)}`];
    if (item.reason || item.connection === 'unreachable') lines.push(`失败原因：${item.reason ? clean(item.reason, 140) : '连接检查失败，具体原因未回报'}`);
    for (const agent of ['codex', 'claude'] as const) {
      const engine = item.agents.find(value => value.agent === agent);
      const cli = engine ? { ready: '可用', unavailable: '不可用', unknown: '未确认' }[engine.cli] : '未登记';
      const preparation = !engine ? '未登记' : item.connection === 'unreachable' || engine.cli === 'unavailable' ? '未就绪'
        : item.connection === 'connected' && engine.cli === 'ready' ? '入口已就绪（模型未实测）' : '未确认';
      lines.push(`${agentLabel(agent)} CLI 静态入口：${cli}`, `${agentLabel(agent)} 直属派发准备：${preparation}`);
      if (engine?.reason || engine?.cli === 'unavailable') lines.push(`${agentLabel(agent)} 失败原因：${engine.reason ? clean(engine.reason, 140) : 'CLI 静态入口检查未通过，具体原因未回报'}`);
    }
    lines.push('模型实测：未提供实测结果');
    return { kind: 'entry', text: lines.join('\n') };
  }), footer: '登记仅表示已配置；连接和 CLI 静态入口检查不代表模型服务或现有会话一定健康。' };
}

/** Discord 展示入口；核心使用上面的结构化总览。 */
export const formatComputerOverview = (items: readonly ComputerOverview[], details = false): string => discordPresentationText(computerOverview(items, details));
export const formatWorkerOverview = (items: readonly WorkerOverview[], scope: 'current' | 'all', now = Date.now(), details = false, view: WorkerView = 'active'): string => discordPresentationText(workerOverview(items, scope, now, details, view));


/** 默认总览先呈现派发准备；原始检查证据只在 details 展开。 */
export function computerOverview(items: readonly ComputerOverview[], details = false): BridgePresentation {
  if (details) return computerDetails(items);
  const ready = (item: ComputerOverview) => item.connection === 'connected' && item.agents.some(agent => agent.cli === 'ready');
  const rank = (item: ComputerOverview) => ready(item) ? 0 : item.connection === 'unreachable' || item.agents.every(agent => agent.cli === 'unavailable') ? 2 : 1;
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
  const count = sorted.filter(ready).length;
  return { title: `当前工作区的电脑 · 已登记${items.length}台`, tone: 'info', purpose: 'overview',
    blocks: sorted.length ? [{ kind: 'entry', text: `✅ 就绪 ${count} 台 · ⚠️ 待确认 ${sorted.filter(item => rank(item) === 1).length} 台 · ❌ 不可用 ${sorted.filter(item => rank(item) === 2).length} 台` }, ...sorted.map((item, index) => {
      const lines = [`${ready(item) ? '✅' : rank(item) === 2 ? '❌' : '⚠️'} ${index + 1}. ${clean(item.label, 60)}`];
      for (const agent of ['codex', 'claude'] as const) {
        const cli = item.agents.find(value => value.agent === agent);
        const status = !cli ? '⚪ 未登记' : item.connection === 'unreachable' || cli.cli === 'unavailable' ? '❌ 不可用'
          : item.connection === 'connected' && cli.cli === 'ready' ? '✅ 可派发' : '⚠️ 待确认';
        lines.push(`${agentLabel(agent)}：${status}`);
      }
      if (item.connection === 'unreachable') lines.push(`连接：${clean(item.reason ?? '连接不可用', 70)}`);
      return { kind: 'entry' as const, text: lines.join('\n') };
    })] : [{ kind: 'text', text: '当前工作区没有登记的电脑。' }],
    footer: '✅ 表示连接与 CLI 入口就绪，模型需实际调用确认。/computers details 查看检查时间和详情。' };
}
/** 已收报告与程序退出分别展示；核对锁仍由运行时管理。 */
function workerReviewEvidence(item: WorkerOverview): string | undefined {
  if (!item.blocked && item.status !== 'uncertain') return undefined;
  if (item.resultKnown) return '报告已保存；' + (item.processStopped === true ? '退出已确认，结果待核对' : '退出待确认');
  if (item.processStopped === true) return '退出已确认，结果待核对';
  return undefined;
}

export function workerOverview(items: readonly WorkerOverview[], scope: 'current' | 'all', now = Date.now(), details = false, view: WorkerView = 'active'): BridgePresentation {
  const label = scope === 'all' ? '你的全部对话' : '当前对话';
  const running = items.filter(item => item.running).length, queued = items.reduce((sum, item) => sum + item.queued, 0);
  const uncertain = items.filter(item => item.status === 'uncertain').length;
  const retiring = items.filter(item => item.status === 'retiring').length;
  const rank = (item: WorkerOverview) => item.running ? 0 : ['uncertain', 'handoff-pending'].includes(item.status) ? 1 : item.queued ? 2 : 3;
  const endedAt = (item: WorkerOverview) => {
    const timestamp = Date.parse(item.endedAt ?? '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || endedAt(b) - endedAt(a));
  if (details) return workerDetails(sorted, scope, now, view);
  const states = { queued: '⏳ 等待执行', running: '🔄 运行中', retiring: '✅ 本轮完成 · CLI 收尾中', completed: '✅ 已完成', failed: '❌ 失败', cancelled: '⏹ 已停止', uncertain: '⚠️ 待核对', idle: '💤 空闲', 'handed-off': '👤 已交给你', 'handoff-pending': '⚠️ 交接待确认' };
  return { title: view === 'history' ? `${label}的历史助手 · 共${items.length}个` : `${label}的直属助手 · 运行${running}个 · 等待${queued}轮${uncertain ? ` · 待核对${uncertain}个` : ''}${retiring ? ` · 收尾${retiring}个` : ''}`, tone: 'info', purpose: 'overview',
    blocks: sorted.length ? sorted.map((item, index) => {
      const model = item.model ? clean(item.model, 60).replace(/^gpt-/i, '') : '模型未知';
      const effort = workerEffort(item);
      const status = item.archivedAt && item.processStopped === true && !item.running && !item.queued ? '📁 已归档' : ['uncertain', 'handoff-pending', 'handed-off', 'retiring'].includes(item.status) ? states[item.status] : item.running ? states.running : item.queued ? states.queued : states[item.status];
      const elapsed = item.status === 'uncertain' ? '耗时未知' : item.running ? elapsedText(item.startedAt, now) : item.endedAt ? elapsedText(item.startedAt, Date.parse(item.endedAt)) : item.queued ? '尚未开始' : '耗时未回报';
      const lines = [`${index + 1}. ${dispatchLabel(item)} · ${clean(item.targetId === 'local' ? '桥电脑' : item.targetLabel, 40)} · ${agentLabel(item.agent)} · ${model} · ${effort} · ${shortWorkerId(item, items)}`,
        `${status} · ${elapsed}${item.queued ? ` · 等待${item.queued}轮` : ''}`, `任务：${clean(item.title, 70)}`];
      if (scope === 'all') lines.push(`主控：${clean(item.conversationTitle ?? item.conversationId, 40)}`);
      if (item.archivedAt) lines.push(`归档：${clean(item.archiveReason ?? '已确认停止，保留异常历史', 80)}`);
      if (item.blocked || workerReviewEvidence(item) || item.statusReason && ['uncertain', 'failed', 'handoff-pending'].includes(item.status)) lines.push(`${item.status === 'failed' && item.processStopped === true ? '失败原因' : '需核对'}：${workerReviewEvidence(item) ?? clean(item.statusReason ?? '任务已阻塞', 180)}`);
      return { kind: 'entry', text: lines.join('\n') };
    }) : [{ kind: 'text', text: view === 'history' ? `${label}没有历史助手。` : `${label}没有正在执行、排队或待核对的助手。` }], footer: view === 'history' ? '/workers 查看未结束助手 · /workers history details 查看历史详情。' : '/workers history 查看历史 · /workers details 查看完整 ID 与回执。' };
}

export function elapsedText(startedAt: string | null, now = Date.now()): string {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(now) || started > now) return '开始时间未记录';
  const seconds = Math.floor((now - started) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}小时${minutes}分` : minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function shortWorkerId(item: WorkerOverview, items: readonly WorkerOverview[]): string {
  let length = Math.min(8, item.workerId.length);
  while (length < item.workerId.length && items.some(other => other.workerId !== item.workerId && other.workerId.startsWith(item.workerId.slice(0, length)))) length++;
  return clean(item.workerId.slice(0, length), 256);
}

function workerDetails(items: readonly WorkerOverview[], scope: 'current' | 'all', now = Date.now(), view: WorkerView = 'active'): BridgePresentation {
  const prefix = scope === 'all' ? '你的全部对话' : '当前对话';
  const running = items.filter(item => item.running).length;
  const queued = items.reduce((total, item) => total + item.queued, 0);
  const uncertain = items.filter(item => item.status === 'uncertain').length;
  const retiring = items.filter(item => item.status === 'retiring').length;
  const title = view === 'history' ? `${prefix}的历史助手 · 共${items.length}个` : `${prefix}的直属助手 · 运行${running}个 · 等待${queued}轮${uncertain ? ` · 待核对${uncertain}个` : ''}${retiring ? ` · 收尾${retiring}个` : ''}`;
  if (!items.length) return { title, tone: 'info', purpose: 'overview', blocks: [{ kind: 'text', text: view === 'history' ? `${prefix}没有历史助手。` : `${prefix}没有正在执行、排队或待核对的助手。` }] };
  const statuses = { queued: '等待执行', running: '运行中', retiring: '本轮完成 · CLI 收尾中', completed: '已完成', failed: '失败', cancelled: '已停止', uncertain: '状态待核对', idle: '空闲', 'handed-off': '已交给用户', 'handoff-pending': '交接待确认' };
  return { title, tone: 'info', purpose: 'overview', blocks: items.map((item, index) => {
    const status = ['uncertain', 'handoff-pending', 'handed-off', 'retiring'].includes(item.status) ? statuses[item.status]
      : item.running ? '运行中' : item.queued > 0 ? '等待执行' : statuses[item.status];
    const elapsed = item.status === 'uncertain' ? '未知（状态待核对）' : item.running ? elapsedText(item.startedAt, now)
      : item.status === 'queued' || item.queued > 0 && item.status !== 'retiring' ? '尚未开始'
      : item.endedAt ? elapsedText(item.startedAt, Date.parse(item.endedAt)) : '未回报';
    const model = item.model ? clean(item.model).replace(/^gpt-/i, '') || '模型未知' : '模型未知';
    const effort = workerEffort(item);
    const computer = item.targetId === 'local' ? '桥电脑' : clean(item.targetLabel);
    const lines = [`${index + 1}. ${dispatchLabel(item)} · ${computer} · ${agentLabel(item.agent)} · ${model} · ${effort} · ${shortWorkerId(item, items)}`,
      `会话名：${clean(item.title, 80)}`, `电脑：${clean(item.targetLabel)} · target ID：${clean(item.targetId, 64)}`,
      `workerId：${clean(item.workerId, 256)}`, `原生会话 ID：${item.nativeId ? clean(item.nativeId, 256) : '未回报'}`];
    if (item.presetId) lines.push(`预设 ID：${clean(item.presetId, 96)}`);
    const metadata = item.effortMetadata, configuration = metadata ? metadata.configuration : item.effortConfiguration;
    const requested = metadata ? metadata.requested : item.requestedEffort, observed = metadata ? metadata.actual : item.effort;
    lines.push(`强度指定：${requested ? clean(requested, 30) : 'CLI 默认'} · CLI 回报：${observed ? clean(observed, 30) : '未回报'}`);
    if (configuration) lines.push(`启动配置：${clean(configuration.value, 30)} · 来源：${configuration.source}${configuration.applied === false ? ` · 未采用${configuration.reason ? `：${clean(configuration.reason, 100)}` : ''}` : ''}`);
    if (metadata) lines.push(`强度能力：${metadata.capability.status === 'unsupported' ? '不支持可调强度' : metadata.capability.status === 'supported' ? metadata.capability.levels.map(value => clean(value, 32)).join('、') : '未提供证据'} · 来源：${clean(metadata.capability.source, 80)}`);
    if (scope === 'all') lines.push(`主控对话：${clean(item.conversationTitle ?? item.conversationId, 80)}`);
    if (item.archivedAt) lines.push(`归档：${clean(item.archiveReason ?? '已确认停止，保留异常历史', 80)}`);
    if (item.blocked) lines.push('阻塞：' + (workerReviewEvidence(item) ?? '已阻塞，需先核对结果与进程'));
    if (item.ownership) lines.push(`拥有权：${item.ownership === 'user' ? '用户' : '桥'}`);
    if (item.statusReason || workerReviewEvidence(item)) lines.push(`状态说明：${workerReviewEvidence(item) ?? clean(item.statusReason!, 140)}`);
    if (item.lastResultPreview != null) lines.push(`最近回执：${clean(item.lastResultPreview, 180)}`);
    if (item.unresolvedSupplements) lines.push(`未确认补充回执：${item.unresolvedSupplements}条`);
    lines.push(`${status} · 本轮耗时：${elapsed} · 等待${item.queued}轮`);
    return { kind: 'entry', text: lines.join('\n') };
  }), footer: '模型来自 CLI 回报；强度优先显示回报，〔配置〕和〔指定〕仅表示启动设置，未证明模型实际执行。完整会话名、回执及续接/取消/交接操作可由主控按完整 workerId 查询，原有权限检查仍适用。' };
}
