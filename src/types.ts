export type AgentName = 'codex' | 'claude';
export type BridgePlatform = 'discord' | 'feishu';
export interface Conversation {
  id: string;
  userId: string;
  agent: AgentName;
  nativeId: string | null;
  /** Explicit per-conversation selection; null leaves the CLI default unchanged. */
  model?: string | null;
  /** Explicit default follows current CLI settings even when resuming; absent preserves legacy native behavior. */
  modelPolicy?: 'cli-default';
  /** Most recently reported effective model, separate from aliases/selections. */
  actualModel?: string | null;
  /** Most recently reported reasoning effort; null means the CLI did not confirm it. */
  actualEffort?: string | null;
  /** Explicit per-conversation effort; null uses the CLI default. */
  effort?: string | null;
  title: string;
  controllerMode?: boolean;
  contextSeed?: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentCommand { command: string; args: string[] }
export interface BridgeConfig {
  platform?: BridgePlatform;
  profile?: string;
  applicationId?: string;
  appSecret?: string;
  scopePrefix?: string;
  externalAllowedUserIds?: string[];
  features?: { reactions?: boolean; nativeCommands?: boolean; presence?: boolean };
  token: string;
  allowedUserIds: string[];
  defaultAgent: AgentName;
  workspace: string;
  proxyUrl: string | null;
  commands: Record<AgentName, AgentCommand>;
  dataDir: string;
  attachmentsDir: string;
  logsDir: string;
  maxImageBytes: number;
  /** Short coordinating turns with independently running execution agents. */
  controllerMode?: boolean;
  /** Outgoing ordinary files; defaults to 20 MiB, at most 24 MiB. */
  maxFileBytes?: number;
  /** Reference defaults for display/fallback only, never an automatic CLI override. */
  defaultModels?: Partial<Record<AgentName, string>>;
  modelOptions?: Partial<Record<AgentName, string[]>>;
}
export type EffortCapability = {
  status: 'supported'; levels: [string, ...string[]];
  source: string; modelId: string | null; resolvedModel?: string; cliVersion?: string;
} | {
  status: 'unsupported' | 'unknown'; levels: [];
  source: string; modelId: string | null; resolvedModel?: string; cliVersion?: string;
};
export interface AgentModel {
  id: string; displayName: string; description?: string; isDefault?: boolean;
  /** Only an explicit CLI resolution may associate an alias with another ID. */
  resolvedModel?: string; effortCapability?: EffortCapability;
  /** Compatibility with older metadata adapters; normalized before use. */
  supportedEfforts?: string[];
}
export interface AgentModelInfo { models: AgentModel[]; defaultModel: string | null; source?: string; cliVersion?: string }
export type AgentInput = { type: 'text'; text: string } | { type: 'localImage'; path: string };
export interface AgentSupplement { id: string; input: AgentInput[] }
export type SteerResult = { status: 'accepted' } | { status: 'queued'; reason?: string; unsupported?: boolean } | { status: 'uncertain'; reason: string };
export interface AgentActivityMetadata {
  at: string;
  type: 'reasoning' | 'message' | 'tool-started' | 'tool-completed';
  itemId?: string;
  toolName?: string;
  status?: 'completed' | 'failed' | 'cancelled' | 'unknown';
}
export interface AgentToolActivity { itemId: string; toolName: string; startedAt: string }
export interface AgentExecutionProgress {
  observed: true; sequence: number; stage: 'reasoning' | 'message' | 'tool' | 'between-tools';
  lastActivity: AgentActivityMetadata; activeTools: AgentToolActivity[]; lastTool?: AgentActivityMetadata;
}
export interface AgentActivity extends AgentActivityMetadata {
  /** Owned remote snapshot; polling never creates a fresh native activity timestamp. */
  snapshot?: AgentExecutionProgress;
}
export interface AgentTurn {
  conversation: Conversation;
  text: string;
  imagePaths: string[];
  /** 连续消息保留文字与图片的交错顺序。 */
  input?: AgentInput[];
  /** Bridge-scoped registration capability; passed to CLI tools through the environment. */
  taskContextPath?: string;
  /** Stable dispatch identity for remote request deduplication and reconnect. */
  dispatchId?: string;
  /** Reattach to a previously dispatched remote job; never submit a fresh task. */
  recovering?: boolean;
  /** app-server 确认活动 turn 后通知桥尝试补充。 */
  onReady?: () => void;
  /** Bridge child accepts supplements through its current native transport. */
  acceptSupplements?: boolean;
  signal: AbortSignal;
  onProgress: (text: string) => void;
  /** Native lifecycle metadata only, without arguments, command text or output. */
  onActivity?: (activity: AgentActivity) => void;
  onNativeId?: (nativeId: string) => void;
  /** Only this explicit channel may publish coordinating-agent output. */
  onPublicMessage?: (text: string, attachmentPaths?: string[], messageKey?: string) => Promise<void>;
  /** Standalone background input, never a human authorization. */
  event?: { kind: 'worker-result' | 'worker-progress' | 'wake' | 'workspace-context'; toolName?: string; text: string; introductionRequested?: boolean };
  /** Optional explicit worker effort inherited from the coordinating turn. */
  effort?: string;
  onModel?: (model: string) => void;
  onReasoningEffort?: (effort: string | null) => void;
}
export interface AgentResult { nativeId: string; text: string; controlledOutput?: boolean }
export interface AgentAdapter {
  run(turn: AgentTurn): Promise<AgentResult>;
  /** queued 必须表示尚未提交或收到明确拒绝；不确定结果禁止自动重发。 */
  steer?(conversationId: string, supplement: AgentSupplement): Promise<SteerResult>;
  interrupt(conversationId: string): Promise<void>;
  /** Read-only reconciliation; true only after target-native exit was confirmed. */
  confirmStopped?(conversationId: string): Promise<boolean>;
  close(): Promise<void>;
  /** Metadata only: never sends a user prompt or starts a generated turn. */
  getModelInfo?(cwd: string): Promise<AgentModelInfo>;
}
export interface BridgeMessage {
  id: string;
  userId: string;
  channelId: string;
  text: string;
  imagePaths: string[];
}
export interface OutgoingImage {
  filename: string;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: Uint8Array;
  description?: string;
}
export interface OutgoingFile {
  filename: string;
  contentType: string;
  data: Uint8Array;
  description?: string;
}
export interface ReplyOptions { presentation?: import('./presentation.js').BridgePresentation; repeatHeader?: string; images?: OutgoingImage[]; files?: OutgoingFile[]; signal?: AbortSignal }
export interface ReplySink {
  sendText(channelId: string, text: string, options?: ReplyOptions): Promise<void>;
  /** Registered background agents on the latest ordinary message; zero removes the counter. */
  setTaskCount?(message: Pick<BridgeMessage, 'id' | 'channelId'>, count: number): Promise<void>;
  /** Best effort indication on the original messages, after successful reply delivery. */
  markReplyDelivered?(messages: Pick<BridgeMessage, 'id' | 'channelId'>[]): Promise<void>;
}
export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  content_type?: string;
  /** Feishu IM resource reference; never a cloud-drive token. */
  resourceKey?: string;
  messageId?: string;
}
export interface IncomingDM {
  id: string;
  userId: string;
  channelId: string;
  text: string;
  attachments: DiscordAttachment[];
  /** Gateway interaction credentials stay in memory and never enter the session store. */
  interaction?: { id: string; token: string; applicationId: string };
}
