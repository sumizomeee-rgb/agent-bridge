import { harnessText } from '../harness.js';
import type { AgentInput, AgentResult, AgentTurn, PrivateInputBatch } from '../types.js';
import { abortError, deferred, isObject, type JsonObject } from '../agents/process.js';
import { DeliveryPreparationError } from '../delivery-errors.js';
import { assertBotCommunicationAllowed } from '../bot-communication.js';
import { compactControllerReceipt } from './tool-receipt.js';
import { controllerToolHelp, resolveControllerTool, ControllerToolInputError } from './tools/entry.js';
import { controllerTools } from './tools/catalog.js';
import { controllerClock, controllerGroupScene, currentImageManifest } from './context.js';

export interface ControllerCoordinatorOptions {
  invokeTool: (turn: AgentTurn, name: string, args: JsonObject, callId?: string) => Promise<unknown>;
  internalBotCommunicationEnabled?: boolean;
  maxToolCalls?: number;
}
export type ControllerDecisionOutcome = 'continued' | 'completed';
export interface ControllerDecisionPort {
  resetDecision(): void;
  continueDecision(kind: 'scene-refresh' | 'reply-recovery', evidence: string): Promise<void>;
  continuePrivate(input: AgentInput[]): Promise<void>;
  result(): AgentResult;
}
export class TurnSealedError extends Error {
  constructor() { super('主控本轮已封闭，等待下一条真实输入。'); this.name = 'TurnSealedError'; }
}
export interface ControllerCoordinationState {
  turn: AgentTurn;
  completed: ReturnType<typeof deferred<AgentResult>>;
  toolCalls: number; helpCalls?: number;
  publicCalls: number;
  silent?: boolean;
  restartAccepted: boolean;
  sealed: boolean;
  publicationPromise?: Promise<unknown>;
  publicationPreparationError?: DeliveryPreparationError;
  collaborationPromise?: Promise<unknown>;
  collaborationCompleted?: boolean;
  replyPausePromise?: Promise<unknown>;
  deliveryPromise?: Promise<unknown>;
  sceneCheckTail?: Promise<void>;
  sceneRefreshPending?: { scene?: string; privateInput?: PrivateInputBatch };
  sceneReassessmentStarted?: boolean;
  privateFinalCallId?: string;
  completingDecision?: boolean;
  completionPromise?: Promise<ControllerDecisionOutcome>;
  replyRecovery?: boolean;
  submissionAcknowledged?: boolean;
  inFlightTools: Map<string, { name: string; signature: string; promise: Promise<unknown>; succeeded: boolean; settled: boolean }>;
}
export function createControllerCoordinationState(turn: AgentTurn, options: { replyRecovery?: boolean } = {}): ControllerCoordinationState {
  return { turn, completed: deferred<AgentResult>(), toolCalls: 0, publicCalls: 0, restartAccepted: false, sealed: false,
    inFlightTools: new Map(), ...(options.replyRecovery ? { replyRecovery: true } : {}) };
}

/** Shared controller decisions. Native wires and external ports only transport inputs and completion events. */
export class ControllerCoordinator {
  constructor(private readonly options: ControllerCoordinatorOptions) {}
  async invoke(active: ControllerCoordinationState, name: string, args: JsonObject, callId: string): Promise<unknown> {
    const existing = active.inFlightTools.get(callId);
    const signature = canonicalControllerJSON([name, args]);
    if (existing) {
      if (existing.signature !== signature) {
        if (active.sealed) this.rejectSealed(active);
        throw new Error('相同主控工具标识的参数不一致，未重新执行。');
      }
      return existing.promise;
    }
    if (active.completed.settled) throw new TurnSealedError();
    let inputError: unknown;
    try { ({ name, args } = resolveControllerTool(name, args, this.options.internalBotCommunicationEnabled)); }
    catch (error) { inputError = error; }
    const terminal = name === 'bridge_silent' || name === 'bridge_send_user'
      || ((name === 'bridge_send_message' || name === 'bridge_send_private') && args.finish !== false);
    const work = (async () => {
      // Let an admitted collaboration's real public receipt win before a concurrent
      // final acknowledgement or silence can seal the turn and conflict with it.
      if (terminal && active.collaborationPromise) {
        await active.collaborationPromise;
        if (active.collaborationCompleted) return { alreadyCompleted: true };
      }
      if (active.sealed) {
        if (active.turn.onPrivateInputCheck && active.privateFinalCallId) return this.privateFinalPendingResult();
        this.rejectSealed(active);
      }
      if (inputError) throw inputError;
      return this.invokeOnce(active, name, args, callId).finally(() => {
        if (active.privateFinalCallId === callId && !active.sealed) active.privateFinalCallId = undefined;
      });
    })();
    const receipt = { name, signature, promise: work, succeeded: false, settled: false };
    active.inFlightTools.set(callId, receipt);
    void work.then(() => { receipt.succeeded = true; receipt.settled = true; }, () => { receipt.settled = true; });
    if ((name === 'bridge_send_message' || name === 'bridge_send_private') && args.finish === false) active.deliveryPromise = Promise.allSettled([...(active.deliveryPromise ? [active.deliveryPromise] : []), work]);
    if (name === 'bridge_start_collaboration') active.collaborationPromise = Promise.allSettled([...(active.collaborationPromise ? [active.collaborationPromise] : []), work]);
    return work;
  }
  private rejectSealed(active: ControllerCoordinationState): never {
    const error = new TurnSealedError();
    active.completed.reject(error);
    throw error;
  }
  private pauseGroupReply(active: ControllerCoordinationState, error: unknown, callId: string, targetId?: string): Promise<unknown> | undefined {
    if (!error || typeof error !== 'object' || !('groupReplyPaused' in error) || error.groupReplyPaused !== true
      || !active.turn.groupContext || !active.turn.onSilent || targetId === 'private') return undefined;
    if (active.replyPausePromise) return active.replyPausePromise;
    active.sealed = true;
    // Only admitted management must settle. Another publication may already be
    // waiting on this call; including it (or ourselves) would create a cycle.
    const admitted = [...active.inFlightTools.entries()].filter(([id, tool]) => id !== callId
      && !['bridge_send_user', 'bridge_send_message', 'bridge_send_private', 'bridge_silent'].includes(tool.name)).map(([, tool]) => tool.promise);
    const pause = Promise.allSettled(admitted).then(async () => {
      if (active.turn.signal.aborted) throw abortError();
      await active.turn.onSilent!(); active.silent = true;
      return { delivered: false, silent: true, reason: 'group-public-reply-limit' };
    });
    active.replyPausePromise = pause; active.publicationPromise = pause;
    return pause;
  }
  private async invokeOnce(active: ControllerCoordinationState, name: string, args: JsonObject, callId: string): Promise<unknown> {
    if (active.turn.preparing) throw new Error('目标会话准备轮次禁止工具、副作用和公开回复。');
    if (name === 'bridge_help') {
      if (active.turn.signal.aborted) throw abortError();
      active.helpCalls = (active.helpCalls ?? 0) + 1;
      if (active.helpCalls > (this.options.maxToolCalls ?? 12)) throw new ControllerToolInputError('本轮工具说明查询已达上限；可直接调用已明确参数的命令。');
      return controllerToolHelp(args.command, this.options.internalBotCommunicationEnabled);
    }
    if (active.replyRecovery) {
      const finalReply = (name === 'bridge_send_user' || name === 'bridge_send_message') && args.finish !== false
        && (args.targetId == null || args.targetId === 'private');
      if (!finalReply && !['bridge_read_feedback', 'bridge_list_dispatch_failures', 'bridge_list_workers', 'bridge_search_chat_history', 'bridge_read_chat_history', 'bridge_list_tasks', 'bridge_read_file', 'bridge_list_directory'].includes(name))
        throw new Error('本次补救只允许核对已有结果并补发原私聊最终回复；禁止重派任务或产生其他副作用。');
    }
    if (name === 'bridge_claim_work' || name === 'bridge_finish_work') return { performed: false, legacyTool: true, message: 'Work ownership and completion are recorded automatically. Use bridge_start_worker, bridge_continue_worker, bridge_schedule_worker or bridge_list_workers directly; no separate claim/finish step is needed.' };
    if (!controllerTools.some(tool => tool.name === name)) throw new Error('主控不能调用未登记的工具。');
    assertBotCommunicationAllowed(this.options.internalBotCommunicationEnabled, name, args);
    const privateFinal = !!active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event
      && (name === 'bridge_send_user' || (name === 'bridge_send_message' && args.finish !== false));
    if (privateFinal && args.targetId != null && args.targetId !== 'private') return { performed: false, privateResponseRequired: true,
      message: 'This private owner input still needs its private FINAL. Send authorized group content with bridge_send_message finish=false, then send the final response to targetId=private (or omit targetId in bridge_send_user). Nothing was sent and this rejection did not consume reassessment.' };
    if (privateFinal && !active.privateFinalCallId) active.privateFinalCallId = callId;
    const scenePause = !active.replyRecovery && (active.turn.onSceneCheck || active.turn.onPrivateInputCheck || active.sceneRefreshPending) ? await this.checkScene(active, name, args, callId) : undefined;
    if (scenePause) return scenePause;
    if (active.sealed) this.rejectSealed(active);
    if (++active.toolCalls > (this.options.maxToolCalls ?? 12)) { active.completed.reject(new Error('主控本轮协调调用过多，已停止继续派发。')); throw new Error('主控协调调用上限'); }
    if (active.turn.signal.aborted) throw abortError();
    if (name === 'bridge_read_feedback') {
      if (!active.turn.onReadBridgeFeedback) throw new Error('本轮没有错误回执查询通道。');
      if (args.id !== undefined && (typeof args.id !== 'string' || !/^[a-f0-9]{64}$/.test(args.id))
        || args.includeDelivered !== undefined && typeof args.includeDelivered !== 'boolean'
        || args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) throw new Error('错误回执查询参数无效。');
      return active.turn.onReadBridgeFeedback(args);
    }
    if (name === 'bridge_silent') {
      if (active.turn.deliveryRequirement !== 'none' && (!active.turn.groupContext || !active.turn.onSilent)) throw new Error('静默终态只适用于已授权的群参与轮次或无渠道主控。');
      if (Object.keys(args).length) throw new Error('静默工具不接受参数。');
      const admitted = [...active.inFlightTools.entries()].filter(([id]) => id !== callId).map(([, tool]) => tool.promise);
      active.sealed = true;
      active.publicationPromise = Promise.allSettled(admitted).then(async () => {
        if (active.turn.signal.aborted) throw abortError();
        if (active.sceneRefreshPending) { active.sealed = false; return this.scenePausedResult(active); }
        await active.turn.onSilent?.(); active.silent = true; return { silent: true };
      });
      return active.publicationPromise;
    }
    if (name === 'bridge_send_private') {
      const context = active.turn.groupContext;
      if (!context || args.principalId !== context.principalId) throw new Error('兼容私聊只允许当前群轮次已验证的负责人。');
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 12000 || args.text.includes('\0')) throw new Error('兼容私聊文字为空、包含空字符或超过12000字限制。');
      name = 'bridge_send_message'; args = { ...args, targetId: 'private' };
    }
    if (name === 'bridge_send_message') {
      if (args.finish !== undefined && typeof args.finish !== 'boolean') throw new Error('finish 必须是布尔值；省略表示最终发送。');
      if (typeof args.targetId !== 'string' || !args.targetId.trim() || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000) throw new Error('发送消息需要明确目标ID与有效文字。');
    }
    if (name === 'bridge_send_message' && args.finish === false) {
      if (args.attachmentPaths != null && (!Array.isArray(args.attachmentPaths) || args.attachmentPaths.length > 10 || args.attachmentPaths.some(path => typeof path !== 'string'))) throw new Error('附件路径清单格式无效。');
      if (!active.turn.onPublicMessage) throw new Error('主控投递通道不可用。');
      try { await active.turn.onPublicMessage(args.text as string, args.attachmentPaths as string[] | undefined, callId, args.targetId as string, false); }
      catch (error) {
        const paused = this.pauseGroupReply(active, error, callId, args.targetId as string | undefined); if (paused) return paused;
        if (error && typeof error === 'object' && 'deliveryUncertain' in error) { active.sealed = true; active.completed.reject(error); }
        throw error;
      }
      return { delivered: true, supplementary: true, originalDeliveryUnchanged: true };
    }
    if (name !== 'bridge_send_user' && name !== 'bridge_send_message') {
      let result: unknown;
      try { result = await this.options.invokeTool(active.turn, name, args, callId); }
      catch (error) {
        if (error && typeof error === 'object' && 'deliveryUncertain' in error) { active.sealed = true; active.completed.reject(error); }
        throw error;
      }
      if (isObject(result) && result.sceneRefreshRequired === true && result.performed === false && result.sceneChanged === true) {
        active.sceneRefreshPending = { ...(typeof result.scene === 'string' ? { scene: result.scene } : {}) };
        return this.scenePausedResult(active);
      }
      if (name === 'bridge_request_restart' && isObject(result) && result.accepted === true) {
        active.restartAccepted = true;
        if (active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event) return { ...result, privateResponseRequired: true,
          message: harnessText('controller.restart_private_ack') };
      }
      if (name === 'bridge_start_collaboration' && isObject(result) && isObject(result.completion) && result.completion.publicDeliveryComplete === true) {
        if (!active.turn.groupContext || !active.turn.onPublicDeliveryComplete) throw new Error('同群公开交付收据缺少有效群轮次。');
        if (active.sealed) this.rejectSealed(active);
        active.sealed = true;
        const publication = active.turn.onPublicDeliveryComplete().then(() => { active.publicCalls++; active.collaborationCompleted = true; });
        active.publicationPromise = publication;
        try { await publication; } catch (error) { active.completed.reject(error); throw error; }
      }
      return compactControllerReceipt(name, result);
    }
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 16000) throw new Error('公开消息需要有效文字。');
    if (args.targetId != null && (typeof args.targetId !== 'string' || !args.targetId.trim())) throw new Error('投递目标ID无效。');
    const paths = args.attachmentPaths;
    if (paths != null && (!Array.isArray(paths) || paths.length > 10 || paths.some(file => typeof file !== 'string'))) throw new Error('附件路径清单格式无效。');
    if (!active.turn.onPublicMessage) throw new Error('主控公开投递通道不可用。');
    // Seal synchronously, before any await. Earlier admitted management calls may
    // settle, but a parallel new call cannot overtake an in-flight publication.
    const admitted = [...active.inFlightTools.entries()].filter(([id]) => id !== callId).map(([, tool]) => tool.promise);
    active.sealed = true;
    const pendingManagement = [...active.inFlightTools.entries()].filter(([id, tool]) => id !== callId && !tool.settled
      && !['bridge_send_user', 'bridge_send_message', 'bridge_send_private', 'bridge_silent'].includes(tool.name));
    const publication = (async () => {
      const outcomes = await Promise.allSettled(pendingManagement.map(([, tool]) => tool.promise));
      await Promise.allSettled(admitted);
      if (active.turn.signal.aborted) throw abortError();
      if (active.replyPausePromise) return active.replyPausePromise;
      if (active.sceneRefreshPending) { active.sealed = false; return this.scenePausedResult(active); }
      try {
        if (pendingManagement.length) {
          const receipts = pendingManagement.map(([id, tool], index) => ({ callId: id, tool: tool.name, status: outcomes[index]!.status }));
          throw new DeliveryPreparationError('最终回复写于管理工具返回之前，尚未发送。工具现已结束：' + JSON.stringify(receipts)
            + harnessText('controller.delivery_receipt_correction'));
        }
        await active.turn.onPublicMessage!(args.text as string, paths as string[] | undefined, callId, args.targetId as string | undefined, true);
      }
      catch (error) {
        const paused = this.pauseGroupReply(active, error, callId, args.targetId as string | undefined); if (paused) return paused;
        if (error instanceof DeliveryPreparationError && !('deliveryUncertain' in error)) {
          // No upload/send happened. Let the model correct this declaration in this
          // same turn; never replay earlier successful management calls for it.
          active.sealed = false;
          active.publicationPreparationError = error;
          active.publicationPromise = undefined;
          throw error;
        }
        // A failed publication can have reached the chat platform. Preserve that failure;
        // never turn it into a successful sealed turn or retry under a new ID.
        active.completed.reject(error); throw error;
      }
      active.publicationPreparationError = undefined;
      active.publicCalls++;
      return { delivered: true };
    })();
    active.publicationPromise = publication;
    return publication;
  }
  scenePausedResult(active?: ControllerCoordinationState): JsonObject {
    if (active?.sceneRefreshPending?.privateInput || (active?.sceneReassessmentStarted && active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event)) return { performed: false, privateInputChanged: true, reassessmentPending: true,
      message: harnessText('controller.private_input_changed') };
    return { performed: false, sceneChanged: true, reassessmentPending: true,
      message: harnessText('controller.scene_changed') };
  }
  private privateFinalPendingResult(): JsonObject {
    return { performed: false, privateFinalPending: true,
      message: 'A private FINAL is already being prepared or delivered. This later action did not run and claimed no new private messages. Finish DONE; later owner inputs stay queued for their own response.' };
  }
  private async checkScene(active: ControllerCoordinationState, name: string, args: JsonObject, callId: string): Promise<JsonObject | undefined> {
    // A native turn, unlike an individual tool call, is an explicit protocol boundary
    // shared by Codex and Claude. Keep its whole remaining batch behind the barrier.
    const readonly = ['bridge_delivery_targets', 'bridge_read_group_history', 'bridge_list_controllers', 'bridge_group_context',
      'bridge_search_chat_history', 'bridge_read_chat_history', 'bridge_list_tasks',
      'bridge_read_file', 'bridge_list_directory', 'bridge_list_dispatch_failures',
      'bridge_list_schedules', 'bridge_list_native_sessions', 'bridge_read_native_session', 'bridge_check_capabilities', 'bridge_list_targets', 'bridge_list_workers'].includes(name);
    if (!readonly && active.turn.onPrivateInputCheck && active.privateFinalCallId && active.privateFinalCallId !== callId) return this.privateFinalPendingResult();
    if (!readonly && active.sceneCheckTail) await active.sceneCheckTail;
    if (!readonly && active.turn.onPrivateInputCheck && active.privateFinalCallId && active.privateFinalCallId !== callId) return this.privateFinalPendingResult();
    if (!readonly && active.turn.onPrivateInputCheck && active.sealed) this.rejectSealed(active);
    if (active.sceneRefreshPending) return readonly ? undefined : this.scenePausedResult(active);
    if (active.sceneReassessmentStarted || (!active.turn.onSceneCheck && !active.turn.onPrivateInputCheck)) return undefined;
    const guarded = ['bridge_start_worker', 'bridge_continue_worker', 'bridge_schedule_worker', 'bridge_schedule_message', 'bridge_send_user',
      'bridge_send_message', 'bridge_send_private', 'bridge_update_tasks', 'bridge_ack_dispatch_failure'].includes(name) || (name === 'bridge_start_collaboration' && args.mode === 'public');
    if (!guarded) return undefined;
    const previous = active.sceneCheckTail ?? Promise.resolve();
    let release!: () => void;
    active.sceneCheckTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (active.sceneRefreshPending) return this.scenePausedResult(active);
      if (active.turn.signal.aborted) throw abortError();
      if (active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event) {
        const result = await active.turn.onPrivateInputCheck({ name, args, callId });
        if (!result.refreshRequired) return undefined;
        if (!result.input || !Number.isSafeInteger(result.input.version) || result.input.version < 1 || !Array.isArray(result.input.messages) || !result.input.messages.length) {
          const error = new Error('私聊更新缺少有效的新主人输入，旧动作未执行。'); active.completed.reject(error); throw error;
        }
        active.sceneRefreshPending = { privateInput: result.input };
      } else {
        const result = await active.turn.onSceneCheck?.({ name, args, callId });
        if (!result?.refreshRequired) return undefined;
        active.sceneRefreshPending = { ...(result.scene == null ? {} : { scene: result.scene }) };
      }
      return this.scenePausedResult(active);
    } finally { release(); }
  }
  finish(active: ControllerCoordinationState, port: ControllerDecisionPort): Promise<ControllerDecisionOutcome> {
    if (active.completingDecision) return active.completionPromise!;
    active.completingDecision = true;
    const settle = async (): Promise<ControllerDecisionOutcome> => {
      if (active.turn.onSceneCheck || active.turn.onPrivateInputCheck || active.turn.deliveryRequirement === 'none')
        await Promise.allSettled([...active.inFlightTools.values()].map(tool => tool.promise));
      await active.collaborationPromise; await active.deliveryPromise; await active.publicationPromise;
      if (active.sceneRefreshPending) {
        await Promise.allSettled([...active.inFlightTools.values()].map(tool => tool.promise));
        if (active.turn.signal.aborted) throw abortError();
        const pending = active.sceneRefreshPending;
        active.sceneRefreshPending = undefined;
        active.sceneReassessmentStarted = true;
        active.privateFinalCallId = undefined;
        active.toolCalls = 0; active.helpCalls = 0;
        port.resetDecision(); active.completingDecision = false;
        if (pending.privateInput) {
          await port.continuePrivate(preparePrivateReassessment(active, pending.privateInput));
          return 'continued';
        }
        const evidence = harnessText('controller.scene_refresh_header')
          + JSON.stringify({ scene: controllerGroupScene(pending.scene), automaticReassessment: 1, previousActionPerformed: false })
          + '\n' + controllerClock();
        await port.continueDecision('scene-refresh', evidence);
        return 'continued';
      }
      const noDelivery = active.turn.deliveryRequirement === 'none';
      if (!noDelivery && active.turn.controllerRecovery && !active.turn.groupContext && !active.turn.event
        && active.publicCalls === 0 && !active.silent && !active.sealed && !active.replyRecovery) {
        active.replyRecovery = true;
        active.privateFinalCallId = undefined;
        active.toolCalls = 0; active.helpCalls = 0;
        port.resetDecision(); active.completingDecision = false;
        const reason = active.publicationPreparationError ? 'final delivery rejected before any send' : 'native decision completed without a private final reply';
        const preparationError = active.publicationPreparationError?.message;
        active.publicationPreparationError = undefined;
        active.turn.onControllerState?.({ attempt: 1, phase: 'reply-recovery', submission: 'accepted' });
        if (active.turn.signal.aborted) throw abortError();
        const evidence = harnessText('controller.reply_recovery_header') + JSON.stringify({
          reason, preparationError, previousDecisionCompleted: true, finalReplySent: false,
          reportRecoveryOnly: true, automaticRecoveryAttempt: 1
        });
        await port.continueDecision('reply-recovery', evidence);
        return 'continued';
      }
      if (active.publicationPreparationError && !active.silent) throw active.publicationPreparationError;
      const privateFinalRequired = !!active.turn.onPrivateInputCheck && !active.turn.groupContext && !active.turn.event;
      if (!noDelivery && (!active.turn.event || active.turn.event.kind === 'recovery' || active.replyRecovery) && active.publicCalls === 0 && !active.silent && (!active.restartAccepted || privateFinalRequired))
        throw Object.assign(new Error('主控没有通过公开通道回复，本轮未标记为成功。'), { finalReplyMissing: true });
      const result = port.result();
      active.sealed = true;
      active.completed.resolve(result);
      return 'completed';
    };
    const completion = settle(); active.completionPromise = completion;
    void completion.catch(error => active.completed.reject(error));
    return completion;
  }
}

export function canonicalControllerJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalControllerJSON).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalControllerJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function preparePrivateReassessment(active: ControllerCoordinationState, batch: PrivateInputBatch): AgentInput[] {
    const values: AgentInput[] = [];
    for (const message of batch.messages) {
      if (typeof message.id !== 'string' || typeof message.userId !== 'string' || typeof message.channelId !== 'string'
        || typeof message.text !== 'string' || !Array.isArray(message.imagePaths) || message.imagePaths.some(path => typeof path !== 'string')) throw new Error('新私聊输入格式无效，未提交续决策。');
      const source = message.source ?? { messageId: message.id, userId: message.userId, channelId: message.channelId, authorType: 'user' };
      values.push({ type: 'text', text: '[Bridge incoming private owner message; verified new user input] '
        + JSON.stringify({ version: batch.version, id: message.id, userId: message.userId, channelId: message.channelId, source, freshOwnerInput: true }) + '\n' + message.text });
      values.push(...message.imagePaths.map(path => ({ type: 'localImage' as const, path })));
    }
    const last = batch.messages[batch.messages.length - 1]!;
    active.turn = { ...active.turn, source: { messageId: last.id, userId: last.userId, channelId: last.channelId, ...(last.source ? { original: last.source } : {}) },
      text: batch.messages.map(message => message.text).join('\n\n'), input: values,
      imagePaths: [...new Set([...active.turn.imagePaths, ...batch.messages.flatMap(message => message.imagePaths)])] };
    const manifest = currentImageManifest(active.turn); if (manifest) values.push({ type: 'text', text: manifest });
    return values;
}
