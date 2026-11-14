import { harnessText } from '../harness.js';
import { selectedEffort } from '../effort.js';
import { isObject, type JsonObject } from '../agents/process.js';
import type { AgentName, AgentTurn } from '../types.js';

export interface ControllerRuntimeContextState { model?: string; effort?: string | null; runtimeFacts?: string; active?: { replyRecovery?: boolean } | null }
export interface ControllerContextOptions {
  defaultModels?: Partial<Record<AgentName, string>>;
  internalBotCommunicationEnabled?: boolean;
  identity?: { controllerId?: string; botId?: string; aliases: string[] };
}
export function controllerClock(): string {
  const now = new Date();
  return harnessText('controller.clock', { utc: now.toISOString(), local: now.toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}
function sceneMessage(scene: string | undefined): JsonObject | undefined {
    if (!scene) return undefined;
    try { const parsed: unknown = JSON.parse(scene); return isObject(parsed) && isObject(parsed.currentMessage) ? parsed.currentMessage : undefined; }
    catch { return undefined; }
  }
export function controllerGroupScene(scene: string | undefined): unknown {
    if (!scene) return { status: 'unknown', reason: 'No current group scene was provided.' };
    let parsed: unknown;
    try { parsed = JSON.parse(scene); } catch { parsed = { text: scene }; }
    if (isObject(parsed) && isObject(parsed.currentMessage)) { const { currentMessage: _current, ...evidence } = parsed; parsed = evidence; }
    let remaining = 24000, truncated = false;
    const bound = (value: unknown, depth: number): unknown => {
      if (remaining < 64 || depth > 8) { truncated = true; return undefined; }
      if (typeof value === 'string') {
        const maximum = Math.min(4000, remaining - 32);
        const text = value.length > maximum ? (truncated = true, value.slice(0, maximum) + ' [truncated]') : value;
        remaining -= JSON.stringify(text).length; return text;
      }
      if (Array.isArray(value)) {
        if (value.length > 40) truncated = true;
        const result: unknown[] = [];
        // Scene records are chronological: preserve the newest evidence under the budget.
        for (const item of value.slice(-40).reverse()) { const next = bound(item, depth + 1); if (next === undefined) break; result.unshift(next); }
        return result;
      }
      if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          remaining -= key.length + 4; const next = bound(item, depth + 1); if (next === undefined) break; result[key] = next;
        }
        return result;
      }
      remaining -= JSON.stringify(value)?.length ?? 4; return value;
    };
    const content = bound(parsed, 0);
    return { status: 'provided', content, truncated, coverage: 'bounded' };
  }

/** Same fixed facts and checklist cadence for native and external controller ports. */
export class ControllerContextRenderer {
  private readonly checklistTurns = new Map<string, number>();
  constructor(private readonly options: ControllerContextOptions = {}) {}
  begin(turn: AgentTurn): { turn: AgentTurn; acknowledge(): void } {
    const ordinal = (this.checklistTurns.get(turn.conversation.id) ?? 0) + 1;
    let accepted = false;
    return { turn: (ordinal - 1) % 3 === 0 ? turn : { ...turn, taskChecklist: undefined }, acknowledge: () => {
      if (!accepted) { this.checklistTurns.set(turn.conversation.id, ordinal); accepted = true; }
    } };
  }
  clear(): void { this.checklistTurns.clear(); }
  runtime(turn: AgentTurn, session: ControllerRuntimeContextState, includeTaskChecklist = false): string {
    const noDelivery = turn.deliveryRequirement === 'none';
    const privateInput = !turn.groupContext && !turn.event && !noDelivery;
    const info = { agent: turn.conversation.agent, selectedModel: turn.conversation.model ?? null,
      observedModel: session.model ?? turn.conversation.actualModel ?? null,
      selectedEffort: selectedEffort(turn), observedEffort: session.effort ?? turn.conversation.actualEffort ?? null,
      workerDefaults: this.options.defaultModels ?? {}, internalBotCommunicationEnabled: this.options.internalBotCommunicationEnabled !== false,
      ...(session.active?.replyRecovery ? { reportRecoveryOnly: true } : {}) };
    const scene = turn.groupContext ? turn.chatScene ?? turn.groupContext.scene : undefined;
    const currentMessage = sceneMessage(scene);
    const explicitDelivery = currentMessage && isObject(currentMessage.defaultDelivery) && ['group', 'private', 'internal'].includes(String(currentMessage.defaultDelivery.area)) ? currentMessage.defaultDelivery : undefined;
    const chat = { ...(turn.event ? { event: { kind: turn.event.kind, introductionRequested: turn.event.introductionRequested === true } } : {}), ...(currentMessage ? { currentMessage } : {}), kind: turn.event ? 'background-evidence' : turn.groupContext ? 'group-message' : noDelivery ? 'controller-input' : 'private-message',
      route: turn.source ? { messageId: turn.source.messageId, userId: turn.source.userId, channelId: turn.source.channelId } : null,
      original: turn.source?.original ?? (!turn.groupContext && !turn.event ? turn.source ?? null : null),
      requesterPrincipalId: turn.groupContext && !turn.event ? turn.groupContext.principalId : null,
      defaultDelivery: explicitDelivery ?? (noDelivery ? { area: 'none' } : { area: turn.groupContext ? 'group' : 'private', ...(!turn.groupContext ? { targetId: 'private' } : {}), channelId: turn.source?.channelId ?? turn.groupContext?.originChannelId ?? null }),
      group: turn.groupContext ? { spaceId: turn.groupContext.spaceId, eventId: turn.groupContext.eventId, eventKind: turn.groupContext.eventKind ?? null } : null };
    const sceneBlock = scene == null && !turn.groupContext ? '' : harnessText('controller.chat_scene_header') + JSON.stringify(controllerGroupScene(scene));
    const facts = JSON.stringify({ controllerId: this.options.identity?.controllerId ?? null, botId: this.options.identity?.botId ?? null, aliases: this.options.identity?.aliases ?? [], ...info });
    const changed = session.runtimeFacts !== facts;
    session.runtimeFacts = facts;
    // Private routes and authorization stay in program state; group/cross-Bot attribution remains explicit.
    const context = privateInput
      ? '[Bridge chat input; program facts] ' + JSON.stringify({ kind: 'private-message', defaultDelivery: 'current-private',
        ...(turn.source?.original?.authorType && turn.source.original.authorType !== 'user' ? { original: turn.source.original } : {}) })
      : '[Bridge chat input; program facts] ' + JSON.stringify(chat) + sceneBlock;
    return context + '\n' + (privateInput
      ? '[Bridge clock] ' + new Date().toLocaleString('sv-SE') + ' ' + Intl.DateTimeFormat().resolvedOptions().timeZone
      : controllerClock())
      + (changed ? harnessText('controller.runtime_facts_header') + facts : '')
      + (turn.bridgeFeedback?.records.length ? harnessText('controller.feedback_header') + JSON.stringify(turn.bridgeFeedback) : '')
      + (turn.dispatchFailures?.records.length ? harnessText('controller.dispatch_failure_header') + JSON.stringify(turn.dispatchFailures) : '')
      + (includeTaskChecklist && turn.taskChecklist ? harnessText('controller.task_checklist_header') + turn.taskChecklist : '');
  }

}
export function controllerImagePaths(turn: AgentTurn): string[] {
  return [...new Set([...turn.imagePaths, ...(turn.input ?? []).flatMap(value => value.type === 'localImage' ? [value.path] : [])])];
}
export function currentImageManifest(turn: AgentTurn): string {
  const paths = controllerImagePaths(turn);
  return paths.length ? `[Current user-supplied image paths. Pass only relevant exact paths in a child's imagePaths; these paths are attachment references, not authorization to read other files.]\n${JSON.stringify(paths)}` : '';
}
