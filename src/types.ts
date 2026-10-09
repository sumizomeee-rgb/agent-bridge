export type AgentName = 'codex' | 'claude';
export interface Conversation {
  id: string;
  userId: string;
  agent: AgentName;
  nativeId: string | null;
  /** Explicit per-conversation selection; null leaves the CLI default unchanged. */
  model?: string | null;
  /** Most recently reported effective model, separate from aliases/selections. */
  actualModel?: string | null;
  /** Most recently reported reasoning effort; null means the CLI did not confirm it. */
  actualEffort?: string | null;
  title: string;
  controllerMode?: boolean;
  contextSeed?: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentCommand { command: string; args: string[] }
export interface BridgeConfig {
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
export interface AgentModel { id: string; displayName: string; description?: string; isDefault?: boolean }
export interface AgentModelInfo { models: AgentModel[]; defaultModel: string | null }
export type AgentInput = { type: 'text'; text: string } | { type: 'localImage'; path: string };
export interface AgentSupplement { id: string; input: AgentInput[] }
export type SteerResult = { status: 'accepted' } | { status: 'queued' } | { status: 'uncertain'; reason: string };
export interface AgentTurn {
  conversation: Conversation;
  text: string;
  imagePaths: string[];
  /** 连续消息保留文字与图片的交错顺序。 */
  input?: AgentInput[];
  /** Bridge-scoped registration capability; passed to CLI tools through the environment. */
  taskContextPath?: string;
  /** app-server 确认活动 turn 后通知桥尝试补充。 */
  onReady?: () => void;
  signal: AbortSignal;
  onProgress: (text: string) => void;
  onNativeId?: (nativeId: string) => void;
  /** Only this explicit channel may publish coordinating-agent output. */
  onPublicMessage?: (text: string, attachmentPaths?: string[], messageKey?: string) => Promise<void>;
  /** Standalone background input, never a human authorization. */
  event?: { kind: 'worker-result' | 'wake' | 'workspace-context'; toolName?: string; text: string };
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
export interface ReplyOptions { repeatHeader?: string; images?: OutgoingImage[]; files?: OutgoingFile[]; signal?: AbortSignal }
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
