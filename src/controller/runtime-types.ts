import type { AgentName } from '../types.js';
import type { TaskCompletionEvent, TaskOrigin } from '../tasks.js';

export type ControllerJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export interface ControllerWorker {
  id: string; origin: TaskOrigin; agent: AgentName; model: string | null; actualModel: string | null;
  effort: string | null; cwd: string; title: string; nativeId: string | null; imagePaths: string[];
  wakeAllowed: boolean; blocked?: boolean; createdAt: string; updatedAt: string;
}
export interface ControllerJob {
  id: string; workerId: string; origin: TaskOrigin; prompt: string; imagePaths: string[];
  status: ControllerJobStatus; taskId: string | null; result: string | null; cancelReason: string | null;
  /** Route cancellation belongs to this dispatch, never all future turns of an idle worker. */
  wakeAllowed?: boolean;
  createdAt: string; updatedAt: string;
}
export interface ControllerWake {
  id: string; origin: TaskOrigin; dueAt: string; text: string;
  status: 'pending' | 'firing' | 'fired' | 'cancelled'; taskId: string | null; createdAt: string;
}
export interface ControllerRuntimeCallbacks {
  onCompletion?: (event: TaskCompletionEvent) => void | Promise<void>;
  onCountChanged?: (conversationId: string, count: number) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Test clock; production uses real UTC timestamps. */
  now?: () => number;
  pollIntervalMs?: number;
}
