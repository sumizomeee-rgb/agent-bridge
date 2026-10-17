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
  /** Runtime identity is stable across profile/display-name changes. */
  botId?: string;
  /** Human names only; never identity, authorization, or routing selectors. */
  aliases?: string[];
  ownerPrincipalId?: string;
  ownerUserId?: string;
  contextWorkspace?: string;
  workingCwd?: string;
  groupMode?: boolean;
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
  /** Bridge worker defaults when parent model inheritance does not apply; independent of a remote CLI's default. */
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
export interface AgentSupplement { id: string; input: AgentInput[]; source?: AgentTurn['source'] }
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
export interface EffortConfiguration {
  value: string;
  source: 'argument' | 'environment' | 'user-settings' | 'project-settings' | 'local-settings' | 'session-settings';
  /** False means the bridge did not pass this setting to the launched backend. */
  applied?: boolean;
  reason?: string;
}
export interface EffortMetadata {
  requested: string | null;
  configuration: EffortConfiguration | null;
  capability: EffortCapability;
  actual: string | null;
}
export interface AgentTurn {
  conversation: Conversation;
  /** The real source of this input, never the last contacted destination. */
  source?: { messageId: string; userId: string; channelId: string; original?: ChatInputSource };
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
  onPublicMessage?: (text: string, attachmentPaths?: string[], messageKey?: string, targetId?: string, finish?: boolean) => Promise<void>;
  /** Automatically supplied bounded active-group evidence; never a fresh request. */
  chatScene?: string;
  /** Frozen per-event audience and host causal identity; never inferred from last contact. */
  groupContext?: { eventId: string; rootId: string; botId: string; spaceId: string; generation: number; bindingEpoch: number; originChannelId: string; principalId: string; scene: string; eventKind?: 'worker-result' | 'wake' | 'group-event' };
  onSilent?: () => Promise<void>;
  preparing?: boolean;
  /** Disposable evidence-only execution: restricted filesystem tools, no inherited MCP/plugins. */
  readOnly?: boolean;
  /** Standalone background input, never a human authorization. */
  event?: { kind: 'worker-result' | 'worker-progress' | 'wake' | 'workspace-context' | 'group-event'; toolName?: string; text: string; introductionRequested?: boolean };
  /** Optional explicit worker effort inherited from the coordinating turn. */
  effort?: string;
  onModel?: (model: string) => void;
  onReasoningEffort?: (effort: string | null) => void;
  /** Captured on the execution machine at launch; separate from native confirmation. */
  onEffortConfiguration?: (configuration: EffortConfiguration | null) => void;
  /** Adapter-owned evidence, shared by controllers, workers and every presentation. */
  onEffortMetadata?: (metadata: EffortMetadata) => void;
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
  /** Actual platform sender and region, separate from the owner's internal authorization route. */
  source?: ChatInputSource;
  groupContext?: AgentTurn['groupContext'];
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
export interface GroupMessageSpace {
  kind: 'group'; spaceId: string; mentionedUserIds: string[]; replyToMessageId?: string;
}
export interface GroupSpaceInfo { spaceId: string; name?: string; ownerId?: string; guildId?: string; memberCount?: number; botIsMember?: boolean }
export interface GroupMember { id: string; idType: 'open_id' | 'user_id' | 'union_id' | 'discord'; isBot?: boolean }
export interface GroupMembersPage { members: GroupMember[]; hasMore: boolean; pageToken?: string; verification: 'verified' | 'unknown'; reason?: string; scope?: 'humans' | 'channel' }
export interface ChatInputSource {
  messageId: string; userId: string; channelId: string;
  space?: GroupMessageSpace;
  authorType?: 'user' | 'bot' | 'system' | 'unknown';
  authorName?: string; time?: string;
}
export interface IncomingDM {
  source?: ChatInputSource;
  space?: GroupMessageSpace;
  id: string;
  userId: string;
  channelId: string;
  text: string;
  attachments: DiscordAttachment[];
  /** Gateway interaction credentials stay in memory and never enter the session store. */
  interaction?: { id: string; token: string; applicationId: string };
}
