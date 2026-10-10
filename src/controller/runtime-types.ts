import type { AgentAdapter, AgentName } from '../types.js';
import type { TaskCompletionEvent, TaskOrigin } from '../tasks.js';
import type { ExecutionTargetBinding, RemoteHandoff, TargetSummary } from '../remote/types.js';

export type ControllerJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface ControllerWorker {
  id: string; origin: TaskOrigin; agent: AgentName; model: string | null; actualModel: string | null;
  actualEffort?: string | null;
  effort: string | null; cwd: string; title: string; nativeId: string | null; imagePaths: string[];
  target?: ExecutionTargetBinding; ownership?: 'bridge' | 'user'; handoffPending?: boolean;
  wakeAllowed: boolean; blocked?: boolean; createdAt: string; updatedAt: string;
}
export interface ControllerJob {
  id: string; workerId: string; origin: TaskOrigin; prompt: string; imagePaths: string[];
  status: ControllerJobStatus; taskId: string | null; result: string | null; cancelReason: string | null;
  /** Route cancellation belongs to this dispatch, never all future turns of an idle worker. */
  wakeAllowed?: boolean;
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
}
export interface ControllerRuntimeCallbacks {
  targetCatalog?: ControllerTargetCatalog;
  onRequestRestart?: (origin: TaskOrigin) => Promise<unknown>;
  isDraining?: () => boolean;
  onCompletion?: (event: TaskCompletionEvent) => void | Promise<void>;
  onCountChanged?: (conversationId: string, count: number) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Test clock; production uses real UTC timestamps. */
  now?: () => number;
  pollIntervalMs?: number;
}
