export interface CommandOption {
  type: 'string' | 'boolean'; name: string; description: string; required?: boolean;
  min_length?: number; max_length?: number; choices?: Array<{ name: string; value: string }>;
}
export interface CommandDefinition { name: string; description: string; help: string; options?: CommandOption[] }
const agents = [{ name: 'Codex CLI', value: 'codex' }, { name: 'Claude Code', value: 'claude' }];
const agentOption: CommandOption = { type: 'string', name: 'agent', description: '选择 Agent；留空查看当前状态', choices: agents };

/** 两个平台的唯一命令定义；平台菜单只做参数编码。 */
export const COMMANDS: CommandDefinition[] = [
  { name: 'new', help: "/new [codex|claude] 或 new chat：新建会话，沿用工作目录", description: '新建会话，清空当前上下文', options: [{ ...agentOption, description: '新会话使用的 Agent；留空沿用当前 Agent' }] },
  { name: 'agent', help: "/agent [codex|claude]：查看或切换 Agent，续接该目录的上次会话", description: '切换 Agent 并自动续接该目录的上下文', options: [agentOption] },
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
  { name: 'models', help: "/models：列出当前 Agent 的模型选项", description: '列出当前 Agent 的模型选项' },
  { name: 'status', help: "/status：查看桥、模型、会话、运行与排队状态", description: '查看当前模型、会话和排队情况' },
  { name: 'computers', help: "/computers [refresh|cached] [details]：查看登记电脑、连接与 CLI 入口", description: '查看已登记电脑、连接状态和 Agent CLI 入口', options: [
    { type: 'boolean', name: 'refresh', description: '默认重新检查；关闭后查看已有检查' },
    { type: 'boolean', name: 'details', description: '展开完整检查信息；默认简要展示' },
  ] },
  { name: 'workers', help: "/workers [history] [all] [details]：默认查看未结束助手；history 查看历史", description: '查看执行中的直属助手，或单独查询历史', options: [
    { type: 'string', name: 'scope', description: '留空查看当前对话；all 查看你的全部对话', choices: [
      { name: '当前对话', value: 'current' }, { name: '我的全部对话', value: 'all' },
    ] },
    { type: 'boolean', name: 'history', description: '查看已结束或空闲的历史助手；默认仅未结束助手' },
    { type: 'boolean', name: 'details', description: '展开完整 ID 与回执；默认简要展示' },
  ] },
  { name: 'stop', help: "/stop：停止当前任务、清空队列和取消后台自动汇总；不会停止远端子任务", description: '停止当前任务并清空其队列，保留上下文' },
  { name: 'help', help: "/help：查看共用命令与用法", description: '查看可用命令和用法' },
];

export function commandHelp(controllerMode = false): string {
  return ['直接发送文字或图片即可继续当前会话。命令只在 bot 私聊中使用。', ...COMMANDS.map(command =>
    controllerMode && command.name === 'stop' ? '/stop：停止桥管理的执行子 Agent、清空队列并取消预约；独立远端进程需要另行核对' : command.help)].join('\n');
}
export function parseCommand(text: string): { name: string; argument: string } | null {
  const trimmed = text.trim();
  if (/^(?:new\s+chat|新会话|新聊天)$/i.test(trimmed)) return { name: 'new', argument: '' };
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  return match ? { name: match[1]!.toLowerCase(), argument: (match[2] ?? '').trim() } : null;
}
