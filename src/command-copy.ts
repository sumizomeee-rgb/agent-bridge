import { agentEffortProtocol } from './effort.js';
import { workerDefaultUsage } from './controller/worker-selection.js';

/** 只映射已知的输入错误；未知异常继续使用通用回执，不公开内部诊断。 */
export function commandFailureCopy(name: string, argument: string, error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (name === 'cwd') {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return '未新建会话：目录不存在，请核对路径后重试。';
    if (code === 'EACCES' || code === 'EPERM') return '未新建会话：无权访问目录，请检查目录权限。';
  }
  if (name === 'effort' || name === 'model' || name === 'default') {
    for (const agent of ['codex', 'claude'] as const) if (error.message.startsWith(`${agent} CLI 不支持强度 `)) {
      const levels = agentEffortProtocol[agent].levels;
      return `未修改设置：${agent === 'codex' ? 'Codex' : 'Claude'} CLI 不支持此强度；${levels ? `可用值：${levels.join('、')}，或 default` : '须为合法强度参数，或 default'}。`;
    }
  }
  if (name !== 'default') return null;
  if (error.message === workerDefaultUsage) {
    const [scope, target, mode, ...rest] = argument.trim().split(/\s+/);
    const computer = target && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target) ? target : '<电脑ID>';
    if (scope === 'agentworker' && mode === 'preset') return `未设置默认助手：${rest.length ? '预设参数格式不正确' : '缺少预设 ID'}。用法：/default agentworker ${computer} preset <预设ID> [强度]。`;
    if (scope === 'agentworker' && (mode === 'codex' || mode === 'claude')) return `未设置默认助手：${rest.length ? '模型参数格式不正确' : '缺少模型 ID'}。用法：/default agentworker ${computer} ${mode} <模型> [强度]。`;
    return '未设置默认助手：参数格式不正确。/default agentworker [电脑ID] 查看默认和候选。';
  }
  const known = new Map([
    ['电脑 ID 无效，请使用清单中的 targetId。', '电脑 ID 无效，请使用清单中的 targetId。'],
    ['所选电脑未登记，请查看电脑清单。', '所选电脑未登记，/computers 查看电脑清单。'],
    ['预设 ID 无效。', '预设 ID 无效，请使用登记清单中的预设 ID。'],
    ['预设未启用或不属于所选电脑，默认设置未改变。', '预设未启用或不属于所选电脑，默认设置未改变。'],
    ['该电脑未登记所选普通引擎，默认设置未改变。', '该电脑未登记所选普通引擎，默认设置未改变。'],
    ['普通助手须明确指定模型，不能用 model=default 代替助手选择。', '普通助手须明确指定模型，不能用 default 代替模型 ID。'],
    ['助手强度无效。', '助手强度无效，请使用合法强度或 default。'],
    ['助手强度无效；可指定支持的强度或 default。', '助手强度无效，请使用合法强度或 default。'],
    ['跟随主控不单独指定强度。', '跟随主控不单独指定强度。'],
    ['跟随主控仅用于桥电脑 local；请为远端选择该电脑的普通助手或预设。', '跟随主控仅用于 local；远端请选择该电脑的普通助手或预设。'],
  ]);
  const reason = known.get(error.message);
  return reason ? `未设置默认助手：${reason}` : null;
}
