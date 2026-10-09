import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommand, AgentName, BridgeConfig } from './types.js';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function isModelId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*(?:\[[A-Za-z0-9]+\])?$/.test(value);
}
export function loadConfig(argv = process.argv.slice(2)): BridgeConfig {
  let configPath = resolve(projectRoot, '.local', 'config.json');
  let portOverride: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configPath = resolve(argv[++i] ?? '');
    else if (argv[i] === '--proxy-port') portOverride = parsePort(argv[++i]);
    else if (!['--check', '--help'].includes(argv[i] ?? '')) throw new Error(`未知参数：${argv[i]}`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  const token = String(raw.token ?? '').trim();
  if (!token) throw new Error('配置缺少机器人 token');
  if (!Array.isArray(raw.allowedUserIds) || !raw.allowedUserIds.length || raw.allowedUserIds.some(id => !/^\d{15,22}$/.test(String(id)))) {
    throw new Error('allowedUserIds 必须包含明确的 Discord 用户 ID');
  }
  const localPath = (value: unknown, fallback: string): string => {
    const p = String(value ?? fallback);
    return isAbsolute(p) ? p : resolve(projectRoot, p);
  };
  const commands = raw.commands as Record<string, unknown> | undefined;
  const command = (name: AgentName): AgentCommand => {
    const value = commands?.[name] as AgentCommand | undefined;
    if (!value || typeof value.command !== 'string' || !Array.isArray(value.args) || value.args.some(a => typeof a !== 'string')) {
      throw new Error(`缺少 ${name} 启动命令配置`);
    }
    const executable = localPath(value.command, '');
    if (!existsSync(executable)) throw new Error(`${name} 运行时不存在：${executable}`);
    return { command: executable, args: value.args.map(a => a.replaceAll('{project}', projectRoot)) };
  };
  const proxyPort = portOverride ?? (raw.proxyPort == null ? null : parsePort(String(raw.proxyPort)));
  const proxyUrl = proxyPort == null ? null : `http://127.0.0.1:${proxyPort}`;
  const defaultAgent = raw.defaultAgent ?? 'codex';
  if (defaultAgent !== 'codex' && defaultAgent !== 'claude') throw new Error('defaultAgent 只能是 codex 或 claude');
  const defaultModels: Partial<Record<AgentName, string>> = {};
  const modelOptions: Partial<Record<AgentName, string[]>> = {};
  for (const [key, target] of [['defaultModels', defaultModels], ['modelOptions', modelOptions]] as const) {
    const input = raw[key];
    if (input == null) continue;
    if (typeof input !== 'object' || Array.isArray(input)) throw new Error(`${key} 必须按 Agent 配置`);
    for (const [name, value] of Object.entries(input)) {
      if (name !== 'codex' && name !== 'claude') throw new Error(`${key} 的 Agent 只能是 codex 或 claude`);
      if (key === 'defaultModels') {
        if (typeof value !== 'string' || !isModelId(value)) throw new Error(`${key}.${name} 需要有效模型 ID`);
        (target as Partial<Record<AgentName, string>>)[name] = value;
      } else {
        if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !isModelId(item))) {
          throw new Error(`${key}.${name} 需要有效模型 ID 数组`);
        }
        (target as Partial<Record<AgentName, string[]>>)[name] = [...new Set(value as string[])];
      }
    }
  }
  const maxFileBytes = raw.maxFileBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFileBytes) || (maxFileBytes as number) <= 0 || (maxFileBytes as number) > 24 * 1024 * 1024) {
    throw new Error('maxFileBytes 必须是 1–25165824 的整数（单个回传文件大小上限）。');
  }
  if (raw.controllerMode != null && typeof raw.controllerMode !== 'boolean') throw new Error('controllerMode 必须是布尔值');
  const config: BridgeConfig = {
    token, allowedUserIds: raw.allowedUserIds.map(String), defaultAgent,
    workspace: localPath(raw.workspace, '.local/workspace'), proxyUrl,
    commands: { codex: command('codex'), claude: command('claude') },
    dataDir: localPath(raw.dataDir, '.local/data'),
    attachmentsDir: localPath(raw.attachmentsDir, '.local/data/attachments'),
    logsDir: localPath(raw.logsDir, '.local/logs'), maxImageBytes: 20 * 1024 * 1024,
    defaultModels, modelOptions, maxFileBytes: maxFileBytes as number,
    controllerMode: raw.controllerMode === true,
  };
  for (const p of [config.workspace, config.dataDir, config.attachmentsDir, config.logsDir]) mkdirSync(p, { recursive: true });
  return config;
}
function parsePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('代理端口需要是 1–65535 的整数');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('代理端口需要是 1–65535 的整数');
  return port;
}
export function agentEnvironment(config: BridgeConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.proxyUrl) {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = config.proxyUrl;
  }
  const bypass = new Set((env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(s => s.trim()).filter(Boolean));
  for (const host of ['localhost', '127.0.0.1', '::1', '10.101.0.8']) bypass.add(host);
  env.NO_PROXY = env.no_proxy = [...bypass].join(',');
  return env;
}
export function safeError(error: unknown, secrets: string[] = []): string {
  return redactText(error instanceof Error ? error.message : String(error), secrets).slice(0, 1500);
}
export function redactText(text: string, secrets: string[] = []): string {
  let message = text;
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/(Bearer|Bot)\s+[\w.\-]+/gi, '$1 [redacted]');
}
