import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentName } from '../types.js';

/** User-owned CLI data must not live in an executor's program directory. */
export function sessionHomePath(dataRoot: string, userHome: string, kind: 'worker' | 'preset', agent: AgentName, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) throw new Error('助手编号无效。');
  const root = resolve(dataRoot), marker = join(root, 'session-home-root.json');
  mkdirSync(root, { recursive: true });
  if (!existsSync(marker)) {
    try { writeFileSync(marker, JSON.stringify({ version: 1, scope: randomUUID().replaceAll('-', '') }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const saved = JSON.parse(readFileSync(marker, 'utf8'));
  if (saved.version !== 1 || typeof saved.scope !== 'string' || !/^[a-f0-9]{32}$/.test(saved.scope)) throw new Error('助手用户目录登记损坏。');
  const scope = saved.scope;
  const destination = join(userHome, agent === 'codex' ? '.codex' : '.claude', 'bridge', scope, kind, id);
  return destination;
}

export function sessionHome(dataRoot: string, userHome: string, kind: 'worker' | 'preset', agent: AgentName, id: string): string {
  const source = join(resolve(dataRoot), `${kind}-homes`, agent, id);
  if (existsSync(source)) throw new Error('助手旧目录尚未迁移，请先完成离线迁移；未创建空会话替代历史。');
  const destination = sessionHomePath(dataRoot, userHome, kind, agent, id);
  const pending = join(destination, 'migration-incomplete');
  if (existsSync(pending)) {
    const verified = join(destination, 'migration-verified');
    if (!existsSync(verified) || readFileSync(verified, 'utf8') !== source || readFileSync(pending, 'utf8') !== source) throw new Error('助手目录迁移尚未完成，未启动 CLI。');
    unlinkSync(pending);
  }
  return destination;
}
