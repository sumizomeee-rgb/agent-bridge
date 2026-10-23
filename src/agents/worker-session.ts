import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { executionErrorEvidence } from '../delivery-errors.js';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentAdapter, AgentCommand, AgentName, AgentResult, AgentSupplement, AgentTurn, Conversation, SessionVisibility, SteerResult } from '../types.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { abortError, completedResultFromError, isObject, processStopFailure } from './process.js';

export function sessionVisibility(value: unknown): SessionVisibility | undefined {
  if (value === undefined) return undefined;
  if (value !== 'hidden' && value !== 'visible') throw new Error('sessionVisibility 必须是 hidden 或 visible。');
  return value;
}
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key, value]) => key.toUpperCase() === name && value !== undefined)?.[1];
}
export function setSessionEnvironment(env: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
  env[name] = value;
}
export function nativeProfileHome(agent: AgentName, env: NodeJS.ProcessEnv, userHome = homedir()): string {
  return resolve(environmentValue(env, agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR') ?? join(userHome, agent === 'codex' ? '.codex' : '.claude'));
}
interface SessionLocation { version: 1; visibility: SessionVisibility; profileHome: string; sqliteHome: string }
/** Kept next to the worker, never in the shared user profile. Absence preserves legacy launches. */
export function pinSessionLocation(home: string, agent: AgentName, visibility: SessionVisibility | undefined, nativeId: string | null,
  env: NodeJS.ProcessEnv, userHome = homedir()): SessionLocation | undefined {
  sessionVisibility(visibility);
  const marker = join(home, 'session-location.json');
  if (existsSync(marker)) {
    const saved = JSON.parse(readFileSync(marker, 'utf8')) as SessionLocation;
    if (saved.version !== 1 || saved.visibility !== visibility || !isAbsolute(saved.profileHome) || !isAbsolute(saved.sqliteHome)) throw new Error('助手的会话可见性或目录绑定不同，禁止切换。');
    return saved;
  }
  if (visibility === undefined) return undefined;
  if (nativeId) throw new Error('助手原有会话目录绑定丢失，未回退用户默认目录。');
  mkdirSync(home, { recursive: true });
  if (lstatSync(home).isSymbolicLink()) throw new Error('助手运行目录不能是链接。');
  const profileHome = nativeProfileHome(agent, env, userHome);
  const saved: SessionLocation = { version: 1, visibility, profileHome,
    sqliteHome: resolve(environmentValue(env, 'CODEX_SQLITE_HOME') ?? profileHome) };
  writeFileSync(marker, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
  return saved;
}
function linkDirectory(source: string, destination: string): void {
  if (!existsSync(source)) mkdirSync(source, { recursive: true });
  if (existsSync(destination)) {
    // Do not silently redirect or adopt a pre-existing session directory.
    if (!lstatSync(destination).isSymbolicLink() || (process.platform === 'win32' ? realpathSync(destination).toLowerCase() !== realpathSync(source).toLowerCase() : realpathSync(destination) !== realpathSync(source))) throw new Error('会话目录已存在且与登记不同。');
    return;
  }
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}
/** Keep preset configuration private while exposing one shared transcript and native index. */
export function exposeCodexHistory(home: string, location: { profileHome: string; sqliteHome: string }): void {
  mkdirSync(location.profileHome, { recursive: true }); mkdirSync(location.sqliteHome, { recursive: true });
  for (const name of ['sessions', 'archived_sessions']) linkDirectory(join(location.profileHome, name), join(home, name));
}

// A hidden profile keeps its configuration/history pinned, but its copied ChatGPT
// login must not stay stale after the original profile renews the same account.
function refreshChatGPTCredentials(home: string, source: string): void {
  const destination = join(home, 'auth.json'), sourcePath = join(source, 'auth.json');
  if (!existsSync(destination) || !existsSync(sourcePath)) return;
  const readAuth = (bytes: Buffer): { accountId: string; expires: number } | null => {
    try {
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isObject(value) || !isObject(value.tokens) || value.OPENAI_API_KEY
        || value.auth_mode != null && value.auth_mode !== 'chatgpt') return null;
      const { account_id: accountId, access_token: accessToken } = value.tokens;
      if (typeof accountId !== 'string' || !accountId || typeof accessToken !== 'string') return null;
      const payload: unknown = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
      // Metadata only selects a fresher local cache; Codex still authenticates it.
      return isObject(payload) && typeof payload.exp === 'number' && Number.isFinite(payload.exp)
        ? { accountId, expires: payload.exp * 1000 } : null;
    } catch { return null; }
  };
  const sourceBytes = readFileSync(sourcePath), current = readAuth(readFileSync(destination)), fresh = readAuth(sourceBytes);
  if (!current || !fresh || current.accountId !== fresh.accountId || fresh.expires <= Date.now() || fresh.expires <= current.expires) return;
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, sourceBytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, destination); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export class WorkerSessionRuntime {
  constructor(readonly dataRoot: string, private readonly userHome = homedir()) {}
  prepare(agent: AgentName, workerId: string, nativeId: string | null, visibility: SessionVisibility, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(workerId)) throw new Error('助手编号无效。');
    const home = join(this.dataRoot, 'worker-homes', agent, workerId), env = { ...process.env, ...baseEnv };
    const location = pinSessionLocation(home, agent, visibility, nativeId, env, this.userHome)!;
    if (visibility === 'hidden') {
      const ready = join(home, 'profile-ready');
      if (!existsSync(ready)) {
        if (nativeId) throw new Error('助手私有配置不完整，未尝试默认目录续接。');
        const source = location.profileHome;
        const names = agent === 'codex' ? ['config.toml', 'auth.json', 'AGENTS.md', 'instructions.md', 'models_cache.json']
          : ['settings.json', 'settings.local.json', '.credentials.json', '.claude.json'];
        if (agent === 'codex' && existsSync(source)) names.push(...readdirSync(source).filter(name => /^[A-Za-z0-9_.-]+\.config\.toml$/.test(name)));
        for (const name of names) {
          const from = join(source, name);
          if (existsSync(from)) copyFileSync(from, join(home, name));
        }
        if (agent === 'claude' && !existsSync(join(home, '.claude.json')) && existsSync(join(this.userHome, '.claude.json'))) copyFileSync(join(this.userHome, '.claude.json'), join(home, '.claude.json'));
        for (const name of ['skills', 'plugins', 'agents', 'commands', 'hooks', 'rules', 'output-styles']) {
          if (existsSync(join(source, name)) && !existsSync(join(home, name))) symlinkSync(join(source, name), join(home, name), process.platform === 'win32' ? 'junction' : 'dir');
        }
        writeFileSync(ready, '1', { flag: 'wx', mode: 0o600 });
      }
      if (agent === 'codex') refreshChatGPTCredentials(home, location.profileHome);
    }
    if (agent === 'codex') {
      setSessionEnvironment(env, 'CODEX_HOME', visibility === 'hidden' ? home : location.profileHome);
      setSessionEnvironment(env, 'CODEX_SQLITE_HOME', visibility === 'hidden' ? home : location.sqliteHome);
    } else {
      setSessionEnvironment(env, 'CLAUDE_CONFIG_DIR', visibility === 'hidden' ? home : location.profileHome);
      setSessionEnvironment(env, 'DISABLE_AUTOUPDATER', '1');
      if (visibility === 'visible') setSessionEnvironment(env, 'CLAUDE_CODE_ENTRYPOINT', 'local-agent');
    }
    return env;
  }
}

/** Only newly registered workers use this layer; controllers and legacy workers keep their original adapters. */
export class WorkerSessionAdapter implements AgentAdapter {
  private readonly active = new Map<string, AgentAdapter>();
  private readonly metadata = new Set<AgentAdapter>();
  private readonly unconfirmed = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly completed = new Set<string>();
  private closed = false;
  constructor(private readonly runtime: WorkerSessionRuntime, private readonly agent: AgentName, private readonly visibility: SessionVisibility,
    private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv,
    private readonly factory: (command: AgentCommand, env: NodeJS.ProcessEnv) => AgentAdapter =
      (command, env) => agent === 'codex' ? new CodexAdapter(command, env) : new ClaudeAdapter(command, env)) {}
  async getModelInfo(cwd: string, context?: Pick<Conversation, 'id' | 'nativeId'>) {
    if (this.closed) throw abortError();
    const env = this.runtime.prepare(this.agent, context?.id ?? `metadata-${this.agent}-${this.visibility}`, context?.nativeId ?? null, this.visibility, this.env);
    const adapter = this.factory(this.command, env); this.metadata.add(adapter);
    try { if (!adapter.getModelInfo) throw new Error('执行器不支持模型查询。'); return await adapter.getModelInfo(cwd); }
    finally { await adapter.close(); this.metadata.delete(adapter); }
  }
  async run(turn: AgentTurn) {
    if (this.closed || turn.signal.aborted) throw abortError();
    const id = turn.conversation.id;
    if (this.active.has(id)) throw new Error('该助手会话仍在执行。');
    const env = this.runtime.prepare(this.agent, id, turn.conversation.nativeId, this.visibility, this.env);
    const adapter = this.factory(this.command, env); this.active.set(id, adapter); this.stopped.delete(id); this.completed.delete(id);
    let nativeResult: AgentResult | undefined;
    let success = false, stopOnlyReport = false, resultUncertain = false, executionError: string | undefined;
    try { nativeResult = await adapter.run(turn); success = true; return nativeResult; }
    catch (error) {
      nativeResult = completedResultFromError(error);
      executionError = executionErrorEvidence(error);
      resultUncertain = isObject(error) && 'resultUncertain' in error;
      stopOnlyReport = !!nativeResult && isObject(error) && error.processStillRunning === true && !('resultUncertain' in error);
      if (error && typeof error === 'object' && 'processStillRunning' in error) this.unconfirmed.add(id);
      throw error;
    } finally {
      let cleanupError: unknown, confirmed = false;
      if (success && nativeResult?.processStopped === false) { stopOnlyReport = true; this.unconfirmed.add(id); this.completed.add(id); }
      if (stopOnlyReport) { try { confirmed = await adapter.confirmStopped?.(id) === true; } catch {} }
      // A completed report does not authorize forcing down a CLI that is still exiting.
      if (!stopOnlyReport || confirmed) { try { await adapter.close(); } catch (error) { cleanupError = error; } }
      if (confirmed && cleanupError === undefined && !turn.signal.aborted && !this.closed) {
        this.unconfirmed.delete(id); this.active.delete(id); this.stopped.add(id); return nativeResult!;
      }
      if (success && nativeResult && cleanupError !== undefined && !turn.signal.aborted && !this.closed) {
        nativeResult.processStopped = false; nativeResult.cleanupError = executionErrorEvidence(cleanupError);
        this.unconfirmed.add(id); this.completed.add(id); return nativeResult;
      }
      if (cleanupError !== undefined) { this.unconfirmed.add(id); throw Object.assign(processStopFailure(cleanupError, nativeResult), { executionError, cleanupError: executionErrorEvidence(cleanupError) }, resultUncertain ? { resultUncertain: true } : {}); }
      if (!this.unconfirmed.has(id)) { this.active.delete(id); this.stopped.add(id); }
    }
  }
  async steer(id: string, message: AgentSupplement): Promise<SteerResult> {
    return await this.active.get(id)?.steer?.(id, message) ?? { status: 'queued', unsupported: true, reason: '助手尚未就绪。' };
  }
  async interrupt(id: string): Promise<void> {
    const adapter = this.active.get(id); await adapter?.interrupt(id);
    if (adapter && this.unconfirmed.has(id)) {
      await adapter.close(); this.active.delete(id); this.unconfirmed.delete(id); this.stopped.add(id);
    }
  }
  async confirmStopped(id: string): Promise<boolean> {
    if (this.unconfirmed.has(id)) {
      try { const adapter = this.active.get(id); if (await adapter?.confirmStopped?.(id) === true) {
        await adapter?.close(); this.unconfirmed.delete(id); this.active.delete(id); this.stopped.add(id);
      } } catch {}
    }
    return this.stopped.has(id) && !this.active.has(id) && !this.unconfirmed.has(id);
  }
  async close(): Promise<void> {
    this.closed = true; await Promise.all([...this.active.keys()].map(async id => {
      if (this.completed.has(id)) {
        await this.active.get(id)!.close();
        if (await this.confirmStopped(id) !== true) throw processStopFailure(new Error('CLI 仍在收尾。'));
      } else await this.interrupt(id);
    }));
    await Promise.all([...this.metadata].map(adapter => adapter.close()));
  }
}
