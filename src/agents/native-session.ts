import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentCommand, SessionVisibility } from '../types.js';

export const nativeSessionRuntimeVersion = '0.160.0';
export function nativeAppServerPath(userHome = homedir()): string {
  return join(userHome, '.codex', 'bridge', 'runtime', nativeSessionRuntimeVersion, 'bin', process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server');
}

const installations = new Map<string, Promise<void>>();
export async function ensureNativeAppServer(env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.BRIDGE_SESSION_SOURCE) return;
  const user = env.USERPROFILE ?? env.HOME ?? homedir(), path = env.BRIDGE_CODEX_APP_SERVER ?? nativeAppServerPath(user);
  if (existsSync(path)) return;
  if (env.BRIDGE_CODEX_APP_SERVER || process.platform !== 'win32') throw new Error('登记的原生会话运行时不存在。');
  let installation = installations.get(path);
  if (!installation) {
    installation = new Promise<void>((accept, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../../../scripts/install-native-session-runtime.ps1', import.meta.url)), '-UserDirectory', user],
      { windowsHide: true, timeout: 240_000, maxBuffer: 8192 }, (error) => error ? reject(new Error('原生会话运行时安装失败；未回退会暴露会话的旧入口。', { cause: error })) : accept()));
    installations.set(path, installation);
  }
  try { await installation; } finally { installations.delete(path); }
}

/** Only workers opt in. Controllers retain their configured CLI and protocol. */
export function codexSessionLaunch(command: AgentCommand, args: string[], env: NodeJS.ProcessEnv): { command: AgentCommand; args: string[] } {
  const source = env.BRIDGE_SESSION_SOURCE;
  if (!source) return { command, args };
  if (!['mcp', 'cli'].includes(source)) throw new Error('助手会话来源无效。');
  const executable = env.BRIDGE_CODEX_APP_SERVER ?? nativeAppServerPath(env.USERPROFILE ?? env.HOME);
  if (!existsSync(executable)) throw new Error('尚未安装原生会话运行时；请运行 scripts/install-native-session-runtime.ps1。');
  if (args[0] !== 'app-server') throw new Error('原生助手入口只接受 app-server 协议。');
  // The registered command may be node + codex.js. Preserve its explicit config
  // overrides, but do not pass the launcher script to the standalone executable.
  const overrides: string[] = [];
  for (let i = 0; i < command.args.length; i++) {
    const arg = command.args[i]!;
    if (arg === '-c' || arg === '--config') { const value = command.args[++i]; if (value === undefined) throw new Error('Codex 配置参数缺少值。'); overrides.push(arg, value); }
    else if (arg.startsWith('--config=') || arg.startsWith('-c=')) overrides.push(arg);
    else if (i !== 0 || !/\.(?:[cm]?js)$/i.test(arg)) throw new Error('原生助手入口不支持此 Codex 启动参数，未静默丢弃。');
  }
  return { command: { command: executable, args: overrides }, args: ['--session-source', source === 'mcp' ? 'app-server' : 'cli', ...args.slice(1)] };
}

export function nativeSessionEnvironment(env: NodeJS.ProcessEnv, visibility: SessionVisibility): void {
  env.BRIDGE_SESSION_SOURCE = visibility === 'hidden' ? 'mcp' : 'cli';
  env.CLAUDE_CODE_ENTRYPOINT = visibility === 'hidden' ? 'sdk-cli' : 'local-agent';
}
