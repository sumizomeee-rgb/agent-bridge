import { feishuPresentationCards, type BridgePresentation } from './presentation.js';
import { BRIDGE_LIFECYCLE_COPY, type BridgeLifecycleEvent } from './lifecycle.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fetch, FormData, ProxyAgent, type Dispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WSClient, EventDispatcher, Domain, type HttpInstance } from '@larksuiteoapi/node-sdk';
import type { BridgeConfig, IncomingDM, DiscordAttachment, ReplyOptions, BridgeMessage, GroupSpaceInfo, GroupMember, GroupMembersPage } from './types.js';
import type { DMHistoryOptions, DMHistoryPage } from './ingress.js';
import { historyOptions, historyPage, type ConversationHistoryOptions, type ConversationHistoryPage, type ConversationHistoryMessage } from './group-history.js';
import { compareMessageIds } from './routing.js';
import { shouldShowMessageReceipts, type ReceiptMessage } from './receipt-policy.js';
import { groupMessagePayloadHash, type GroupMentionView } from './group-mentions.js';

type Json = Record<string, any>;
export interface FeishuOptions {
  apiBase?: string; fetch?: typeof fetch;
  socketFactory?: (options: ConstructorParameters<typeof WSClient>[0]) => Pick<WSClient, 'start' | 'close'>;
  onReceive?: (message: IncomingDM) => boolean | void;
  onReady?: () => Promise<void>;
  logger?: (message: string) => void;
}
export class FeishuTransport {
  botUser?: { id?: string; username: string };
  private token = ''; private expires = 0; private obtaining?: Promise<string>;
  private readonly shutdown = new AbortController();
  private readonly dispatcher?: Dispatcher;
  private readonly http: typeof fetch;
  private readonly apiBase: string;
  private socket?: Pick<WSClient, 'start' | 'close'>;
  private readonly sends = new Map<string, Promise<void>>();
  private readonly receipts = new Map<string, Promise<void>>();
  private readonly processingReactions = new Map<string, string>();
  private readonly seenMessages = new Set<string>();
  private closed = false;
  constructor(private readonly config: BridgeConfig, private readonly receive: (message: IncomingDM) => Promise<void>,
    private readonly options: FeishuOptions = {}) {
    this.http = options.fetch ?? fetch;
    this.apiBase = options.apiBase ?? 'https://open.feishu.cn/open-apis';
    this.dispatcher = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : undefined;
  }
  private log(message: string): void { this.options.logger?.(message); }
  private async tenantToken(): Promise<string> {
    if (this.token && Date.now() < this.expires) return this.token;
    if (this.obtaining) return this.obtaining;
    this.obtaining = (async () => {
      const response = await this.http(`${this.apiBase}/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.config.applicationId, app_secret: this.config.appSecret }),
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)]), ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
      const data = await response.json() as Json;
      if (!response.ok || data.code !== 0 || typeof data.tenant_access_token !== 'string') throw new Error(`飞书鉴权失败（HTTP ${response.status}，code=${data.code ?? 'unknown'}）。`);
      this.token = data.tenant_access_token; this.expires = Date.now() + Math.max(1, Number(data.expire ?? 7200) - 60) * 1000;
      return this.token;
    })();
    try { return await this.obtaining; } finally { this.obtaining = undefined; }
  }
  private async api(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Json> {
    if (this.closed) throw new Error('飞书通信已关闭。');
    const token = await this.tenantToken();
    const form = body instanceof FormData;
    const response = await this.http(this.apiBase + path, { method,
      headers: { Authorization: `Bearer ${token}`, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
      signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    const data = await response.json() as Json;
    if (!response.ok || data.code !== 0) throw new Error(`飞书请求失败（HTTP ${response.status}，code=${data.code ?? 'unknown'}）；未自动重发。`);
    return data.data ?? data;
  }
  async verifyIdentity(): Promise<string> {
    const data = await this.api('/bot/v3/info');
    this.botUser = { username: String(data.bot?.app_name ?? data.bot?.name ?? 'Feishu Bot'),
      ...(typeof data.bot?.open_id === 'string' && /^ou_[a-zA-Z0-9_-]+$/.test(data.bot.open_id) ? { id: data.bot.open_id } : {}) };
    return this.config.applicationId!;
  }
  async start(): Promise<void> {
    let ready!: () => void, failed!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    let initial = true;
    const onReady = () => {
      if (this.closed) return;
      void (this.options.onReady?.() ?? Promise.resolve()).then(() => { if (initial) { initial = false; ready(); } }, error => { this.log('FEISHU_RECOVERY_FAILED'); if (initial) failed(error); });
    };
    // Only transport primitives use the SDK. Ingress, authorization, ordering and replies remain bridge-owned.
    const sdkRequest = async (opts: Json) => {
      const url = new URL(opts.url); for (const [key, value] of Object.entries(opts.params ?? {})) url.searchParams.set(key, String(value));
      const response = await this.http(url, { method: opts.method ?? 'GET', headers: opts.headers,
        ...(opts.data == null ? {} : { body: JSON.stringify(opts.data), headers: { ...opts.headers, 'Content-Type': 'application/json' } }),
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)]), ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
      if (!response.ok) throw new Error(`飞书长连接配置请求失败（HTTP ${response.status}）。`);
      return response.json();
    };
    const httpInstance = { request: sdkRequest,
      ...Object.fromEntries(['get', 'delete', 'head', 'options'].map(method => [method, (url: string, opts?: Json) => sdkRequest({ ...opts, url, method })])),
      ...Object.fromEntries(['post', 'put', 'patch'].map(method => [method, (url: string, data?: unknown, opts?: Json) => sdkRequest({ ...opts, url, method, data })])),
    } as HttpInstance;
    const parameters: ConstructorParameters<typeof WSClient>[0] = { appId: this.config.applicationId!, appSecret: this.config.appSecret!, domain: Domain.Feishu,
      httpInstance, ...(this.config.proxyUrl ? { agent: new HttpsProxyAgent(this.config.proxyUrl) } : {}),
      onReady, onReconnected: onReady, onError: () => { this.log('FEISHU_WS_FAILED'); if (initial) failed(new Error('飞书长连接启动失败。')); },
      handshakeTimeoutMs: 15_000, wsConfig: { pingTimeout: 60 },
      logger: { error: () => this.log('FEISHU_WS_ERROR'), warn: () => this.log('FEISHU_WS_WARN'), info: () => {}, debug: () => {}, trace: () => {} },
    };
    this.socket = (this.options.socketFactory ?? (settings => new WSClient(settings)))(parameters);
    const timer = setTimeout(() => failed(new Error('飞书长连接启动超时。')), 20_000);
    try {
      await this.socket.start({ eventDispatcher: new EventDispatcher({}).register({ 'im.message.receive_v1': data => this.receiveEvent(data) }) });
      await connected;
    } catch (error) { this.socket.close({ force: true }); throw error; }
    finally { clearTimeout(timer); }
  }
  private messageId(message: Json): string {
    const time = String(message.create_time ?? ''); const id = String(message.message_id ?? '');
    if (!/^\d{10,16}$/.test(time) || !/^om_[a-zA-Z0-9_-]+$/.test(id)) throw new Error('飞书消息身份或时间无效。');
    return `${this.config.scopePrefix}${time}|${id}`;
  }
  private normalize(message: Json, user: string): IncomingDM {
    const content = JSON.parse(String(message.content ?? message.body?.content ?? '{}')) as Json;
    const attachments: DiscordAttachment[] = [];
    const image = (key: string) => attachments.push({ id: key, filename: 'image', url: '', size: 0,
      content_type: 'image/unknown', resourceKey: key, messageId: message.message_id });
    let text = '';
    const type = message.message_type ?? message.msg_type;
    if (type === 'text') text = String(content.text ?? '');
    else if (type === 'image') image(String(content.image_key ?? ''));
    else if (type === 'post') {
      const post = content.content ? content : content.zh_cn ?? content.en_us ?? {};
      text = [post.title ?? '', ...(post.content ?? []).map((line: Json[]) => line.map(node => {
        if (node.tag === 'img') { image(String(node.image_key ?? '')); return ''; }
        if (node.tag === 'a') return `[${node.text ?? node.href}](${node.href})`;
        return node.tag === 'text' || node.tag === 'md' ? String(node.text ?? '') : '';
      }).join(''))].filter(Boolean).join('\n');
    } else attachments.push({ id: String(content.file_key ?? ''), filename: String(content.file_name ?? type ?? 'attachment'),
      url: '', size: 0, content_type: 'application/octet-stream', resourceKey: String(content.file_key ?? ''), messageId: message.message_id });
    const channel = String(message.chat_id ?? '');
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(channel)) throw new Error('飞书聊天地址无效。');
    const mentions: Json[] = Array.isArray(message.mentions) ? message.mentions.map((item: Json) => ({ ...item,
      id: { open_id: typeof item?.id === 'string' && item.id_type === 'open_id' ? item.id : item?.id?.open_id },
    })).filter((item: Json) => typeof item.id.open_id === 'string' && /^ou_[a-zA-Z0-9_-]+$/.test(item.id.open_id)) : [];
    const mentionedUserIds = [...new Set<string>(mentions.map((item: Json) => item.id.open_id))];
    // Only platform-resolved leading tokens may precede a text command. Display names never establish identity.
    if (message.chat_type === 'group') {
      let previous: string;
      do {
        previous = text;
        const mention = mentions.find((item: Json) => typeof item.key === 'string' && item.key && text.trimStart().startsWith(item.key));
        if (mention) text = text.trimStart().slice(mention.key.length).trimStart();
      } while (text !== previous);
    }
    return { id: this.messageId(message), userId: this.config.scopePrefix + user, channelId: this.config.scopePrefix + channel, text, attachments,
      ...(message.chat_type === 'group' ? { space: { kind: 'group' as const, spaceId: channel, mentionedUserIds,
        ...(typeof message.parent_id === 'string' && /^om_[a-zA-Z0-9_-]+$/.test(message.parent_id) ? { replyToMessageId: message.parent_id } : {}) } } : {}) };
  }
  async receiveEvent(event: any): Promise<void> {
    const data = event.event ?? event; const sender = data.sender, message = data.message;
    if (this.closed || sender?.sender_type !== 'user' || (message?.chat_type !== 'p2p' && !(this.config.groupMode === true && message?.chat_type === 'group'))) return;
    if (event.header?.app_id && event.header.app_id !== this.config.applicationId) return;
    const user = sender.sender_id?.open_id;
    if (typeof user !== 'string' || !/^ou_[a-zA-Z0-9_-]+$/.test(user) || (message.chat_type === 'p2p' && !this.config.externalAllowedUserIds?.includes(user))) return;
    if (!/^\d{10,16}$/.test(String(message.create_time ?? '')) || !Number.isFinite(new Date(Number(message.create_time)).getTime())) return;
    const normalized = this.normalize(message, user);
    if (normalized.space) normalized.source = { messageId: normalized.id, userId: normalized.userId, channelId: normalized.channelId, space: normalized.space, authorType: 'user', ...(typeof sender.name === 'string' ? { authorName: sender.name } : {}), time: new Date(Number(message.create_time)).toISOString() };
    if (this.seenMessages.has(normalized.id)) return;
    // This must finish durable capture before SDK acknowledgement; it never waits for model work.
    const captured = this.options.onReceive?.(normalized);
    if (captured !== false && !this.seenMessages.has(normalized.id)) {
      this.seenMessages.add(normalized.id);
      if (this.seenMessages.size > 5000) this.seenMessages.delete(this.seenMessages.values().next().value!);
      if (shouldShowMessageReceipts(this.config, normalized)) void this.markReceived(normalized);
    }
    await this.receive(normalized);
  }
  /** Every application must verify its own raw chat ID; names/counts do not establish cross-app identity. */
  async getGroupInfo(spaceId: string): Promise<GroupSpaceInfo> {
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(spaceId)) throw new Error('飞书群地址无效。');
    const [chat, membership] = await Promise.all([
      this.api(`/im/v1/chats/${spaceId}?user_id_type=open_id`),
      this.api(`/im/v1/chats/${spaceId}/members/is_in_chat`),
    ]);
    if (chat.chat_mode !== 'group' || typeof membership.is_in_chat !== 'boolean') throw new Error('飞书群身份或机器人在群状态无法确认。');
    const count = Number(chat.user_count);
    return { spaceId, botIsMember: membership.is_in_chat,
      ...(typeof chat.name === 'string' ? { name: chat.name } : {}),
      ...(chat.owner_id_type === 'open_id' && typeof chat.owner_id === 'string' ? { ownerId: chat.owner_id } : {}),
      ...(Number.isSafeInteger(count) && count >= 0 ? { memberCount: count } : {}) };
  }
  /** Feishu's members API excludes bots. Its result only proves human membership. */
  async listGroupMembers(spaceId: string, options: { pageToken?: string; limit?: number } = {}): Promise<GroupMembersPage> {
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(spaceId)) throw new Error('飞书群地址无效。');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('飞书群成员页面大小无效。');
    const params = new URLSearchParams({ member_id_type: 'open_id', page_size: String(limit), ...(options.pageToken ? { page_token: options.pageToken } : {}) });
    const data = await this.api(`/im/v1/chats/${spaceId}/members?${params}`);
    if (!Array.isArray(data.items) || data.items.some((item: Json) => item.member_id_type !== 'open_id' || typeof item.member_id !== 'string' || !/^ou_[a-zA-Z0-9_-]+$/.test(item.member_id))
      || (data.has_more === true && (typeof data.page_token !== 'string' || !data.page_token))) throw new Error('飞书群成员返回格式无效。');
    return { members: data.items.map((item: Json) => ({ id: item.member_id, idType: 'open_id' as const, isBot: false })),
      hasMore: data.has_more === true, ...(data.has_more === true ? { pageToken: data.page_token } : {}),
      verification: data.trigger_security_conf_limit === true ? 'unknown' : 'verified', scope: 'humans',
      ...(data.trigger_security_conf_limit === true ? { reason: '群成员安全限制导致返回不完整。' } : {}) };
  }
  async getGroupMember(spaceId: string, userId: string): Promise<GroupMember | null> {
    if (!/^ou_[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('飞书群成员身份无效。');
    const tokens = new Set<string>(); let pageToken: string | undefined;
    do {
      const page = await this.listGroupMembers(spaceId, { pageToken });
      const member = page.members.find(item => item.id === userId); if (member) return member;
      if (page.verification !== 'verified') throw new Error('飞书群成员访问权无法确认。');
      pageToken = page.pageToken;
      if (pageToken && tokens.has(pageToken)) throw new Error('飞书群成员分页游标重复。');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    return null;
  }
  /** Read the same original message in this app's ID namespace, never infer from names. */
  async readGroupMentionView(spaceId: string, messageId: string): Promise<GroupMentionView> {
    const match = /^(\d{10,16})\|(om_[a-zA-Z0-9_-]+)$/.exec(messageId);
    if (this.config.groupMode !== true || !/^oc_[a-zA-Z0-9_-]+$/.test(spaceId) || !match) throw new Error('飞书提及关联消息无效。');
    const data = await this.api(`/im/v1/messages/${match[2]}`);
    if (!Array.isArray(data.items) || data.items.length !== 1) throw new Error('飞书提及关联消息数量无效。');
    const item = data.items[0];
    if (item.message_id !== match[2] || item.chat_id !== spaceId || String(item.create_time) !== match[1] || item.deleted === true
      || item.sender?.sender_type !== 'user' || item.sender?.id_type !== 'open_id' || !/^ou_[a-zA-Z0-9_-]+$/.test(item.sender.id ?? '')) throw new Error('飞书提及关联消息身份无效。');
    const mentions = (Array.isArray(item.mentions) ? item.mentions : []).map((m: Json) => ({ key: m.key, id: m.id }));
    if (!Array.isArray(item.mentions) || mentions.some((m: Json) => typeof m.key !== 'string' || !m.key || !/^ou_[a-zA-Z0-9_-]+$/.test(m.id ?? ''))
      || item.mentions.some((m: Json) => m.id_type !== 'open_id') || new Set(mentions.map((m: Json) => m.key)).size !== mentions.length) throw new Error('飞书提及实体无法核对。');
    const normalized = this.normalize({ ...item, chat_type: 'group' }, item.sender.id);
    return { messageId: item.message_id, spaceId, createTime: String(item.create_time), senderId: item.sender.id,
      payloadHash: groupMessagePayloadHash(normalized), mentions };
  }
  /** Group recovery has its own authorization and retains group space/mentions, never a synthetic DM. */
  async readGroupHistory(spaceId: string, options: DMHistoryOptions & { ownerUserId?: string; includeObservers?: boolean } = {}): Promise<DMHistoryPage> {
    if (this.config.groupMode !== true || !/^oc_[a-zA-Z0-9_-]+$/.test(spaceId)) throw new Error('飞书群历史未启用或群标识无效。');
    const users = this.config.externalAllowedUserIds ?? [];
    const owner = options.ownerUserId ?? (users.length === 1 ? users[0] : undefined);
    if (!owner || !users.includes(owner)) throw new Error('飞书群历史需要明确的已授权负责人账号。');
    const limit = Math.min(options.limit ?? 50, 50);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('飞书群历史页面大小无效。');
    if (options.after && options.since && options.after !== options.since) throw new Error('飞书群历史起点不一致。');
    const seconds = (id: string): number => {
      if (!id.startsWith(this.config.scopePrefix!)) throw new Error('飞书群历史游标不属于当前机器人。');
      const raw = id.slice(this.config.scopePrefix!.length);
      if (!/^\d{10,16}\|om_[a-zA-Z0-9_-]+$/.test(raw)) throw new Error('飞书群历史游标无效。');
      return Math.floor(Number(raw.split('|')[0]) / 1000);
    };
    const params = new URLSearchParams({ container_id_type: 'chat', container_id: spaceId, page_size: String(limit), sort_type: 'ByCreateTimeDesc' });
    const since = options.since ?? options.after;
    // One-second overlap preserves opaque IDs sharing a timestamp. The host deduplicates original message IDs.
    if (since) params.set('start_time', String(Math.max(0, seconds(since) - 1)));
    if (options.before) params.set('end_time', String(seconds(options.before) + 1));
    if (options.pageToken) params.set('page_token', options.pageToken);
    const info = await this.getGroupInfo(spaceId);
    if (info.botIsMember !== true || !await this.getGroupMember(spaceId, owner)) throw new Error('飞书群历史访问权已失效。');
    const data = await this.api(`/im/v1/messages?${params}`);
    if (!Array.isArray(data.items) || (data.has_more === true && (typeof data.page_token !== 'string' || !data.page_token))) throw new Error('飞书群历史分页格式无效。');
    const ids: string[] = [], messages = new Map<string, IncomingDM>();
    for (const item of data.items as Json[]) {
      if (item.chat_id != null && item.chat_id !== spaceId) throw new Error('飞书群历史返回了其他群的消息。');
      const id = this.messageId(item); ids.push(id);
      if (item.deleted === true || item.sender?.sender_type !== 'user' || item.sender?.id_type !== 'open_id' || !/^ou_[a-zA-Z0-9_-]+$/.test(item.sender.id ?? '') || (!options.includeObservers && item.sender.id !== owner)) continue;
      if (!messages.has(id)) {
        const message = this.normalize({ ...item, chat_id: spaceId, chat_type: 'group' }, item.sender.id);
        if (options.includeObservers) message.source = { messageId: message.id, userId: message.userId, channelId: message.channelId, space: message.space, authorType: 'user', ...(typeof item.sender.name === 'string' ? { authorName: item.sender.name } : {}), time: new Date(Number(item.create_time)).toISOString() };
        messages.set(id, message);
      }
    }
    ids.sort(compareMessageIds);
    return { messages: [...messages.values()], oldestId: ids[0] ?? null, newestId: ids.at(-1) ?? null, hasMore: data.has_more === true,
      ...(data.has_more === true ? { pageToken: data.page_token } : {}) };
  }
  /** All visible authors are evidence only; this endpoint never replays commands or downloads resources. */
  async readConversationHistory(spaceId: string, options: ConversationHistoryOptions = {}): Promise<ConversationHistoryPage> {
    if (this.config.groupMode !== true || !/^oc_[a-zA-Z0-9_-]+$/.test(spaceId)) throw new Error('飞书群历史未启用或群标识无效。');
    const { limit, start, end } = historyOptions(options);
    const users = this.config.externalAllowedUserIds ?? [];
    const owner = options.ownerUserId ?? (users.length === 1 ? users[0] : undefined);
    if (!owner || !users.includes(owner)) throw new Error('飞书群历史需要明确的已授权负责人账号。');
    const info = await this.getGroupInfo(spaceId);
    if (info.botIsMember !== true || !await this.getGroupMember(spaceId, owner)) throw new Error('飞书群历史访问权已失效。');
    const params = new URLSearchParams({ container_id_type: 'chat', container_id: spaceId, page_size: String(limit), sort_type: 'ByCreateTimeDesc' });
    if (start !== undefined) params.set('start_time', String(Math.floor(start / 1000)));
    if (end !== undefined) params.set('end_time', String(Math.ceil(end / 1000)));
    if (options.pageToken) params.set('page_token', options.pageToken);
    const data = await this.api(`/im/v1/messages?${params}`);
    if (!Array.isArray(data.items) || data.items.length > limit || typeof data.has_more !== 'boolean' || (data.has_more && (typeof data.page_token !== 'string' || !data.page_token || data.page_token.length > 4096))) throw new Error('飞书群历史分页格式无效。');
    const messages = new Map<string, ConversationHistoryMessage>();
    for (const item of data.items as Json[]) {
      if (item.chat_id != null && item.chat_id !== spaceId) throw new Error('飞书群历史返回了其他群的消息。');
      this.messageId(item);
      const timestamp = Number(item.create_time);
      if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) throw new Error('飞书群历史时间无效。');
      if ((start !== undefined && timestamp < start) || (end !== undefined && timestamp >= end)) continue;
      const sender = item.sender ?? {};
      const authorType = sender.sender_type === 'user' ? 'user' : sender.sender_type === 'app' ? 'bot' : sender.sender_type === 'system' ? 'system' : 'unknown';
      const authorId = typeof sender.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(sender.id) ? sender.id : 'unknown';
      const type = item.msg_type ?? item.message_type;
      let content: Json = {}, text = '', truncated = false;
      try { const parsed = JSON.parse(String(item.body?.content ?? item.content ?? '{}')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) content = parsed; else truncated = true; } catch { truncated = true; }
      const attachments: ConversationHistoryMessage['attachments'] = [];
      const attachment = (id: unknown, name?: unknown, contentType?: string) => { if (typeof id === 'string' && id) attachments.push({ id, ...(typeof name === 'string' ? { name } : {}), ...(contentType ? { contentType } : {}) }); };
      if (item.deleted === true) text = '[消息已撤回或删除]';
      else if (type === 'text') text = typeof content.text === 'string' ? content.text : '';
      else if (type === 'interactive') {
        const parts: string[] = []; let visited = 0;
        const collect = (value: unknown, depth = 0): void => {
          if (depth > 12 || visited++ > 500) { truncated = true; return; }
          if (Array.isArray(value)) { for (const child of value) collect(child, depth + 1); return; }
          if (!value || typeof value !== 'object') return;
          const node = value as Json;
          if (typeof node.content === 'string') parts.push(node.content);
          if (typeof node.text === 'string') parts.push(node.text);
          if (typeof node.title === 'string') parts.push(node.title);
          for (const key of ['title', 'header', 'body', 'elements', 'fields', 'text', 'content', 'columns']) if (node[key] && typeof node[key] === 'object') collect(node[key], depth + 1);
        };
        collect(content); text = parts.join('\n'); if (!text) { text = '[卡片消息：当前接口未提取正文]'; truncated = true; }
      }
      else if (type === 'post') {
        const post = content.content ? content : content.zh_cn ?? content.en_us ?? {};
        text = [typeof post.title === 'string' ? post.title : '', ...(Array.isArray(post.content) ? post.content : []).map((line: Json[]) => Array.isArray(line) ? line.map(node => {
          if (!node || typeof node !== 'object') return '';
          if (node.tag === 'img') { attachment(node.image_key, 'image', 'image/unknown'); return ''; }
          return typeof node.text === 'string' ? node.text : typeof node.user_id === 'string' ? `@${node.user_id}` : '';
        }).join('') : '')].filter(Boolean).join('\n');
      } else if (type === 'image') attachment(content.image_key, 'image', 'image/unknown');
      else if (content.file_key) attachment(content.file_key, content.file_name, 'application/octet-stream');
      else { text = `[${String(type ?? 'unknown').slice(0, 64)} 消息：当前接口未提取正文]`; truncated = true; }
      const mentions = (Array.isArray(item.mentions) ? item.mentions : []).flatMap((mention: Json) => mention && typeof mention.id === 'string' ? [{ id: mention.id, ...(typeof mention.name === 'string' ? { name: mention.name } : {}) }] : []);
      const message: ConversationHistoryMessage = { id: item.message_id, author: { id: authorId, type: authorType, ...(typeof sender.name === 'string' ? { name: sender.name } : {}) }, time: new Date(timestamp).toISOString(), text, mentions, attachments,
        ...(typeof item.parent_id === 'string' && /^om_[a-zA-Z0-9_-]+$/.test(item.parent_id) ? { replyToMessageId: item.parent_id } : {}), ...(truncated ? { truncated: true } : {}) };
      messages.set(message.id, message);
    }
    return historyPage(spaceId, options, [...messages.values()], data.has_more, data.page_token, ['飞书接口实际可见记录；ID 仅属于当前应用命名空间，不可跨应用互换。', '按创建时间倒序；删除、权限或接口保留范围可能造成缺口，不声称完整历史。', ...(data.items.some((item: Json) => (item.msg_type ?? item.message_type) === 'interactive') ? ['卡片正文仅为飞书接口可见投影，可能是兼容提示，不保证原卡完整；不得根据提示编造原文。'] : [])]);
  }
  async readDMHistory(channelId: string, options: DMHistoryOptions = {}): Promise<DMHistoryPage> {
    const params = new URLSearchParams({ container_id_type: 'chat', container_id: channelId, page_size: String(Math.min(options.limit ?? 50, 50)), sort_type: 'ByCreateTimeDesc' });
    if (options.since) params.set('start_time', String(Math.max(0, Math.floor(Number(options.since.split('|')[1]) / 1000) - 1)));
    if (options.pageToken) params.set('page_token', options.pageToken);
    const data = await this.api(`/im/v1/messages?${params}`);
    const items: Json[] = data.items ?? []; const ids: string[] = [], messages: IncomingDM[] = [];
    for (const item of items) {
      ids.push(this.messageId(item));
      if (item.sender?.sender_type !== 'user' || !this.config.externalAllowedUserIds?.includes(item.sender.id)) continue;
      messages.push(this.normalize({ ...item, chat_id: channelId }, item.sender.id));
    }
    ids.sort(compareMessageIds);
    return { messages, oldestId: ids[0] ?? null, newestId: ids.at(-1) ?? null, hasMore: data.has_more === true,
      ...(data.page_token ? { pageToken: String(data.page_token) } : {}) };
  }
  async downloadImages(message: IncomingDM): Promise<string[]> {
    if (message.attachments.length > 10) throw new Error('图片超过每轮 10 张上限。');
    const files: string[] = []; let total = 0;
    try {
    for (const item of message.attachments) {
      if (item.content_type !== 'image/unknown' || !item.resourceKey || !/^om_[a-zA-Z0-9_-]+$/.test(item.messageId ?? '')) throw new Error('附件已收到但未交给模型：当前仅支持用户图片输入，普通文件输入尚未启用。');
      const token = await this.tenantToken();
      const response = await this.http(`${this.apiBase}/im/v1/messages/${item.messageId}/resources/${encodeURIComponent(item.resourceKey)}?type=image`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30_000)]), ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
      if (!response.ok || !response.body) throw new Error(`飞书图片无法下载（HTTP ${response.status}）。`);
      const max = Math.min(this.config.maxImageBytes, 10 * 1024 * 1024); const parts: Uint8Array[] = []; let size = 0;
      const reader = response.body.getReader();
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) throw new Error('图片超过 10 MiB 或本地限额。'); parts.push(part.value); } }
      finally { await reader.cancel().catch(() => undefined); }
      total += size; if (total > 100 * 1024 * 1024) throw new Error('图片总量超过 100 MiB。');
      const bytes = Buffer.concat(parts); const extension = imageExtension(bytes);
      if (!extension) throw new Error('附件内容不是受支持的 PNG/JPEG/GIF/WebP 图片。');
      await mkdir(this.config.attachmentsDir, { recursive: true });
      const path = join(this.config.attachmentsDir, `${randomUUID()}.${extension}`), temporary = path + '.tmp';
      try { await writeFile(temporary, bytes); await rename(temporary, path); files.push(path); }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    }
    return files;
    } catch (error) { await Promise.all(files.map(file => unlink(file).catch(() => undefined))); throw error; }
  }
  sendText(channelId: string, text: string, options?: ReplyOptions): Promise<void> {
    const prior = this.sends.get(channelId) ?? Promise.resolve();
    const send = prior.catch(() => {}).then(() => this.send(channelId, text, options)); this.sends.set(channelId, send);
    void send.finally(() => { if (this.sends.get(channelId) === send) this.sends.delete(channelId); }).catch(() => {});
    return send;
  }
  private async send(channelId: string, text: string, options?: ReplyOptions): Promise<void> {
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(channelId)) throw new Error('飞书回复地址无效。');
    const images = options?.images ?? [], files = options?.files ?? [];
    if (images.length + files.length > 10 || [...images, ...files].reduce((sum, file) => sum + file.data.length, 0) > 100 * 1024 * 1024) throw new Error('回传附件超过每轮限额。');
    for (const item of [...images, ...files]) {
      const max = images.includes(item as any) ? Math.min(this.config.maxImageBytes, 10 * 1024 * 1024) : this.config.maxFileBytes ?? 20 * 1024 * 1024;
      if (!item.data.length || item.data.length > max) throw new Error('回传附件为空或超过限额；未重新运行 Agent。');
    }
    let view = options?.presentation;
    if (!view && options?.repeatHeader) {
      const prefix = options.repeatHeader + '\n\n';
      if (!text.startsWith(prefix)) throw new Error('回复头与正文不一致。');
      view = { title: options.repeatHeader.startsWith('[') && options.repeatHeader.endsWith(']') ? options.repeatHeader.slice(1, -1) : options.repeatHeader, tone: 'success', purpose: 'reply', blocks: [{ kind: 'text', text: text.slice(prefix.length) }] };
    }
    if (view) for (const card of feishuPresentationCards(view)) {
      await this.api('/im/v1/messages?receive_id_type=chat_id', 'POST', { receive_id: channelId, msg_type: 'interactive', uuid: randomUUID(), content: JSON.stringify(card) }, options?.signal);
    } else for (const chunk of splitUtf8(text, 24 * 1024)) {
      await this.api('/im/v1/messages?receive_id_type=chat_id', 'POST', { receive_id: channelId, msg_type: 'text', uuid: randomUUID(), content: JSON.stringify({ text: chunk }) }, options?.signal);
    }
    for (const item of [...images, ...files]) {
      const isImage = images.includes(item as any);
      const max = isImage ? Math.min(this.config.maxImageBytes, 10 * 1024 * 1024) : this.config.maxFileBytes ?? 20 * 1024 * 1024;
      if (!item.data.length || item.data.length > max) throw new Error('回传附件为空或超过限额；未重新运行 Agent。');
      const form = new FormData(); const fileName = item.filename.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180);
      form.set(isImage ? 'image_type' : 'file_type', isImage ? 'message' : 'stream');
      if (!isImage) form.set('file_name', fileName);
      form.set(isImage ? 'image' : 'file', new Blob([Uint8Array.from(item.data)], { type: item.contentType }), fileName);
      const uploaded = await this.api(isImage ? '/im/v1/images' : '/im/v1/files', 'POST', form, options?.signal);
      const key = uploaded[isImage ? 'image_key' : 'file_key'];
      if (typeof key !== 'string' || !key) throw new Error('飞书未返回上传资源标识。');
      await this.api('/im/v1/messages?receive_id_type=chat_id', 'POST', { receive_id: channelId, msg_type: isImage ? 'image' : 'file', uuid: randomUUID(),
        content: JSON.stringify({ [isImage ? 'image_key' : 'file_key']: key }) }, options?.signal);
    }
  }
  /** 回执只表示持久收件与回复送达；更新失败不影响任务，串行避免完成后留下处理中表情。 */
  private receipt(message: Pick<BridgeMessage, 'id' | 'channelId'>, update: (id: string) => Promise<void>): Promise<void> {
    const prefix = this.config.scopePrefix!;
    if (this.closed || !this.config.features?.reactions || !message.id.startsWith(prefix) || !message.channelId.startsWith(prefix)) return Promise.resolve();
    const id = message.id.slice(prefix.length).split('|').at(-1)!;
    if (!/^om_[a-zA-Z0-9_-]+$/.test(id)) return Promise.resolve();
    const previous = this.receipts.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => { if (!this.closed) await update(id); })
      .catch(() => { if (!this.closed) this.log('FEISHU_RECEIPT_FAILED'); });
    this.receipts.set(id, work);
    void work.finally(() => { if (this.receipts.get(id) === work) this.receipts.delete(id); }).catch(() => {});
    return work;
  }
  private markReceived(message: IncomingDM): Promise<void> {
    return this.receipt(message, async id => {
      const result = await this.api(`/im/v1/messages/${id}/reactions`, 'POST', { reaction_type: { emoji_type: 'Status_PrivateMessage' } }, AbortSignal.timeout(5000));
      if (typeof result.reaction_id === 'string') this.processingReactions.set(id, result.reaction_id);
    });
  }
  async markReplyDelivered(messages: ReceiptMessage[]): Promise<void> {
    await Promise.all([...new Map(messages.filter(message => shouldShowMessageReceipts(this.config, message))
      .map(message => [message.id, message])).values()].map(message => this.receipt(message, async id => {
      await this.api(`/im/v1/messages/${id}/reactions`, 'POST', { reaction_type: { emoji_type: 'CheckMark' } }, AbortSignal.timeout(5000));
      const cached = this.processingReactions.get(id), pending: string[] = cached ? [cached] : [];
      // 重启后按平台身份找回自己的处理中表情，只删除当前 bot 的回执。
      if (!cached) {
        let pageToken: string | undefined;
        do {
          const params = new URLSearchParams({ reaction_type: 'Status_PrivateMessage', page_size: '50', ...(pageToken ? { page_token: pageToken } : {}) });
          const page = await this.api(`/im/v1/messages/${id}/reactions?${params}`, 'GET', undefined, AbortSignal.timeout(5000));
          for (const item of page.items ?? []) if (item.operator?.operator_type === 'app' && item.operator.operator_id === this.config.applicationId
            && item.reaction_type?.emoji_type === 'Status_PrivateMessage' && typeof item.reaction_id === 'string') pending.push(item.reaction_id);
          pageToken = page.has_more === true && typeof page.page_token === 'string' ? page.page_token : undefined;
        } while (pageToken);
      }
      for (const reactionId of pending) await this.api(`/im/v1/messages/${id}/reactions/${encodeURIComponent(reactionId)}`, 'DELETE', undefined, AbortSignal.timeout(5000));
      this.processingReactions.delete(id);
    })));
  }
  async onBridgeLifecycle(event: BridgeLifecycleEvent): Promise<void> {
    if (event.phase !== 'ready' || !event.recipient) return;
    if (!this.config.allowedUserIds.includes(event.recipient.userId)) return;
    const prefix = this.config.scopePrefix!;
    if (!event.recipient.channelId.startsWith(prefix)) throw new Error('启动通知不属于当前机器人。');
    const view: BridgePresentation = { title: event.reason === 'restart' ? BRIDGE_LIFECYCLE_COPY.restart : BRIDGE_LIFECYCLE_COPY.ready,
      tone: 'success', purpose: 'lifecycle', blocks: [{ kind: 'text', text: BRIDGE_LIFECYCLE_COPY.continuation }] };
    await this.sendText(event.recipient.channelId.slice(prefix.length), '', { presentation: view });
  }
  isIdle(): boolean { return this.sends.size === 0 && this.receipts.size === 0; }
  setPresence(): void {} setWorkCounts(): void {} async syncSlashCommands(): Promise<void> {} async setTaskCount(): Promise<void> {}
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.shutdown.abort(); this.socket?.close({ force: true });
    await Promise.allSettled([...this.sends.values(), ...this.receipts.values()]); this.processingReactions.clear(); this.seenMessages.clear(); this.token = ''; this.expires = 0;
    await this.dispatcher?.close();
  }
}
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes < 100) throw new Error('回复头超过分片限额。');
  const result: string[] = []; let chunk = '', size = 0;
  for (const character of text) { const bytes = Buffer.byteLength(character, 'utf8'); if (size + bytes > maxBytes) { result.push(chunk); chunk = ''; size = 0; } chunk += character; size += bytes; }
  if (chunk) result.push(chunk); return result;
}
function imageExtension(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}
