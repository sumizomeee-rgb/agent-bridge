import { harnessText } from '../harness.js';
import { ControllerCoordinator, createControllerCoordinationState, TurnSealedError, canonicalControllerJSON as canonicalJSON, type ControllerCoordinationState } from './coordinator.js';
import { ControllerContextRenderer, controllerClock as bridgeClock, controllerImagePaths, currentImageManifest as imageManifest } from './context.js';
import { claudeModelSettings, createEffortReporter, effortCapabilityForModel, isEffortLevel, normalizeEffortCapability, observedClaudeEffort, resolveDefaultModel, selectedEffort, validateEffort } from '../effort.js';
import { workspaceDocuments } from './workspace-documents.js';
import { refreshControllerCodexLogin } from './codex-credentials.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync, renameSync, lstatSync, statSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import type { Server } from 'node:http';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import type { AgentAdapter, AgentCommand, AgentModelInfo, AgentName, AgentResult, AgentTurn, AgentInput, EffortConfiguration, EffortCapability, Conversation } from '../types.js';
import { claudeEffortConfiguration } from '../agents/claude-effort.js';
import { MetadataProbeError } from '../agents/metadata.js';
import { readCodexModelInfo } from '../agents/codex-models.js';
import { executionErrorEvidence } from '../delivery-errors.js';
export { controllerTools, controllerToolsForCommunication } from './tools/catalog.js';
import { createClaudeMcpServer } from './agents/claude/mcp.js';
import { codexToolContent } from './image-content.js';
import { codexDynamicTools } from './agents/codex/dynamic-tools.js';
import type { ControllerSubmission, ControllerTurnState } from '../controller-lifecycle.js';
import { abortError, isObject, JsonLineProcess, JsonRpcClient, JsonRpcTimeoutError, processStopFailure, safeError, type JsonObject, type RpcTransport } from '../agents/process.js';

export const controllerInstructions = harnessText('controller.protocol');

export function controllerInstructionsForCommunication(_enabled?: boolean): string {
  return harnessText('controller.protocol');
}

const disabledFeatures = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'view_image', 'workspace_dependencies', 'goals', 'sleep_tool', 'tool_suggest', 'skill_search', 'memories', 'in_app_browser'];
const configKeys = ['model', 'model_provider', 'model_providers', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'model_context_window', 'model_auto_compact_token_limit', 'model_max_output_tokens', 'model_supports_reasoning_summaries', 'model_catalog_json', 'service_tier', 'disable_response_storage', 'openai_base_url', 'chatgpt_base_url', 'chatgpt_headers', 'forced_login_method', 'forced_chatgpt_workspace_id', 'cli_auth_credentials_store'];
export function isolatedCodexConfig(source: string): string {
  // Parse TOML, then select model/auth routing. Empty override tables alone do not
  // remove user MCP entries: real 0.160.0 still launches those processes at startup.
  const original: JsonObject = parseTOML(source);
  const select = (value: JsonObject): JsonObject => Object.fromEntries(configKeys.filter(key => key in value).map(key => [key, value[key]]));
  const config = select(original);
  if (typeof original.profile === 'string') config.profile = original.profile;
  if (isObject(original.profiles)) config.profiles = Object.fromEntries(Object.entries(original.profiles).filter((entry): entry is [string, JsonObject] => isObject(entry[1])).map(([name, value]) => [name, select(value)]));
  config.agents = { enabled: false };
  config.features = Object.fromEntries([...disabledFeatures.map(name => [name, false]), ['code_mode_host', true]]);
  config.web_search = 'disabled'; config.project_doc_max_bytes = 0; config.check_for_update_on_startup = false;
  return stringifyTOML(config);
}
export function codexControllerOverrides(): string[] {
  // agents.enabled is the actual 0.160.0 collaboration switch. Code Mode must remain
  // enabled to execute its limited management functions; it has no filesystem/network API.
  return ['agents.enabled=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'check_for_update_on_startup=false', 'mcp_servers={}', 'plugins={}', 'features.code_mode_host=true', ...disabledFeatures.map(name => `features.${name}=false`)];
}
export interface NativeControllerOptions {
  agent: AgentName;
  internalBotCommunicationEnabled?: boolean;
  dataDir: string;
  contextWorkspace?: string;
  invokeTool: (turn: AgentTurn, name: string, args: JsonObject, callId?: string) => Promise<unknown>;
  metadataAdapter?: AgentAdapter;
  defaultModels?: Partial<Record<AgentName, string>>;
  identity?: { controllerId?: string; botId?: string; aliases: string[] };
  maxToolCalls?: number;
  /** Test-only transport seam; production uses a real CLI process. */
  createTransport?: (command: AgentCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv) => RpcTransport;
  userHome?: string;
  isolatedLaunch?: boolean;
}
/** A native turn failed; final platform delivery is tracked independently. */
class NativeTurnFailure extends Error {}
/** A failed report decision ended, its CLI stopped, and no publication or tool is outstanding. */
class ReportRecoveryFailure extends Error {}
interface ActiveTurn extends ControllerCoordinationState {
  reportEffort: ReturnType<typeof createEffortReporter>;
  effortCapability: EffortCapability;
  nativeTurnId: string | null;
  pendingClaudeTools: { id: string; name: string; args?: JsonObject }[];
  retiredNativeTurnIds: Set<string>;
  seenClaudeTools: Set<string>;
}

interface ControllerSession {
  transport: RpcTransport;
  rpc: JsonRpcClient | null;
  nativeId: string | null;
  signature: string;
  active: ActiveTurn | null;
  server: Server | null;
  removeListeners: (() => void)[];
  closed: boolean;
  stopPromise?: Promise<void>;
  stopFailed?: boolean;
  transportFailure?: Error;
  model?: string;
  effort?: string | null;
  effortConfiguration?: EffortConfiguration | null;
  effortCapability?: EffortCapability;
  metadataSource?: string;
  runtimeFacts?: string;
}

interface ControllerProcessProof {
  version: 1; agent: AgentName; conversationId: string; pid: number; nonce: string;
  stopped: boolean; startedAt: string; stoppedAt?: string;
}
export class NativeControllerAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, ControllerSession>();
  private readonly coordinator: ControllerCoordinator;
  private readonly context: ControllerContextRenderer;
  private readonly metadataConnections = new WeakMap<MetadataProbeError, ControllerSession>();
  private readonly closingSessions = new Map<string, ControllerSession>();
  private readonly transportProofs = new WeakMap<RpcTransport, ControllerProcessProof>();
  private readonly confirmedStopped = new Map<string, { nonce?: string }>();
  private closed = false;
  constructor(private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv, private readonly options: NativeControllerOptions) {
    this.coordinator = new ControllerCoordinator(options);
    this.context = new ControllerContextRenderer(options);
  }

  async getModelInfo(cwd: string, conversation?: Conversation): Promise<AgentModelInfo> {
    if (this.closed) throw new Error('主控适配器已关闭。');
    const session = conversation && this.sessions.get(conversation.id);
    // 同一配置的已初始化主控提供目录，不再为每条消息额外启动 CLI。
    if (session?.rpc && !session.closed && !session.stopFailed && !session.transportFailure && session.metadataSource === this.metadataSource(cwd)) {
      try { return await readCodexModelInfo(session.rpc, cwd); }
      catch (error) { const failure = new MetadataProbeError(error, false); this.metadataConnections.set(failure, session); throw failure; }
    }
    if (!this.options.metadataAdapter?.getModelInfo) throw new Error('主控没有配置模型目录查询适配器。');
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new Error('主控适配器已关闭。');
      try { return await this.options.metadataAdapter.getModelInfo(cwd); }
      catch (error) {
        const retry = error instanceof MetadataProbeError && error.processStopped && attempt === 0 && !this.closed;
        try { appendFileSync(join(this.options.dataDir, 'controller-preflight-diagnostic.jsonl'), JSON.stringify({
          at: new Date().toISOString(), stage: 'metadata', attempt: attempt + 1, retry,
          evidence: executionErrorEvidence(error), ...(error instanceof MetadataProbeError ? { processStopped: error.processStopped, cleanupError: error.cleanupError, stopEvidence: error.stopEvidence } : {}),
        }) + '\n'); } catch { /* Diagnostic failure never permits an unsafe retry. */ }
        if (!retry) throw error;
        // Only repeat this no-generation probe; never replay a submitted controller turn.
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  private sourceFiles(): string[] {
    const userHome = this.options.userHome ?? homedir();
    if (this.options.isolatedLaunch) {
      const home = this.options.agent === 'codex' ? this.env.CODEX_HOME : this.env.CLAUDE_CONFIG_DIR;
      if (!home) throw new Error('预设启动配置目录缺失，拒绝回退普通配置。');
      return this.options.agent === 'codex' ? [join(home, 'config.toml'), join(home, 'auth.json')]
        : [join(home, 'settings.json'), join(home, '.credentials.json'), join(home, '.claude.json')];
    }
    return this.options.agent === 'codex'
      ? [join(userHome, '.codex', 'config.toml'), join(userHome, '.codex', 'auth.json')]
      : [join(userHome, '.claude', 'settings.json'), join(userHome, '.claude', '.credentials.json'), join(userHome, '.claude.json')];
  }
  private metadataSource(cwd: string): string {
    const hash = createHash('sha256');
    for (const file of this.sourceFiles()) hash.update(existsSync(file) ? readFileSync(file) : 'missing');
    hash.update(cwd); return hash.digest('hex');
  }
  private instructions(): string {
    return workspaceDocuments(this.options.contextWorkspace, { agent: this.options.agent, internalBotCommunicationEnabled: this.options.internalBotCommunicationEnabled }).text;
  }
  private signature(turn: AgentTurn): string {
    return createHash('sha256').update(this.metadataSource(turn.conversation.cwd))
      .update(JSON.stringify([turn.conversation.model ?? null, selectedEffort(turn), this.options.agent === 'codex' && turn.conversation.fastMode != null]))
      .update(this.instructions()).digest('hex');
  }
  private processProofPath(conversationId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId)) throw new Error('主控会话标识不合法。');
    return resolve(this.options.dataDir, 'controller-homes', this.options.agent, conversationId, 'process-proof.json');
  }
  private readProcessProof(conversationId: string): ControllerProcessProof | null {
    const path = this.processProofPath(conversationId);
    try {
      if (lstatSync(path).isSymbolicLink() || statSync(path).size > 4096) return null;
      const value = JSON.parse(readFileSync(path, 'utf8')) as ControllerProcessProof;
      if (value.version !== 1 || value.agent !== this.options.agent || value.conversationId !== conversationId
        || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.nonce)
        || typeof value.stopped !== 'boolean' || typeof value.startedAt !== 'string') return null;
      return value;
    } catch { return null; }
  }
  private writeProcessProof(proof: ControllerProcessProof): void {
    const path = this.processProofPath(proof.conversationId), temporary = path + '.' + randomUUID() + '.tmp';
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(temporary, JSON.stringify(proof), { mode: 0o600 }); renameSync(temporary, path);
  }
  private createTransport(args: string[], cwd: string, env: NodeJS.ProcessEnv): RpcTransport {
    const transport = this.options.createTransport?.(this.command, args, cwd, env) ?? new JsonLineProcess(this.command, args, cwd, env);
    const home = this.options.agent === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR;
    if (transport instanceof JsonLineProcess && home && Number.isSafeInteger(transport.child.pid) && transport.child.pid! > 0) {
      const conversationId = basename(home);
      if (resolve(home, 'process-proof.json') !== this.processProofPath(conversationId)) throw new Error('主控进程证明目录与会话不一致。');
      const proof: ControllerProcessProof = { version: 1, agent: this.options.agent, conversationId, pid: transport.child.pid!, nonce: randomUUID(), stopped: false, startedAt: new Date().toISOString() };
      this.confirmedStopped.delete(conversationId); this.transportProofs.set(transport, proof);
      // Subscribe before writing the initial proof. A close callback may only complete its own nonce.
      transport.child.once('close', () => {
        const current = this.readProcessProof(conversationId); if (current?.nonce !== proof.nonce) return;
        try { this.writeProcessProof({ ...proof, stopped: true, stoppedAt: new Date().toISOString() }); } catch { /* Missing evidence remains unknown. */ }
      });
      try { this.writeProcessProof(proof); }
      catch (error) { void transport.stop(false).catch(() => {}); throw error; }
    }
    return transport;
  }
  /** Read-only process reconciliation. A fresh adapter with no sessions is never proof of exit. */
  async confirmStopped(conversationId: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId)) return false;
    if (this.sessions.has(conversationId) || this.closingSessions.get(conversationId)?.active) return false;
    const proof = this.readProcessProof(conversationId), confirmed = this.confirmedStopped.get(conversationId);
    if (confirmed && (confirmed.nonce == null && !proof || confirmed.nonce === proof?.nonce && proof?.stopped)) return true;
    if (!proof) return false;
    try { process.kill(proof.pid, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      const closing = this.closingSessions.get(conversationId);
      if (closing && !closing.active) this.closingSessions.delete(conversationId);
      return true;
    }
  }
  private controllerHome(turn: AgentTurn): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(turn.conversation.id)) throw new Error('主控会话标识不合法。');
    const home = resolve(this.options.dataDir, 'controller-homes', this.options.agent, turn.conversation.id);
    mkdirSync(home, { recursive: true });
    const userFiles = this.sourceFiles();
    if (this.options.agent === 'codex') {
      const sourceConfig = userFiles[0]!;
      writeFileSync(join(home, 'config.toml'), isolatedCodexConfig(existsSync(sourceConfig) ? readFileSync(sourceConfig, 'utf8') : ''), 'utf8');
      this.copyCredential(userFiles[1]!, join(home, 'auth.json'));
      if (!this.options.isolatedLaunch) refreshControllerCodexLogin(userFiles[1]!, join(home, 'auth.json'));
    } else {
      for (const file of userFiles.slice(1)) this.copyCredential(file, join(home, file.endsWith('.credentials.json') ? '.credentials.json' : '.claude.json'));
    }
    return home;
  }
  private copyCredential(source: string, destination: string): void {
    const marker = destination + '.source-hash';
    if (!existsSync(source)) { if (existsSync(destination)) unlinkSync(destination); if (existsSync(marker)) unlinkSync(marker); return; }
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
    // Preserve CLI-refreshed isolated credentials until the source is changed or removed.
    if (existsSync(destination) && existsSync(marker) && readFileSync(marker, 'utf8') === hash) return;
    copyFileSync(source, destination); writeFileSync(marker, hash, 'utf8');
  }
  private async open(turn: AgentTurn, signature: string): Promise<ControllerSession> {
    const home = this.controllerHome(turn);
    if (this.options.agent === 'codex') return this.openCodex(turn, signature, home);
    return this.openClaude(turn, signature, home);
  }
  private async openCodex(turn: AgentTurn, signature: string, home: string): Promise<ControllerSession> {
    const args = ['app-server', '--listen', 'stdio://', ...codexControllerOverrides().flatMap(value => ['-c', value]), ...(turn.conversation.fastMode != null ? ['-c', 'features.fast_mode=true'] : [])];
    const transport = this.createTransport(args, turn.conversation.cwd, { ...this.env, CODEX_HOME: home });
    const session: ControllerSession = { transport, rpc: new JsonRpcClient(transport), nativeId: turn.conversation.nativeId, signature, active: null, server: null, removeListeners: [], closed: false };
    this.sessions.set(turn.conversation.id, session);
    session.removeListeners.push(transport.onFailure(error => { session.transportFailure = error; session.active?.completed.reject(error); }), transport.onMessage(message => this.onCodexMessage(session, message)));
    try {
      await session.rpc!.request('initialize', { clientInfo: { name: 'discord_bridge_controller', version: '1' }, capabilities: { experimentalApi: true } }, 15000);
      session.rpc!.notify('initialized');
      if (this.signature(turn) !== signature) throw new Error('主控启动期间源配置已变化；本轮未提交。');
      session.metadataSource = this.metadataSource(turn.conversation.cwd);
      if (selectedEffort(turn)) session.effortCapability = await validateEffort(this, turn.conversation, selectedEffort(turn)!);
      const configured = await session.rpc!.request('config/read', { includeLayers: false, cwd: turn.conversation.cwd }, 15000);
      if (!isObject(configured.config)) throw new Error('Codex 主控没有返回供应商配置。');
      const provider = configured.config.model_provider ?? 'openai';
      session.effortConfiguration = selectedEffort(turn) ? { value: selectedEffort(turn)!, source: 'argument' }
        : isEffortLevel(configured.config.model_reasoning_effort) ? { value: configured.config.model_reasoning_effort, source: 'session-settings' } : null;
      if (typeof provider !== 'string' || !provider.trim()) throw new Error('Codex 主控供应商配置无效。');
      const params: JsonObject = { ...((selectedEffort(turn) ?? configured.config.model_reasoning_effort) ? { config: { model_reasoning_effort: selectedEffort(turn) ?? configured.config.model_reasoning_effort } } : {}), modelProvider: provider, cwd: turn.conversation.cwd, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: this.instructions(), developerInstructions: '', ...(turn.conversation.model ? { model: turn.conversation.model } : {}) };
      const prior = session.nativeId;
      const response = await session.rpc!.request(prior ? 'thread/resume' : 'thread/start', prior
        ? { ...params, threadId: prior, excludeTurns: true }
        : { ...params, ephemeral: false, environments: [], selectedCapabilityRoots: [], dynamicTools: codexDynamicTools(this.options.internalBotCommunicationEnabled) }, 20000);
      if (!isObject(response.thread) || typeof response.thread.id !== 'string' || (prior && response.thread.id !== prior)) throw new Error('Codex 主控续接返回了不同会话；原会话已保留。');
      if (typeof response.modelProvider !== 'string' || response.modelProvider !== provider) throw new Error('Codex 主控回报的供应商与当前配置不一致；原会话已保留，本轮未提交。');
      session.nativeId = response.thread.id; turn.onNativeId?.(session.nativeId);
      if (typeof response.model === 'string') { session.model = response.model; turn.onModel?.(session.model); }
      if (!selectedEffort(turn) && (typeof response.reasoningEffort === 'string' || response.reasoningEffort === null)) { session.effort = response.reasoningEffort; turn.onReasoningEffort?.(session.effort); }
      return session;
    } catch (error) {
      try { await this.stopSession(turn.conversation.id, session); }
      catch (cleanup) {
        const failure = processStopFailure(cleanup); failure.cause = error;
        Object.assign(failure, { cleanupError: executionErrorEvidence(cleanup) }); throw failure;
      }
      throw error;
    }
  }
  private onCodexMessage(session: ControllerSession, message: JsonObject): void {
    if (typeof message.method !== 'string') return;
    const params = isObject(message.params) ? message.params : {};
    if ('id' in message) { void this.handleCodexRequest(session, message, params).catch(error => session.active?.completed.reject(error)); return; }
    const active = session.active;
    if (!active || (typeof params.threadId === 'string' && params.threadId !== session.nativeId)) return;
    if ((typeof params.turnId === 'string' && active.retiredNativeTurnIds.has(params.turnId))
      || (isObject(params.turn) && typeof params.turn.id === 'string' && active.retiredNativeTurnIds.has(params.turn.id))) return;
    if (typeof params.turnId === 'string' && active.nativeTurnId && params.turnId !== active.nativeTurnId) return;
    if (message.method === 'turn/started' && isObject(params.turn) && typeof params.turn.id === 'string') { if (!active.nativeTurnId || active.nativeTurnId === params.turn.id) { active.nativeTurnId = params.turn.id; this.acknowledgeSubmission(active); } }
    else if (message.method === 'model/rerouted' && typeof params.toModel === 'string') { session.model = params.toModel; active.effortCapability = effortCapabilityForModel(active.effortCapability, params.toModel); active.reportEffort({ capability: active.effortCapability }); active.turn.onModel?.(params.toModel); }
    else if (message.method === 'error' && params.willRetry === false) active.completed.reject(new NativeTurnFailure(`主控请求失败：${safeError(isObject(params.error) ? params.error.message : '', 'Agent 错误')}`));
    else if (message.method === 'turn/completed' && isObject(params.turn)) {
      if (active.nativeTurnId && params.turn.id !== active.nativeTurnId) return;
      if (params.turn.status !== 'completed') {
        const failure = `主控执行失败：${safeError(isObject(params.turn.error) ? params.turn.error.message : '', String(params.turn.status))}`;
        active.completed.reject(params.turn.status === 'failed' ? new NativeTurnFailure(failure) : new Error(failure));
      }
      else if (!session.nativeId) active.completed.reject(new Error('主控没有返回会话标识。'));
      else this.finish(session, active);
    }
  }
  private async handleCodexRequest(session: ControllerSession, message: JsonObject, params: JsonObject): Promise<void> {
    if (message.method !== 'item/tool/call') { session.transport.write({ id: message.id, error: { code: -32601, message: 'Controller only accepts registered bridge management calls' } }); return; }
    try {
      if (session.active && params.threadId === session.nativeId && typeof params.turnId === 'string' && session.active.retiredNativeTurnIds.has(params.turnId)) {
        session.transport.write({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(this.coordinator.scenePausedResult(session.active)) }] } }); return;
      }
      if (!session.active || params.threadId !== session.nativeId || typeof params.tool !== 'string' || (session.active.nativeTurnId && params.turnId !== session.active.nativeTurnId)) throw new Error('主控工具请求不属于当前会话轮次。');
      const args: unknown = typeof params.arguments === 'string' ? JSON.parse(params.arguments) : params.arguments;
      if (!isObject(args)) throw new Error('主控工具参数格式无效。');
      const callId = typeof params.callId === 'string' ? params.callId : typeof params.itemId === 'string' ? params.itemId : null;
      if (!callId) throw new Error('主控工具请求缺少稳定调用标识。');
      const value = await this.coordinator.invoke(session.active, params.tool, args, callId);
      session.transport.write({ id: message.id, result: { success: true, contentItems: codexToolContent(value) } });
    } catch (error) { session.transport.write({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: safeError(error instanceof Error ? error.message : error, '主控工具失败') }] } }); }
  }
  private finish(session: ControllerSession, active: ActiveTurn): void {
    void this.coordinator.finish(active, {
      resetDecision: () => {
        active.pendingClaudeTools = [];
        if (active.nativeTurnId) active.retiredNativeTurnIds.add(active.nativeTurnId);
        active.nativeTurnId = null;
      },
      continueDecision: async (kind, evidence) => {
        if (session.rpc) {
          const started = await this.startCodexTurn(session, active, { threadId: session.nativeId, environments: [], input: [],
            toolOutput: { name: kind === 'scene-refresh' ? 'bridge_scene_refresh' : 'bridge_reply_recovery', namespace: null, output: evidence },
            ...(selectedEffort(active.turn) ? { effort: selectedEffort(active.turn) } : {}) });
          if (!isObject(started.turn) || typeof started.turn.id !== 'string') throw new Error('主控续决策没有返回轮次标识。');
          if (active.nativeTurnId && active.nativeTurnId !== started.turn.id) throw new Error('主控续决策轮次确认不一致。');
          active.nativeTurnId = started.turn.id;
        } else session.transport.write({ type: 'user', session_id: session.nativeId ?? '', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: evidence }] } });
      },
      continuePrivate: values => this.startPrivateReassessment(session, active, values),
      result: () => {
        if (!session.nativeId) throw new Error('主控没有返回会话标识。');
        return { nativeId: session.nativeId, text: '', controlledOutput: true };
      },
    }).catch(() => {});
  }
  private async claudeInput(values: AgentInput[]): Promise<JsonObject[]> {
    const content: JsonObject[] = [];
    for (const value of values) {
      if (value.type === 'text') content.push(value);
      else { const bytes = await readFile(value.path); content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType(bytes), data: bytes.toString('base64') } }); }
    }
    return content;
  }
  private async startPrivateReassessment(session: ControllerSession, active: ActiveTurn, values: AgentInput[]): Promise<void> {
    values.push({ type: 'text', text: harnessText('controller.private_input_update') + this.runtimeContext(active.turn, session) });
    if (session.rpc) {
      const started = await this.startCodexTurn(session, active, { threadId: session.nativeId, environments: [],
        input: values.map(value => value.type === 'text' ? { ...value, text_elements: [] } : value),
        ...(selectedEffort(active.turn) ? { effort: selectedEffort(active.turn) } : {}) });
      if (!isObject(started.turn) || typeof started.turn.id !== 'string') throw new Error('Codex 私聊续决策没有返回轮次标识。');
      if (active.nativeTurnId && active.nativeTurnId !== started.turn.id) throw new Error('Codex 私聊续决策轮次确认不一致。');
      active.nativeTurnId = started.turn.id;
    } else session.transport.write({ type: 'user', session_id: session.nativeId ?? '', parent_tool_use_id: null,
      message: { role: 'user', content: await this.claudeInput(values) } });
  }
  private async openClaude(turn: AgentTurn, signature: string, home: string): Promise<ControllerSession> {
    let session: ControllerSession;
    const { server, token } = createClaudeMcpServer({
      dataDir: this.options.dataDir, internalBotCommunicationEnabled: this.options.internalBotCommunicationEnabled,
      invoke: async (name, args, matched) => {
        if (!session?.active) throw new Error('没有当前主控轮次或参数无效。');
        // Match the stable native tool-use ID, never the process-local MCP request number.
        const active = session.active;
        const matches = (tool: ActiveTurn['pendingClaudeTools'][number]) => tool.name === name && tool.args != null && canonicalJSON(tool.args) === canonicalJSON(args);
        let index = active.pendingClaudeTools.findIndex(matches);
        for (let attempt = 0; index < 0 && attempt < 25; attempt++) { await new Promise(resolve => setTimeout(resolve, 20)); index = active.pendingClaudeTools.findIndex(matches); }
        const nativeTool = index < 0 ? null : active.pendingClaudeTools.splice(index, 1)[0];
        if (!nativeTool) throw new Error('Claude 工具调用缺少原生调用标识，未执行派发。');
        matched();
        return this.coordinator.invoke(active, name, args, nativeTool.id);
      },
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法启动主控 MCP。');
    try {
    let settingsEnv: JsonObject = {}, modelSettings: JsonObject = {}, sourceSettings: JsonObject = {};
    const settingsPath = this.sourceFiles()[0]!;
    if (existsSync(settingsPath)) { const settings: unknown = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')); if (isObject(settings)) { sourceSettings = settings; if (isObject(settings.env)) settingsEnv = settings.env; modelSettings = claudeModelSettings(settings); } }
    const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { bridge_controller: { type: 'http', url: `http://127.0.0.1:${address.port}/${token}` } } }), '--no-chrome', '--disable-slash-commands', '--setting-sources', '', '--system-prompt', this.instructions(), '--dangerously-skip-permissions', '--settings', JSON.stringify({ ...modelSettings, env: settingsEnv }), ...(turn.conversation.nativeId ? ['--resume', turn.conversation.nativeId] : []), ...(turn.conversation.model ? ['--model', turn.conversation.model] : []), ...(selectedEffort(turn) ? ['--effort', selectedEffort(turn)!] : [])];
    const effectiveEnv = { ...settingsEnv as NodeJS.ProcessEnv, ...this.env, CLAUDE_CONFIG_DIR: home };
    const configuration = await claudeEffortConfiguration({ ...this.command, args: [...this.command.args, ...args] }, effectiveEnv, turn.conversation.cwd, selectedEffort(turn));
    const transport = this.createTransport(args, turn.conversation.cwd, { ...settingsEnv as NodeJS.ProcessEnv, ...this.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_BRIEF: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    session = { transport, rpc: null, nativeId: turn.conversation.nativeId, signature, active: null, server, removeListeners: [], closed: false,
      effortConfiguration: configuration ?? (typeof sourceSettings.effortLevel === 'string' ? { value: sourceSettings.effortLevel, source: 'user-settings', applied: false, reason: '当前适配器未将此设置传入主控 CLI' } : null) };
    this.sessions.set(turn.conversation.id, session);
    session.removeListeners.push(transport.onFailure(error => { session.transportFailure = error; session.active?.completed.reject(error); }), transport.onMessage(message => this.onClaudeMessage(session, message)));
    return session;
    } catch (error) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      throw error;
    }
  }
  private onClaudeMessage(session: ControllerSession, message: JsonObject): void {
    const active = session.active;
    if (!active) return;
    const observedEffort = observedClaudeEffort(message);
    if (observedEffort !== undefined) active.reportEffort({ actual: observedEffort });
    if (typeof message.session_id === 'string' && message.session_id) {
      if (session.nativeId && message.session_id !== session.nativeId) { active.completed.reject(new Error('Claude 主控返回了不同会话；原会话已保留。')); return; }
      session.nativeId = message.session_id; active.turn.onNativeId?.(session.nativeId);
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (!Array.isArray(message.tools) || message.tools.some(tool => typeof tool !== 'string' || !tool.startsWith('mcp__bridge_controller__'))) { active.completed.reject(new Error('Claude 主控暴露了非桥管理工具，本轮已停止。')); return; }
      if (typeof message.model === 'string') { session.model = message.model; active.effortCapability = effortCapabilityForModel(active.effortCapability, message.model); active.reportEffort({ capability: active.effortCapability }); active.turn.onModel?.(message.model); }
      if (message.supportsEffort === false || Array.isArray(message.supportedEffortLevels)) {
        active.effortCapability = normalizeEffortCapability('claude', message.supportedEffortLevels,
          { source: 'claude-init', modelId: session.model ?? active.turn.conversation.model ?? null }, message.supportsEffort === false);
        active.reportEffort({ capability: active.effortCapability });
      }
    } else if (message.type === 'stream_event' && isObject(message.event) && message.event.type === 'content_block_start' && isObject(message.event.content_block)) {
      this.recordClaudeTool(active, message.event.content_block);
    } else if (message.type === 'assistant' && !message.parent_tool_use_id && isObject(message.message)) {
      this.acknowledgeSubmission(active);
      if (typeof message.message.model === 'string') { session.model = message.message.model; active.effortCapability = effortCapabilityForModel(active.effortCapability, message.message.model); active.reportEffort({ capability: active.effortCapability }); active.turn.onModel?.(message.message.model); }
      if (Array.isArray(message.message.content)) for (const item of message.message.content) if (isObject(item)) this.recordClaudeTool(active, item);
    } else if (message.type === 'result') {
      this.acknowledgeSubmission(active);
      if (message.is_error === true || message.subtype !== 'success') {
        const details = [String(message.subtype), typeof message.result === 'string' ? message.result : '', ...(Array.isArray(message.errors) ? message.errors.filter((value): value is string => typeof value === 'string').slice(0, 3) : [])].filter(Boolean).join('\n');
        active.completed.reject(new NativeTurnFailure(`Claude 主控失败：${safeError(details || String(message.subtype), String(message.subtype))}`));
      }
      else if (!session.nativeId) active.completed.reject(new Error('Claude 主控没有返回会话标识。'));
      else this.finish(session, active);
    }
  }
  private acknowledgeSubmission(active: ActiveTurn): void {
    if (active.submissionAcknowledged) return;
    active.submissionAcknowledged = true;
    try { active.turn.onControllerState?.({ attempt: 1, phase: 'accepted', submission: 'accepted' }); }
    catch (error) { active.completed.reject(error); }
  }
  private recordClaudeTool(active: ActiveTurn, item: JsonObject): void {
    if (item.type !== 'tool_use' || typeof item.id !== 'string' || typeof item.name !== 'string') return;
    const name = item.name.replace(/^mcp__bridge_controller__/, '');
    const existing = active.pendingClaudeTools.find(tool => tool.id === item.id);
    if (existing) { if (isObject(item.input)) existing.args = item.input; }
    else if (!active.seenClaudeTools.has(item.id)) { active.seenClaudeTools.add(item.id); active.pendingClaudeTools.push({ id: item.id, name, ...(isObject(item.input) ? { args: item.input } : {}) }); }
  }
  private runtimeContext(turn: AgentTurn, session: ControllerSession, includeTaskChecklist = false): string {
    return this.context.runtime(turn, session, includeTaskChecklist);
  }

  async run(turn: AgentTurn): Promise<AgentResult> {
    if (this.closed) throw new Error('主控适配器已关闭。');
    if (turn.conversation.agent !== this.options.agent) throw new Error('原生主控入口与当前 Agent 类型不一致。');
    if (turn.signal.aborted) throw abortError();
    // A parallel call is a caller error, not permission to retire another active decision.
    if (this.sessions.get(turn.conversation.id)?.active) throw new Error('主控消息必须按顺序执行。');
    // One logical model turn, shared by private/group/background entry points and native retries.
    const contextTurn = this.context.begin(turn);
    turn = contextTurn.turn;
    let counted = false;
    const report = turn.event?.kind === 'worker-result';
    const recover = turn.controllerRecovery === true && (!turn.event || report) && !turn.groupContext && !turn.preparing;
    let reportRecovery = false;
    const originalSignature = this.signature(turn);
    let nativeId = turn.conversation.nativeId;
    for (let attempt = 1; ; attempt++) {
      let submission: ControllerSubmission = 'not-submitted';
      const state = (phase: ControllerTurnState['phase'], value = submission, error?: unknown) => {
        submission = value;
        turn.onControllerState?.({ attempt, phase, submission, ...(error === undefined ? {} : { diagnostic: executionErrorEvidence(error) }) });
        if (!counted && value !== 'not-submitted') {
          contextTurn.acknowledge(); counted = true;
        }
      };
      state('preparing');
      try {
        const result = await this.runAttempt({ ...turn, taskChecklist: counted ? undefined : turn.taskChecklist, conversation: { ...turn.conversation, nativeId },
          onNativeId: id => { nativeId = id; turn.onNativeId?.(id); },
          onControllerState: update => state(update.phase, update.submission),
        }, value => state(value === 'unknown' ? 'submitting' : 'accepted', value), reportRecovery);
        state('completed', 'accepted');
        return result;
      } catch (error) {
        const session = this.sessions.get(turn.conversation.id) ?? this.closingSessions.get(turn.conversation.id);
        const unsafeProbe = error instanceof MetadataProbeError && !error.processStopped
          && (!session || this.metadataConnections.get(error) !== session);
        // A failed independent probe is not permission to retire the healthy controller or overlap that probe.
        // Only pre-submission recovery may retire a session here. Submitted failures are already handled by runAttempt.
        if (recover && submission === 'not-submitted' && session && !session.active && !unsafeProbe) {
          try { await this.stopSession(turn.conversation.id, session); }
          catch (cleanup) { const failure = processStopFailure(cleanup); failure.cause = error; state('failed', submission, failure); throw failure; }
        }
        const stopping = this.closingSessions.has(turn.conversation.id);
        if (recover && attempt === 1 && submission === 'not-submitted' && !unsafeProbe && !stopping
          && !this.closed && !turn.signal.aborted && this.signature(turn) === originalSignature) {
          state('retrying', submission, error);
          continue;
        }
        if (recover && report && attempt === 1 && (submission as ControllerSubmission) === 'accepted' && error instanceof ReportRecoveryFailure
          && !stopping && !this.closed && !turn.signal.aborted && this.signature(turn) === originalSignature) {
          // Continue only the saved report, in the same native history, with execution tools blocked.
          reportRecovery = true;
          state('reply-recovery', submission, error);
          const evidence = harnessText('controller.report_recovery', { report: turn.event!.text });
          turn = { ...turn, event: { ...turn.event!, text: evidence }, text: evidence, input: [{ type: 'text', text: evidence }] };
          continue;
        }
        state('failed', submission, error);
        throw error;
      }
    }
  }
  private async startCodexTurn(session: ControllerSession, active: ActiveTurn, params: JsonObject): Promise<JsonObject> {
    try { return await session.rpc!.request('turn/start', params, 20000); }
    catch (error) {
      // A matching native turn event is independent acceptance evidence. Losing
      // only the RPC response must not retire a controller that is still working.
      // Unknown submission, explicit rejection and transport failures stay errors.
      if (error instanceof JsonRpcTimeoutError && error.method === 'turn/start'
        && session.active === active && active.submissionAcknowledged && active.nativeTurnId
        && !session.closed && !session.transportFailure && !active.turn.signal.aborted) {
        return { turn: { id: active.nativeTurnId } };
      }
      throw error;
    }
  }
  private async runAttempt(turn: AgentTurn, submitted: (state: ControllerSubmission) => void, reportRecovery = false): Promise<AgentResult> {
    if (this.closed) throw new Error('主控适配器已关闭。');
    if (turn.conversation.agent !== this.options.agent) throw new Error('原生主控入口与当前 Agent 类型不一致。');
    if (turn.signal.aborted) throw abortError();
    const idle = this.sessions.get(turn.conversation.id);
    if (idle?.transportFailure) await this.stopSession(turn.conversation.id, idle);
    turn = await resolveDefaultModel(this, turn);
    const effort = selectedEffort(turn);
    const key = turn.conversation.id, signature = this.signature(turn);
    const closing = this.closingSessions.get(key);
    if (closing) await this.stopSession(key, closing);
    if (this.closed) throw new Error('主控适配器已关闭。');
    if (turn.conversation.agent !== this.options.agent) throw new Error('原生主控入口与当前 Agent 类型不一致。');
    if (turn.signal.aborted) throw abortError();
    let session = this.sessions.get(key);
    if (session?.active) throw new Error('主控消息必须按顺序执行。');
    if (session && session.signature !== signature) { await this.stopSession(key, session); session = undefined; }
    // 能力只复用于相同源配置、目录、模型和 effort 的同一运行会话。
    let capability = session?.effortCapability ?? normalizeEffortCapability(this.options.agent, undefined, { source: this.options.agent + '-native', modelId: turn.conversation.model ?? null });
    if (!session && effort && this.options.agent === 'claude') capability = await validateEffort(this, turn.conversation, effort);
    if (turn.signal.aborted) throw abortError();
    session ??= await this.open(turn, signature);
    capability = session.effortCapability ?? capability;
    session.effortCapability = capability;
    if (turn.signal.aborted) { await this.stopSession(key, session); throw abortError(); }
    if (session.nativeId) turn.onNativeId?.(session.nativeId);
    if (session.model) turn.onModel?.(session.model);
    const scopedCapability = session.model ? effortCapabilityForModel(capability, session.model) : capability;
    const reportEffort = createEffortReporter(turn, this.options.agent, { capability: scopedCapability, configuration: session.effortConfiguration ?? null, actual: !effort ? session.effort ?? null : null });
    reportEffort();
    const active: ActiveTurn = { ...createControllerCoordinationState(turn, { replyRecovery: reportRecovery }), reportEffort, effortCapability: scopedCapability, nativeTurnId: null, pendingClaudeTools: [], seenClaudeTools: new Set(), retiredNativeTurnIds: new Set() };
    session.active = active;
    const onAbort = () => { active.completed.reject(abortError()); void this.stopSession(key, session!).catch(() => {}); };
    turn.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (session.rpc) {
        const input = (turn.input ?? [{ type: 'text' as const, text: turn.text }, ...turn.imagePaths.map(path => ({ type: 'localImage' as const, path }))]).map(value => value.type === 'text' ? { ...value, text_elements: [] } : value);
        const manifest = imageManifest(turn);
        if (!turn.event && manifest) input.push({ type: 'text', text: manifest, text_elements: [] });
        const clock = this.runtimeContext(turn, session, true);
        if (!turn.event) input.push({ type: 'text', text: clock, text_elements: [] });
        const params: JsonObject = { threadId: session.nativeId, environments: [], input: turn.event ? controllerImagePaths(turn).map(path => ({ type: 'localImage', path })) : input, ...(effort ? { effort } : {}),
          ...(turn.conversation.fastMode != null ? { serviceTierForTurn: turn.conversation.fastMode ? 'fast' : 'default' } : {}) };
        if (turn.event) params.toolOutput = { name: turn.event.toolName ?? (turn.event.kind === 'wake' ? 'bridge_schedule_controller' : 'bridge_worker_result'), namespace: null, output: `${clock}\n\n${turn.event.text}${manifest ? '\n' + manifest : ''}` };
        submitted('unknown'); // Persist before I/O: a lost acknowledgement must never cause a replay.
        const started = await this.startCodexTurn(session, active, params);
        if (!isObject(started.turn) || typeof started.turn.id !== 'string') throw new Error('Codex 主控没有返回轮次标识。');
        if (active.nativeTurnId && active.nativeTurnId !== started.turn.id) throw new Error('Codex 主控轮次确认不一致。');
        active.nativeTurnId = started.turn.id;
        if (!active.submissionAcknowledged) { active.submissionAcknowledged = true; submitted('accepted'); }
        if (effort) {
          try {
            const configured = await session.rpc.request('thread/read', { includeTurns: false, threadId: session.nativeId }, 15000);
            const actual = isObject(configured.thread) ? configured.thread.reasoningEffort : null;
            session.effort = typeof actual === 'string' ? actual : null;
          } catch { session.effort = null; } // Missing metadata does not fail or replay a submitted turn.
          active.reportEffort({ actual: session.effort });
        }
      } else {
        const values = turn.event ? [{ type: 'text' as const, text: harnessText('controller.background_event', { kind: turn.event.kind, text: turn.event.text }) }, ...controllerImagePaths(turn).map(path => ({ type: 'localImage' as const, path }))] : turn.input ?? [{ type: 'text' as const, text: turn.text }, ...turn.imagePaths.map(path => ({ type: 'localImage' as const, path }))];
        const content = await this.claudeInput(values);
        const manifest = imageManifest(turn);
        if (!turn.event && manifest) content.push({ type: 'text', text: manifest });
        content.push({ type: 'text', text: this.runtimeContext(turn, session, true) });
        submitted('unknown'); // A successful pipe write alone is not model acceptance.
        session.transport.write({ type: 'user', session_id: session.nativeId ?? '', parent_tool_use_id: null, message: { role: 'user', content } });
      }
      return await active.completed.promise;
    } catch (error) {
      let cleanupFailure: unknown;
      try { await this.stopSession(key, session); } catch (cleanup) { cleanupFailure = cleanup; }
      if (error instanceof TurnSealedError || active.sealed && active.publicationPromise && !active.sceneRefreshPending) {
        // Retire the failed CLI, then preserve only a positively acknowledged final reply.
        // Pending delivery must really succeed before this user turn can complete.
        await active.publicationPromise;
        if (turn.signal.aborted) throw abortError();
        if ((active.publicCalls > 0 || error instanceof TurnSealedError && active.silent) && session.nativeId) return {
          nativeId: session.nativeId, text: '', controlledOutput: true,
          ...(!(error instanceof TurnSealedError) || cleanupFailure ? { postDeliveryError: executionErrorEvidence(error) } : {}),
          ...(cleanupFailure ? { processStopped: false, cleanupError: executionErrorEvidence(cleanupFailure) } : {}),
        };
      }
      if (cleanupFailure) {
        const failure = processStopFailure(cleanupFailure); failure.cause = error;
        Object.assign(failure, { cleanupError: executionErrorEvidence(cleanupFailure) }); throw failure;
      }
      if (error instanceof NativeTurnFailure && turn.controllerRecovery && turn.event?.kind === 'worker-result'
        && !active.sealed && !active.silent && active.publicCalls === 0 && [...active.inFlightTools.values()].every(tool => tool.succeeded)
        && !active.publicationPromise && !active.deliveryPromise && !active.collaborationPromise) {
        throw new ReportRecoveryFailure('已保存的助手结果汇报失败；原进程已退出，尚无最终投递。', { cause: error });
      }
      throw error;
    }
    finally { turn.signal.removeEventListener('abort', onAbort); if (session.active === active) session.active = null; }
  }
  private stopSession(key: string, session: ControllerSession): Promise<void> {
    if (session.stopPromise) {
      const proof = this.transportProofs.get(session.transport), current = proof ? this.readProcessProof(key) : null;
      if (session.stopFailed && !session.active && (session.transport.confirmStopped?.() === true
        || proof && current?.nonce === proof.nonce && current.stopped)) {
        // Late exit evidence releases only this exact retired CLI, never replays its failed turn.
        this.confirmedStopped.set(key, { nonce: proof?.nonce });
        if (this.closingSessions.get(key) === session) this.closingSessions.delete(key);
        return Promise.resolve();
      }
      if (!session.stopFailed || session.active || session.transport.canRetryStop?.() !== true) return session.stopPromise;
      // 原 CLI 尚在且上次未授权任何 tree kill：重试收尾，不重放失败轮次。
      session.stopPromise = undefined; session.stopFailed = false;
    }
    session.closed = true;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
    this.closingSessions.set(key, session);
    session.stopPromise = (async () => {
      try { await session.transport.stop(false); this.confirmedStopped.set(key, { nonce: this.transportProofs.get(session.transport)?.nonce }); }
      finally {
        session.rpc?.close(); session.removeListeners.forEach(remove => remove());
        if (session.server) { session.server.closeAllConnections(); await new Promise<void>(resolve => session.server!.close(() => resolve())); }
      }
    })();
    // Failed shutdown stays registered: a new controller must not overlap an
    // old process whose exit is still unknown. Every caller awaits the same stop.
    void session.stopPromise.then(() => { if (this.closingSessions.get(key) === session) this.closingSessions.delete(key); }, () => { session.stopFailed = true; });
    return session.stopPromise;
  }
  async interrupt(conversationId: string): Promise<void> { const session = this.sessions.get(conversationId) ?? this.closingSessions.get(conversationId); if (session) { session.active?.completed.reject(abortError()); await this.stopSession(conversationId, session); } }
  async close(): Promise<void> {
    this.closed = true; this.context.clear();
    const sessions = new Map([...this.sessions, ...this.closingSessions]);
    const results = await Promise.allSettled([...sessions].map(([key, session]) => { session.active?.completed.reject(abortError()); return this.stopSession(key, session); }));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '部分主控进程的停止尚未确认。');
    if (this.options.isolatedLaunch) await this.options.metadataAdapter?.close();
  }
}
function imageMediaType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('主控图片格式需要 PNG、JPEG、GIF 或 WebP。');
}
