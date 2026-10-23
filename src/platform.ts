import { DiscordTransport, ingressFailureText } from './discord.js';
import { FeishuTransport } from './feishu.js';
import type { BridgeLifecycleEvent } from './lifecycle.js';
import { externalId } from './routing.js';
import type { BridgeConfig, IncomingDM, ReplyOptions, BridgeMessage, GroupSpaceInfo, GroupMember, GroupMembersPage } from './types.js';
import type { ForwardedContent } from './forwarded.js';
import type { WorkCounts } from './overview.js';
import type { DMHistoryOptions, DMHistoryPage } from './ingress.js';
import type { GroupMentionView } from './group-mentions.js';
import type { ConversationHistoryOptions, ConversationHistoryPage } from './group-history.js';

export class PlatformTransport {
  private readonly transport: DiscordTransport | FeishuTransport;
  constructor(private readonly config: BridgeConfig, receive: (message: IncomingDM) => Promise<void>, hooks: {
    onReceive: (message: IncomingDM) => boolean | void; onReady: () => Promise<void>; logger: (message: string) => void;
  }) {
    if (!config.scopePrefix || !config.applicationId || !['discord', 'feishu'].includes(config.platform ?? '')) throw new Error('缺少完整平台 Profile 身份。');
    this.transport = config.platform === 'feishu' ? new FeishuTransport(config, receive, hooks)
      : new DiscordTransport({ ...config, allowedUserIds: config.externalAllowedUserIds ?? config.allowedUserIds },
        message => receive(this.scoped(message)), { ...hooks, onReceive: message => hooks.onReceive(this.scoped(message)) });
  }
  get botUser(): { id?: string; username: string } | undefined { return this.transport.botUser ?? undefined; }
  private scoped(message: IncomingDM): IncomingDM {
    const scope = this.config.scopePrefix ?? '';
    return { ...message, id: scope + message.id, userId: scope + message.userId, channelId: scope + message.channelId, ...(message.source ? { source: { ...message.source, messageId: scope + message.source.messageId, userId: scope + message.source.userId, channelId: scope + message.source.channelId, ...(message.space ? { space: message.space } : {}) } } : {}) };
  }
  private raw(id: string): string { return externalId(this.config.scopePrefix ?? '', id); }
  private unscoped(message: IncomingDM): IncomingDM {
    return { ...message, id: this.raw(message.id), userId: this.raw(message.userId), channelId: this.raw(message.channelId) };
  }
  async verifyIdentity(): Promise<string> {
    const applicationId = await this.transport.verifyIdentity();
    if (applicationId !== this.config.applicationId) throw new Error('凭据对应的机器人与 Profile applicationId 不一致。');
    return applicationId;
  }
  getGroupInfo(spaceId: string): Promise<GroupSpaceInfo> { return this.transport.getGroupInfo(spaceId); }
  listGroupMembers(spaceId: string, options: { pageToken?: string; limit?: number } = {}): Promise<GroupMembersPage> { return this.transport.listGroupMembers(spaceId, options); }
  getGroupMember(spaceId: string, userId: string): Promise<GroupMember | null> { return this.transport.getGroupMember(spaceId, userId); }
  readGroupMentionView(spaceId: string, messageId: string): Promise<GroupMentionView> {
    if (!(this.transport instanceof FeishuTransport)) throw new Error('当前平台不使用跨应用提及关联。');
    return this.transport.readGroupMentionView(spaceId, messageId);
  }
  async syncGroupSlashCommands(guildId: string): Promise<void> {
    if (this.config.features?.nativeCommands !== false && this.transport instanceof DiscordTransport) await this.transport.syncGroupSlashCommands(guildId);
  }
  start(): Promise<void> { return this.transport.start(); }
  close(): Promise<void> { return this.transport.close(); }
  isIdle(): boolean { return this.transport.isIdle(); }
  sendText(channelId: string, text: string, options?: ReplyOptions): Promise<void> { return this.transport.sendText(this.raw(channelId), text, options); }
  sendInteractionText(interaction: NonNullable<IncomingDM['interaction']>, text: string, options?: ReplyOptions): Promise<void> {
    if (!(this.transport instanceof DiscordTransport)) throw new Error('当前平台没有原生斜杠交互。');
    return this.transport.sendInteractionText(interaction, text, options);
  }
  async readGroupHistory(spaceId: string, options: DMHistoryOptions & { ownerUserId?: string; includeObservers?: boolean } = {}): Promise<DMHistoryPage> {
    if (this.transport instanceof FeishuTransport) return this.transport.readGroupHistory(spaceId, options);
    const cursor = (id: string) => this.config.scopePrefix && id.startsWith(this.config.scopePrefix) ? this.raw(id) : id;
    const page = await this.transport.readGroupHistory(spaceId, { ...options,
      ...(options.before ? { before: cursor(options.before) } : {}), ...(options.after ? { after: cursor(options.after) } : {}) });
    const scope = this.config.scopePrefix ?? '';
    return { ...page, messages: page.messages.map(message => this.scoped(message)),
      oldestId: page.oldestId ? scope + page.oldestId : null, newestId: page.newestId ? scope + page.newestId : null };
  }
  readConversationHistory(spaceId: string, options: ConversationHistoryOptions = {}): Promise<ConversationHistoryPage> { return this.transport.readConversationHistory(spaceId, options); }
  async readDMHistory(channelId: string, options: DMHistoryOptions = {}): Promise<DMHistoryPage> {
    if (this.transport instanceof FeishuTransport) return this.transport.readDMHistory(this.raw(channelId), options);
    const rawOptions = { ...options, ...(options.before ? { before: this.raw(options.before) } : {}), ...(options.after ? { after: this.raw(options.after) } : {}) };
    const page = await this.transport.readDMHistory(this.raw(channelId), rawOptions), scope = this.config.scopePrefix ?? '';
    return { ...page, messages: page.messages.map(message => this.scoped(message)),
      oldestId: page.oldestId ? scope + page.oldestId : null, newestId: page.newestId ? scope + page.newestId : null };
  }
  readForwardedContent(message: IncomingDM, signal?: AbortSignal): Promise<ForwardedContent | undefined> {
    return this.transport.readForwardedContent(this.transport instanceof FeishuTransport ? message : this.unscoped(message), signal);
  }
  downloadImages(message: IncomingDM): Promise<string[]> { return this.transport.downloadImages(this.transport instanceof FeishuTransport ? message : this.unscoped(message)); }
  async markReplyDelivered(messages: Array<Pick<BridgeMessage, 'id' | 'channelId'> & { text?: string; isGroup?: boolean }>): Promise<void> {
    if (this.config.features?.reactions === false) return;
    await this.transport.markReplyDelivered(this.transport instanceof FeishuTransport ? messages : messages.map(message => ({ ...message, id: this.raw(message.id), channelId: this.raw(message.channelId) })));
  }
  async setTaskCount(message: Pick<BridgeMessage, 'id' | 'channelId'>, count: number): Promise<void> {
    if (this.config.features?.reactions === false || this.transport instanceof FeishuTransport) return;
    await this.transport.setTaskCount({ id: this.raw(message.id), channelId: this.raw(message.channelId) }, count);
  }
  onBridgeLifecycle(event: BridgeLifecycleEvent): Promise<void> { return this.transport.onBridgeLifecycle(event); }
  setWorkCounts(counts: WorkCounts): void { if (this.transport instanceof DiscordTransport) this.transport.setWorkCounts(counts); }
  async syncSlashCommands(): Promise<void> { if (this.config.features?.nativeCommands !== false) await this.transport.syncSlashCommands(); }
  failureText(error: unknown): string {
    if (this.transport instanceof FeishuTransport && error instanceof Error && /^(附件已收到但未交给模型：|图片超过|图片总量超过|附件内容不是|飞书图片无法下载)/.test(error.message)) return error.message;
    return ingressFailureText(error);
  }
}
