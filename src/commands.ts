export interface CommandOption {
  type: 'string' | 'boolean'; name: string; description: string; required?: boolean;
  min_length?: number; max_length?: number; choices?: Array<{ name: string; value: string }>;
}
export interface CommandDefinition { name: string; description: string; help: string; options?: CommandOption[]; contexts?: Array<'dm' | 'group'> }
/** Group controls share this registry; adapters only render their platform menu. */
const agents = [{ name: 'Codex CLI', value: 'codex' }, { name: 'Claude Code', value: 'claude' }];
const agentOption: CommandOption = { type: 'string', name: 'agent', description: '选择 Agent；留空查看当前状态', choices: agents };

/** 两个平台的唯一命令定义；平台菜单只做参数编码。 */
export const COMMANDS: CommandDefinition[] = [
  { name: 'group', contexts: ['group'], help: '/group start|stop：激活或停用当前工作群', description: '激活、刷新或停用当前工作群', options: [{ type: 'string', name: 'action', description: 'start 激活／刷新，stop 停用', required: true, choices: [{ name: 'start', value: 'start' }, { name: 'stop', value: 'stop' }] }] },
  { name: 'new', help: "/new [continue] [codex|claude]：新建会话；continue 提炼上一会话后续接。两者都会取消旧定时", description: '新建会话，可提炼上一会话后续接', options: [{ ...agentOption, description: '新会话使用的 Agent；留空沿用当前 Agent' }, { type: 'boolean', name: 'continue', description: '初始化时提炼上一会话；仍取消旧定时，不接管旧助手' }] },
  { name: 'agent', help: "/agent [codex|claude]：查看或切换 Agent，交接当前主控的最新上下文", description: '切换 Agent 并交接当前最新上下文', options: [agentOption] },
  { name: 'chats', help: "/chats：只读查看当前 bot 下自己的历史会话", description: '只读查看自己的历史会话' },
  { name: 'cwd', help: "/cwd 路径：在指定目录新建会话", description: '在指定工作目录新建会话', options: [
    { type: 'string', name: 'path', description: '工作目录路径', required: true, min_length: 1, max_length: 1000 },
  ] },
  { name: 'model', help: "/model [模型名|list|default]：查询、列出或切换模型，保留上下文；/model custom 模型名：网关自定义模型", description: '查看或切换模型，保留当前上下文', options: [
    { type: 'string', name: 'name', description: '模型名；Claude 可填 haiku/sonnet/opus；list 列出，default 默认；留空查询', min_length: 1, max_length: 200 },
    { type: 'boolean', name: 'custom', description: '网关自定义模型：跳过官方目录验证' },
  ] },
  { name: 'effort', help: "/effort [level|default]：查询或设置推理强度，保留上下文", description: '查看或设置当前会话推理强度，保留上下文', options: [
    { type: 'string', name: 'level', description: '留空查询；default 使用 CLI 默认；可用值取决于后端和模型', choices: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(value => ({ name: value, value })) },
  ] },
  { name: 'fast', help: '/fast [on|off]：查询或切换当前 Codex 主控的 Fast，保留上下文', description: '查询或切换当前 Codex 主控 Fast 模式', options: [
    { type: 'string', name: 'mode', description: '留空查询；on 开启（额度消耗更快），off 关闭', choices: [{ name: '开启', value: 'on' }, { name: '关闭', value: 'off' }] },
  ] },
  { name: 'models', help: "/models：列出当前 Agent 的模型选项", description: '列出当前 Agent 的模型选项' },
  { name: 'status', help: "/status：查看桥、模型、会话、运行与排队状态", description: '查看当前模型、会话和排队情况' },
  { name: 'computers', help: "/computers [refresh|cached] [details]：查看登记电脑、连接与 CLI 入口", description: '查看已登记电脑、连接状态和 Agent CLI 入口', options: [
    { type: 'boolean', name: 'refresh', description: '默认重新检查；关闭后查看已有检查' },
    { type: 'boolean', name: 'details', description: '展开完整检查信息；默认简要展示' },
  ] },
  { name: 'default', help: '/default agentworker [电脑ID] [follow|clear|preset 预设ID|codex 模型|claude 模型] [强度]：查看或设置各电脑默认助手', description: '查看或设置当前 Bot 各电脑的默认助手', options: [
    { type: 'string', name: 'args', description: 'agentworker [电脑ID] [follow|clear|preset 预设ID|codex 模型|claude 模型] [强度]', min_length: 1, max_length: 400 },
  ] },
  { name: 'presetlist', help: '/presetlist：查看可派发预设的口语别名，一行一条', description: '可派发预设清单与别名速查' },
  { name: 'housekeeper', contexts: ['dm'], help: '/housekeeper on|off|status：开启、关闭或查看事务巡视；默认关闭，每20分钟一次', description: '设置或查看当前 Bot 的事务巡视', options: [
    { type: 'string', name: 'action', description: 'on 开启，off 关闭，status 查看；留空查看状态', choices: ['on', 'off', 'status'].map(value => ({ name: value, value })) },
  ] },
  { name: 'tasks', contexts: ['dm'], help: '/tasks [all] [页码]：查看主控登记的任务清单；默认未结束，all 含已结束', description: '只读查看当前私聊的主控任务清单', options: [
    { type: 'string', name: 'args', description: '留空查看未结束任务；all 包含已结束，可追加页码（每页10项）', min_length: 1, max_length: 30 },
  ] },
  { name: 'workers', help: "/workers [history] [all] [details]：默认查看未结束助手；history 查看历史", description: '查看执行中的直属助手，或单独查询历史', options: [
    { type: 'string', name: 'scope', description: '留空查看当前对话；all 查看你的全部对话', choices: [
      { name: '当前对话', value: 'current' }, { name: '我的全部对话', value: 'all' },
    ] },
    { type: 'boolean', name: 'history', description: '查看已结束或空闲的历史助手；默认仅未结束助手' },
    { type: 'boolean', name: 'details', description: '展开完整 ID 与回执；默认简要展示' },
  ] },
  { name: 'stop', help: "/stop：停止当前任务、清空队列和取消后台自动汇总；不会停止远端子任务", description: '停止当前任务并清空其队列，保留上下文' },
  { name: 'restart', help: '/restart：待当前任务结束后重启桥，保留会话与定时计划', description: '待当前任务结束后重启桥，保留会话与定时计划' },
  { name: 'help', help: "/help：查看共用命令与用法", description: '查看可用命令和用法' },
];

export function commandHelp(controllerMode = false): string {
  return ['直接发送文字或图片即可继续当前会话。命令只在 bot 私聊中使用。', ...COMMANDS.filter(command => command.contexts?.includes('dm') ?? !command.contexts).map(command =>
    controllerMode && command.name === 'stop' ? '/stop：停止桥管理的执行子 Agent、清空队列并取消预约；独立远端进程需要另行核对' : command.help)].join('\n');
}
export function groupCommands(): CommandDefinition[] {
  return COMMANDS.filter(c => ['group', 'status', 'workers', 'new', 'stop', 'help'].includes(c.name)).map(c => ({
    ...c, contexts: ['group'], options: c.name === 'new' ? [] : c.options,
    help: c.name === 'new' ? '/new：重置本群全部成员，影响其私聊和其他群，取消旧定时' : c.name === 'stop' ? '/stop：停止本群成员的主控、助手与预约，影响其所有入口' : c.help,
  }));
}
export function parseNewArguments(argument: string): { agent?: 'codex' | 'claude'; continue: boolean } | null {
  const parts = argument.toLowerCase().split(/\s+/).filter(Boolean).map(value => value === 'c' ? 'continue' : value);
  if (new Set(parts).size !== parts.length || parts.some(value => !['continue', 'codex', 'claude'].includes(value))
    || parts.includes('codex') && parts.includes('claude')) return null;
  return { continue: parts.includes('continue'), ...(parts.includes('codex') ? { agent: 'codex' as const } : parts.includes('claude') ? { agent: 'claude' as const } : {}) };
}
export function parseCommand(text: string): { name: string; argument: string } | null {
  const trimmed = text.trim();
  if (/^(?:new\s+chat|新会话|新聊天)$/i.test(trimmed)) return { name: 'new', argument: '' };
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  return match ? { name: match[1]!.toLowerCase(), argument: (match[2] ?? '').trim() } : null;
}
