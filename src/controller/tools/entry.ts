import { harnessText } from '../../harness.js';
import { isObject, type JsonObject } from '../../agents/process.js';
import { controllerToolsForCommunication } from './catalog.js';

export class ControllerToolInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ControllerToolInputError'; }
}
/** Only these interfaces are registered with new native CLI sessions. */
export const controllerEntryTools = [
  { name: 'bridge_help', description: '查看工具短目录；指定命令时展开完整参数、说明与边界。', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, additionalProperties: false } },
  { name: 'bridge_call', description: '执行指定桥命令；按对应命令的完整参数与权限校验。', inputSchema: { type: 'object', properties: { command: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['command', 'arguments'], additionalProperties: false } },
];
export function controllerToolIndex(enabled?: boolean): { name: string; description: string }[] {
  return controllerToolsForCommunication(enabled).map(tool => ({ name: tool.name, description: harnessText(`tools.${tool.name}.summary`) }));
}
export function controllerToolIndexText(enabled?: boolean): string {
  return controllerToolIndex(enabled).map(tool => `- \`${tool.name}\`：${tool.description}`).join('\n');
}
/** Validate the command's actual schema without changing or defaulting its arguments. */
function validate(value: unknown, schema: JsonObject, at: string): void {
  const invalid = (reason: string): never => { throw new ControllerToolInputError(`${at}：${reason}`); };
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) invalid('不在允许值清单中');
  switch (schema.type) {
    case 'object': {
      if (!isObject(value)) invalid('须为对象');
      const object = value as JsonObject, properties = isObject(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === 'string' && !Object.hasOwn(object, key)) invalid(`缺少参数 ${key}`);
      for (const [key, child] of Object.entries(object)) {
        if (Object.hasOwn(properties, key) && isObject(properties[key])) validate(child, properties[key], `${at}.${key}`);
        else if (schema.additionalProperties === false) invalid(`未知参数 ${key}`);
        else if (isObject(schema.additionalProperties)) validate(child, schema.additionalProperties, `${at}.${key}`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) invalid('须为数组');
      const array = value as unknown[];
      if (typeof schema.minItems === 'number' && array.length < schema.minItems) invalid('条目过少');
      if (typeof schema.maxItems === 'number' && array.length > schema.maxItems) invalid('条目过多');
      if (isObject(schema.items)) array.forEach((child, index) => validate(child, schema.items as JsonObject, `${at}[${index}]`));
      break;
    }
    case 'string':
      if (typeof value !== 'string') invalid('须为文字');
      if (typeof schema.minLength === 'number' && (value as string).length < schema.minLength) invalid('文字过短');
      if (typeof schema.maxLength === 'number' && (value as string).length > schema.maxLength) invalid('文字过长');
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value as string)) invalid('文字格式无效');
      break;
    case 'integer': case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value)) invalid('须为有效数值');
      if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) invalid('低于下限');
      if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) invalid('超过上限');
      break;
    case 'boolean': if (typeof value !== 'boolean') invalid('须为布尔值'); break;
    case undefined: break;
    default: invalid('工具登记含不支持的参数类型');
  }
}
export function controllerToolHelp(command: unknown, enabled?: boolean): unknown {
  if (command === undefined) return { tools: controllerToolIndex(enabled) };
  if (typeof command !== 'string' || !command.trim()) throw new ControllerToolInputError('command 须为有效命令名。');
  const tool = controllerToolsForCommunication(enabled).find(tool => tool.name === command);
  if (!tool) throw new ControllerToolInputError('命令不存在或当前未启用；bridge_help 查看可用目录。');
  return tool;
}
/** Resolve before lifecycle, scope, recovery, receipt and terminal-action checks. */
export function resolveControllerTool(name: string, args: JsonObject, enabled?: boolean): { name: string; args: JsonObject } {
  if (name !== 'bridge_help' && name !== 'bridge_call') return { name, args }; // Legacy native sessions keep registered calls.
  validate(args, controllerEntryTools.find(tool => tool.name === name)!.inputSchema as JsonObject, name);
  if (name === 'bridge_help') return { name, args };
  const tool = controllerToolHelp(args.command, enabled) as { name: string; inputSchema: JsonObject };
  validate(args.arguments, tool.inputSchema, tool.name);
  return { name: tool.name, args: args.arguments as JsonObject };
}
