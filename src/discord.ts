import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fetch, FormData, ProxyAgent, type Dispatcher } from 'undici';
import WebSocket from 'ws';
import type { BridgeConfig, DiscordAttachment, IncomingDM, OutgoingFile, OutgoingImage, ReplyOptions } from './types.js';
import { SLASH_COMMANDS, slashText, type SlashInteraction } from './slash.js';

/** Overrides are for isolated tests; ordinary startup uses Discord's public endpoints. */
export interface DiscordTransportOptions {
  restBaseUrl?: string;
  gatewayUrl?: string;
  fetch?: typeof fetch;
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  random?: () => number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  readyTimeoutMs?: number;
  identifyIntervalMs?: number;
  invalidSessionDelayMs?: number;
  maxImages?: number;
  maxTotalImageBytes?: number;
  logger?: (message: string) => void;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const snowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,20}$/.test(value);
const imageTypes: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
};
const fatalGatewayCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const cdnHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const mib = 1024 * 1024;
const outgoingBatchBytes = 24 * mib; // Leave room below Discord's 25 MiB request limit.
interface PreparedAttachment { filename: string; blob: Blob; description?: string }

class DiscordRestError extends Error {
  constructor(public readonly status: number) { super(`Discord REST 请求失败（HTTP ${status}）。`); }
}

function imageExtension(attachment: DiscordAttachment): string | null {
  if (attachment.content_type) {
    const mediaType = attachment.content_type.split(';')[0]?.toLowerCase();
    if (mediaType && imageTypes[mediaType]) return imageTypes[mediaType]!;
    if (mediaType?.startsWith('image/')) throw new Error('仅支持 JPG、PNG、WebP 和 GIF 图片。');
    if (mediaType !== 'application/octet-stream') return null;
  }
  const extension = attachment.filename.split('.').at(-1)?.toLowerCase();
  return extension === 'jpeg' ? 'jpg' :
    extension && ['jpg', 'png', 'webp', 'gif'].includes(extension) ? extension : null;
}

function attachmentUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !cdnHosts.has(url.hostname) || url.username ||
      url.password || (url.port && url.port !== '443') ||
      !/^\/(?:attachments|ephemeral-attachments)\//.test(url.pathname)) {
    throw new Error('图片下载地址必须是 Discord 的 HTTPS 附件地址。');
  }
  return url;
}

function validImage(header: Buffer, extension: string): boolean {
  switch (extension) {
    case 'jpg': return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case 'png': return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'gif': return ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'));
    case 'webp': return header.subarray(0, 4).toString('ascii') === 'RIFF' &&
      header.subarray(8, 12).toString('ascii') === 'WEBP';
    default: return false;
  }
}

function safeOutgoingFilename(filename: unknown): filename is string {
  return typeof filename === 'string' && filename.length > 0 && filename.length <= 200
    && filename === filename.trim() && !/[\x00-\x1f\x7f/\\:*?"<>|]/.test(filename)
    && !filename.endsWith('.') && filename !== '.' && filename !== '..'
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename);
}

function prepareOutgoingAttachments(images: OutgoingImage[], files: OutgoingFile[],
  maxImageBytes: number, maxFileBytes: number): PreparedAttachment[][] {
  if (!Array.isArray(images) || !Array.isArray(files)) throw new Error('回复附件列表无效。');
  if (images.length + files.length > 10) {
    throw new Error(files.length ? '单次回复最多发送 10 个附件（图片与文件合计）。' : '单次回复最多发送 10 张图片。');
  }
  const perImageLimit = Math.min(maxImageBytes, 10 * mib);
  const perFileLimit = Math.min(maxFileBytes, outgoingBatchBytes);
  const attachments = [...images, ...files];
  let totalBytes = 0;
  // Validate the entire logical reply before copying bytes or sending any text.
  for (const [index, attachment] of attachments.entries()) {
    const isImage = index < images.length;
    if (!attachment || !safeOutgoingFilename(attachment.filename)) {
      throw new Error('回复附件的文件名无效，必须是安全的文件名。');
    }
    if (typeof attachment.contentType !== 'string' || attachment.contentType.length > 255
      || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(attachment.contentType)) {
      throw new Error('回复附件的 MIME 类型无效。');
    }
    const extension = isImage ? imageTypes[attachment.contentType] : undefined;
    if (isImage) {
      const filenameExtension = attachment.filename.split('.').at(-1)?.toLowerCase();
      if (!extension || (filenameExtension === 'jpeg' ? 'jpg' : filenameExtension) !== extension) {
        throw new Error('回复图片仅支持扩展名与类型一致的 JPG、PNG、WebP 和 GIF。');
      }
    }
    if (!(attachment.data instanceof Uint8Array) || (isImage && attachment.data.byteLength === 0)
      || attachment.data.byteLength > (isImage ? perImageLimit : perFileLimit)) {
      throw new Error(isImage ? '回复图片为空或大小超过上限。' : '回复文件为空或大小超过上限。');
    }
    totalBytes += attachment.data.byteLength;
    if (totalBytes > 100 * mib) throw new Error('单次回复的附件总大小超过 100 MiB。');
    if (isImage && !validImage(Buffer.from(attachment.data.buffer, attachment.data.byteOffset,
      Math.min(attachment.data.byteLength, 12)), extension!)) {
      throw new Error('回复图片内容不是声明的图片格式。');
    }
    if (attachment.description !== undefined && (typeof attachment.description !== 'string'
      || attachment.description.length > 1024 || attachment.description.includes('\0'))) {
      throw new Error('回复附件说明无效或超过 1024 字。');
    }
  }
  const batches: PreparedAttachment[][] = [];
  let batch: PreparedAttachment[] = [];
  let batchBytes = 0;
  for (const attachment of attachments) {
    if (batch.length && batchBytes + attachment.data.byteLength > outgoingBatchBytes) {
      batches.push(batch); batch = []; batchBytes = 0;
    }
    // A Blob snapshots the supplied view so queued sends and retries are immutable.
    batch.push({ filename: attachment.filename,
      blob: new Blob([new Uint8Array(attachment.data)], { type: attachment.contentType }),
      ...(attachment.description === undefined ? {} : { description: attachment.description }) });
    batchBytes += attachment.data.byteLength;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function chunks(text: string, limit = 2000): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + limit, text.length);
    // Discord's limit counts UTF-16 units; avoid splitting a surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push(text.slice(offset, end));
    offset = end;
  }
  return result;
}

function waitForSend(job: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return job;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    void job.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}

export class DiscordTransport {
  public botUser: { id: string; username: string } | null = null;
  private readonly httpFetch: typeof fetch;
  private readonly restBase: string;
  private readonly allowedUsers: Set<string>;
  private readonly shutdown = new AbortController();
  private readonly restDispatcher: Dispatcher | undefined;
  private readonly cdnDispatcher: Dispatcher | undefined;
  private readonly gatewayAgent: HttpsProxyAgent<string> | undefined;
  private readonly sendQueues = new Map<string, Promise<void>>();
  private readonly channelWaitUntil = new Map<string, number>();
  private readonly seenMessages = new Set<string>();
  private readonly seenInteractions = new Set<string>();
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private applicationId: string | undefined;
  private globalWaitUntil = 0;
  private ws: WebSocket | undefined;
  private gatewayUrl: string | undefined;
  private resumeUrl: string | undefined;
  private sessionId: string | undefined;
  private sequence: number | null = null;
  private heartbeat: NodeJS.Timeout | undefined;
  private protocolTimer: NodeJS.Timeout | undefined;
  private identifyTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private heartbeatAcknowledged = true;
  private reconnectAttempt = 0;
  private nextReconnectDelay: number | undefined;
  private lastIdentifyAt = 0;
  private connecting = false;
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;

  constructor(
    private readonly config: BridgeConfig,
    private readonly onMessage: (message: IncomingDM) => Promise<void>,
    private readonly options: DiscordTransportOptions = {},
  ) {
    this.httpFetch = options.fetch ?? fetch;
    this.restBase = (options.restBaseUrl ?? 'https://discord.com/api/v10').replace(/\/$/, '');
    this.gatewayUrl = options.gatewayUrl;
    this.allowedUsers = new Set(config.allowedUserIds);
    if (!Number.isSafeInteger(config.maxImageBytes) || config.maxImageBytes <= 0) {
      throw new Error('maxImageBytes 必须是正整数。');
    }
    if (config.maxFileBytes !== undefined && (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes <= 0)) {
      throw new Error('maxFileBytes 必须是正整数。');
    }
    // REST, Gateway and CDN each explicitly use the configured proxy.
    if (config.proxyUrl) {
      this.restDispatcher = new ProxyAgent(config.proxyUrl);
      this.cdnDispatcher = new ProxyAgent(config.proxyUrl);
      this.gatewayAgent = new HttpsProxyAgent(config.proxyUrl);
    }
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Discord transport 已关闭。'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimer = setTimeout(() => this.fail(new Error('等待 Discord READY 超时。')),
      this.options.readyTimeoutMs ?? 120_000);
    void this.connect();
    return this.startPromise;
  }

  async sendText(channelId: string, text: string, options?: ReplyOptions): Promise<void> {
    if (!snowflake(channelId)) throw new Error('无效的 Discord channelId。');
    if (this.closed) throw new Error('Discord transport 已关闭。');
    const signal = options?.signal;
    signal?.throwIfAborted();
    const attachmentBatches = prepareOutgoingAttachments(options?.images ?? [], options?.files ?? [],
      this.config.maxImageBytes, this.config.maxFileBytes ?? 20 * mib);
    const caption = options?.files?.length ? '附件' : '图片';
    if (!text.length && !attachmentBatches.length) return;
    const prefix = options?.repeatHeader ? `${options.repeatHeader}\n\n` : '';
    if (prefix && (prefix.length >= 1998 || (text.length > 0 && !text.startsWith(prefix)))) throw new Error('回复头过长或与正文不一致。');
    const parts = prefix ? chunks(text.slice(prefix.length), 2000 - prefix.length).map(part => `${prefix}${part}`) : chunks(text);
    const previous = this.sendQueues.get(channelId) ?? Promise.resolve();
    const job = previous.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      for (let index = 0; index < Math.max(parts.length, attachmentBatches.length); index++) {
        signal?.throwIfAborted();
        const attachments = attachmentBatches[index];
        const content = parts[index] ?? `${prefix}${chunks(`${caption} ${index + 1}/${attachmentBatches.length}`, 2000 - prefix.length)[0]}`;
        // A nonce prevents duplicate delivery if a server retries a message internally.
        await this.rest(`/channels/${channelId}/messages`, 'POST', {
          content, allowed_mentions: { parse: [] },
          nonce: randomUUID().replaceAll('-', '').slice(0, 24), enforce_nonce: true,
          ...(attachments ? { attachments: attachments.map((attachment, id) => ({ id, filename: attachment.filename,
            ...(attachment.description === undefined ? {} : { description: attachment.description }) })) } : {}),
        }, channelId, attachments, signal);
      }
    });
    this.sendQueues.set(channelId, job);
    // An aborted caller returns immediately, but its slot still waits for the prior
    // job so later replies cannot overtake an upload already running on this channel.
    void job.finally(() => {
      if (this.sendQueues.get(channelId) === job) this.sendQueues.delete(channelId);
    }).catch(() => undefined);
    await waitForSend(job, signal);
  }

  async syncSlashCommands(): Promise<void> {
    if (this.closed) throw new Error('Discord transport 已关闭。');
    if (!this.applicationId) {
      const application = await this.rest('/applications/@me', 'GET');
      if (!record(application) || !snowflake(application.id)) throw new Error('Discord 没有返回有效应用标识。');
      this.applicationId = application.id;
    }
    await this.rest(`/applications/${this.applicationId}/commands`, 'PUT', SLASH_COMMANDS);
  }

  async sendInteractionText(interaction: SlashInteraction, text: string): Promise<void> {
    if (!snowflake(interaction.id) || !snowflake(interaction.applicationId) || !interaction.token || interaction.token.length > 4096) {
      throw new Error('无效的 Discord 交互回复信息。');
    }
    const parts = chunks(text || '命令已完成。');
    const endpoint = `/webhooks/${interaction.applicationId}/${encodeURIComponent(interaction.token)}`;
    for (let index = 0; index < parts.length; index++) {
      await this.interactionRest(index === 0 ? `${endpoint}/messages/@original` : endpoint,
        index === 0 ? 'PATCH' : 'POST', { content: parts[index], allowed_mentions: { parse: [] } });
    }
  }

  async downloadImages(message: IncomingDM): Promise<string[]> {
    if (this.closed) throw new Error('Discord transport 已关闭。');
    const images = message.attachments.flatMap(attachment => {
      const extension = imageExtension(attachment);
      return extension ? [{ attachment, extension, url: attachmentUrl(attachment.url) }] : [];
    });
    const maxTotal = this.options.maxTotalImageBytes ?? Math.min(this.config.maxImageBytes * 10, 100 * 1024 * 1024);
    if (images.length > (this.options.maxImages ?? 10)) throw new Error('单条消息的图片数量超过上限。');
    let declaredBytes = 0;
    for (const { attachment } of images) {
      if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > this.config.maxImageBytes) {
        throw new Error('图片大小超过上限或附件信息无效。');
      }
      declaredBytes += attachment.size;
    }
    if (declaredBytes > maxTotal) throw new Error('单条消息的图片总大小超过上限。');
    const downloaded: string[] = [];
    let actualTotal = 0;
    try {
      if (images.length) await mkdir(this.config.attachmentsDir, { recursive: true });
      for (const image of images) {
        const result = await this.downloadImage(image.url, image.extension, maxTotal - actualTotal);
        actualTotal += result.bytes;
        downloaded.push(result.path);
      }
      return downloaded;
    } catch (error) {
      await Promise.all(downloaded.map(path => unlink(path).catch(() => undefined)));
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdown.abort();
    this.clearConnectionTimers();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.readyTimer);
    this.rejectReady?.(new Error('Discord transport 已关闭。'));
    this.rejectReady = undefined;
    this.resolveReady = undefined;
    this.ws?.terminate();
    this.ws = undefined;
    this.gatewayAgent?.destroy();
    await Promise.allSettled([
      this.restDispatcher?.destroy(), this.cdnDispatcher?.destroy(),
    ]);
  }

  private log(message: string): void {
    (this.options.logger ?? console.log)(`[Discord] ${message}`);
  }

  private fail(error: Error): void {
    this.log(error.message);
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    void this.close();
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    try {
      if (!this.gatewayUrl) {
        const data = await this.rest('/gateway/bot', 'GET');
        if (!record(data) || typeof data.url !== 'string') throw new Error('无效的 Gateway 地址。');
        const url = new URL(data.url);
        if (url.protocol !== 'wss:' || !url.hostname.endsWith('.discord.gg')) throw new Error('无效的 Gateway 地址。');
        this.gatewayUrl = data.url;
      }
      if (this.closed) return;
      const url = new URL(this.sessionId && this.resumeUrl ? this.resumeUrl : this.gatewayUrl);
      url.searchParams.set('v', '10');
      url.searchParams.set('encoding', 'json');
      const socket = (this.options.webSocketFactory ?? ((address, settings) => new WebSocket(address, settings)))(
        url.toString(), { agent: this.gatewayAgent, handshakeTimeout: 30_000, maxPayload: 2 * 1024 * 1024 },
      );
      this.ws = socket;
      socket.on('message', raw => {
        if (this.ws !== socket || this.closed) return;
        try { this.packet(socket, JSON.parse(raw.toString()) as unknown); }
        catch { this.log('Gateway 消息格式异常，重新连接。'); this.reconnect(socket); }
      });
      socket.on('error', () => {
        if (this.ws === socket && !this.closed) this.log('Gateway 连接出错，等待重新连接。');
      });
      socket.on('close', code => {
        if (this.ws !== socket) return;
        this.ws = undefined;
        this.clearConnectionTimers();
        if (this.closed) return;
        if (fatalGatewayCodes.has(code)) {
          this.fail(new Error(`Discord Gateway 拒绝连接（${code}），请检查 Bot 凭据和配置。`));
          return;
        }
        if ([1000, 1001, 4007, 4009].includes(code)) this.clearSession();
        this.scheduleReconnect();
      });
      this.protocolTimer = setTimeout(() => this.reconnect(socket), 30_000);
    } catch (error) {
      if (error instanceof DiscordRestError && [401, 403].includes(error.status)) {
        this.fail(new Error(`Discord 身份验证失败（HTTP ${error.status}），请检查 Bot 凭据。`));
      } else if (!this.closed) { this.log('Discord 连接失败，将自动重试。'); this.scheduleReconnect(); }
    } finally { this.connecting = false; }
  }

  private clearSession(): void {
    this.sessionId = undefined;
    this.resumeUrl = undefined;
    this.sequence = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const base = this.options.reconnectBaseMs ?? 1000;
    const cap = this.options.reconnectMaxMs ?? 30_000;
    const random = (this.options.random ?? Math.random)();
    const wait = this.nextReconnectDelay ?? Math.min(cap, base * 2 ** Math.min(this.reconnectAttempt++, 10)) * (0.8 + random * 0.4);
    this.nextReconnectDelay = undefined;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, wait);
  }

  private reconnect(socket: WebSocket, wait?: number): void {
    if (this.ws !== socket || this.closed) return;
    this.nextReconnectDelay = wait;
    this.clearConnectionTimers();
    socket.terminate(); // Keep the resumable session; codes 1000/1001 would invalidate it.
  }

  private clearConnectionTimers(): void {
    clearTimeout(this.heartbeat);
    clearTimeout(this.protocolTimer);
    clearTimeout(this.identifyTimer);
    this.heartbeat = undefined;
    this.protocolTimer = undefined;
    this.identifyTimer = undefined;
  }

  private sendPacket(socket: WebSocket, op: number, data: unknown): void {
    if (this.ws === socket && !this.closed && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op, d: data }));
    }
  }

  private packet(socket: WebSocket, value: unknown): void {
    if (!record(value) || typeof value.op !== 'number') return;
    if (value.op === 11) { this.heartbeatAcknowledged = true; return; }
    if (value.op === 1) {
      this.heartbeatAcknowledged = false;
      this.sendPacket(socket, 1, this.sequence);
      return;
    }
    if (value.op === 7) { this.reconnect(socket); return; }
    if (value.op === 9) {
      if (value.d !== true) this.clearSession();
      this.reconnect(socket, this.options.invalidSessionDelayMs ?? 1000 + (this.options.random ?? Math.random)() * 4000);
      return;
    }
    if (value.op === 10) {
      if (!record(value.d) || typeof value.d.heartbeat_interval !== 'number' ||
          !Number.isFinite(value.d.heartbeat_interval) || value.d.heartbeat_interval <= 0) {
        this.reconnect(socket); return;
      }
      this.clearConnectionTimers();
      this.heartbeatAcknowledged = true;
      const interval = value.d.heartbeat_interval;
      const beat = () => {
        if (this.ws !== socket || this.closed) return;
        if (!this.heartbeatAcknowledged) { this.reconnect(socket); return; }
        this.heartbeatAcknowledged = false;
        this.sendPacket(socket, 1, this.sequence);
        this.heartbeat = setTimeout(beat, interval);
      };
      this.heartbeat = setTimeout(beat, interval * (this.options.random ?? Math.random)());
      const identify = () => {
        if (this.sessionId && this.sequence !== null) {
          this.sendPacket(socket, 6, { token: this.config.token, session_id: this.sessionId, seq: this.sequence });
        } else {
          this.lastIdentifyAt = Date.now();
          this.sendPacket(socket, 2, {
            token: this.config.token, intents: 4096,
            properties: { os: process.platform, browser: 'discord-agent-bridge', device: 'discord-agent-bridge' },
          });
        }
      };
      const identifyWait = this.sessionId ? 0 : Math.max(0, this.lastIdentifyAt + (this.options.identifyIntervalMs ?? 5000) - Date.now());
      this.identifyTimer = setTimeout(identify, identifyWait);
      this.protocolTimer = setTimeout(() => this.reconnect(socket), 60_000 + identifyWait);
      return;
    }
    if (value.op !== 0) return;
    if (typeof value.s === 'number' && Number.isSafeInteger(value.s) && value.s >= 0) this.sequence = value.s;
    if (!record(value.d)) return;
    if (value.t === 'READY') {
      const user = value.d.user;
      if (typeof value.d.session_id !== 'string' || !record(user) || !snowflake(user.id) || typeof user.username !== 'string') {
        this.reconnect(socket); return;
      }
      this.sessionId = value.d.session_id;
      if (typeof value.d.resume_gateway_url === 'string') {
        const resume = new URL(value.d.resume_gateway_url);
        if (this.options.gatewayUrl || (resume.protocol === 'wss:' && resume.hostname.endsWith('.discord.gg'))) {
          this.resumeUrl = resume.toString();
        }
      }
      this.botUser = { id: user.id, username: user.username };
      if (record(value.d.application) && snowflake(value.d.application.id)) this.applicationId = value.d.application.id;
      this.log(`已连接：${user.username}（${user.id}）。`);
      this.ready();
    } else if (value.t === 'RESUMED') {
      this.log('会话已续接。');
      this.ready();
    } else if (value.t === 'MESSAGE_CREATE') {
      this.incoming(value.d);
    } else if (value.t === 'INTERACTION_CREATE') {
      void this.incomingInteraction(value.d).catch(() => this.log('斜杠命令处理失败，未输出交互凭据。'));
    }
  }

  private ready(): void {
    clearTimeout(this.readyTimer);
    clearTimeout(this.protocolTimer);
    this.reconnectAttempt = 0;
    this.resolveReady?.();
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  private incoming(data: RecordValue): void {
    const author = data.author;
    if (data.guild_id != null || data.webhook_id != null || !record(author) || author.bot === true ||
        !snowflake(author.id) || !this.allowedUsers.has(author.id) || !snowflake(data.id) ||
        !snowflake(data.channel_id) || this.seenMessages.has(data.id)) return;
    this.seenMessages.add(data.id);
    if (this.seenMessages.size > 5000) this.seenMessages.delete(this.seenMessages.values().next().value!);
    const attachments: DiscordAttachment[] = [];
    if (Array.isArray(data.attachments)) {
      for (const item of data.attachments) {
        if (record(item) && typeof item.id === 'string' && typeof item.filename === 'string' &&
            typeof item.url === 'string' && typeof item.size === 'number') {
          attachments.push({ id: item.id, filename: item.filename, url: item.url, size: item.size,
            ...(typeof item.content_type === 'string' ? { content_type: item.content_type } : {}) });
        }
      }
    }
    const message: IncomingDM = {
      id: data.id, userId: author.id, channelId: data.channel_id,
      text: typeof data.content === 'string' ? data.content : '', attachments,
    };
    // Agent turns must never block Gateway heartbeats or subsequent incoming commands.
    void this.deliverInOrder(message).catch(async () => {
      this.log('私聊消息处理失败。');
      if (!this.closed) {
        await this.sendText(message.channelId, '这条消息处理失败，请稍后再试。').catch(() => this.log('错误反馈发送失败。'));
      }
    });
  }

  private async incomingInteraction(data: RecordValue): Promise<void> {
    if (data.type !== 2 || !snowflake(data.id) || !snowflake(data.application_id)
      || typeof data.token !== 'string' || !data.token || data.token.length > 4096
      || this.seenInteractions.has(data.id)) return;
    this.seenInteractions.add(data.id);
    if (this.seenInteractions.size > 5000) this.seenInteractions.delete(this.seenInteractions.values().next().value!);
    const endpoint = `/interactions/${data.id}/${encodeURIComponent(data.token)}/callback`;
    const reject = (content: string) => this.interactionRest(endpoint, 'POST',
      { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } }, true);
    const user = data.user;
    const channel = record(data.channel) ? data.channel : undefined;
    const channelId = snowflake(data.channel_id) ? data.channel_id : channel?.id;
    const botDM = data.context === 1 || (data.context == null && channel?.type === 1);
    if (data.guild_id != null || !botDM || (channel?.type != null && channel.type !== 1)
      || !record(user) || user.bot === true || !snowflake(user.id) || !this.allowedUsers.has(user.id)
      || !snowflake(channelId) || (this.applicationId && data.application_id !== this.applicationId)) {
      await reject('这些命令仅供已授权用户在机器人的私聊中使用。'); return;
    }
    const parsed = slashText(data.data);
    if ('error' in parsed) { await reject(parsed.error); return; }
    const interaction: SlashInteraction = { id: data.id, token: data.token, applicationId: data.application_id };
    const message: IncomingDM & { interaction: SlashInteraction } = {
      id: data.id, userId: user.id, channelId, text: parsed.text, attachments: [], interaction,
    };
    let acknowledged!: Promise<void>;
    // Reserve the arrival position before starting the network request, so text cannot overtake it.
    const delivered = this.deliverInOrder(message, () => acknowledged);
    void delivered.catch(() => undefined);
    // ACK bypasses the ordinary channel queue/rate-limit wait: Discord requires it within 3 seconds.
    // No command may mutate state until this response succeeds.
    acknowledged = this.interactionRest(endpoint, 'POST', { type: 5 }, true);
    void acknowledged.catch(() => undefined);
    await acknowledged;
    try { await delivered; }
    catch {
      this.log('斜杠命令执行失败。');
      if (!this.closed) await this.sendInteractionText(interaction, '这条命令处理失败，请稍后重试。')
        .catch(() => this.log('斜杠命令错误反馈发送失败。'));
    }
  }

  private deliverInOrder(message: IncomingDM, before: () => Promise<void> = () => Promise.resolve()): Promise<void> {
    const previous = this.deliveryQueues.get(message.userId) ?? Promise.resolve();
    let handled: Promise<void> = Promise.resolve();
    const delivered = previous.catch(() => undefined).then(async () => {
      await before();
      if (this.closed) return;
      // Preserve onMessage invocation order; its own OrderedInbox controls preparation/processing.
      handled = Promise.resolve().then(() => this.onMessage(message));
      void handled.catch(() => undefined);
    });
    this.deliveryQueues.set(message.userId, delivered);
    return delivered.finally(() => {
      if (this.deliveryQueues.get(message.userId) === delivered) this.deliveryQueues.delete(message.userId);
    }).then(() => handled);
  }

  /** Interaction callback/webhook tokens authorize these requests; never attach the bot credential. */
  private async interactionRest(path: string, method: 'POST' | 'PATCH', body: unknown, initial = false): Promise<void> {
    for (let attempt = 0; attempt < (initial ? 1 : 10); attempt++) {
      if (this.closed) throw new Error('Discord transport 已关闭。');
      let response;
      try {
        response = await this.httpFetch(`${this.restBase}${path}`, {
          method, dispatcher: this.restDispatcher, redirect: 'error',
          signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(initial ? 2000 : 30_000)]),
          headers: { 'content-type': 'application/json', 'user-agent': 'DiscordBot (https://github.com/discord/discord-api-docs, 0.1.0)' },
          body: JSON.stringify(body),
        });
      } catch { throw new Error('Discord 交互网络请求失败。'); }
      let data: unknown;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        if (response.status === 429 && !initial) {
          const seconds = record(data) && typeof data.retry_after === 'number' ? data.retry_after : Number(response.headers.get('retry-after'));
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) throw new Error('Discord 交互限流等待时间无效。');
          await delay(Math.max(50, seconds * 1000), undefined, { signal: this.shutdown.signal });
          continue;
        }
        throw new DiscordRestError(response.status);
      }
      return;
    }
    throw new Error('Discord 交互持续限流，请稍后重试。');
  }

  private async rest(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown, channelId?: string,
    attachments?: PreparedAttachment[], turnSignal?: AbortSignal): Promise<unknown> {
    const cancel = turnSignal ? AbortSignal.any([this.shutdown.signal, turnSignal]) : this.shutdown.signal;
    let localWaitUntil = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (this.closed) throw new Error('Discord transport 已关闭。');
      cancel.throwIfAborted();
      const wait = Math.max(this.globalWaitUntil, localWaitUntil, channelId ? this.channelWaitUntil.get(channelId) ?? 0 : 0) - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal: cancel });
      cancel.throwIfAborted();
      let form: FormData | undefined;
      if (attachments?.length) {
        // Rebuild multipart for every attempt; a consumed request body is never reused.
        form = new FormData();
        form.set('payload_json', JSON.stringify(body));
        attachments.forEach((attachment, index) => form!.append(`files[${index}]`, attachment.blob, attachment.filename));
      }
      const requestSignal = AbortSignal.any([cancel, AbortSignal.timeout(30_000)]);
      const response = await this.httpFetch(`${this.restBase}${path}`, {
        method, dispatcher: this.restDispatcher,
        signal: requestSignal, redirect: 'error',
        headers: { authorization: `Bot ${this.config.token}`, ...(form ? {} : { 'content-type': 'application/json' }),
          'user-agent': 'DiscordBot (https://github.com/discord/discord-api-docs, 0.1.0)' },
        ...(body === undefined ? {} : { body: form ?? JSON.stringify(body) }),
      });
      let data: unknown;
      try { data = await response.json(); } catch { data = null; }
      requestSignal.throwIfAborted();
      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after');
        const seconds = record(data) && typeof data.retry_after === 'number' ? data.retry_after :
          retryHeader === null ? NaN : Number(retryHeader);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) throw new Error('Discord 限流等待时间无效。');
        const until = Date.now() + Math.max(50, seconds * 1000);
        if (record(data) && data.global === true) this.globalWaitUntil = Math.max(this.globalWaitUntil, until);
        else if (channelId) this.channelWaitUntil.set(channelId, until);
        else localWaitUntil = until;
        continue;
      }
      if (!response.ok) throw new DiscordRestError(response.status);
      if (channelId && response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(response.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(reset) && reset > 0 && reset <= 300) this.channelWaitUntil.set(channelId, Date.now() + reset * 1000);
      }
      return data;
    }
    throw new Error('Discord 多次限流，请稍后再试。');
  }

  private async downloadImage(url: URL, extension: string, remaining: number): Promise<{ path: string; bytes: number }> {
    let response: Awaited<ReturnType<typeof fetch>> | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await this.httpFetch(url, { dispatcher: this.cdnDispatcher,
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(60_000)]), redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('图片下载重定向过多或无效。');
      url = attachmentUrl(new URL(location, url).toString());
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel();
      throw new Error(`图片下载失败（HTTP ${response?.status ?? 0}）。`);
    }
    const limit = Math.min(this.config.maxImageBytes, remaining);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > limit) {
      await response.body.cancel();
      throw new Error('图片实际大小超过上限。');
    }
    const path = join(this.config.attachmentsDir, `${randomUUID()}.${extension}`);
    const temporary = `${path}.part`;
    let file;
    try { file = await open(temporary, 'wx'); }
    catch (error) { await response.body.cancel(); throw error; }
    let bytes = 0;
    let header = Buffer.alloc(0);
    let complete = false;
    try {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          const buffer = Buffer.from(part.value);
          bytes += buffer.length;
          if (bytes > limit) throw new Error('图片实际大小超过上限。');
          if (header.length < 12) header = Buffer.concat([header, buffer.subarray(0, 12 - header.length)]);
          await file.writeFile(buffer);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!validImage(header, extension)) throw new Error('附件内容不是声明的图片格式。');
      await file.close();
      await rename(temporary, path);
      complete = true;
      return { path, bytes };
    } finally {
      if (!complete) { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
    }
  }
}
