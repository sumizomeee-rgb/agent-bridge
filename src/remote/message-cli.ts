import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ExecutorMessages } from '../executor-messages.js';

export function messageCommand(argv: string[]): unknown {
  const operation = argv[0], options: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key?.startsWith('--') || !value || key in options) throw new Error('命令参数无效。');
    options[key] = value;
  }
  const allowed = operation === 'send' ? ['--root', '--worker', '--to', '--text', '--file', '--id']
    : operation === 'get' ? ['--root', '--id'] : operation === 'list' ? ['--root', '--cwd'] : operation === 'controllers' ? ['--root'] : [];
  if (!allowed.length || !options['--root'] || Object.keys(options).some(key => !allowed.includes(key)))
    throw new Error('用法：controllers | list [--cwd DIR] | send [--worker ID] [--to 主控名称或controllerId] --id MESSAGE_ID --text TEXT（或 --file FILE）| get --id MESSAGE_ID；均需 --root EXECUTOR_ROOT。');
  const store = new ExecutorMessages(resolve(options['--root']));
  try {
    if (operation === 'list') return store.list(options['--cwd']);
    if (operation === 'controllers') return store.recipients();
    if (operation === 'get') return store.get(options['--id']!);
    if (!!options['--text'] === !!options['--file']) throw new Error('正文只选 --text 或 --file。');
    if (!options['--id']) throw new Error('发送前先生成消息 ID；回执未知时用原 ID 查询，不换 ID 重发。');
    if (options['--file'] && statSync(options['--file']).size > 64 * 1024) throw new Error('正文文件超过 64 KiB。');
    const text = options['--text'] ?? readFileSync(options['--file']!, 'utf8').replace(/^\uFEFF/, '');
    return store.send(options['--worker'] ?? null, text, options['--id'], options['--to']);
  } finally { store.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(messageCommand(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : '消息命令失败'); process.exitCode = 1; }
}
