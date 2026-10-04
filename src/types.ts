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
  /** Reference defaults for display/fallback only, never an automatic CLI override. */
  defaultModels?: Partial<Record<AgentName, string>>;
  modelOptions?: Partial<Record<AgentName, string[]>>;
}
export interface AgentModel { id: string; displayName: string; description?: string; isDefault?: boolean }
export interface AgentModelInfo { models: AgentModel[]; defaultModel: string | null }
export interface AgentTurn {
  conversation: Conversation;
  text: string;
  imagePaths: string[];
  /** Bridge-owned transport guidance, supplied separately from the user's original message. */
  deliveryInstructions?: string;
  signal: AbortSignal;
  onProgress: (text: string) => void;
  onNativeId?: (nativeId: string) => void;
  onModel?: (model: string) => void;
  onReasoningEffort?: (effort: string | null) => void;
}
export interface AgentResult { nativeId: string; text: string }
export interface AgentAdapter {
  run(turn: AgentTurn): Promise<AgentResult>;
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
export interface ReplyOptions { repeatHeader?: string; images?: OutgoingImage[]; signal?: AbortSignal }
export interface ReplySink { sendText(channelId: string, text: string, options?: ReplyOptions): Promise<void> }
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
