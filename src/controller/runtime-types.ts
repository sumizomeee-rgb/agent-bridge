import type { AgentAdapter, AgentName, AgentResult, AgentExecutionProgress, AgentToolActivity, EffortConfiguration, EffortMetadata } from '../types.js';
import type { TaskCompletionEvent, TaskOrigin } from '../tasks.js';
import type { ExecutionTargetBinding, RemoteHandoff, TargetSummary } from '../remote/types.js';
import type { NativeSessionAdoptArgs, NativeSessionAdoption, NativeSessionPage, NativeSessionRead, NativeSessionReadOptions, NativeSessionRef } from '../native-sessions.js';
import type { WorkCounts } from '../overview.js';
import type { AgentStopEvidence } from '../agents/process.js';

export type ControllerJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface ControllerWorker {
  id: string; origin: TaskOrigin; agent: AgentName; model: string | null; actualModel: string | null;
  actualEffort?: string | null;
  effortConfiguration?: EffortConfiguration | null;
  effortMetadata?: EffortMetadata | null;
  modelPolicy?: 'cli-default';
  effort: string | null; cwd: string; title: string; nativeId: string | null; imagePaths: string[];
  target?: ExecutionTargetBinding; ownership?: 'bridge' | 'user'; handoffPending?: boolean;
  wakeAllowed: boolean; blocked?: boolean; createdAt: string; updatedAt: string;
  supersededBy?: string;
  /** Explicit cancellation with confirmed exit; archival never resolves business effects or unlocks continuation. */
  archivedAt?: string; archiveReason?: string;
  adoption?: { id: string; ref: NativeSessionRef; expectedRevision: string; status: 'pending' | 'adopted'; previousWorkers: string[]; callKey?: string };
}
export interface ControllerJob {
  id: string; workerId: string; origin: TaskOrigin; prompt: string; imagePaths: string[];
  scheduleId?: string;
  status: ControllerJobStatus; taskId: string | null; result: string | null; cancelReason: string | null;
  /** A completed turn report and process exit proof are independent of reconciliation status. */
  nativeResult?: AgentResult;
  processStopped?: boolean;
  /** Previous execution ended without a reliable business result; new input may resume after proven exit. */
  interrupted?: boolean;
  stopEvidence?: AgentStopEvidence;
  executionError?: string; cleanupError?: string;
  /** Optional metadata keeps old JSON rows compatible; no native payloads are stored. */
  progress?: AgentExecutionProgress;
  /** Stable per-tool notices survive remote reconnect and bridge restart. */
  stallNotices?: string[];
  /** Route cancellation belongs to this dispatch, never all future turns of an idle worker. */
  wakeAllowed?: boolean;
  startedAt?: string;
  execution?: { model: string | null; effort: string | null; modelPolicy?: 'cli-default' };
  createdAt: string; updatedAt: string;
}
export interface ControllerSupplement {
  id: string; workerId: string; jobId: string; origin: TaskOrigin; prompt: string; imagePaths: string[];
  status: 'pending' | 'steering' | 'accepted' | 'not_delivered' | 'unsupported' | 'uncertain' | 'cancelled';
  reason?: string; callKey?: string; createdAt: string; updatedAt: string;
  /** 异步失败已落库但尚未交给主控反馈日志；重启仅补交记录。 */
  feedbackPending?: boolean;
}
export interface ControllerSchedule {
  id: string; origin: TaskOrigin; dueAt: string; title: string; text: string;
  kind: 'controller' | 'worker';
  status: 'pending' | 'dispatching' | 'running' | 'triggered' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  taskId: string | null; createdAt: string; updatedAt: string;
  /** Frozen execution selection, prepared at registration; no controller turn is needed when due. */
  worker?: ControllerWorker; job?: ControllerJob; error?: string;
}
export interface ControllerTargetCatalog {
  listPresets?(workspace: string, filter?: import('../presets/types.js').PresetFilter): Promise<import('../presets/types.js').DispatchPreset[]>;
  resolvePreset?(workspace: string, presetId: string, cwd?: string): Promise<ExecutionTargetBinding>;
  listTargets(workspace: string, refresh?: boolean): Promise<TargetSummary[]>;
  resolveTarget(workspace: string, targetId: string, agent: AgentName, cwd?: string): Promise<ExecutionTargetBinding>;
  adapterFor(binding: ExecutionTargetBinding): AgentAdapter;
  handoff(binding: ExecutionTargetBinding, nativeId: string, cwd: string, agent: AgentName): Promise<RemoteHandoff>;
  authorizeNativeAccess?(workspace: string, userId: string, targetId: string): Promise<void>;
  listNativeSessions?(binding: ExecutionTargetBinding, userId: string, query: { cwd?: string; cursor?: string; limit?: number; query?: string }): Promise<NativeSessionPage>;
  readNativeSession?(binding: ExecutionTargetBinding, userId: string, ref: NativeSessionRef, options?: NativeSessionReadOptions): Promise<NativeSessionRead>;
  adoptNativeSession?(binding: ExecutionTargetBinding, userId: string, args: NativeSessionAdoptArgs): Promise<NativeSessionAdoption>;
}
export interface ControllerStallEvent {
  id: string; observationKey: string; taskId: string | null; origin: TaskOrigin; workerId: string; jobId: string; targetId: string;
  tool: AgentToolActivity; observedAt: string; waitingMs: number;
}
export interface WorkerPolicyReport {
  origin: TaskOrigin; workerId: string; jobId: string; taskId: string; taskTitle: string;
}
export interface ControllerRuntimeCallbacks {
  targetCatalog?: ControllerTargetCatalog;
  onCheckCapabilities?: (workspace: string, args: { targetId?: string; agent?: AgentName; capabilityId?: string; refresh?: boolean }) => Promise<unknown>;
  onRequestRestart?: (origin: TaskOrigin) => Promise<unknown>;
  isDraining?: () => boolean;
  onCompletion?: (event: TaskCompletionEvent) => void | Promise<void>;
  onPolicyReport?: (report: WorkerPolicyReport) => void | Promise<void>;
  onSupplementFailure?: (supplement: ControllerSupplement) => boolean | void | Promise<boolean | void>;
  onCountChanged?: (conversationId: string, count: number) => void | Promise<void>;
  onWorkCountsChanged?: (counts: WorkCounts) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** 在执行占用真正释放后通知宿主对账，不产生模型回合。 */
  onExecutionSettled?: () => void;
  /** Test clock; production uses real UTC timestamps. */
  now?: () => number;
  pollIntervalMs?: number;
  /** Observation only; the coordinating agent chooses what to do, never an automatic timeout. */
  onStall?: (event: ControllerStallEvent) => void | Promise<void>;
  stallAfterMs?: number;
}
