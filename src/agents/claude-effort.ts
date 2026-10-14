import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentCommand, EffortConfiguration } from '../types.js';

const level = (value: unknown): string | null => typeof value === 'string'
  && /^(none|minimal|low|medium|high|xhigh|max|ultra|auto)$/.test(value) ? value : null;
async function settings(path: string): Promise<Record<string, unknown>> {
  try { const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
function option(args: string[], name: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) found = args[++i];
    else if (args[i]!.startsWith(name + '=')) found = args[i]!.slice(name.length + 1);
  }
  return found;
}

/** Launch-time configuration evidence, never a claim that the native CLI or gateway applied it. */
export async function claudeEffortConfiguration(command: AgentCommand, env: NodeJS.ProcessEnv,
  cwd: string, selected: string | null): Promise<EffortConfiguration | null> {
  const argument = level(selected ?? option(command.args, '--effort'));
  if (argument) return { value: argument, source: 'argument' };
  const environment = level(env.CLAUDE_CODE_EFFORT_LEVEL);
  if (environment) return { value: environment, source: 'environment' };
  const enabled = new Set((option(command.args, '--setting-sources') ?? 'user,project,local').split(','));
  const home = env.CLAUDE_CONFIG_DIR || join(env.USERPROFILE || env.HOME || homedir(), '.claude');
  let root = resolve(cwd);
  for (let current = root; ; current = dirname(current)) {
    try { await stat(join(current, '.git')); root = current; break; } catch {}
    if (dirname(current) === current) break;
  }
  let evidence: EffortConfiguration | null = null;
  const read = (value: Record<string, unknown>, source: EffortConfiguration['source']) => {
    const effort = level(value.effortLevel);
    if (effort) evidence = { value: effort, source };
  };
  if (enabled.has('user')) read(await settings(join(home, 'settings.json')), 'user-settings');
  if (enabled.has('project')) read(await settings(join(root, '.claude', 'settings.json')), 'project-settings');
  if (enabled.has('local')) read(await settings(join(root, '.claude', 'settings.local.json')), 'local-settings');
  const session = option(command.args, '--settings');
  if (session) {
    if (session.trimStart().startsWith('{')) {
      try { read(JSON.parse(session), 'session-settings'); } catch {}
    } else read(await settings(isAbsolute(session) ? session : resolve(cwd, session)), 'session-settings');
  }
  return evidence;
}
