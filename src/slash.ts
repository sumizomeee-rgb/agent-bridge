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
import { COMMANDS } from './commands.js';
export const SLASH_COMMANDS: SlashDefinition[] = COMMANDS.map(({ name, description, options }) => ({
  type: 1, name, description, contexts: [1], ...(options ? { options: options.map(option => ({ ...option, type: option.type === 'string' ? 3 as const : 5 as const })) } : {}),
}));

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
    case 'computers': return { text: `/computers${values.has('refresh') ? values.get('refresh') ? ' refresh' : ' cached' : ''}${values.get('details') ? ' details' : ''}` };
    case 'workers': return { text: `/workers${values.has('scope') ? ` ${values.get('scope')}` : ''}${values.get('details') ? ' details' : ''}` };
    case 'model': {
      const name = values.get('name');
      if (values.get('custom') === true && !name) return { error: '使用自定义模型时请填写模型 ID。' };
      return { text: `/model${name ? ` ${values.get('custom') === true ? 'custom ' : ''}${name}` : ''}` };
    }
    default: return { text: `/${definition.name}` };
  }
}
