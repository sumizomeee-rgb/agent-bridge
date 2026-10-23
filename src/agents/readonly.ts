import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { isolatedCodexConfig } from '../controller/native.js';
import { claudeModelSettings } from '../effort.js';
import { isObject } from './process.js';

export interface ReadOnlyRuntime { env: NodeJS.ProcessEnv; args: string[]; cleanup(): void }

/** Fresh CLI state preserves provider/auth routing but excludes inherited MCP, hooks, plugins and skills. */
export function readOnlyRuntime(agent: 'codex' | 'claude', env: NodeJS.ProcessEnv): ReadOnlyRuntime {
  const root = mkdtempSync(join(tmpdir(), `bridge-${agent}-readonly-`));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith(`bridge-${agent}-readonly-`) || lstatSync(root).isSymbolicLink()) throw new Error('只读摘要临时目录边界无效。');
    rmSync(root, { recursive: true, force: true }); cleaned = true;
  };
  try {
    const userHome = env.USERPROFILE || env.HOME || process.env.USERPROFILE || process.env.HOME || homedir();
    const copy = (source: string, name: string) => { if (existsSync(source)) copyFileSync(source, join(root, name)); };
    if (agent === 'codex') {
      const source = env.CODEX_HOME || process.env.CODEX_HOME || join(userHome, '.codex');
      const configPath = join(source, 'config.toml');
      const config = parse(isolatedCodexConfig(existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''));
      const features = isObject(config.features) ? Object.fromEntries(Object.entries(config.features).map(([key, value]) => [key, value === true])) : {};
      config.features = { ...features, code_mode_host: false, shell_tool: true, unified_exec: true };
      config.sandbox_mode = 'read-only'; config.approval_policy = 'never';
      writeFileSync(join(root, 'config.toml'), stringify(config), { encoding: 'utf8', mode: 0o600 }); copy(join(source, 'auth.json'), 'auth.json');
      return { env: { ...env, CODEX_HOME: root, BRIDGE_TASK_CONTEXT: undefined }, args: ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-c', 'plugins={}', '-c', 'agents.enabled=false'], cleanup };
    }
    const source = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(userHome, '.claude');
    const settingsPath = join(source, 'settings.json');
    const settings: unknown = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')) : {};
    const value = isObject(settings) ? settings : {};
    const routingEnv = isObject(value.env) ? Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    copy(join(source, '.credentials.json'), '.credentials.json'); copy(join(userHome, '.claude.json'), '.claude.json');
    return { env: { ...routingEnv, ...env, CLAUDE_CONFIG_DIR: root, BRIDGE_TASK_CONTEXT: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      args: ['--tools', 'Read,Glob,Grep', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,Agent,Task', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--no-chrome', '--disable-slash-commands', '--setting-sources', '', '--settings', JSON.stringify({ ...claudeModelSettings(value), env: routingEnv })], cleanup };
  } catch (error) { cleanup(); throw error; }
}
