import { harnessText } from '../harness.js';
import { claudeModelSettings, createEffortReporter, effortCapabilityForModel, isEffortLevel, normalizeEffortCapability, observedClaudeEffort, resolveDefaultModel, selectedEffort, validateEffort } from '../effort.js';
import { workspaceDocuments } from './workspace-documents.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync, renameSync, lstatSync, statSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer, type Server } from 'node:http';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import type { AgentAdapter, AgentCommand, AgentModelInfo, AgentName, AgentResult, AgentTurn, AgentInput, PrivateInputBatch, EffortConfiguration, EffortCapability, Conversation } from '../types.js';
import { claudeEffortConfiguration } from '../agents/claude-effort.js';
import { MetadataProbeError } from '../agents/metadata.js';
import { readCodexModelInfo } from '../agents/codex-models.js';
import { DeliveryPreparationError, executionErrorEvidence } from '../delivery-errors.js';
import { FEEDBACK_RULE } from '../controller-feedback.js';
import { knowledgeTools } from './knowledge-tools.js';
import { controllerFileTools } from './files.js';
import type { ControllerSubmission, ControllerTurnState } from '../controller-lifecycle.js';
import { assertBotCommunicationAllowed, internalBotCommunicationTools } from '../bot-communication.js';
import { abortError, deferred, isObject, JsonLineProcess, JsonRpcClient, JsonRpcTimeoutError, processStopFailure, safeError, type JsonObject, type RpcTransport } from '../agents/process.js';

const object = (properties: JsonObject): JsonObject => ({ type: 'object', properties, additionalProperties: false });
const string = (description: string): JsonObject => ({ type: 'string', description });
function bridgeClock(): string {
  const now = new Date();
  return harnessText('controller.clock', { utc: now.toISOString(), local: now.toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}
const scheduleTime = { afterSeconds: { type: 'number', minimum: 1, maximum: 2592000, description: harnessText('tools.shared.scheduleTime.afterSeconds.description') },
  dueAt: string(harnessText('tools.shared.scheduleTime.dueAt.description')) };
const outgoingAttachmentPaths = { type: 'array', items: { type: 'string' }, maxItems: 10, description: harnessText('tools.shared.outgoingAttachmentPaths.description') };
const workerDispatchSelection = {
  targetId: string(harnessText('tools.shared.workerDispatchSelection.targetId.description')),
  assistant: { ...object({ kind: { type: 'string', enum: ['default', 'ordinary', 'preset'] },
    agent: { type: 'string', enum: ['codex', 'claude'], description: harnessText('tools.shared.workerDispatchSelection.assistant.agent.description') },
    model: string(harnessText('tools.shared.workerDispatchSelection.assistant.model.description')), presetId: string(harnessText('tools.shared.workerDispatchSelection.assistant.presetId.description')),
    effort: string(harnessText('tools.shared.workerDispatchSelection.assistant.effort.description')),
  }), required: ['kind'], description: harnessText('tools.shared.workerDispatchSelection.assistant.description') },
  cwd: string(harnessText('tools.shared.workerDispatchSelection.cwd.description')),
  effort: string(harnessText('tools.shared.workerDispatchSelection.effort.description')),
  agent: { type: 'string', enum: ['codex', 'claude'], description: harnessText('tools.shared.workerDispatchSelection.agent.description') },
  model: string(harnessText('tools.shared.workerDispatchSelection.model.description')),
  presetId: string(harnessText('tools.shared.workerDispatchSelection.presetId.description')),
};
export const controllerTools: { name: string; description: string; inputSchema: JsonObject }[] = [
  ...knowledgeTools,
  ...controllerFileTools,
  { name: 'bridge_read_feedback', description: harnessText('tools.bridge_read_feedback.description'), inputSchema: object({ id: string(harnessText('tools.bridge_read_feedback.inputSchema.id.description')), includeDelivered: { type: 'boolean', description: harnessText('tools.bridge_read_feedback.inputSchema.includeDelivered.description') }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } }) },
  { name: 'bridge_delivery_targets', description: harnessText('tools.bridge_delivery_targets.description'), inputSchema: object({}) },
  { name: 'bridge_send_message', description: harnessText('tools.bridge_send_message.description'), inputSchema: { ...object({ targetId: string(harnessText('tools.bridge_send_message.inputSchema.targetId.description')), text: string(harnessText('tools.bridge_send_message.inputSchema.text.description')), finish: { type: 'boolean', default: true, description: harnessText('tools.bridge_send_message.inputSchema.finish.description') }, attachmentPaths: outgoingAttachmentPaths }), required: ['targetId', 'text'] } },
  { name: 'bridge_read_group_history', description: harnessText('tools.bridge_read_group_history.description'), inputSchema: object({ targetId: string(harnessText('tools.bridge_read_group_history.inputSchema.targetId.description')), startTime: string(harnessText('tools.bridge_read_group_history.inputSchema.startTime.description')), endTime: string(harnessText('tools.bridge_read_group_history.inputSchema.endTime.description')), limit: { type: 'integer', minimum: 1, maximum: 50, default: 30 }, cursor: string(harnessText('tools.bridge_read_group_history.inputSchema.cursor.description')) }) },
  { name: 'bridge_list_controllers', description: harnessText('tools.bridge_list_controllers.description'), inputSchema: object({ botId: string(harnessText('tools.bridge_list_controllers.inputSchema.botId.description')), limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, offset: { type: 'integer', minimum: 0, default: 0 } }) },
  { name: 'bridge_start_collaboration', description: harnessText('tools.bridge_start_collaboration.description'), inputSchema: { ...object({ targetId: string(harnessText('tools.bridge_start_collaboration.inputSchema.targetId.description')), targetBotId: string(harnessText('tools.bridge_start_collaboration.inputSchema.targetBotId.description')), mode: { type: 'string', enum: ['internal', 'public'] }, text: string(harnessText('tools.bridge_start_collaboration.inputSchema.text.description')) }), required: ['targetId', 'targetBotId', 'mode', 'text'] } },
  { name: 'bridge_group_context', description: harnessText('tools.bridge_group_context.description'), inputSchema: object({}) },
  { name: 'bridge_send_bot', description: harnessText('tools.bridge_send_bot.description'), inputSchema: { ...object({ targetBotId: string(harnessText('tools.bridge_send_bot.inputSchema.targetBotId.description')), text: string(harnessText('tools.bridge_send_bot.inputSchema.text.description')) }), required: ['targetBotId', 'text'] } },
  { name: 'bridge_send_private', description: harnessText('tools.bridge_send_private.description'), inputSchema: { ...object({ principalId: string(harnessText('tools.bridge_send_private.inputSchema.principalId.description')), text: string(harnessText('tools.bridge_send_private.inputSchema.text.description')), finish: { type: 'boolean', default: true, description: harnessText('tools.bridge_send_private.inputSchema.finish.description') }, attachmentPaths: outgoingAttachmentPaths }), required: ['principalId', 'text'] } },
  { name: 'bridge_propose_handoff', description: harnessText('tools.bridge_propose_handoff.description'), inputSchema: { ...object({ taskId: string(harnessText('tools.bridge_propose_handoff.inputSchema.taskId.description')), targetBotId: string(harnessText('tools.bridge_propose_handoff.inputSchema.targetBotId.description')), summary: string(harnessText('tools.bridge_propose_handoff.inputSchema.summary.description')) }), required: ['taskId', 'targetBotId', 'summary'] } },
  { name: 'bridge_accept_handoff', description: harnessText('tools.bridge_accept_handoff.description'), inputSchema: { ...object({ handoffId: string(harnessText('tools.bridge_accept_handoff.inputSchema.handoffId.description')) }), required: ['handoffId'] } },
  { name: 'bridge_silent', description: harnessText('tools.bridge_silent.description'), inputSchema: object({}) },

  { name: 'bridge_start_worker', description: harnessText('tools.bridge_start_worker.description'), inputSchema: { ...object({ workId: string(harnessText('tools.bridge_start_worker.inputSchema.workId.description')), resources: { type: 'array', items: { type: 'string' }, description: harnessText('tools.bridge_start_worker.inputSchema.resources.description') }, title: string(harnessText('tools.bridge_start_worker.inputSchema.title.description')), prompt: string(harnessText('tools.bridge_start_worker.inputSchema.prompt.description')), sessionVisibility: { type: 'string', enum: ['hidden', 'visible'], description: harnessText('tools.bridge_start_worker.inputSchema.sessionVisibility.description') }, ...workerDispatchSelection, imagePaths: { type: 'array', items: { type: 'string' }, description: harnessText('tools.bridge_start_worker.inputSchema.imagePaths.description') } }), required: ['title', 'prompt'] } },
  { name: 'bridge_continue_worker', description: harnessText('tools.bridge_continue_worker.description'), inputSchema: { ...object({ workId: string(harnessText('tools.bridge_continue_worker.inputSchema.workId.description')), workerId: string(harnessText('tools.bridge_continue_worker.inputSchema.workerId.description')), prompt: string(harnessText('tools.bridge_continue_worker.inputSchema.prompt.description')), model: string(harnessText('tools.bridge_continue_worker.inputSchema.model.description')), effort: string(harnessText('tools.bridge_continue_worker.inputSchema.effort.description')), delivery: { type: 'string', enum: ['current', 'next'], description: harnessText('tools.bridge_continue_worker.inputSchema.delivery.description') }, imagePaths: { type: 'array', items: { type: 'string' }, description: harnessText('tools.bridge_continue_worker.inputSchema.imagePaths.description') } }), required: ['workerId', 'prompt'] } },
  { name: 'bridge_cancel_worker', description: harnessText('tools.bridge_cancel_worker.description'), inputSchema: { ...object({ workerId: string(harnessText('tools.bridge_cancel_worker.inputSchema.workerId.description')), reason: string(harnessText('tools.bridge_cancel_worker.inputSchema.reason.description')) }), required: ['workerId'] } },
  { name: 'bridge_schedule_worker', description: harnessText('tools.bridge_schedule_worker.description'), inputSchema: { ...object({ ...scheduleTime, workId: string(harnessText('tools.bridge_schedule_worker.inputSchema.workId.description')), resources: { type: 'array', items: { type: 'string' }, description: harnessText('tools.bridge_schedule_worker.inputSchema.resources.description') }, title: string(harnessText('tools.bridge_schedule_worker.inputSchema.title.description')), prompt: string(harnessText('tools.bridge_schedule_worker.inputSchema.prompt.description')), sessionVisibility: { type: 'string', enum: ['hidden', 'visible'], description: harnessText('tools.bridge_schedule_worker.inputSchema.sessionVisibility.description') }, ...workerDispatchSelection, imagePaths: { type: 'array', items: { type: 'string' }, description: harnessText('tools.bridge_schedule_worker.inputSchema.imagePaths.description') } }), required: ['title', 'prompt'] } },
  { name: 'bridge_schedule_controller', description: harnessText('tools.bridge_schedule_controller.description'), inputSchema: { ...object({ ...scheduleTime, title: string(harnessText('tools.bridge_schedule_controller.inputSchema.title.description')), text: string(harnessText('tools.bridge_schedule_controller.inputSchema.text.description')) }), required: ['text'] } },
  { name: 'bridge_list_schedules', description: harnessText('tools.bridge_list_schedules.description'), inputSchema: object({ scheduleId: string(harnessText('tools.bridge_list_schedules.inputSchema.scheduleId.description')), includeFinished: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }) },
  { name: 'bridge_cancel_schedule', description: harnessText('tools.bridge_cancel_schedule.description'), inputSchema: { ...object({ scheduleId: string(harnessText('tools.bridge_cancel_schedule.inputSchema.scheduleId.description')) }), required: ['scheduleId'] } },
  { name: 'bridge_update_schedule', description: harnessText('tools.bridge_update_schedule.description'), inputSchema: { ...object({ scheduleId: string(harnessText('tools.bridge_update_schedule.inputSchema.scheduleId.description')), ...scheduleTime }), required: ['scheduleId'] } },
  { name: 'bridge_list_native_sessions', description: harnessText('tools.bridge_list_native_sessions.description'), inputSchema: { ...object({ targetId: string(harnessText('tools.bridge_list_native_sessions.inputSchema.targetId.description')), agent: { type: 'string', enum: ['codex', 'claude'] }, cwd: string(harnessText('tools.bridge_list_native_sessions.inputSchema.cwd.description')), query: string(harnessText('tools.bridge_list_native_sessions.inputSchema.query.description')), cursor: string(harnessText('tools.bridge_list_native_sessions.inputSchema.cursor.description')), limit: { type: 'integer', minimum: 1, maximum: 20 } }), required: ['agent'] } },
  { name: 'bridge_read_native_session', description: harnessText('tools.bridge_read_native_session.description'), inputSchema: { ...object({ targetId: string(harnessText('tools.bridge_read_native_session.inputSchema.targetId.description')), agent: { type: 'string', enum: ['codex', 'claude'] }, nativeId: string(harnessText('tools.bridge_read_native_session.inputSchema.nativeId.description')), profile: { type: 'string', enum: ['default'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }), required: ['agent', 'nativeId'] } },
  { name: 'bridge_adopt_native_session', description: harnessText('tools.bridge_adopt_native_session.description'), inputSchema: { ...object({ targetId: string(harnessText('tools.bridge_adopt_native_session.inputSchema.targetId.description')), agent: { type: 'string', enum: ['codex', 'claude'] }, nativeId: string(harnessText('tools.bridge_adopt_native_session.inputSchema.nativeId.description')), profile: { type: 'string', enum: ['default'] }, expectedRevision: string(harnessText('tools.bridge_adopt_native_session.inputSchema.expectedRevision.description')), title: string(harnessText('tools.bridge_adopt_native_session.inputSchema.title.description')) }), required: ['agent', 'nativeId', 'expectedRevision'] } },
  { name: 'bridge_check_capabilities', description: harnessText('tools.bridge_check_capabilities.description'), inputSchema: object({ capabilityId: string(harnessText('tools.bridge_check_capabilities.inputSchema.capabilityId.description')), targetId: string(harnessText('tools.bridge_check_capabilities.inputSchema.targetId.description')), agent: { type: 'string', enum: ['codex', 'claude'] }, refresh: { type: 'boolean', description: harnessText('tools.bridge_check_capabilities.inputSchema.refresh.description') } }) },
  { name: 'bridge_list_targets', description: harnessText('tools.bridge_list_targets.description'), inputSchema: object({ refresh: { type: 'boolean' }, includePresets: { type: 'boolean', description: harnessText('tools.bridge_list_targets.inputSchema.includePresets.description') }, targetId: string(harnessText('tools.bridge_list_targets.inputSchema.targetId.description')), agent: { type: 'string', enum: ['codex', 'claude'] }, query: string(harnessText('tools.bridge_list_targets.inputSchema.query.description')), details: { type: 'boolean', description: harnessText('tools.bridge_list_targets.inputSchema.details.description') } }) },
  { name: 'bridge_handoff_worker', description: harnessText('tools.bridge_handoff_worker.description'), inputSchema: { ...object({ workerId: string(harnessText('tools.bridge_handoff_worker.inputSchema.workerId.description')) }), required: ['workerId'] } },
  { name: 'bridge_request_restart', description: harnessText('tools.bridge_request_restart.description'), inputSchema: object({}) },
  { name: 'bridge_list_workers', description: harnessText('tools.bridge_list_workers.description'), inputSchema: object({ workerId: string(harnessText('tools.bridge_list_workers.inputSchema.workerId.description')) }) },
  { name: 'bridge_send_user', description: harnessText('tools.bridge_send_user.description'), inputSchema: { ...object({ text: string(harnessText('tools.bridge_send_user.inputSchema.text.description')), targetId: string(harnessText('tools.bridge_send_user.inputSchema.targetId.description')), attachmentPaths: outgoingAttachmentPaths }), required: ['text'] } },
];

const internalBotCommunicationInstructions = harnessText('controller.bot_communication.internal');
export const controllerInstructions = harnessText('controller.protocol', { internal_bot_communication: internalBotCommunicationInstructions });

export function controllerToolsForCommunication(enabled?: boolean): typeof controllerTools {
  if (enabled !== false) return controllerTools;
  return controllerTools.filter(tool => !internalBotCommunicationTools.has(tool.name)).map(tool => tool.name !== 'bridge_start_collaboration' ? tool : {
    ...tool,
    description: harnessText('tools.bridge_start_collaboration.public_only'),
    inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as JsonObject), mode: { type: 'string', enum: ['public'] } } },
  });
}

export function controllerInstructionsForCommunication(enabled?: boolean): string {
  return harnessText('controller.protocol', { internal_bot_communication: harnessText(enabled === false
    ? 'controller.bot_communication.public_only' : 'controller.bot_communication.internal') });
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
  identity?: { botId?: string; aliases: string[] };
  maxToolCalls?: number;
  /** Test-only transport seam; production uses a real CLI process. */
  createTransport?: (command: AgentCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv) => RpcTransport;
  userHome?: string;
}
class TurnSealedError extends Error {
  constructor() { super('主控本轮已封闭，等待下一条真实输入。'); this.name = 'TurnSealedError'; }
}
/** A native turn failed; final platform delivery is tracked independently. */
class NativeTurnFailure extends Error {}
/** A failed report decision ended, its CLI stopped, and no publication or tool is outstanding. */
class ReportRecoveryFailure extends Error {}
interface ActiveTurn {
  turn: AgentTurn;
  reportEffort: ReturnType<typeof createEffortReporter>;
  effortCapability: EffortCapability;
  completed: ReturnType<typeof deferred<AgentResult>>;
  nativeTurnId: string | null;
  toolCalls: number;
  publicCalls: number;
  silent?: boolean;
  restartAccepted: boolean;
  sealed: boolean;
  publicationPromise?: Promise<unknown>;
  publicationPreparationError?: DeliveryPreparationError;
  collaborationPromise?: Promise<unknown>;
  collaborationCompleted?: boolean;
  replyPausePromise?: Promise<unknown>;
  deliveryPromise?: Promise<unknown>;
  pendingClaudeTools: { id: string; name: string; args?: JsonObject }[];
  sceneCheckTail?: Promise<void>;
  sceneRefreshPending?: { scene?: string; privateInput?: PrivateInputBatch };
  sceneReassessmentStarted?: boolean;
  privateFinalCallId?: string;
  completingNativeTurn?: boolean;
  replyRecovery?: boolean;
  submissionAcknowledged?: boolean;
  retiredNativeTurnIds: Set<string>;
  seenClaudeTools: Set<string>;
  inFlightTools: Map<string, { name: string; signature: string; promise: Promise<unknown>; succeeded: boolean; settled: boolean }>;
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
}

interface ControllerProcessProof {
  version: 1; agent: AgentName; conversationId: string; pid: number; nonce: string;
  stopped: boolean; startedAt: string; stoppedAt?: string;
}
export class NativeControllerAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, ControllerSession>();
  private readonly metadataConnections = new WeakMap<MetadataProbeError, ControllerSession>();
  private readonly closingSessions = new Map<string, ControllerSession>();
  private readonly transportProofs = new WeakMap<RpcTransport, ControllerProcessProof>();
  private readonly confirmedStopped = new Map<string, { nonce?: string }>();
  private closed = false;
  constructor(private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv, private readonly options: NativeControllerOptions) {}

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
    const rules = controllerInstructionsForCommunication(this.options.internalBotCommunicationEnabled);
    return this.options.contextWorkspace ? rules + '\n\n' + workspaceDocuments(this.options.contextWorkspace).text : rules;
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
      const params: JsonObject = { ...((selectedEffort(turn) ?? configured.config.model_reasoning_effort) ? { config: { model_reasoning_effort: selectedEffort(turn) ?? configured.config.model_reasoning_effort } } : {}), modelProvider: provider, cwd: turn.conversation.cwd, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: this.instructions(), developerInstructions: harnessText('controller.codex_developer'), ...(turn.conversation.model ? { model: turn.conversation.model } : {}) };
      const prior = session.nativeId;
      const response = await session.rpc!.request(prior ? 'thread/resume' : 'thread/start', prior
        ? { ...params, threadId: prior, excludeTurns: true }
        : { ...params, ephemeral: false, environments: [], selectedCapabilityRoots: [], dynamicTools: controllerToolsForCommunication(this.options.internalBotCommunicationEnabled).map(tool => ({ ...tool, type: 'function' })) }, 20000);
      if (!isObject(response.thread) || typeof response.thread.id !== 'string' || (prior && response.thread.id !== prior)) throw new Error('Codex 主控续接返回了不同会话；原会话已保留。');
      if (typeof response.modelProvider !== 'string' || response.modelProvider !== provider) throw new Error('Codex 主控回报的供应商与当前配置不一致；原会话已保留，本轮未提交。');
      if (selectedEffort(turn) && typeof response.model === 'string' && response.model !== turn.conversation.model) session.effortCapability = await validateEffort(this, { ...turn.conversation, model: response.model }, selectedEffort(turn)!);
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
        session.transport.write({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(this.scenePausedResult(session.active)) }] } }); return;
      }
      if (!session.active || params.threadId !== session.nativeId || typeof params.tool !== 'string' || (session.active.nativeTurnId && params.turnId !== session.active.nativeTurnId)) throw new Error('主控工具请求不属于当前会话轮次。');
      const args: unknown = typeof params.arguments === 'string' ? JSON.parse(params.arguments) : params.arguments;
      if (!isObject(args)) throw new Error('主控工具参数格式无效。');
      const callId = typeof params.callId === 'string' ? params.callId : typeof params.itemId === 'string' ? params.itemId : null;
      if (!callId) throw new Error('主控工具请求缺少稳定调用标识。');
      const value = await this.invoke(session.active, params.tool, args, callId);
      session.transport.write({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value ?? null) }] } });
    } catch (error) { session.transport.write({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: safeError(error instanceof Error ? error.message : error, '主控工具失败') }] } }); }
  }
  private async invoke(active: ActiveTurn, name: string, args: JsonObject, callId: string): Promise<unknown> {
    const existing = active.inFlightTools.get(callId);
    const signature = canonicalJSON([name, args]);
    if (existing) {
      if (existing.signature !== signature) {
        if (active.sealed) this.rejectSealed(active);
        throw new Error('相同主控工具标识的参数不一致，未重新执行。');
      }
      return existing.promise;
    }
    const terminal = name === 'bridge_silent' || name === 'bridge_send_user'
      || ((name === 'bridge_send_message' || name === 'bridge_send_private') && args.finish !== false);
    const work = (async () => {
      // Let an admitted collaboration's real public receipt win before a concurrent
      // final acknowledgement or silence can seal the turn and conflict with it.
      if (terminal && active.collaborationPromise) {
        await active.collaborationPromise;
        if (active.collaborationCompleted) return { alreadyCompleted: true };
      }
      if (active.sealed) {
        if (active.turn.onPrivateInputCheck && active.privateFinalCallId) return this.privateFinalPendingResult();
        this.rejectSealed(active);
      }
      return this.invokeOnce(active, name, args, callId).finally(() => {
        if (active.privateFinalCallId === callId && !active.sealed) active.privateFinalCallId = undefined;
      });
    })();
    const receipt = { name, signature, promise: work, succeeded: false, settled: false };
    active.inFlightTools.set(callId, receipt);
    void work.then(() => { receipt.succeeded = true; receipt.settled = true; }, () => { receipt.settled = true; });
    if ((name === 'bridge_send_message' || name === 'bridge_send_private') && args.finish === false) active.deliveryPromise = Promise.allSettled([...(active.deliveryPromise ? [active.deliveryPromise] : []), work]);
    if (name === 'bridge_start_collaboration') active.collaborationPromise = Promise.allSettled([...(active.collaborationPromise ? [active.collaborationPromise] : []), work]);
    return work;
  }
  private rejectSealed(active: ActiveTurn): never {
    const error = new TurnSealedError();
    active.completed.reject(error);
    throw error;
  }
  private pauseGroupReply(active: ActiveTurn, error: unknown, callId: string, targetId?: string): Promise<unknown> | undefined {
    if (!error || typeof error !== 'object' || !('groupReplyPaused' in error) || error.groupReplyPaused !== true
      || !active.turn.groupContext || !active.turn.onSilent || targetId === 'private') return undefined;
    if (active.replyPausePromise) return active.replyPausePromise;
    active.sealed = true;
    // Only admitted management must settle. Another publication may already be
    // waiting on this call; including it (or ourselves) would create a cycle.
    const admitted = [...active.inFlightTools.entries()].filter(([id, tool]) => id !== callId
      && !['bridge_send_user', 'bridge_send_message', 'bridge_send_private', 'bridge_silent'].includes(tool.name)).map(([, tool]) => tool.promise);
    const pause = Promise.allSettled(admitted).then(async () => {
      if (active.turn.signal.aborted) throw abortError();
      await active.turn.onSilent!(); active.silent = true;
      return { delivered: false, silent: true, reason: 'group-public-reply-limit' };
    });
    active.replyPausePromise = pause; active.publicationPromise = pause;
    return pause;
  }
  private async invokeOnce(active: ActiveTurn, name: string, args: JsonObject, callId: string): Promise<unknown> {
    if (active.turn.preparing) throw new Error('目标会话准备轮次禁止工具、副作用和公开回复。');
    if (active.replyRecovery) {
      const finalReply = (name === 'bridge_send_user' || name === 'bridge_send_message') && args.finish !== false
        && (args.targetId == null || args.targetId === 'private');
      if (!finalReply && !['bridge_read_feedback', 'bridge_list_workers', 'bridge_search_chat_history', 'bridge_read_chat_history', 'bridge_list_tasks', 'bridge_read_file', 'bridge_list_directory'].includes(name))
        throw new Error('本次补救只允许核对已有结果并补发原私聊最终回复；禁止重派任务或产生其他副作用。');
    }
    if (name === 'bridge_claim_work' || name === 'bridge_finish_work') return { performed: false, legacyTool: true, message: 'Work ownership and completion are recorded automatically. Use bridge_start_worker, bridge_continue_worker, bridge_schedule_worker or bridge_list_workers directly; no separate claim/finish step is needed.' };
    if (!controllerTools.some(tool => tool.name === name)) throw new Error('主控不能调用未登记的工具。');
    assertBotCommunicationAllowed(this.options.internalBotCommunicationEnabled, name, args);
    const privateFinal = !!active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event
      && (name === 'bridge_send_user' || (name === 'bridge_send_message' && args.finish !== false));
    if (privateFinal && args.targetId != null && args.targetId !== 'private') return { performed: false, privateResponseRequired: true,
      message: 'This private owner input still needs its private FINAL. Send authorized group content with bridge_send_message finish=false, then send the final response to targetId=private (or omit targetId in bridge_send_user). Nothing was sent and this rejection did not consume reassessment.' };
    if (privateFinal && !active.privateFinalCallId) active.privateFinalCallId = callId;
    const scenePause = !active.replyRecovery && (active.turn.onSceneCheck || active.turn.onPrivateInputCheck || active.sceneRefreshPending) ? await this.checkScene(active, name, args, callId) : undefined;
    if (scenePause) return scenePause;
    if (active.sealed) this.rejectSealed(active);
    if (++active.toolCalls > (this.options.maxToolCalls ?? 12)) { active.completed.reject(new Error('主控本轮协调调用过多，已停止继续派发。')); throw new Error('主控协调调用上限'); }
    if (active.turn.signal.aborted) throw abortError();
    if (name === 'bridge_read_feedback') {
      if (!active.turn.onReadBridgeFeedback) throw new Error('本轮没有错误回执查询通道。');
      if (args.id !== undefined && (typeof args.id !== 'string' || !/^[a-f0-9]{64}$/.test(args.id))
        || args.includeDelivered !== undefined && typeof args.includeDelivered !== 'boolean'
        || args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) throw new Error('错误回执查询参数无效。');
      return { ...active.turn.onReadBridgeFeedback(args), rule: FEEDBACK_RULE };
    }
    if (name === 'bridge_silent') {
      if (!active.turn.groupContext || !active.turn.onSilent) throw new Error('静默终态只适用于已授权的群参与轮次。');
      if (Object.keys(args).length) throw new Error('静默工具不接受参数。');
      const admitted = [...active.inFlightTools.entries()].filter(([id]) => id !== callId).map(([, tool]) => tool.promise);
      active.sealed = true;
      active.publicationPromise = Promise.allSettled(admitted).then(async () => {
        if (active.turn.signal.aborted) throw abortError();
        if (active.sceneRefreshPending) { active.sealed = false; return this.scenePausedResult(active); }
        await active.turn.onSilent!(); active.silent = true; return { silent: true };
      });
      return active.publicationPromise;
    }
    if (name === 'bridge_send_private') {
      const context = active.turn.groupContext;
      if (!context || args.principalId !== context.principalId) throw new Error('兼容私聊只允许当前群轮次已验证的负责人。');
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 12000 || args.text.includes('\0')) throw new Error('兼容私聊文字为空、包含空字符或超过12000字限制。');
      name = 'bridge_send_message'; args = { ...args, targetId: 'private' };
    }
    if (name === 'bridge_send_message') {
      if (args.finish !== undefined && typeof args.finish !== 'boolean') throw new Error('finish 必须是布尔值；省略表示最终发送。');
      if (typeof args.targetId !== 'string' || !args.targetId.trim() || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000) throw new Error('发送消息需要明确目标ID与有效文字。');
    }
    if (name === 'bridge_send_message' && args.finish === false) {
      if (args.attachmentPaths != null && (!Array.isArray(args.attachmentPaths) || args.attachmentPaths.length > 10 || args.attachmentPaths.some(path => typeof path !== 'string'))) throw new Error('附件路径清单格式无效。');
      if (!active.turn.onPublicMessage) throw new Error('主控投递通道不可用。');
      try { await active.turn.onPublicMessage(args.text as string, args.attachmentPaths as string[] | undefined, callId, args.targetId as string, false); }
      catch (error) {
        const paused = this.pauseGroupReply(active, error, callId, args.targetId as string | undefined); if (paused) return paused;
        if (error && typeof error === 'object' && 'deliveryUncertain' in error) { active.sealed = true; active.completed.reject(error); }
        throw error;
      }
      return { delivered: true, supplementary: true, originalDeliveryUnchanged: true };
    }
    if (name !== 'bridge_send_user' && name !== 'bridge_send_message') {
      let result: unknown;
      try { result = await this.options.invokeTool(active.turn, name, args, callId); }
      catch (error) {
        if (error && typeof error === 'object' && 'deliveryUncertain' in error) { active.sealed = true; active.completed.reject(error); }
        throw error;
      }
      if (name === 'bridge_list_workers' && args.details === true && isObject(result) && active.turn.onReadBridgeFeedback) {
        const feedback = active.turn.onReadBridgeFeedback({ limit: 20 });
        if (feedback.records.length) result = { ...result, bridgeFeedback: { ...feedback, rule: FEEDBACK_RULE } };
      }
      if (isObject(result) && result.sceneRefreshRequired === true && result.performed === false && result.sceneChanged === true) {
        active.sceneRefreshPending = { ...(typeof result.scene === 'string' ? { scene: result.scene } : {}) };
        return this.scenePausedResult(active);
      }
      if (name === 'bridge_request_restart' && isObject(result) && result.accepted === true) {
        active.restartAccepted = true;
        if (active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event) return { ...result, privateResponseRequired: true,
          message: harnessText('controller.restart_private_ack') };
      }
      if (name === 'bridge_start_collaboration' && isObject(result) && isObject(result.completion) && result.completion.publicDeliveryComplete === true) {
        if (!active.turn.groupContext || !active.turn.onPublicDeliveryComplete) throw new Error('同群公开交付收据缺少有效群轮次。');
        if (active.sealed) this.rejectSealed(active);
        active.sealed = true;
        const publication = active.turn.onPublicDeliveryComplete().then(() => { active.publicCalls++; active.collaborationCompleted = true; });
        active.publicationPromise = publication;
        try { await publication; } catch (error) { active.completed.reject(error); throw error; }
      }
      return result;
    }
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000) throw new Error('公开消息需要有效文字。');
    if (args.targetId != null && (typeof args.targetId !== 'string' || !args.targetId.trim())) throw new Error('投递目标ID无效。');
    const paths = args.attachmentPaths;
    if (paths != null && (!Array.isArray(paths) || paths.length > 10 || paths.some(file => typeof file !== 'string'))) throw new Error('附件路径清单格式无效。');
    if (!active.turn.onPublicMessage) throw new Error('主控公开投递通道不可用。');
    // Seal synchronously, before any await. Earlier admitted management calls may
    // settle, but a parallel new call cannot overtake an in-flight publication.
    const admitted = [...active.inFlightTools.entries()].filter(([id]) => id !== callId).map(([, tool]) => tool.promise);
    active.sealed = true;
    const pendingManagement = [...active.inFlightTools.entries()].filter(([id, tool]) => id !== callId && !tool.settled
      && !['bridge_send_user', 'bridge_send_message', 'bridge_send_private', 'bridge_silent'].includes(tool.name));
    const publication = (async () => {
      const outcomes = await Promise.allSettled(pendingManagement.map(([, tool]) => tool.promise));
      await Promise.allSettled(admitted);
      if (active.turn.signal.aborted) throw abortError();
      if (active.replyPausePromise) return active.replyPausePromise;
      if (active.sceneRefreshPending) { active.sealed = false; return this.scenePausedResult(active); }
      try {
        if (pendingManagement.length) {
          const receipts = pendingManagement.map(([id, tool], index) => ({ callId: id, tool: tool.name, status: outcomes[index]!.status }));
          throw new DeliveryPreparationError('最终回复写于管理工具返回之前，尚未发送。工具现已结束：' + JSON.stringify(receipts)
            + harnessText('controller.delivery_receipt_correction'));
        }
        await active.turn.onPublicMessage!(args.text as string, paths as string[] | undefined, callId, args.targetId as string | undefined, true);
      }
      catch (error) {
        const paused = this.pauseGroupReply(active, error, callId, args.targetId as string | undefined); if (paused) return paused;
        if (error instanceof DeliveryPreparationError && !('deliveryUncertain' in error)) {
          // No upload/send happened. Let the model correct this declaration in this
          // same turn; never replay earlier successful management calls for it.
          active.sealed = false;
          active.publicationPreparationError = error;
          active.publicationPromise = undefined;
          throw error;
        }
        // A failed publication can have reached the chat platform. Preserve that failure;
        // never turn it into a successful sealed turn or retry under a new ID.
        active.completed.reject(error); throw error;
      }
      active.publicationPreparationError = undefined;
      active.publicCalls++;
      return { delivered: true };
    })();
    active.publicationPromise = publication;
    return publication;
  }
  private scenePausedResult(active?: ActiveTurn): JsonObject {
    if (active?.sceneRefreshPending?.privateInput || (active?.sceneReassessmentStarted && active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event)) return { performed: false, privateInputChanged: true, reassessmentPending: true,
      message: harnessText('controller.private_input_changed') };
    return { performed: false, sceneChanged: true, reassessmentPending: true,
      message: harnessText('controller.scene_changed') };
  }
  private privateFinalPendingResult(): JsonObject {
    return { performed: false, privateFinalPending: true,
      message: 'A private FINAL is already being prepared or delivered. This later action did not run and claimed no new private messages. Finish DONE; later owner inputs stay queued for their own response.' };
  }
  private async checkScene(active: ActiveTurn, name: string, args: JsonObject, callId: string): Promise<JsonObject | undefined> {
    // A native turn, unlike an individual tool call, is an explicit protocol boundary
    // shared by Codex and Claude. Keep its whole remaining batch behind the barrier.
    const readonly = ['bridge_delivery_targets', 'bridge_read_group_history', 'bridge_list_controllers', 'bridge_group_context',
      'bridge_search_chat_history', 'bridge_read_chat_history', 'bridge_list_tasks',
      'bridge_read_file', 'bridge_list_directory',
      'bridge_list_schedules', 'bridge_list_native_sessions', 'bridge_read_native_session', 'bridge_check_capabilities', 'bridge_list_targets', 'bridge_list_workers'].includes(name);
    if (!readonly && active.turn.onPrivateInputCheck && active.privateFinalCallId && active.privateFinalCallId !== callId) return this.privateFinalPendingResult();
    if (!readonly && active.sceneCheckTail) await active.sceneCheckTail;
    if (!readonly && active.turn.onPrivateInputCheck && active.privateFinalCallId && active.privateFinalCallId !== callId) return this.privateFinalPendingResult();
    if (!readonly && active.turn.onPrivateInputCheck && active.sealed) this.rejectSealed(active);
    if (active.sceneRefreshPending) return readonly ? undefined : this.scenePausedResult(active);
    if (active.sceneReassessmentStarted || (!active.turn.onSceneCheck && !active.turn.onPrivateInputCheck)) return undefined;
    const guarded = ['bridge_start_worker', 'bridge_continue_worker', 'bridge_schedule_worker', 'bridge_send_user',
      'bridge_send_message', 'bridge_send_private', 'bridge_update_tasks'].includes(name) || (name === 'bridge_start_collaboration' && args.mode === 'public');
    if (!guarded) return undefined;
    const previous = active.sceneCheckTail ?? Promise.resolve();
    let release!: () => void;
    active.sceneCheckTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (active.sceneRefreshPending) return this.scenePausedResult(active);
      if (active.turn.signal.aborted) throw abortError();
      if (active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event) {
        const result = await active.turn.onPrivateInputCheck({ name, args, callId });
        if (!result.refreshRequired) return undefined;
        if (!result.input || !Number.isSafeInteger(result.input.version) || result.input.version < 1 || !Array.isArray(result.input.messages) || !result.input.messages.length) {
          const error = new Error('私聊更新缺少有效的新主人输入，旧动作未执行。'); active.completed.reject(error); throw error;
        }
        active.sceneRefreshPending = { privateInput: result.input };
      } else {
        const result = await active.turn.onSceneCheck?.({ name, args, callId });
        if (!result?.refreshRequired) return undefined;
        active.sceneRefreshPending = { ...(result.scene == null ? {} : { scene: result.scene }) };
      }
      return this.scenePausedResult(active);
    } finally { release(); }
  }
  private finish(session: ControllerSession, active: ActiveTurn): void {
    if (active.completingNativeTurn) return;
    active.completingNativeTurn = true;
    const settle = async () => {
      if (active.turn.onSceneCheck || active.turn.onPrivateInputCheck) await Promise.allSettled([...active.inFlightTools.values()].map(tool => tool.promise));
      await active.collaborationPromise; await active.deliveryPromise; await active.publicationPromise;
      if (active.sceneRefreshPending) {
        // Completion is the reliable boundary: no old parallel call is permitted to
        // consume the one refresh and accidentally admit another stale operation.
        await Promise.allSettled([...active.inFlightTools.values()].map(tool => tool.promise));
        if (active.turn.signal.aborted) throw abortError();
        const pending = active.sceneRefreshPending;
        active.sceneRefreshPending = undefined;
        active.sceneReassessmentStarted = true;
        active.privateFinalCallId = undefined;
        active.toolCalls = 0;
        active.pendingClaudeTools = [];
        if (active.nativeTurnId) active.retiredNativeTurnIds.add(active.nativeTurnId);
        active.nativeTurnId = null;
        active.completingNativeTurn = false;
        if (pending.privateInput) {
          await this.startPrivateReassessment(session, active, pending.privateInput);
          return;
        }
        const evidence = harnessText('controller.scene_refresh_header')
          + JSON.stringify({ scene: this.groupScene(pending.scene), rule: 'The original owner, root, authorization and delivery scope are unchanged. Actions with performed=false did not execute. Earlier successful tool receipts remain valid: do not replay them. Reconsider the new evidence, choose useful remaining work or silence, and use existing tools normally. This is the only automatic reassessment for this request.' })
          + '\n' + bridgeClock();
        if (session.rpc) {
          const started = await this.startCodexTurn(session, active, { threadId: session.nativeId, environments: [], input: [],
            toolOutput: { name: 'bridge_scene_refresh', namespace: null, output: evidence }, ...(selectedEffort(active.turn) ? { effort: selectedEffort(active.turn) } : {}) });
          if (!isObject(started.turn) || typeof started.turn.id !== 'string') throw new Error('Codex 现场重判没有返回轮次标识。');
          if (active.nativeTurnId && active.nativeTurnId !== started.turn.id) throw new Error('Codex 现场重判轮次确认不一致。');
          active.nativeTurnId = started.turn.id;
        } else session.transport.write({ type: 'user', session_id: session.nativeId ?? '', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: evidence }] } });
        return;
      }
      if (active.turn.controllerRecovery && !active.turn.groupContext && !active.turn.event
        && active.publicCalls === 0 && !active.silent && !active.sealed && !active.replyRecovery) {
        // The previous native decision completed. Only a missing, never-sent final may be repaired.
        active.replyRecovery = true;
        active.privateFinalCallId = undefined;
        active.toolCalls = 0;
        active.pendingClaudeTools = [];
        if (active.nativeTurnId) active.retiredNativeTurnIds.add(active.nativeTurnId);
        active.nativeTurnId = null;
        active.completingNativeTurn = false;
        const reason = active.publicationPreparationError ? 'final delivery rejected before any send' : 'native decision completed without a private final reply';
        const preparationError = active.publicationPreparationError?.message;
        active.publicationPreparationError = undefined;
        active.turn.onControllerState?.({ attempt: 1, phase: 'reply-recovery', submission: 'accepted' });
        if (active.turn.signal.aborted) throw abortError();
        const evidence = harnessText('controller.reply_recovery_header') + JSON.stringify({
          reason, preparationError, previousDecisionCompleted: true, finalReplySent: false,
          rule: harnessText('controller.reply_recovery_control')
        });
        if (session.rpc) {
          const started = await this.startCodexTurn(session, active, { threadId: session.nativeId, environments: [], input: [],
            toolOutput: { name: 'bridge_reply_recovery', namespace: null, output: evidence },
            ...(selectedEffort(active.turn) ? { effort: selectedEffort(active.turn) } : {}) });
          if (!isObject(started.turn) || typeof started.turn.id !== 'string') throw new Error('回复补救没有返回轮次标识。');
          if (active.nativeTurnId && active.nativeTurnId !== started.turn.id) throw new Error('回复补救轮次确认不一致。');
          active.nativeTurnId = started.turn.id;
        } else session.transport.write({ type: 'user', session_id: session.nativeId ?? '', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: evidence }] } });
        return;
      }
      if (active.publicationPreparationError && !active.silent) throw active.publicationPreparationError;
      const privateFinalRequired = !!active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event;
      if ((!active.turn.event || active.replyRecovery) && active.publicCalls === 0 && !active.silent && (!active.restartAccepted || privateFinalRequired)) throw Object.assign(new Error('主控没有通过公开通道回复，本轮未标记为成功。'), { finalReplyMissing: true });
      if (!session.nativeId) throw new Error('主控没有返回会话标识。');
      active.completed.resolve({ nativeId: session.nativeId, text: '', controlledOutput: true });
    };
    void settle().catch(error => active.completed.reject(error));
  }
  private async claudeInput(values: AgentInput[]): Promise<JsonObject[]> {
    const content: JsonObject[] = [];
    for (const value of values) {
      if (value.type === 'text') content.push(value);
      else { const bytes = await readFile(value.path); content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType(bytes), data: bytes.toString('base64') } }); }
    }
    return content;
  }
  private async startPrivateReassessment(session: ControllerSession, active: ActiveTurn, batch: PrivateInputBatch): Promise<void> {
    const values: AgentInput[] = [];
    for (const message of batch.messages) {
      if (typeof message.id !== 'string' || typeof message.userId !== 'string' || typeof message.channelId !== 'string'
        || typeof message.text !== 'string' || !Array.isArray(message.imagePaths) || message.imagePaths.some(path => typeof path !== 'string')) throw new Error('新私聊输入格式无效，未提交续决策。');
      const source = message.source ?? { messageId: message.id, userId: message.userId, channelId: message.channelId, authorType: 'user' };
      values.push({ type: 'text', text: '[Bridge incoming private owner message; verified new user input] '
        + JSON.stringify({ version: batch.version, id: message.id, userId: message.userId, channelId: message.channelId, source, freshOwnerInput: true }) + '\n' + message.text });
      values.push(...message.imagePaths.map(path => ({ type: 'localImage' as const, path })));
    }
    const last = batch.messages[batch.messages.length - 1]!;
    active.turn = { ...active.turn, source: { messageId: last.id, userId: last.userId, channelId: last.channelId, ...(last.source ? { original: last.source } : {}) },
      text: batch.messages.map(message => message.text).join('\n\n'), input: values,
      imagePaths: [...new Set([...active.turn.imagePaths, ...batch.messages.flatMap(message => message.imagePaths)])] };
    const manifest = imageManifest(active.turn); if (manifest) values.push({ type: 'text', text: manifest });
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
    const token = randomUUID();
    const diagnosticPath = join(this.options.dataDir, 'mcp-diagnostic.jsonl');
    const diagnostic = (value: JsonObject): void => {
      try { appendFileSync(diagnosticPath, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); } catch { /* 诊断失败不影响工具执行。 */ }
    };
    const server = createServer(async (req, res) => {
      // This loopback JSON endpoint needs no persistent connection. Fresh sockets
      // avoid stale pooled connections in the Claude CLI between model responses;
      // never retry a tool here, since it may already have performed a side effect.
      res.setHeader('Connection', 'close');
      const started = Date.now(), requestKey = randomUUID();
      let method: string | undefined, name: string | undefined, phase = 'received';
      let requestId: string | number | null = null;
      diagnostic({ requestKey, event: 'received', httpMethod: req.method, bytes: req.headers['content-length'] ?? null });
      req.once('aborted', () => diagnostic({ requestKey, event: 'aborted', phase }));
      res.once('close', () => diagnostic({ requestKey, event: 'closed', phase, method, name, status: res.statusCode, complete: res.writableFinished, ms: Date.now() - started }));
      if (req.url !== `/${token}` || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      try {
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 256 * 1024) throw new Error('MCP 请求超过限制。'); chunks.push(chunk as Buffer); }
        const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isObject(request)) throw new Error('MCP 请求格式无效。');
        requestId = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
        method = typeof request.method === 'string' ? request.method : undefined;
        phase = 'parsed';
        if (request.id == null) { res.writeHead(202); res.end(); return; }
        let result: unknown;
        if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bridge_controller', version: '1' } };
        else if (request.method === 'tools/list') result = { tools: controllerToolsForCommunication(this.options.internalBotCommunicationEnabled) };
        else if (request.method === 'tools/call') {
          const params = isObject(request.params) ? request.params : {};
          name = typeof params.name === 'string' ? params.name : undefined; phase = 'tool-matching';
          if (!session?.active || typeof params.name !== 'string' || !isObject(params.arguments)) throw new Error('没有当前主控轮次或参数无效。');
          // The assistant/partial event carries the stable model tool-use ID. The MCP
          // request number alone restarts at zero on process restart and is insufficient.
          const active = session.active;
          const matches = (tool: ActiveTurn['pendingClaudeTools'][number]) => tool.name === params.name && tool.args != null && canonicalJSON(tool.args) === canonicalJSON(params.arguments);
          let index = active.pendingClaudeTools.findIndex(matches);
          for (let attempt = 0; index < 0 && attempt < 25; attempt++) { await new Promise(resolve => setTimeout(resolve, 20)); index = active.pendingClaudeTools.findIndex(matches); }
          const nativeTool = index < 0 ? null : active.pendingClaudeTools.splice(index, 1)[0];
          if (!nativeTool) throw new Error('Claude 工具调用缺少原生调用标识，未执行派发。');
          phase = 'invoking';
          result = { content: [{ type: 'text', text: JSON.stringify(await this.invoke(active, params.name, params.arguments, nativeTool.id)) }] };
          phase = 'invoked';
        } else result = {};
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      } catch (error) {
        diagnostic({ requestKey, event: 'error', phase, method, name, errorType: error instanceof Error ? error.name : 'unknown' });
        const message = safeError(error instanceof Error ? error.message : error, 'MCP 请求失败');
        // 工具失败是可供模型处理的结果，不能伪装成 HTTP 传输失败。
        const toolError = method === 'tools/call' && requestId !== null;
        res.writeHead(toolError ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: requestId, ...(toolError
          ? { result: { isError: true, content: [{ type: 'text', text: message }] } }
          : { error: { code: error instanceof SyntaxError ? -32700 : -32600, message } }) }));
      }
    });
    server.on('clientError', (error, socket) => { diagnostic({ event: 'client-error', errorType: error.name, code: (error as NodeJS.ErrnoException).code ?? null }); socket.destroy(); });
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
      if (message.is_error === true || message.subtype !== 'success') active.completed.reject(new NativeTurnFailure(`Claude 主控失败：${safeError(message.result, String(message.subtype))}`));
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
  private sceneMessage(scene: string | undefined): JsonObject | undefined {
    if (!scene) return undefined;
    try { const parsed: unknown = JSON.parse(scene); return isObject(parsed) && isObject(parsed.currentMessage) ? parsed.currentMessage : undefined; }
    catch { return undefined; }
  }
  private groupScene(scene: string | undefined): unknown {
    if (!scene) return { status: 'unknown', reason: 'No current group scene was provided.' };
    let parsed: unknown;
    try { parsed = JSON.parse(scene); } catch { parsed = { text: scene }; }
    if (isObject(parsed) && isObject(parsed.currentMessage)) { const { currentMessage: _current, ...evidence } = parsed; parsed = evidence; }
    let remaining = 24000, truncated = false;
    const bound = (value: unknown, depth: number): unknown => {
      if (remaining < 64 || depth > 8) { truncated = true; return undefined; }
      if (typeof value === 'string') {
        const maximum = Math.min(4000, remaining - 32);
        const text = value.length > maximum ? (truncated = true, value.slice(0, maximum) + ' [truncated]') : value;
        remaining -= JSON.stringify(text).length; return text;
      }
      if (Array.isArray(value)) {
        if (value.length > 40) truncated = true;
        const result: unknown[] = [];
        // Scene records are chronological: preserve the newest evidence under the budget.
        for (const item of value.slice(-40).reverse()) { const next = bound(item, depth + 1); if (next === undefined) break; result.unshift(next); }
        return result;
      }
      if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          remaining -= key.length + 4; const next = bound(item, depth + 1); if (next === undefined) break; result[key] = next;
        }
        return result;
      }
      remaining -= JSON.stringify(value)?.length ?? 4; return value;
    };
    const content = bound(parsed, 0);
    return { status: 'provided', content, truncated, coverage: harnessText('controller.group_scene_coverage') };
  }
  private runtimeContext(turn: AgentTurn, session: ControllerSession): string {
    const info = { agent: turn.conversation.agent, selectedModel: turn.conversation.model ?? null,
      observedModel: session.model ?? turn.conversation.actualModel ?? null,
      selectedEffort: selectedEffort(turn), observedEffort: session.effort ?? turn.conversation.actualEffort ?? null,
      workerDefaults: this.options.defaultModels ?? {} };
    const scene = turn.groupContext ? turn.chatScene ?? turn.groupContext.scene : undefined;
    const currentMessage = this.sceneMessage(scene);
    const explicitDelivery = currentMessage && isObject(currentMessage.defaultDelivery) && ['group', 'private', 'internal'].includes(String(currentMessage.defaultDelivery.area)) ? currentMessage.defaultDelivery : undefined;
    const chat = { ...(currentMessage ? { currentMessage } : {}), kind: turn.event ? 'background-evidence' : turn.groupContext ? 'group-message' : 'private-message',
      route: turn.source ? { messageId: turn.source.messageId, userId: turn.source.userId, channelId: turn.source.channelId } : null,
      original: turn.source?.original ?? (!turn.groupContext && !turn.event ? turn.source ?? null : null),
      requesterPrincipalId: turn.groupContext && !turn.event ? turn.groupContext.principalId : null,
      defaultDelivery: explicitDelivery ?? { area: turn.groupContext ? 'group' : 'private', ...(!turn.groupContext ? { targetId: 'private' } : {}), channelId: turn.source?.channelId ?? turn.groupContext?.originChannelId ?? null },
      group: turn.groupContext ? { spaceId: turn.groupContext.spaceId, eventId: turn.groupContext.eventId, eventKind: turn.groupContext.eventKind ?? null } : null,
      rule: harnessText('controller.runtime_source_facts') };
    const sceneBlock = scene == null && !turn.groupContext ? '' : harnessText('controller.chat_scene_header') + JSON.stringify(this.groupScene(scene));
    return '[Bridge chat input; program facts] ' + JSON.stringify(chat) + sceneBlock + '\n' + harnessText('controller.bot_identity_header') + JSON.stringify({ botId: this.options.identity?.botId ?? null, aliases: this.options.identity?.aliases ?? [], rule: 'Aliases are names used to address this Bot; they do not assign a profession, task, identity ownership, or permission. Authorize with real botId/principal/space IDs only.' }) + '\n' + bridgeClock() + harnessText('controller.runtime_facts_header') + JSON.stringify(info)
      + (turn.bridgeFeedback?.records.length ? harnessText('controller.feedback_header') + JSON.stringify({ ...turn.bridgeFeedback, rule: FEEDBACK_RULE, more: 'For more records use bridge_read_feedback if exposed; existing resumed toolkits can use bridge_list_workers with details=true for pending feedback.' }) : '')
      + (turn.taskChecklist ? harnessText('controller.task_checklist_header') + turn.taskChecklist : '')
      + '\nWorker model: omitted/default inherits this controller selection, then confirmed actual model; another backend uses its bridge worker default. The bridge resolves it before dispatch; never defer to a remote CLI default. Omitted continuation model keeps that worker selection; explicit default reapplies bridge policy. Effort inherits only within the same backend; explicit effort=default uses backend native default. Preserve user aliases and gateway mappings.';
  }

  async run(turn: AgentTurn): Promise<AgentResult> {
    if (this.closed) throw new Error('主控适配器已关闭。');
    if (turn.signal.aborted) throw abortError();
    // A parallel call is a caller error, not permission to retire another active decision.
    if (this.sessions.get(turn.conversation.id)?.active) throw new Error('主控消息必须按顺序执行。');
    const report = turn.event?.kind === 'worker-result';
    const recover = turn.controllerRecovery === true && (!turn.event || report) && !turn.groupContext && !turn.preparing;
    let reportRecovery = false;
    const originalSignature = this.signature(turn);
    let nativeId = turn.conversation.nativeId;
    for (let attempt = 1; ; attempt++) {
      let submission: ControllerSubmission = 'not-submitted';
      const state = (phase: ControllerTurnState['phase'], value = submission, error?: unknown) => {
        submission = value; turn.onControllerState?.({ attempt, phase, submission, ...(error === undefined ? {} : { diagnostic: executionErrorEvidence(error) }) });
      };
      state('preparing');
      try {
        const result = await this.runAttempt({ ...turn, conversation: { ...turn.conversation, nativeId },
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
    if (turn.signal.aborted) throw abortError();
    const idle = this.sessions.get(turn.conversation.id);
    if (idle?.transportFailure) await this.stopSession(turn.conversation.id, idle);
    turn = await resolveDefaultModel(this, turn);
    const effort = selectedEffort(turn);
    const key = turn.conversation.id, signature = this.signature(turn);
    const closing = this.closingSessions.get(key);
    if (closing) await this.stopSession(key, closing);
    if (this.closed) throw new Error('主控适配器已关闭。');
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
    const active: ActiveTurn = { turn, reportEffort, effortCapability: scopedCapability, completed: deferred<AgentResult>(), nativeTurnId: null, replyRecovery: reportRecovery, toolCalls: 0, publicCalls: 0, restartAccepted: false, sealed: false, pendingClaudeTools: [], seenClaudeTools: new Set(), inFlightTools: new Map(), retiredNativeTurnIds: new Set() };
    session.active = active;
    const onAbort = () => { active.completed.reject(abortError()); void this.stopSession(key, session!).catch(() => {}); };
    turn.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (session.rpc) {
        const input = (turn.input ?? [{ type: 'text' as const, text: turn.text }, ...turn.imagePaths.map(path => ({ type: 'localImage' as const, path }))]).map(value => value.type === 'text' ? { ...value, text_elements: [] } : value);
        const manifest = imageManifest(turn);
        if (!turn.event && manifest) input.push({ type: 'text', text: manifest, text_elements: [] });
        const clock = this.runtimeContext(turn, session);
        if (!turn.event) input.push({ type: 'text', text: clock, text_elements: [] });
        const params: JsonObject = { threadId: session.nativeId, environments: [], input: turn.event ? [] : input, ...(effort ? { effort } : {}),
          ...(turn.conversation.fastMode != null ? { serviceTierForTurn: turn.conversation.fastMode ? 'fast' : 'default' } : {}) };
        if (turn.event) params.toolOutput = { name: turn.event.toolName ?? (turn.event.kind === 'wake' ? 'bridge_schedule_controller' : 'bridge_worker_result'), namespace: null, output: `${clock}\n\n${turn.event.text}` };
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
        const values = turn.event ? [{ type: 'text' as const, text: harnessText('controller.background_event', { kind: turn.event.kind, text: turn.event.text }) }] : turn.input ?? [{ type: 'text' as const, text: turn.text }, ...turn.imagePaths.map(path => ({ type: 'localImage' as const, path }))];
        const content = await this.claudeInput(values);
        const manifest = imageManifest(turn);
        if (!turn.event && manifest) content.push({ type: 'text', text: manifest });
        content.push({ type: 'text', text: this.runtimeContext(turn, session) });
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
    this.closed = true;
    const sessions = new Map([...this.sessions, ...this.closingSessions]);
    const results = await Promise.allSettled([...sessions].map(([key, session]) => { session.active?.completed.reject(abortError()); return this.stopSession(key, session); }));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '部分主控进程的停止尚未确认。');
  }
}
function imageMediaType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('主控图片格式需要 PNG、JPEG、GIF 或 WebP。');
}
function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function imageManifest(turn: AgentTurn): string {
  const paths = [...new Set([...turn.imagePaths, ...(turn.input ?? []).flatMap(value => value.type === 'localImage' ? [value.path] : [])])];
  return paths.length ? `[Current user-supplied image paths. Pass only relevant exact paths in a child's imagePaths; these paths are attachment references, not authorization to read other files.]\n${JSON.stringify(paths)}` : '';
}
