export type AgentName = 'codex' | 'claude';
export interface Conversation {
  id: string;
  userId: string;
  agent: AgentName;
  nativeId: string | null;
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
}
export interface AgentTurn {
  conversation: Conversation;
  text: string;
  imagePaths: string[];
  signal: AbortSignal;
  onProgress: (text: string) => void;
  onNativeId?: (nativeId: string) => void;
}
export interface AgentResult { nativeId: string; text: string }
export interface AgentAdapter {
  run(turn: AgentTurn): Promise<AgentResult>;
  interrupt(conversationId: string): Promise<void>;
  close(): Promise<void>;
}
export interface BridgeMessage {
  id: string;
  userId: string;
  channelId: string;
  text: string;
  imagePaths: string[];
}
export interface ReplySink { sendText(channelId: string, text: string): Promise<void> }
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
}
