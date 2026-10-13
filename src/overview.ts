import type { AgentName } from './types.js';

export interface WorkCounts { running: number; queued: number }
export interface ComputerOverview {
  targetId: string; label: string; transport: 'local' | 'ssh';
  connection: 'connected' | 'unreachable' | 'unknown'; checkedAt: string | null; reason?: string;
  agents: Array<{ agent: AgentName; cli: 'ready' | 'unavailable' | 'unknown'; reason?: string }>;
}
export interface WorkerOverview {
  workerId: string; conversationId: string; conversationTitle?: string;
  targetId: string; targetLabel: string; agent: AgentName; title: string;
  model: string | null; effort: string | null; nativeId: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain' | 'idle' | 'handed-off' | 'handoff-pending';
  running: boolean; queued: number; startedAt: string | null;
}

const clean = (value: string, limit = 100): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const agentLabel = (agent: AgentName): string => agent === 'codex' ? 'Codex' : 'Claude Code';
const checkedTime = (value: string | null): string => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未检查';
};

export function formatComputerOverview(items: readonly ComputerOverview[]): string {
  if (!items.length) return '当前工作区没有登记的电脑。';
  return ['当前工作区的电脑与 Agent', ...items.map(item => {
    const connection = { connected: '已连接', unreachable: '连接不可用', unknown: '连接尚未确认' }[item.connection];
    const agents = item.agents.length ? item.agents.map(engine => {
      const status = { ready: 'CLI 入口可用', unavailable: 'CLI 入口不可用', unknown: 'CLI 入口尚未确认' }[engine.cli];
      return `${agentLabel(engine.agent)}：${status}${engine.reason ? `（${clean(engine.reason, 140)}）` : ''}`;
    }).join('\n  ') : '未登记 Agent';
    return `${clean(item.label)}（${clean(item.targetId, 64)} · ${item.transport === 'local' ? '桥电脑' : '跨电脑'}）\n  ${connection}${item.reason ? `：${clean(item.reason, 140)}` : ''}；检查：${checkedTime(item.checkedAt)}\n  ${agents}`;
  }), '登记仅表示已配置；CLI 入口可用不代表模型服务或现有会话一定健康。'].join('\n\n');
}

export function elapsedText(startedAt: string | null, now = Date.now()): string {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(started) || started > now) return '开始时间未记录';
  const seconds = Math.floor((now - started) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}小时${minutes}分` : minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

export function formatWorkerOverview(items: readonly WorkerOverview[], scope: 'current' | 'all', now = Date.now()): string {
  const active = items.filter(item => item.running || item.queued > 0 || item.status === 'uncertain' || item.status === 'handoff-pending');
  const prefix = scope === 'all' ? '你的全部对话' : '当前对话';
  if (!active.length) return `${prefix}没有运行、排队或待核对的直属 Agent。`;
  const running = active.filter(item => item.running).length;
  const queued = active.reduce((total, item) => total + item.queued, 0);
  const uncertain = active.filter(item => item.status === 'uncertain').length;
  const heading = `${prefix}的直属 Agent · 运行 ${running} 个 · 等待 ${queued} 轮${uncertain ? ` · 待核对 ${uncertain} 个` : ''}`;
  const statuses = { queued: '等待执行', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已停止', uncertain: '状态待核对', idle: '空闲', 'handed-off': '已交给用户', 'handoff-pending': '交接待确认' };
  return [heading, ...active.map(item => {
    const status = item.status === 'uncertain' || item.status === 'handoff-pending' ? statuses[item.status] : item.running ? '运行中' : item.queued > 0 ? '等待执行' : statuses[item.status];
    const elapsed = item.running ? elapsedText(item.startedAt, now) : item.status === 'uncertain' ? '无法确认' : '尚未开始';
    const source = scope === 'all' ? `\n  主控对话：${clean(item.conversationTitle ?? item.conversationId)}` : '';
    return `${clean(item.title)} · ${clean(item.workerId, 8)}\n  ${clean(item.targetLabel)}（${clean(item.targetId, 64)}） · ${agentLabel(item.agent)}\n  模型：${item.model ? clean(item.model) : '未确认'}；强度：${item.effort ? clean(item.effort) : '未确认'}\n  ${status}；本轮耗时：${elapsed}；等待 ${item.queued} 轮${source}`;
  })].join('\n\n');
}
