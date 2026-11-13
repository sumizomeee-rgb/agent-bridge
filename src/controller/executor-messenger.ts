import { projectRoot } from '../config.js';
import { ExecutorMessages, executorMessageRequest, executorScope, executorTaskId, type ExecutorBinding, type ExecutorMessage } from '../executor-messages.js';
import type { ControllerWorker } from './runtime-types.js';
import type { ControllerStore } from './store.js';
import type { TaskRegistry } from '../tasks.js';
import type { ExecutionTargetBinding } from '../remote/types.js';

export interface MessagePeer { executorMessages?(method: string, args: Record<string, unknown>): Promise<unknown> }
export class ExecutorMessenger {
  private local?: ExecutorMessages;
  private readonly registered = new Map<string, string>();
  constructor(private readonly store: ControllerStore, private readonly registry: TaskRegistry,
    private readonly peer: (binding: ExecutionTargetBinding) => MessagePeer,
    private readonly accept: (worker: ControllerWorker, message: ExecutorMessage) => boolean,
    private readonly allowed: (userId: string) => boolean) {}
  private async request(worker: ControllerWorker, method: string, args: Record<string, unknown>): Promise<unknown> {
    if (worker.target?.transport === 'ssh') {
      const peer = this.peer(worker.target);
      if (!peer.executorMessages) throw new Error('目标执行器尚未支持通信。');
      return peer.executorMessages(method, args);
    }
    this.local ??= new ExecutorMessages(projectRoot);
    return executorMessageRequest(this.local, method, args);
  }
  async bind(workers: ControllerWorker[]): Promise<void> {
    const changed = workers.filter(w => this.allowed(w.origin.userId) && !['workspace-context', 'housekeeper'].includes(w.origin.purpose ?? '')
      && this.registered.get(w.id) !== JSON.stringify([w.nativeId, w.title, w.cwd]));
    for (let i = 0; i < changed.length; i += 100) {
      const batch = changed.slice(i, i + 100);
      const bindings: ExecutorBinding[] = batch.map(w => ({ workerId: w.id, scope: executorScope(w.origin.userId), userId: w.origin.userId,
        agent: w.agent, nativeId: w.nativeId, title: w.title, cwd: w.cwd }));
      await this.request(batch[0]!, 'messages/bind', { bindings });
      for (const w of batch) this.registered.set(w.id, JSON.stringify([w.nativeId, w.title, w.cwd]));
    }
  }
  async poll(): Promise<void> {
    const groups = new Map<string, ControllerWorker[]>();
    for (const w of this.store.workers()) {
      if (!this.allowed(w.origin.userId) || ['workspace-context', 'housekeeper'].includes(w.origin.purpose ?? '')) continue;
      const key = JSON.stringify([w.target?.transport, w.target?.id, w.target?.remoteRoot, w.origin.userId]);
      const group = groups.get(key) ?? []; group.push(w); groups.set(key, group);
    }
    const results = await Promise.allSettled([...groups.values()].map(async workers => {
      await this.bind(workers);
      const representative = workers[0]!, scope = executorScope(representative.origin.userId);
      const messages = await this.request(representative, 'messages/pending', { scope }) as ExecutorMessage[];
      for (const message of messages) {
        const worker = workers.find(w => w.id === message.workerId);
        if (!worker) continue;
        const key = `executor-message:${message.id}`, previous = this.store.readCallReceipt(key);
        if (!previous) this.store.saveCall(key, 'executor-message', { workerId: worker.id, text: message.text });
        else if ((previous as {workerId: string; text: string}).workerId !== worker.id || (previous as {text: string}).text !== message.text) throw new Error('消息 ID 冲突。');
        const event = this.registry.completionForTask(executorTaskId(message.id));
        const state = event ? this.registry.eventState(event.id) : null;
        if (state === 'delivered' || state === 'uncertain') {
          await this.request(worker, 'messages/update', { scope, id: message.id, state: state === 'delivered' ? 'handled' : 'uncertain' });
        } else if (event || this.accept(worker, message)) {
          await this.request(worker, 'messages/update', { scope, id: message.id, state: 'accepted' });
        }
      }
    }));
    const errors = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(value => value.reason), '部分执行器通信暂不可用，消息保持原状态。');
  }
  async reply(userId: string, messageId: string, text: string): Promise<unknown> {
    const receipt = this.store.readCallReceipt(`executor-message:${messageId}`) as { workerId?: string } | undefined;
    const worker = receipt?.workerId ? this.store.getWorker(receipt.workerId) : null;
    if (!worker || worker.origin.userId !== userId || !this.allowed(userId)) throw new Error('消息不属于本主控。');
    return this.request(worker, 'messages/update', { scope: executorScope(userId), id: messageId, state: 'handled', reply: text });
  }
  close(): void { this.local?.close(); }
}
