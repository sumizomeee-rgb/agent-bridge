export interface SlashInteraction { id: string; token: string; applicationId: string }
interface SlashOption {
  type: 3 | 5;
  name: string;
  description: string;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  choices?: Array<{ name: string; value: string }>;
}
interface SlashDefinition {
  type: 1;
  name: string;
  description: string;
  contexts: [1];
  options?: SlashOption[];
}
const agents = [{ name: 'Codex CLI', value: 'codex' }, { name: 'Claude Code', value: 'claude' }];
const agentOption: SlashOption = { type: 3, name: 'agent', description: '选择 Agent；留空查看当前状态', choices: agents };

/** Global commands restricted to a DM with the bot, never a guild or group DM. */
export const SLASH_COMMANDS: SlashDefinition[] = [
  { type: 1, name: 'new', description: '新建会话，清空当前上下文', contexts: [1], options: [{ ...agentOption, description: '新会话使用的 Agent；留空沿用当前 Agent' }] },
  { type: 1, name: 'agent', description: '切换 Agent 并自动续接该目录的上下文', contexts: [1], options: [agentOption] },
  { type: 1, name: 'chats', description: '只读查看自己的历史会话', contexts: [1] },
  { type: 1, name: 'cwd', description: '在指定工作目录新建会话', contexts: [1], options: [
    { type: 3, name: 'path', description: '工作目录路径', required: true, min_length: 1, max_length: 1000 },
  ] },
  { type: 1, name: 'model', description: '查看或切换模型，保留当前上下文', contexts: [1], options: [
    { type: 3, name: 'name', description: '模型名；Claude 可填 haiku/sonnet/opus；list 列出，default 默认；留空查询', min_length: 1, max_length: 200 },
    { type: 5, name: 'custom', description: '网关自定义模型：跳过官方目录验证' },
  ] },
  { type: 1, name: 'effort', description: '查看或设置当前会话推理强度，保留上下文', contexts: [1], options: [
    { type: 3, name: 'level', description: '留空查询；default 使用 CLI 默认；可用值取决于后端和模型', choices: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(value => ({ name: value, value })) },
  ] },
  { type: 1, name: 'models', description: '列出当前 Agent 的模型选项', contexts: [1] },
  { type: 1, name: 'status', description: '查看当前模型、会话和排队情况', contexts: [1] },
  { type: 1, name: 'computers', description: '查看已登记电脑、连接状态和 Agent CLI 入口', contexts: [1], options: [
    { type: 5, name: 'refresh', description: '默认重新检查；关闭后查看已有检查' },
  ] },
  { type: 1, name: 'workers', description: '查看已登记直属助手的电脑、会话、状态和本轮耗时', contexts: [1], options: [
    { type: 3, name: 'scope', description: '留空查看当前对话；all 查看你的全部对话', choices: [
      { name: '当前对话', value: 'current' }, { name: '我的全部对话', value: 'all' },
    ] },
  ] },
  { type: 1, name: 'stop', description: '停止当前任务并清空其队列，保留上下文', contexts: [1] },
  { type: 1, name: 'help', description: '查看可用命令和用法', contexts: [1] },
];

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reuse the text-command behavior; no independent session or model state lives here. */
export function slashText(data: unknown): { text: string } | { error: string } {
  if (!object(data) || typeof data.name !== 'string' || (data.type != null && data.type !== 1)) {
    return { error: '这个交互不是支持的斜杠命令。请使用 /help。' };
  }
  const definition = SLASH_COMMANDS.find(command => command.name === data.name);
  if (!definition) return { error: '这个命令已停用或不受支持，请使用 /help 查看当前菜单。' };
  if (data.options != null && !Array.isArray(data.options)) return { error: '命令参数格式不正确，请重新选择。' };
  const values = new Map<string, string | boolean>();
  for (const option of (data.options ?? []) as unknown[]) {
    if (!object(option) || typeof option.name !== 'string' || values.has(option.name)) return { error: '命令参数格式不正确，请重新选择。' };
    const expected = definition.options?.find(item => item.name === option.name);
    if (!expected || option.type !== expected.type) return { error: '命令参数不受支持，请重新选择。' };
    if (expected.type === 3) {
      if (typeof option.value !== 'string' || !option.value.trim() || /[\r\n\0]/.test(option.value)
        || option.value.length > (expected.max_length ?? 200)
        || (expected.choices && !expected.choices.some(choice => choice.value === option.value))) {
        return { error: '命令参数值不正确，请重新选择。' };
      }
    } else if (typeof option.value !== 'boolean') return { error: '命令参数值不正确，请重新选择。' };
    values.set(option.name, option.value as string | boolean);
  }
  if (definition.options?.some(option => option.required && !values.has(option.name))) {
    return { error: '请填写命令需要的参数，再重新发送。' };
  }
  switch (definition.name) {
    case 'new':
    case 'agent': return { text: `/${definition.name}${values.has('agent') ? ` ${values.get('agent')}` : ''}` };
    case 'effort': return { text: `/effort${values.has('level') ? ` ${values.get('level')}` : ''}` };
    case 'cwd': return { text: `/cwd ${values.get('path')}` };
    case 'computers': return { text: `/computers${values.has('refresh') ? values.get('refresh') ? ' refresh' : ' cached' : ''}` };
    case 'workers': return { text: `/workers${values.has('scope') ? ` ${values.get('scope')}` : ''}` };
    case 'model': {
      const name = values.get('name');
      if (values.get('custom') === true && !name) return { error: '使用自定义模型时请填写模型 ID。' };
      return { text: `/model${name ? ` ${values.get('custom') === true ? 'custom ' : ''}${name}` : ''}` };
    }
    default: return { text: `/${definition.name}` };
  }
}
