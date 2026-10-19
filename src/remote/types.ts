import type { PresetBinding } from '../presets/types.js';
import type { AgentCommand, AgentInput, AgentName, AgentResult, AgentSupplement, AgentModelInfo, SteerResult, AgentExecutionProgress, EffortConfiguration, EffortMetadata } from '../types.js';

/** Non-secret snapshot. Native homes, provider credentials and history stay on the target. */
export interface ExecutionTargetBinding {
  preset?: PresetBinding;
  id: string;
  label: string;
  transport: 'local' | 'ssh';
  expectedHostname?: string;
  sshConfig?: string;
  alias?: string;
  remoteRoot?: string;
  nodePath?: string;
  agent: AgentName;
  agentCommand: AgentCommand;
  cwd: string;
}
export interface TargetEngine { agentCommand: AgentCommand; defaultCwd: string }
export interface RemoteTargetRegistration {
  id: string; label: string; expectedHostname: string; sshConfig: string; alias: string;
  allowedUserIds?: string[];
  remoteRoot: string; nodePath: string; engines: Partial<Record<AgentName, TargetEngine>>;
}
export interface TargetSummary {
  id: string; label: string; transport: 'local' | 'ssh'; engines: AgentName[];
  expectedHostname?: string;
  /** Registration, not a claim of current connectivity. Probe happens on dispatch. */
  availability: 'local' | 'registered';
}
export interface RemoteDaemonConfig {
  version: 1; expectedHostname: string; proxyPort?: number | null;
  engines: Partial<Record<AgentName, TargetEngine>>;
}
export interface RemoteDispatch {
  preset?: PresetBinding;
  dispatchId: string; workerId: string; userId: string; agent: AgentName; agentCommand: AgentCommand;
  nativeId: string | null; cwd: string; text: string; imagePaths: string[]; input?: AgentInput[];
  model: string | null; effort?: string; acceptSupplements: boolean;
}
export interface RemoteArtifact {
  id: string; filename: string; description?: string; image: boolean;
  size: number; sha256: string;
}
export interface RemoteJob {
  dispatchId: string; workerId: string; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  nativeId: string | null; ready: boolean; actualModel?: string; actualEffort?: string | null;
  effortConfiguration?: EffortConfiguration | null;
  effortMetadata?: EffortMetadata | null;
  result?: AgentResult; artifacts?: RemoteArtifact[]; error?: string; stopped?: boolean;
  /** Native-owned progress snapshot, distinct from transport query/heartbeat timestamps. */
  progress?: AgentExecutionProgress;
  createdAt: string; updatedAt: string;
}
export interface RemoteClient {
  request<T = unknown>(method: string, args: unknown): Promise<T>;
  close(): Promise<void>;
}
export interface RemoteHandoff { targetId: string; nativeId: string; cwd: string; agent: AgentName; resumeCommand: string; stopped: true }
export class RemoteDispatchUncertain extends Error {
  readonly processStillRunning = true;
  constructor(message = '远端执行连接断开，任务结果未知；禁止重新派发或续接。') { super(message); this.name = 'RemoteDispatchUncertain'; }
}
export class RemoteArtifactTransferError extends Error {
  readonly nativeStopped = true;
  constructor(readonly nativeResult: AgentResult, message: string) { super(`远端原生任务已完成、CLI 已结束；附件传回失败：${message}`); this.name = 'RemoteArtifactTransferError'; }
}
export type RemoteRequest = { id: string; method: string; args: unknown; token?: string };
export type RemoteResponse = { id: string; result?: unknown; error?: { code: string; message: string } };
export interface RemoteMethods {
  hello: { hostname: string; platform: string; engines: AgentName[]; version: 1 };
  dispatch: RemoteJob;
  query: RemoteJob;
  steer: SteerResult;
  interrupt: { stopped: true };
  models: AgentModelInfo;
}
export type RemoteSupplement = AgentSupplement & { dispatchId: string };
