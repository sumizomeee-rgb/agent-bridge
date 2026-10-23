import { createHash } from 'node:crypto';
import { executionErrorEvidence } from '../delivery-errors.js';
import { existsSync, lstatSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isObject, abortError, completedResultFromError, processStopFailure, stopEvidenceFromError, type AgentStopEvidence } from '../agents/process.js';
import { isModelId } from '../config.js';
import { CodexAdapter } from '../agents/codex.js';
import { ClaudeAdapter } from '../agents/claude.js';
import type { Conversation, AgentAdapter, SessionVisibility, AgentCommand, AgentName, AgentResult, AgentTurn, AgentSupplement, SteerResult } from '../types.js';
import { presetId, readPrivateJson } from './registry.js';
import { exposeCodexHistory, pinSessionLocation } from '../agents/worker-session.js';
import { startPresetConnect } from './connect.js';
import type { LaunchProfile, PresetBinding } from './types.js';

export function profileFingerprint(profile: LaunchProfile): string { return createHash('sha256').update(JSON.stringify(profile)).digest('hex'); }
export function parseLaunchProfiles(raw: unknown): LaunchProfile[] {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 100) throw new Error('目标机预设启动配置格式无效。');
  const ids = new Set<string>();
  return raw.profiles.map(value => {
    if (!isObject(value)) throw new Error('目标机启动配置无效。');
    const id = presetId(value.id), credentialId = presetId(value.credentialId);
    if (ids.has(id)) throw new Error('目标机配置 ID 重复。'); ids.add(id);
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !['codex', 'claude'].includes(String(value.agent))
      || typeof value.model !== 'string' || !isModelId(value.model) || typeof value.baseUrl !== 'string') throw new Error('目标机配置模型或版本无效。');
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('供应商入口不能包含凭据或查询参数。');
    const route = value.transport;
    if (!isObject(route) || !['direct', 'ssh-connect'].includes(String(route.kind))) throw new Error('预设传输方式无效。');
    let transport: LaunchProfile['transport'] = { kind: 'direct' };
    if (route.kind === 'ssh-connect') {
      if (url.protocol !== 'https:' || typeof route.sshConfig !== 'string' || !isAbsolute(route.sshConfig)
        || typeof route.alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(route.alias)
        || (route.sshCommand !== undefined && (typeof route.sshCommand !== 'string' || !isAbsolute(route.sshCommand)))) throw new Error('预设 SSH 传输登记无效。');
      transport = { kind: 'ssh-connect', sshConfig: route.sshConfig, alias: route.alias, ...(typeof route.sshCommand === 'string' ? { sshCommand: route.sshCommand } : {}) };
    }
    return { id, revision: Number(value.revision), credentialId, agent: value.agent as AgentName, model: value.model, baseUrl: url.href.replace(/\/$/, ''), transport };
  });
}
export function assertPresetBinding(raw: unknown): asserts raw is PresetBinding {
  if (!isObject(raw) || !['codex', 'claude'].includes(String(raw.agent)) || typeof raw.model !== 'string' || !isModelId(raw.model)
    || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint)) throw new Error('预设绑定无效。');
  for (const key of ['id', 'profileId', 'targetId']) presetId(raw[key]);
  if (Object.keys(raw).some(key => !['id', 'profileId', 'targetId', 'revision', 'agent', 'model', 'fingerprint'].includes(key))) throw new Error('预设绑定包含未支持的字段。');
}
export class PresetResultUnknown extends Error {
  readonly resultUncertain = true;
  constructor(readonly nativeResult?: AgentResult, readonly stopEvidence?: AgentStopEvidence, readonly executionError?: string, readonly cleanupError?: string) { super('预设请求已开始，但未取得完整结果；原会话已保留，禁止自动重放。'); this.name = 'PresetResultUnknown'; }
}
function matches(profile: LaunchProfile, binding: PresetBinding): boolean {
  return profile.id === binding.profileId && profile.revision === binding.revision && profile.agent === binding.agent
    && profile.model === binding.model && profileFingerprint(profile) === binding.fingerprint;
}
export interface PreparedPreset { command: AgentCommand; env: NodeJS.ProcessEnv; close(): Promise<void> }
export class PresetRuntime {
  constructor(readonly privateRoot: string, readonly dataRoot: string, private readonly userHome = homedir()) {}
  private async current(profileId: string): Promise<LaunchProfile> {
    const profile = parseLaunchProfiles(await readPrivateJson(join(this.privateRoot, 'profiles.json'))).find(value => value.id === profileId);
    if (!profile) throw new Error('目标机未登记此预设启动配置。'); return profile;
  }
  async describe(profileId: string, revision: number, agent: AgentName, model: string): Promise<Pick<PresetBinding, 'profileId' | 'revision' | 'agent' | 'model' | 'fingerprint'>> {
    const profile = await this.current(presetId(profileId));
    if (profile.revision !== revision || profile.agent !== agent || profile.model !== model) throw new Error('预设目录与目标机配置不一致，未回退默认配置。');
    return { profileId, revision, agent, model, fingerprint: profileFingerprint(profile) };
  }
  private home(workerId: string, binding: PresetBinding): string { return join(this.dataRoot, 'preset-homes', binding.agent, presetId(workerId)); }
  async pin(binding: PresetBinding, workerId: string, nativeId: string | null, visibility?: SessionVisibility, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    await this.profile(binding, workerId, nativeId, true);
    pinSessionLocation(this.home(workerId, binding), binding.agent, visibility, nativeId, env, this.userHome);
  }
  async validate(binding: PresetBinding, workerId?: string, nativeId?: string | null): Promise<void> { await this.profile(binding, workerId, nativeId, false); }
  private async profile(binding: PresetBinding, workerId?: string, nativeId?: string | null, pin = false): Promise<LaunchProfile> {
    assertPresetBinding(binding);
    const home = workerId ? this.home(workerId, binding) : undefined, path = home ? join(home, 'preset-binding.json') : undefined;
    if (path && existsSync(path)) {
      const saved = await readPrivateJson(path);
      if (!isObject(saved) || !isObject(saved.profile) || !isObject(saved.binding)
        || Object.entries(binding).some(([key, value]) => (saved.binding as Record<string, unknown>)[key] !== value)) throw new Error('原助手的预设绑定不同，禁止切换线路。');
      const profile = parseLaunchProfiles({ version: 1, profiles: [saved.profile] })[0]!;
      if (!matches(profile, binding)) throw new Error('已保存的预设快照无效。'); return profile;
    }
    if (nativeId) throw new Error('原预设会话目录或绑定丢失，未尝试默认目录续接。');
    const profile = await this.current(binding.profileId);
    if (!matches(profile, binding)) throw new Error('目标机预设配置已改变，请重新查询；旧助手不会自动换线。');
    if (pin && path && home) {
      mkdirSync(home, { recursive: true });
      if (lstatSync(home).isSymbolicLink() || resolve(home) !== home) throw new Error('预设会话目录不能是符号链接。');
      writeFileSync(path, JSON.stringify({ binding, profile }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const skills = join(this.userHome, binding.agent === 'codex' ? '.codex' : '.claude', 'skills');
      if (existsSync(skills) && !existsSync(join(home, 'skills'))) symlinkSync(skills, join(home, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return profile;
  }
  async prepare(binding: PresetBinding, workerId: string, nativeId: string | null, original: AgentCommand, baseEnv: NodeJS.ProcessEnv, visibility?: SessionVisibility): Promise<PreparedPreset> {
    const profile = await this.profile(binding, workerId, nativeId, true);
    const location = pinSessionLocation(this.home(workerId, binding), binding.agent, visibility, nativeId, { ...process.env, ...baseEnv }, this.userHome);
    const raw = await readPrivateJson(join(this.privateRoot, 'credentials.json'));
    if (!isObject(raw) || raw.version !== 1 || !isObject(raw.credentials) || !isObject(raw.credentials[profile.credentialId])) throw new Error('目标机预设凭据引用不可用。');
    const credential = raw.credentials[profile.credentialId] as Record<string, unknown>;
    const key = binding.agent === 'codex' ? credential.apiKey : credential.authToken ?? credential.apiKey;
    if (typeof key !== 'string' || !key || /[\r\n\0]/.test(key)) throw new Error('目标机预设认证材料无效。');
    const env: NodeJS.ProcessEnv = { ...process.env, ...baseEnv };
    const cleared = new Set(['CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_API_KEY', 'CLAUDE_CONFIG_DIR', 'BRIDGE_PRESET_API_KEY', 'NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);
    for (const name of Object.keys(env)) {
      const key = name.toUpperCase();
      if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(key) || cleared.has(key)) env[name] = undefined;
    }
    const home = this.home(workerId, binding), command = { command: original.command, args: [...original.args] };
    let relay: Awaited<ReturnType<typeof startPresetConnect>> | undefined;
    try {
      if (profile.transport.kind === 'ssh-connect') {
        const url = new URL(profile.baseUrl); relay = await startPresetConnect(profile.transport, `${url.hostname}:${url.port || '443'}`);
        for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = relay.proxyUrl;
      }
      if (binding.agent === 'codex') {
        env.CODEX_HOME = home; env.CODEX_SQLITE_HOME = home; env.BRIDGE_PRESET_API_KEY = key;
        if (location?.visibility === 'visible') { exposeCodexHistory(home, location); env.CODEX_SQLITE_HOME = location.sqliteHome; }
        const provider = 'bridge_preset';
        const values: Record<string, unknown> = { model_provider: provider, model: binding.model,
          [`model_providers.${provider}.name`]: 'Explicit bridge preset', [`model_providers.${provider}.base_url`]: profile.baseUrl,
          [`model_providers.${provider}.env_key`]: 'BRIDGE_PRESET_API_KEY', [`model_providers.${provider}.requires_openai_auth`]: false,
          [`model_providers.${provider}.wire_api`]: 'responses', check_for_update_on_startup: false };
        for (const [name, value] of Object.entries(values)) command.args.push('-c', `${name}=${JSON.stringify(value)}`);
      } else {
        env.CLAUDE_CONFIG_DIR = location?.visibility === 'visible' ? location.profileHome : home; env.ANTHROPIC_BASE_URL = profile.baseUrl;
        if (location?.visibility === 'visible') { mkdirSync(location.profileHome, { recursive: true }); env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'; }
        env[credential.authToken ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
        env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
        env.DISABLE_AUTOUPDATER = '1';
        env.ANTHROPIC_MODEL = binding.model;
        // Main selection alone does not pin background work or family aliases.
        for (const family of ['HAIKU', 'SONNET', 'OPUS', 'FABLE']) env[`ANTHROPIC_DEFAULT_${family}_MODEL`] = binding.model;
        env.CLAUDE_CODE_SUBAGENT_MODEL = binding.model;
        env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
        command.args.push('--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
      }
      return { command, env, close: async () => { await relay?.close(); } };
    } catch (error) { await relay?.close(); throw error; }
  }
}

export class PresetAgentAdapter implements AgentAdapter {
  private readonly active = new Map<string, { stopped: boolean; adapter?: AgentAdapter; prepared?: PreparedPreset }>();
  private readonly metadata = new Set<AgentAdapter>();
  private readonly unconfirmed = new Set<string>();
  private readonly stopped = new Set<string>();
  private readonly completed = new Set<string>();
  private closed = false;
  constructor(private readonly runtime: PresetRuntime, readonly binding: PresetBinding, private readonly command: AgentCommand,
    private readonly env: NodeJS.ProcessEnv, private readonly factory: (command: AgentCommand, env: NodeJS.ProcessEnv) => AgentAdapter =
      (command, env) => binding.agent === 'codex' ? new CodexAdapter(command, env) : new ClaudeAdapter(command, env),
    private readonly visibility?: SessionVisibility) {}
  async preparePreset(workerId: string, nativeId: string | null): Promise<void> { await this.runtime.pin(this.binding, workerId, nativeId, this.visibility, this.env); }
  async getModelInfo(cwd: string, context?: Pick<Conversation, 'id' | 'nativeId'>) {
    if (this.closed) throw abortError();
    const key = createHash('sha256').update(JSON.stringify(this.binding)).digest('hex').slice(0, 24);
    const prepared = await this.runtime.prepare(this.binding, context?.id ?? `metadata-${key}-${this.visibility ?? 'legacy'}`, context?.nativeId ?? null, this.command, this.env, this.visibility);
    const adapter = this.factory(prepared.command, prepared.env);
    this.metadata.add(adapter);
    try { if (this.closed) throw abortError(); if (!adapter.getModelInfo) throw new Error('预设后端缺少模型目录接口。'); return await adapter.getModelInfo(cwd); }
    finally { try { await adapter.close(); } finally { this.metadata.delete(adapter); await prepared.close(); } }
  }
  async run(turn: AgentTurn): Promise<AgentResult> {
    if (this.closed || turn.signal.aborted) throw abortError();
    if (turn.conversation.agent !== this.binding.agent || turn.conversation.model !== this.binding.model) throw new Error('预设助手的引擎或模型不匹配。');
    const id = turn.conversation.id; if (this.active.has(id)) throw new Error('预设助手仍在执行。');
    const state: { stopped: boolean; adapter?: AgentAdapter; prepared?: PreparedPreset } = { stopped: false }; this.active.set(id, state); this.stopped.delete(id); this.completed.delete(id);
    let prepared: PreparedPreset | undefined;
    let nativeResult: AgentResult | undefined;
    let success = false, stopOnlyReport = false, resultUncertain = false, executionError: string | undefined;
    try {
      prepared = await this.runtime.prepare(this.binding, id, turn.conversation.nativeId, this.command, this.env, this.visibility); state.prepared = prepared;
      if (this.closed || state.stopped || turn.signal.aborted) throw abortError();
      state.adapter = this.factory(prepared.command, prepared.env);
      let ready = false;
      try { nativeResult = await state.adapter.run({ ...turn, onReady: () => { ready = true; turn.onReady?.(); } }); success = true; return nativeResult; }
      catch (error) {
        nativeResult = completedResultFromError(error);
        executionError = executionErrorEvidence(error);
        resultUncertain = isObject(error) && 'resultUncertain' in error;
        stopOnlyReport = !!nativeResult && isObject(error) && error.processStillRunning === true && !('resultUncertain' in error);
        if (error && typeof error === 'object' && 'processStillRunning' in error) this.unconfirmed.add(id);
        if (ready && !turn.signal.aborted && !state.stopped && !(error && typeof error === 'object' && 'processStillRunning' in error)) { resultUncertain = true; throw new PresetResultUnknown(nativeResult, stopEvidenceFromError(error), executionError); }
        throw error;
      }
    } finally {
      let cleanupError: unknown, confirmed = false;
      if (success && nativeResult?.processStopped === false) { stopOnlyReport = true; this.unconfirmed.add(id); this.completed.add(id); }
      if (stopOnlyReport) { try { confirmed = await state.adapter?.confirmStopped?.(id) === true; } catch {} }
      if (!stopOnlyReport || confirmed) { try { await state.adapter?.close(); } catch (error) { cleanupError = error; } }
      if (!stopOnlyReport || confirmed) { try { await prepared?.close(); } catch (error) { cleanupError ??= error; } }
      if (confirmed && cleanupError === undefined && !turn.signal.aborted && !state.stopped && !this.closed) { this.unconfirmed.delete(id); this.active.delete(id); this.stopped.add(id); return nativeResult!; }
      if (success && nativeResult && cleanupError !== undefined && !turn.signal.aborted && !state.stopped && !this.closed) {
        nativeResult.processStopped = false; nativeResult.cleanupError = executionErrorEvidence(cleanupError);
        this.unconfirmed.add(id); this.completed.add(id); return nativeResult;
      }
      if (cleanupError !== undefined) { this.unconfirmed.add(id); throw Object.assign(processStopFailure(cleanupError, nativeResult), { executionError, cleanupError: executionErrorEvidence(cleanupError) }, resultUncertain ? { resultUncertain: true } : {}); }
      if (!this.unconfirmed.has(id)) { this.active.delete(id); this.stopped.add(id); }
    }
  }
  async steer(id: string, input: AgentSupplement): Promise<SteerResult> { return await this.active.get(id)?.adapter?.steer?.(id, input) ?? { status: 'queued', unsupported: true, reason: '预设后端尚未就绪，未投递。' }; }
  async interrupt(id: string): Promise<void> {
    const state = this.active.get(id);
    if (state) {
      state.stopped = true; await state.adapter?.interrupt(id);
      if (this.unconfirmed.has(id)) { await state.adapter?.close(); await state.prepared?.close(); this.active.delete(id); this.unconfirmed.delete(id); this.stopped.add(id); }
    }
  }
  async confirmStopped(id: string): Promise<boolean> {
    if (this.unconfirmed.has(id)) {
      try { const state = this.active.get(id); if (await state?.adapter?.confirmStopped?.(id) === true) {
        await state?.adapter?.close(); await state?.prepared?.close(); this.unconfirmed.delete(id); this.active.delete(id); this.stopped.add(id);
      } } catch {}
    }
    return this.stopped.has(id) && !this.active.has(id) && !this.unconfirmed.has(id);
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.active.keys()].map(async id => {
    if (this.completed.has(id)) {
      await this.active.get(id)!.adapter!.close();
      if (await this.confirmStopped(id) !== true) throw processStopFailure(new Error('CLI 仍在收尾。'));
    } else await this.interrupt(id);
  })); await Promise.all([...this.metadata].map(adapter => adapter.close())); }
}
