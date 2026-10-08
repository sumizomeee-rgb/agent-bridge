import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TaskRegistry, signTaskCompletion, validateTaskWatch, type TaskContextFile, type TaskTicket, type TaskTerminalStatus, type TaskWatch } from './tasks.js';

function argumentsMap(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!key?.startsWith('--') || value == null || value.startsWith('--')) throw new Error('参数需要使用 --名称 值');
    if (options.has(key)) throw new Error(`重复参数：${key}`);
    options.set(key, value);
  }
  return options;
}
function readJson(path: string): unknown {
  if (statSync(path).size > 16 * 1024) throw new Error('任务上下文或票据文件过大');
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
function resultPrefix(path: string): string {
  const size = statSync(path).size;
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, 16 * 1024));
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, count).toString('utf8').replace(/^\uFEFF/, '') + (size > buffer.length ? '\n[Result truncated at 16 KiB]' : '');
  } finally { closeSync(descriptor); }
}
function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (!value?.trim()) throw new Error(`缺少 ${key}`);
  return value;
}
function parseWatch(options: Map<string, string>): TaskWatch {
  return {
    completionFile: options.get('--completion-file'), exitFile: options.get('--exit-file'), resultFile: options.get('--result-file'),
    sshConfig: options.get('--ssh-config'), sshHost: options.get('--ssh-host'),
  };
}
function checkOptions(options: Map<string, string>, allowed: string[]): void {
  for (const key of options.keys()) if (!allowed.includes(key)) throw new Error(`未知参数：${key}`);
}
const watchKeys = ['--completion-file', '--exit-file', '--result-file', '--ssh-config', '--ssh-host'];

/** The environment supplies a scoped capability; callers never provide a parent session ID. */
export function runTaskCli(args: string[], environment: NodeJS.ProcessEnv = process.env): unknown {
  const command = args[0];
  if (!command || command === '--help' || command === 'help') return {
    usage: [
      'register --title "任务名称" [--completion-file ABS_PATH | --exit-file ABS_PATH --result-file ABS_PATH] [--ssh-config ABS_PATH --ssh-host ALIAS]',
      'watch --task-id UUID (--completion-file PATH | --exit-file PATH [--result-file PATH]) [--ssh-config ABS_PATH --ssh-host ALIAS]',
      'status --task-id UUID',
      'complete --ticket ABS_PATH --output ABS_PATH --status completed|failed|cancelled [--text TEXT | --result-file ABS_PATH]',
    ], context: 'register/watch/status read BRIDGE_TASK_CONTEXT automatically; do not supply native Session IDs',
  };
  const options = argumentsMap(args.slice(1));
  if (command === 'complete') {
    checkOptions(options, ['--ticket', '--output', '--status', '--text', '--result-file']);
    const ticket = readJson(required(options, '--ticket')) as TaskTicket;
    const status = required(options, '--status') as TaskTerminalStatus;
    if (options.has('--text') && options.has('--result-file')) throw new Error('text 与 result-file 只能指定一个');
    const resultFile = options.get('--result-file');
    const text = resultFile ? resultPrefix(resultFile) : options.get('--text') ?? '';
    const receipt = signTaskCompletion(ticket, status, text);
    const output = resolve(required(options, '--output'));
    mkdirSync(dirname(output), { recursive: true });
    const temporary = `${output}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, output);
    return { taskId: ticket.taskId, status, completionFile: output };
  }
  if (!['register', 'watch', 'status'].includes(command)) throw new Error('未知任务命令');
  const contextPath = environment.BRIDGE_TASK_CONTEXT;
  if (!contextPath) throw new Error('当前 CLI 没有桥登记上下文 BRIDGE_TASK_CONTEXT');
  const context = readJson(contextPath) as TaskContextFile;
  if (context.version !== 1 || typeof context.registryDir !== 'string' || typeof context.contextId !== 'string'
    || typeof context.token !== 'string') throw new Error('任务上下文文件无效');
  const registry = new TaskRegistry(context.registryDir);
  try {
    if (command === 'register') {
      checkOptions(options, ['--title', ...watchKeys]);
      if (options.has('--completion-file') || options.has('--exit-file')) validateTaskWatch(parseWatch(options));
      const registration = registry.register(context, required(options, '--title'));
      if (options.has('--completion-file') || options.has('--exit-file')) registry.setWatch(context, registration.taskId, parseWatch(options));
      return registration;
    }
    checkOptions(options, command === 'watch' ? ['--task-id', ...watchKeys] : ['--task-id']);
    const taskId = required(options, '--task-id');
    if (command === 'watch') registry.setWatch(context, taskId, parseWatch(options));
    const task = registry.getAuthorizedTask(context, taskId);
    return { taskId, title: task.title, status: task.status, watch: task.watch, wakeAllowed: task.wakeAllowed };
  } finally { registry.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(runTaskCli(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
