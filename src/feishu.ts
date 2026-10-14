import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fetch, FormData, ProxyAgent, type Dispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WSClient, EventDispatcher, Domain, type HttpInstance } from '@larksuiteoapi/node-sdk';
import type { BridgeConfig, IncomingDM, DiscordAttachment, ReplyOptions, BridgeMessage } from './types.js';
import type { DMHistoryOptions, DMHistoryPage } from './ingress.js';
import { compareMessageIds } from './routing.js';

type Json = Record<string, any>;
export interface FeishuOptions {
  apiBase?: string; fetch?: typeof fetch;
  socketFactory?: (options: ConstructorParameters<typeof WSClient>[0]) => Pick<WSClient, 'start' | 'close'>;
  onReceive?: (message: IncomingDM) => void;
  onReady?: () => Promise<void>;
  logger?: (message: string) => void;
}
export class FeishuTransport {
  botUser?: { username: string };
  private token = ''; private expires = 0; private obtaining?: Promise<string>;
  private readonly shutdown = new AbortController();
  private readonly dispatcher?: Dispatcher;
  private readonly http: typeof fetch;
  private readonly apiBase: string;
  private socket?: Pick<WSClient, 'start' | 'close'>;
  private readonly sends = new Map<string, Promise<void>>();
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
    this.botUser = { username: String(data.bot?.app_name ?? data.bot?.name ?? 'Feishu Bot') };
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
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(channel)) throw new Error('飞书私聊地址无效。');
    return { id: this.messageId(message), userId: this.config.scopePrefix + user, channelId: this.config.scopePrefix + channel, text, attachments };
  }
  async receiveEvent(event: any): Promise<void> {
    const data = event.event ?? event; const sender = data.sender, message = data.message;
    if (this.closed || sender?.sender_type !== 'user' || message?.chat_type !== 'p2p') return;
    if (event.header?.app_id && event.header.app_id !== this.config.applicationId) return;
    const user = sender.sender_id?.open_id;
    if (typeof user !== 'string' || !this.config.externalAllowedUserIds?.includes(user)) return;
    const normalized = this.normalize(message, user);
    // This must finish durable capture before SDK acknowledgement; it never waits for model work.
    this.options.onReceive?.(normalized);
    await this.receive(normalized);
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
    const clean = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '').replace(/```ansi\n/g, '```\n');
    const header = options?.repeatHeader ? clean(options.repeatHeader) : '';
    for (const chunk of splitUtf8(clean(text), 24 * 1024 - Buffer.byteLength(header, 'utf8') - 2)) {
      await this.api('/im/v1/messages?receive_id_type=chat_id', 'POST', { receive_id: channelId, msg_type: 'text', uuid: randomUUID(),
        content: JSON.stringify({ text: header && !chunk.startsWith(header) ? header + '\n' + chunk : chunk }) }, options?.signal);
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
  async markReplyDelivered(messages: Pick<BridgeMessage, 'id' | 'channelId'>[]): Promise<void> {
    if (!this.config.features?.reactions) return;
    for (const message of messages) {
      const id = message.id.split('|').at(-1)!;
      await this.api(`/im/v1/messages/${id}/reactions`, 'POST', { reaction_type: { emoji_type: 'DONE' } }).catch(() => this.log('FEISHU_REACTION_FAILED'));
    }
  }
  isIdle(): boolean { return this.sends.size === 0; }
  setPresence(): void {} setWorkCounts(): void {} async syncSlashCommands(): Promise<void> {} async setTaskCount(): Promise<void> {}
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.shutdown.abort(); this.socket?.close({ force: true });
    await Promise.allSettled([...this.sends.values()]); this.token = ''; this.expires = 0;
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
