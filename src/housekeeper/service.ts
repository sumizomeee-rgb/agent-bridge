import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { harnessText } from '../harness.js';
import type { BridgeConfig, BridgeMessage, Conversation } from '../types.js';
import type { TaskCompletionEvent } from '../tasks.js';
import type { ControllerJob } from '../controller/runtime-types.js';
import { HousekeeperStore, type HousekeeperRun, type HousekeeperState } from './store.js';
import { scanTransactionSources, type TransactionSnapshot } from './sources.js';

export interface HousekeeperCallbacks {
  active(userId: string): Conversation | null;
  dispatch(runId: string, state: HousekeeperState, prompt: string): Promise<{ workerId: string; jobId: string }>;
  job(jobId: string): ControllerJob | null;
  recoverRun?(run: HousekeeperRun): { workerId: string; jobId: string } | null;
  eventForJob?(jobId: string): TaskCompletionEvent | null;
  cancel(workerId: string): Promise<void>;
  event(id: string): { state: string | null; processed: boolean; safeToRetry?: true };
  reroute(run: HousekeeperRun, state: HousekeeperState): Promise<{ taskId: string; eventId: string; conversationId: string }>;
  retireEvent(id: string): void;
  wake(): void;
  notify(state: HousekeeperState, text: string, key: string): Promise<void>;
  onError(error: unknown): void;
  isPaused(): boolean;
  now?(): number;
  scan?: typeof scanTransactionSources;
}

/** The service schedules and hands off evidence; only the controller decides actions. */
export class HousekeeperService {
  readonly store: HousekeeperStore;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private closed = false;
  private started = false;
  private paused = false;
  private readonly abort = new AbortController();
  constructor(private readonly config: BridgeConfig, private readonly callbacks: HousekeeperCallbacks) {
    this.store = new HousekeeperStore(config.dataDir);
  }
  private now(): number { return this.callbacks.now?.() ?? Date.now(); }
  private time(): string { return new Date(this.now()).toISOString(); }
  private authorized(userId: string): boolean {
    return userId === (this.config.ownerUserId ?? this.config.allowedUserIds[0]);
  }
  async command(message: BridgeMessage, argument: string): Promise<string> {
    if (!this.authorized(message.userId)) return '事务巡视仅由本 Bot 的主人设置。';
    const [action = 'status', extra] = argument.trim().split(/\s+/).filter(Boolean);
    if (extra || !['on', 'off', 'status'].includes(action)) return '用法：/housekeeper on|off|status。默认关闭，开启后立即检查，此后每20分钟巡视。';
    const current = this.store.read();
    if (action === 'status') return this.status(current);
    if (action === 'off') {
      if (!current) return '事务巡视已关闭。';
      current.enabled = false; this.store.save(current);
      this.recoverIdentity(current);
      if (current.run?.eventId) this.callbacks.retireEvent(current.run.eventId);
      if (current.run?.workerId) await this.callbacks.cancel(current.run.workerId);
      return '事务巡视已关闭；停止后续巡视，正在总结的助手已请求取消。主控已开展的其他任务继续。';
    }
    if (current?.enabled) return '事务巡视已开启，保持原开启时间和消费进度。\n' + this.status(current);
    if (current?.run && !this.canReplaceRun(current)) return '事务巡视保持关闭：上一轮摘要助手尚未确认停止或提交仍在处理中，保留原执行登记，未重复启动。主控和其他任务可继续；稍后再开启或用 /housekeeper off 重试停止。';
    const now = this.time();
    const value: HousekeeperState = { version: 1, enabled: true, epoch: randomUUID(), intervalMinutes: 20,
      userId: message.userId, channelId: message.channelId, authorizationMessageId: message.id,
      enabledAt: now, nextAt: now, failures: 0 };
    // A new enable interval starts at this owner command. Previous raw data is preserved.
    this.store.save(value); this.kick();
    return '事务巡视已开启：立即检查一次，此后每20分钟检查开启后的增量。使用笔记本当前默认助手，只总结给主控；是否跟进或通知由主控判断。跨 /new 和桥重启保留。';
  }
  status(value = this.store.read()): string {
    if (!value) return '事务巡视：关闭（默认）。\n/housekeeper on 开启；/housekeeper off 关闭。';
    return [`事务巡视：${value.enabled ? '开启' : '关闭'} · ${value.intervalMinutes}分钟`,
      `开启时间：${value.enabledAt}；下一次：${value.enabled ? value.nextAt : '已关闭'}`,
      `本轮：${value.run?.phase ?? '空闲'}；最近成功：${value.lastSuccessAt ?? '尚无'}`,
      ...(value.lastCoverage ? [value.lastCoverage] : []), ...(value.lastError ? [`最近问题：${value.lastError}`] : [])].join('\n');
  }
  start(): void { if (!this.closed) { this.started = true; this.kick(); } }
  beginDrain(): void { this.paused = true; clearTimeout(this.timer); }
  isIdle(): boolean { return !this.polling; }
  private kick(): void {
    if (!this.started || this.closed || this.paused) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.poll().catch(error => this.callbacks.onError(error)).finally(() => this.arm()); }, 0);
    this.timer.unref();
  }
  private arm(): void {
    if (!this.started || this.closed || this.paused) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.poll().catch(error => this.callbacks.onError(error)).finally(() => this.arm()); }, 2000);
    this.timer.unref();
  }
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.closed || this.paused || this.callbacks.isPaused()) return Promise.resolve();
    const work = this.pollOnce(); this.polling = work;
    void work.finally(() => { if (this.polling === work) this.polling = undefined; }).catch(() => undefined);
    return work;
  }
  private same(value: HousekeeperState): HousekeeperState | null {
    const current = this.store.read();
    return current?.enabled && current.epoch === value.epoch ? current : null;
  }
  /** Result receipt and CLI retirement are independent. A terminal label alone is not exit proof. */
  private stopped(job: ControllerJob | null): boolean {
    return job?.processStopped === true || (!!job?.nativeResult && job.processStopped !== false && job.nativeResult.processStopped !== false);
  }
  private recoverIdentity(value: HousekeeperState): void {
    const run = value.run; if (!run) return;
    if (run.jobId) {
      const job = this.callbacks.job(run.jobId);
      if (!run.workerId && job) { run.workerId = job.workerId; this.store.save(value); }
    } else {
      const recovered = this.callbacks.recoverRun?.(run);
      if (recovered) { Object.assign(run, recovered); if (run.phase === 'preparing') run.phase = 'worker'; this.store.save(value); }
    }
  }
  private canReplaceRun(value: HousekeeperState): boolean {
    if (!value.run) return true;
    if (value.run.phase === 'preparing' && this.polling) return false;
    this.recoverIdentity(value);
    if (value.run.jobId) return this.stopped(this.callbacks.job(value.run.jobId));
    // Only an exhausted preparation plus a durable lookup proving no dispatch can be replaced.
    return value.run.phase === 'preparing' && !value.run.workerId && !!this.callbacks.recoverRun && !this.polling;
  }
  private coverage(snapshot: TransactionSnapshot): string {
    return snapshot.sources.map(source => `${source.label ?? source.id}：${source.status}${source.error ? `（${source.error.slice(0, 180)}）` : ''}`).join('；');
  }
  private async failure(value: HousekeeperState, error: unknown, terminal = false, uncertainty: 'worker' | 'controller' = 'controller'): Promise<void> {
    const current = this.same(value); if (!current) return;
    current.lastError = String(error instanceof Error ? error.message : error).slice(0, 600);
    current.failures++; current.nextAt = new Date(this.now() + current.intervalMinutes * 60000).toISOString();
    if (terminal && current.run) { current.run.phase = 'uncertain'; current.run.error = current.lastError; current.run.uncertainty = uncertainty; delete current.run.retryAt; }
    else delete current.run;
    this.store.save(current);
    if ((terminal || current.failures >= 3) && current.notifiedError !== current.lastError) {
      await this.callbacks.notify(current, `事务巡视遇到问题：${current.lastError}\n原始内容和已取得的摘要保留，主控仍可正常使用。/housekeeper status 查看状态。`, 'housekeeper-error:' + current.epoch + ':' + current.failures);
      const latest = this.same(current); if (latest) { latest.notifiedError = current.lastError; this.store.save(latest); }
    }
  }
  /** Completion is routed through the existing durable controller-result path. */
  acceptCompletion(event: TaskCompletionEvent): boolean {
    const value = this.store.read(), run = value?.run;
    if (!value?.enabled || !run || event.purpose !== 'housekeeper' || event.userId !== value.userId
      || event.channelId !== value.channelId || event.originMessageId !== value.authorizationMessageId
      || !run.jobId || (event.taskId !== run.jobId && event.taskId !== run.taskId)) return false;
    if (event.status === 'completed') {
      run.phase = 'summary'; run.summary = event.text; run.taskId = event.taskId; run.eventId = event.id; run.eventConversationId = event.conversationId;
      this.store.save(value); this.callbacks.wake();
    } else {
      this.callbacks.retireEvent(event.id);
      const job = this.callbacks.job(run.jobId), handedOff = run.summary !== undefined || !!run.eventId;
      const uncertain = handedOff || job?.status === 'uncertain' || !this.stopped(job);
      void this.failure(value, '同步摘要助手未完成：' + event.text.slice(0, 300), uncertain, handedOff ? 'controller' : 'worker').catch(error => this.callbacks.onError(error));
    }
    return true;
  }
  validEvent(event: TaskCompletionEvent): boolean {
    const value = this.store.read();
    return value?.enabled === true && event.purpose === 'housekeeper' && value.run?.eventId === event.id
      && value.run.phase === 'summary' && value.userId === event.userId && value.channelId === event.channelId
      && value.authorizationMessageId === event.originMessageId && value.run.taskId === event.taskId;
  }
  eventText(event: TaskCompletionEvent): string {
    if (!this.validEvent(event)) throw new Error('事务摘要已关闭、失效或不属于本 Bot。');
    const run = this.store.read()!.run!;
    return harnessText('housekeeper.controller_event', { summary: event.text,
      window_start: run.snapshot.window.start, window_end: run.snapshot.window.end });
  }
  private async pollOnce(): Promise<void> {
    const value = this.store.read();
    if (!value?.enabled || !this.authorized(value.userId)) return;
    const active = this.callbacks.active(value.userId);
    if (!active?.nativeId || !active.controllerMode) return;
    if (value.run) {
      const run = value.run;
      if (run.phase === 'uncertain') {
        // Only a reader that never handed a summary to the controller can safely repeat its frozen input.
        if (run.uncertainty !== 'worker' || run.summary !== undefined || run.eventId || !run.jobId || !this.stopped(this.callbacks.job(run.jobId))) return;
        if (!run.retryAt) { run.retryAt = new Date(this.now() + value.intervalMinutes * 60000).toISOString(); value.nextAt = run.retryAt; this.store.save(value); return; }
        if (Date.parse(run.retryAt) > this.now()) return;
        try { await this.submit(value, active, run.snapshot); } catch (error) { await this.submissionFailure(value, error); }
        return;
      }
      if (run.phase === 'summary' && run.eventId) {
        if (run.retryAt) {
          if (Date.parse(run.retryAt) > this.now()) return;
          this.callbacks.retireEvent(run.eventId);
          try {
            const rebound = await this.callbacks.reroute(run, value), current = this.same(value);
            if (!current?.run || current.run.id !== run.id) { this.callbacks.retireEvent(rebound.eventId); return; }
            Object.assign(current.run, rebound, { eventConversationId: rebound.conversationId }); delete current.run.retryAt; delete current.run.error;
            this.store.save(current); this.callbacks.wake();
          } catch (error) { await this.deferSummary(value, error); }
          return;
        }
        const receipt = this.callbacks.event(run.eventId);
        if (receipt.processed) {
          // A processed summary may still have a CLI retiring in the background; never overlap readers.
          if (run.jobId && !this.stopped(this.callbacks.job(run.jobId))) return;
          value.cursor = run.snapshot.nextCursor; value.lastSuccessAt = this.time();
          value.lastCoverage = this.coverage(run.snapshot); value.failures = 0; delete value.lastError; delete value.notifiedError; delete value.run;
          value.nextAt = new Date(this.now() + (run.snapshot.hasMore ? 1000 : value.intervalMinutes * 60000)).toISOString(); this.store.save(value); return;
        }
        if (receipt.state === 'uncertain') {
          if (receipt.safeToRetry) await this.deferSummary(value, '主控准备阶段尚未提交摘要，已保留原摘要，20分钟后重试交付。');
          else await this.failure(value, '主控处理摘要期间中断，已保留摘要和消费进度，未重复提交可能已执行的操作。', true);
          return;
        }
        if (receipt.state === 'delivered' || receipt.state === null) {
          const rebound = await this.callbacks.reroute(run, value);
          const current = this.same(value); if (!current?.run) return;
          Object.assign(current.run, rebound, { eventConversationId: rebound.conversationId }); this.store.save(current); this.callbacks.wake();
        } else this.callbacks.wake();
        return;
      }
      if (run.phase === 'worker' && run.jobId) {
        const job = this.callbacks.job(run.jobId);
        if (!job) { await this.failure(value, '事务摘要执行记录缺失；消费进度未前移。', true, 'worker'); return; }
        if (job.status === 'uncertain') { await this.failure(value, '事务摘要助手退出尚未确认；保留原执行登记，未重复启动。', true, 'worker'); return; }
        if (job.status === 'completed' && job.result) {
          const event = this.callbacks.eventForJob?.(run.jobId);
          if (event) { this.acceptCompletion(event); return; }
          run.summary = job.result;
          const rebound = await this.callbacks.reroute(run, value);
          const current = this.same(value); if (!current?.run) return;
          Object.assign(current.run, rebound, { phase: 'summary', summary: job.result, eventConversationId: rebound.conversationId });
          this.store.save(current); this.callbacks.wake(); return;
        }
        if (['failed', 'cancelled'].includes(job.status)) await this.failure(value, '事务摘要助手本轮' + job.status + '，消费进度未前移。', !this.stopped(job), 'worker');
        return;
      }
      // Preparation contains no agent submission; after a restart it can be reconstructed safely.
      if (run.phase === 'preparing') {
        const recovered = this.callbacks.recoverRun?.(run);
        if (recovered) { Object.assign(run, recovered, { phase: 'worker' }); this.store.save(value); return; }
        delete value.run; this.store.save(value);
      }
    }
    if (Date.parse(value.nextAt) > this.now()) return;
    value.lastRunAt = this.time(); this.store.save(value);
    try {
      const snapshot = await (this.callbacks.scan ?? scanTransactionSources)(join(this.config.contextWorkspace ?? this.config.workspace, 'bridge-transaction-sync'),
        // Dispatch accepts 128 KiB UTF-8. Keep room for instructions even for all-Chinese JSON;
        // the reader's normal fragment cursor preserves everything outside this bounded page.
        { enabledAt: value.enabledAt, cutoff: this.time(), cursor: value.cursor, limits: { maxChars: 36000 }, signal: this.abort.signal });
      if (!this.same(value) || this.closed || this.paused || this.callbacks.isPaused()) return;
      const coverage = this.coverage(snapshot);
      const failed = snapshot.sources.filter(source => source.status === 'error');
      if (!snapshot.recordCount) {
        if (failed.length) { await this.failure(value, coverage); return; }
        value.cursor = snapshot.nextCursor; value.lastSuccessAt = this.time(); value.lastCoverage = coverage;
        value.nextAt = new Date(this.now() + (snapshot.hasMore ? 1000 : value.intervalMinutes * 60000)).toISOString();
        value.failures = 0; delete value.lastError; this.store.save(value); return;
      }
      await this.submit(value, active, snapshot);
    } catch (error) { if (!this.closed && !this.paused) await this.submissionFailure(value, error); }
  }
  private async deferSummary(value: HousekeeperState, error: unknown): Promise<void> {
    const current = this.same(value); if (!current?.run || current.run.id !== value.run?.id) return;
    current.lastError = String(error instanceof Error ? error.message : error).slice(0, 600); current.failures++;
    current.nextAt = new Date(this.now() + current.intervalMinutes * 60000).toISOString();
    current.run.retryAt = current.nextAt; current.run.error = current.lastError; this.store.save(current);
    if (current.failures >= 3 && current.notifiedError !== current.lastError) {
      await this.callbacks.notify(current, `事务摘要交付连续失败：${current.lastError}\n已保留摘要，20分钟后重试；主控仍可正常使用。/housekeeper status 查看状态。`, 'housekeeper-error:' + current.epoch + ':' + current.failures);
      const latest = this.same(current); if (latest) { latest.notifiedError = current.lastError; this.store.save(latest); }
    }
  }
  private async submissionFailure(value: HousekeeperState, error: unknown): Promise<void> {
    const current = this.same(value); if (!current) return;
    if (current.run) {
      this.recoverIdentity(current);
      const submitted = !!current.run.jobId || !this.callbacks.recoverRun;
      await this.failure(current, error, submitted && !this.stopped(current.run.jobId ? this.callbacks.job(current.run.jobId) : null), 'worker');
    } else await this.failure(current, error);
  }
  private async submit(value: HousekeeperState, active: Conversation, snapshot: TransactionSnapshot): Promise<void> {
    const id = randomUUID(), dir = join(this.config.dataDir, 'housekeeper', id); mkdirSync(dir, { recursive: true });
    const inputPath = join(dir, 'input.json'), temporary = inputPath + '.tmp';
    writeFileSync(temporary, snapshot.text, { encoding: 'utf8', mode: 0o600 }); renameSync(temporary, inputPath);
    value.run = { id, epoch: value.epoch, phase: 'preparing', createdAt: this.time(), conversationId: active.id, snapshot, inputPath };
    this.store.save(value);
    const handle = await this.callbacks.dispatch(id, value, harnessText('housekeeper.summary_worker', { input_path: inputPath, input_text: snapshot.text }));
    const current = this.store.read();
    if (!current || current.epoch !== value.epoch || current.run?.id !== id) { await this.callbacks.cancel(handle.workerId); return; }
    // An off command can race an in-flight dispatch. Save its returned identity even while disabled.
    Object.assign(current.run, handle); if (current.run.phase === 'preparing') current.run.phase = 'worker'; this.store.save(current);
    if (!current.enabled) { await this.callbacks.cancel(handle.workerId); return; }
    const event = this.callbacks.eventForJob?.(handle.jobId);
    if (event) this.acceptCompletion(event);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.abort.abort(); await this.polling; this.store.close();
  }
}
