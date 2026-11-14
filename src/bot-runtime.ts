import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { prepareConfigPaths, safeError, redactText } from './config.js';
import { prepareIncomingMessage } from './forwarded.js';
import { PlatformTransport } from './platform.js';
import { DurableIngress, type DMHistoryOptions, type DMHistoryPage } from './ingress.js';
import { closeResources } from './shutdown.js';
import { BridgeLifecycle } from './lifecycle.js';
import { mapPresentation } from './presentation.js';
import { ControllerCore, type ControllerCoreHooks, type ControllerCoreDependencies } from './controller/core.js';
import type { BridgeConfig, IncomingDM, ReplyOptions } from './types.js';

export interface BotRuntimeHooks extends ControllerCoreHooks {
  receiveGroup(message: IncomingDM): Promise<void>;
  allowDelivery(channelId: string): boolean;
  isGroupChannel?(channelId: string): boolean;
  onReady(): void;
  onReconnect?(): Promise<void>;
}
export type BotTransport = Pick<PlatformTransport, Exclude<keyof PlatformTransport, 'downloadFiles'>> & Partial<Pick<PlatformTransport, 'downloadFiles'>>;
export interface BotRuntimeDependencies extends ControllerCoreDependencies {
  createTransport?: (config: BridgeConfig, receive: (message: IncomingDM) => Promise<void>, hooks: ConstructorParameters<typeof PlatformTransport>[2]) => BotTransport;
}

/** Channel admission and delivery only; controller state belongs to ControllerCore. */
export class BotRuntime {
  readonly core: ControllerCore;
  readonly transport: BotTransport;
  readonly ingress: DurableIngress;
  private readonly lifecycle: BridgeLifecycle;
  private readonly channelConfig: BridgeConfig;
  private guard?: Server;
  private closed=false;
  private ready=false;
  private verified=false;
  private verifyPromise?:Promise<void>;
  private startPromise?:Promise<void>;
  private closePromise?:Promise<void>;
  private reconnecting?:Promise<void>;
  private lagTimer?:ReturnType<typeof setInterval>;
  private readonly revisions=new Map<string,number>();
  private readonly stamps=new Map<string,number>();
  private readonly secrets:string[];
  get manager(){return this.core.manager;}
  get controller(){return this.core.controller;}
  get tasks(){return this.core.tasks;}
  get housekeeper(){return this.core.housekeeper;}
  constructor(readonly config:BridgeConfig,private readonly hooks:BotRuntimeHooks,dependencies:BotRuntimeDependencies={}) {
    if(!hooks.manager.binding)throw new Error('ControllerCore 必须使用已登记主控的会话绑定。');
    if(!config.channelDataDir)throw new Error('渠道必须登记独立的 channelDataDir。');
    this.channelConfig={...config,dataDir:config.channelDataDir,proxyUrl:config.channelProxyUrl ?? null};
    if(config.controllerUserId && !config.channelOwnerUserId)throw new Error('渠道必须登记真实的 channelOwnerUserId。');
    prepareConfigPaths(this.channelConfig);
    this.secrets=[config.token,config.appSecret ?? ''];
    this.transport = (dependencies.createTransport ?? ((selected, receive, events) => new PlatformTransport(selected, receive, events)))(this.channelConfig, async message => {
      if (this.closed || hooks.isDraining()) return;
      if (message.space) { await hooks.receiveGroup(message); return; }
      if (!hooks.isGroupChannel?.(message.channelId) && hooks.authorize(message.userId, message.text)) await this.ingress.receive(message);
    }, {
      logger: message => this.log(message),
      onReceive: message => !this.closed && !message.space && !hooks.isGroupChannel?.(message.channelId) && hooks.authorize(message.userId, message.text) ? this.ingress.capture(message) : false,
      onReady: async () => {
        if (this.ready && !this.closed && !hooks.isDraining()) await this.recoverTransport();
      },
    });
    this.core=new ControllerCore(config,{...hooks,invoke:(...args)=>hooks.invoke(...args),log:message=>this.log(message)},{
      sendText:(channel,text,options)=>this.send(channel,text,options),
      markReplyDelivered:messages=>this.transport.markReplyDelivered(messages),
      setTaskCount:(message,count)=>this.transport.setTaskCount(message,count),
      setWorkCounts:counts=>this.transport.setWorkCounts(counts),
      isReady:()=>this.isReady(),
    },dependencies);
    const control = (message: IncomingDM) => /^(?:\/(?:stop|new|cwd)(?:\s|$)|\/agent\s+\S|new\s+chat$|新会话$|新聊天$)/i.test(message.text.trim());
    this.ingress = new DurableIngress(this.channelConfig.dataDir, {
      allowedUserIds: config.allowedUserIds, hasMessage: id => this.manager.hasMessage(id), isImmediate: control,
      onQueued: (message, replayOnly) => { const n = (this.revisions.get(message.userId) ?? 0) + (control(message) ? 1 : 0);
        this.manager.privateInputQueued(this.controllerMessage(message));
        this.revisions.set(message.userId, n); if (!replayOnly) this.stamps.set(message.id, n); },
      handle: async message => {
        const workersCommand = /^\/workers(?:\s|$)/i.test(message.text.trim());
        const began = performance.now();
        if (workersCommand) this.log('WORKERS_INPUT stage=handler');
        try {
          if (!this.ready || this.closed || hooks.isDraining() || hooks.isGroupChannel?.(message.channelId) || !hooks.authorize(message.userId, message.text)) return;
          const current = () => control(message) || this.stamps.get(message.id) === (this.revisions.get(message.userId) ?? 0);
          const content = current() && !control(message) ? await prepareIncomingMessage(this.transport, message) : { text: message.text, imagePaths: [] };
          const prepared = { id: message.id, userId: config.controllerUserId ?? message.userId, channelId: message.channelId, text: content.text,
            source: { messageId: message.id, userId: message.userId, channelId: message.channelId, authorType: 'user' as const, ...message.source },
            imagePaths: content.imagePaths };
          if (!current()) { this.manager.discard(prepared); return; }
          if (workersCommand) this.log(`WORKERS_INPUT stage=prepared ms=${Math.round(performance.now() - began)}`);
          await this.manager.handle(prepared, message.interaction ? (text, options) => this.transport.sendInteractionText(message.interaction!, text, options) : undefined);
        } finally { this.stamps.delete(message.id); }
      },
      onError: (message, error) => { this.log('INGRESS ' + safeError(error, this.secrets));
        if (!this.closed) void this.manager.reportInputFailure({ ...this.controllerMessage(message), imagePaths: [] }, error, true, () => this.send(message.channelId, this.transport.failureText(error))).catch(() => undefined); },
    });
    this.lifecycle = new BridgeLifecycle(this.channelConfig, event => this.transport.onBridgeLifecycle(event), () => {
      const contact = this.ingress.lastAuthorizedContact();
      return contact && !hooks.isGroupChannel?.(contact.channelId) && hooks.authorize(contact.userId, '') ? contact : undefined;
    }, error => this.log('LIFECYCLE_NOTICE_FAILED ' + safeError(error, this.secrets)));
  }
  log(message:string):void {appendFileSync(join(this.config.logsDir,'bridge.log'),`${new Date().toISOString()} ${safeError(message,this.secrets)}\n`);}
  isReady():boolean{return this.ready && !this.closed;}
  confirmControllerStopped(conversationId:string):Promise<boolean>{return this.core.confirmControllerStopped(conversationId);}
  private readDMHistory(channel: string, options: DMHistoryOptions): Promise<DMHistoryPage> {
    if (this.hooks.isGroupChannel?.(channel)) {
      this.log('IGNORED_LEGACY_GROUP_DM_CURSOR');
      return Promise.resolve({ messages: [], oldestId: null, newestId: null, hasMore: false });
    }
    return this.transport.readDMHistory(channel, options);
  }
  private async recoverTransport(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    const work = (async () => {
      await this.ingress.recover((channel, options) => this.readDMHistory(channel, options));
      if (this.isReady() && !this.hooks.isDraining()) await this.hooks.onReconnect?.();
    })();
    this.reconnecting = work;
    try { await work; } finally { if (this.reconnecting === work) this.reconnecting = undefined; }
  }
  private async failed(error: unknown): Promise<never> {
    await this.transport.onBridgeLifecycle({ phase: 'failed' }).catch(failure => this.log('LIFECYCLE_FAILED ' + safeError(failure, this.secrets)));
    try { await this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Bot 启动失败，部分资源停止尚未确认。'); }
    throw error;
  }
  verify(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Bot 已关闭，不能重新验证。'));
    return this.verifyPromise ??= this.verifyOnce().catch(error => this.failed(error));
  }
  private async verifyOnce(): Promise<void> {
    const identity = await this.transport.verifyIdentity();
    if (identity !== this.config.applicationId) throw new Error('平台凭据与登记的 Bot 应用身份不一致。');
    if (this.closed) throw new Error('Bot 验证期间已关闭。');
    const guard = this.guard = createServer(socket => socket.destroy());
    const key = createHash('sha256').update(this.config.botId!).digest('hex').slice(0, 24);
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\agent-bridge-bot-${key}` : join(this.channelConfig.dataDir, `bridge-${key}.sock`);
    await new Promise<void>((resolve, reject) => { guard.once('error', reject); guard.listen(address, resolve); });
    this.verified = true;
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Bot 已关闭，不能重新启动。'));
    return this.startPromise ??= this.startOnce().catch(error => this.failed(error));
  }
  private async startOnce(): Promise<void> {
    if (!this.verified) throw new Error('Bot 必须先验证真实身份并取得独占锁。');
    // Seed before opening the socket: an early live message must not advance over the outage gap.
    this.seedDMChannels();
    await this.transport.onBridgeLifecycle({ phase: 'recovering' });
    await this.transport.start();
    if (this.closed) throw new Error('Bot 启动期间已关闭。');
    await this.core.recover();
    this.seedDMChannels();
    await this.ingress.recover((channel, options) => this.readDMHistory(channel, options));
    if (this.closed) throw new Error('Bot 恢复期间已关闭。');
    this.ready = true;
    let lastTick = performance.now();
    this.lagTimer = setInterval(() => { const now = performance.now(), lag = now - lastTick - 1000; lastTick = now;
      if (lag >= 1000) this.log(`EVENT_LOOP_LAG ms=${Math.round(lag)}`); }, 1000);
    this.lagTimer.unref();
    const coreStarted=this.core.start(); this.ingress.start(); await coreStarted;
    if (this.config.features?.nativeCommands !== false) {
      try { await this.transport.syncSlashCommands(); this.log('SLASH_COMMANDS_SYNCED'); }
      catch (error) { this.log('SLASH_COMMANDS_FAILED ' + safeError(error, this.secrets)); }
    }
    this.log(`READY bot=${this.transport.botUser?.username ?? this.config.botId} agent=${this.config.defaultAgent}`);
    this.hooks.onReady();
  }
  private controllerMessage(message:IncomingDM):IncomingDM {
    return {...message,userId:this.config.controllerUserId ?? message.userId,source:message.source ?? {messageId:message.id,userId:message.userId,channelId:message.channelId,authorType:'user'}};
  }
  private seedDMChannels(): void {
    for(const channel of this.manager.knownDMChannels()) {
      const actual={...channel,userId:channel.userId===this.config.controllerUserId?this.config.channelOwnerUserId!:channel.userId};
      if(!this.hooks.isGroupChannel?.(actual.channelId) && this.hooks.authorize(actual.userId,''))this.ingress.seedChannel(actual);
    }
  }
  /** Called once after the shared host recovery; reconnects never publish startup notices. */
  publishReadyLifecycle(): Promise<void> { return this.isReady() ? this.lifecycle.ready() : Promise.resolve(); }
  async send(channel: string, text: string, options?: ReplyOptions): Promise<void> {
    if (this.closed) throw new Error('Bot 已关闭，回复保留在原入口。');
    if (!this.hooks.allowDelivery(channel)) throw new Error('原投递目的地当前不可用；结果保留，不改投其他入口。');
    await this.transport.sendText(channel, redactText(text, this.secrets), options ? { ...options,
      ...(options.presentation ? { presentation: mapPresentation(options.presentation, s => redactText(s, this.secrets)) } : {}) } : undefined);
  }
  beginDrain(): void { this.ingress.pause(); this.core.beginDrain(); }
  isIdle(): boolean { return this.core.isIdle() && this.transport.isIdle(); }
  close():Promise<void>{
    if(this.closePromise)return this.closePromise;
    this.closed=true;this.ready=false;clearInterval(this.lagTimer);
    this.closePromise=closeResources([
      {name:'通信平台',close:()=>this.transport.close()},
      {name:'收件',close:()=>this.ingress.close()},
      {name:'主控核心',close:()=>this.core.close()},
      {name:'生命周期',close:()=>this.lifecycle.close()},
      {name:'Bot独占锁',close:()=>new Promise<void>((resolve,reject)=>{
        if(!this.guard?.listening){resolve();return;}
        this.guard.close(error=>error?reject(error):resolve());
      })},
    ]);
    return this.closePromise;
  }
}
