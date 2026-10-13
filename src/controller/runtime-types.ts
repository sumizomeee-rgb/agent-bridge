import type { AgentAdapter, AgentName, AgentExecutionProgress, AgentToolActivity } from '../types.js';
import type { TaskCompletionEvent, TaskOrigin } from '../tasks.js';
import type { ExecutionTargetBinding, RemoteHandoff, TargetSummary } from '../remote/types.js';
import type { NativeSessionAdoptArgs, NativeSessionAdoption, NativeSessionPage, NativeSessionRead, NativeSessionReadOptions, NativeSessionRef } from '../native-sessions.js';
import type { WorkCounts } from '../overview.js';

export type ControllerJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface ControllerWorker {
  id: string; origin: TaskOrigin; agent: AgentName; model: string | null; actualModel: string | null;
  actualEffort?: string | null;
  effort: string | null; cwd: string; title: string; nativeId: string | null; imagePaths: string[];
  target?: ExecutionTargetBinding; ownership?: 'bridge' | 'user'; handoffPending?: boolean;
  wakeAllowed: boolean; blocked?: boolean; createdAt: string; updatedAt: string;
  supersededBy?: string;
  adoption?: { id: string; ref: NativeSessionRef; expectedRevision: string; status: 'pending' | 'adopted'; previousWorkers: string[]; callKey?: string };
}
export interface ControllerJob {
  id: string; workerId: string; origin: TaskOrigin; prompt: string; imagePaths: string[];
  status: ControllerJobStatus; taskId: string | null; result: string | null; cancelReason: string | null;
  /** Optional metadata keeps old JSON rows compatible; no native payloads are stored. */
  progress?: AgentExecutionProgress;
  /** Stable per-tool notices survive remote reconnect and bridge restart. */
  stallNotices?: string[];
  /** Route cancellation belongs to this dispatch, never all future turns of an idle worker. */
  wakeAllowed?: boolean;
  startedAt?: string;
  execution?: { model: string | null; effort: string | null };
  createdAt: string; updatedAt: string;
}
export interface ControllerSupplement {
  id: string; workerId: string; jobId: string; origin: TaskOrigin; prompt: string; imagePaths: string[];
  status: 'pending' | 'steering' | 'accepted' | 'not_delivered' | 'unsupported' | 'uncertain' | 'cancelled';
  reason?: string; callKey?: string; createdAt: string; updatedAt: string;
}
export interface ControllerWake {
  id: string; origin: TaskOrigin; dueAt: string; text: string;
  status: 'pending' | 'firing' | 'fired' | 'cancelled'; taskId: string | null; createdAt: string;
}
export interface ControllerTargetCatalog {
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
export interface ControllerRuntimeCallbacks {
  targetCatalog?: ControllerTargetCatalog;
  onCheckCapabilities?: (workspace: string, args: { targetId?: string; agent?: AgentName; capabilityId?: string; refresh?: boolean }) => Promise<unknown>;
  onRequestRestart?: (origin: TaskOrigin) => Promise<unknown>;
  isDraining?: () => boolean;
  onCompletion?: (event: TaskCompletionEvent) => void | Promise<void>;
  onCountChanged?: (conversationId: string, count: number) => void | Promise<void>;
  onWorkCountsChanged?: (counts: WorkCounts) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Test clock; production uses real UTC timestamps. */
  now?: () => number;
  pollIntervalMs?: number;
  /** Observation only; the coordinating agent chooses what to do, never an automatic timeout. */
  onStall?: (event: ControllerStallEvent) => void | Promise<void>;
  stallAfterMs?: number;
}
