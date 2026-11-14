import type { AgentAdapter, AgentCommand, AgentModelInfo, AgentSupplement, AgentTurn, Conversation, SteerResult } from '../types.js';
import { PresetRuntime, type PreparedPreset } from '../presets/runtime.js';
import { NativeControllerAdapter, type NativeControllerOptions } from './native.js';
import { CodexAdapter } from '../agents/codex.js';
import { ClaudeAdapter } from '../agents/claude.js';
import { workspaceFile } from '../workspace-layout.js';
import type { BridgeConfig, AgentName } from '../types.js';
import { assertPresetBinding } from '../presets/runtime.js';

interface Launch { adapter: AgentAdapter; prepared: PreparedPreset; binding: string; retired: boolean }
type Context = Pick<Conversation, 'id' | 'nativeId'> & Partial<Pick<Conversation, 'preset'>>;
/** Owns launch resources; controller behavior stays in NativeControllerAdapter. */
export class ControllerLaunchAdapter implements AgentAdapter {
  private readonly launches = new Map<string, Promise<Launch>>();
  private closed = false;
  constructor(private readonly ordinary: AgentAdapter, private readonly runtime: PresetRuntime,
    private readonly command: AgentCommand, private readonly env: NodeJS.ProcessEnv,
    private readonly factory: (launch: PreparedPreset) => AgentAdapter) {}
  private async selected(context: Context): Promise<AgentAdapter> {
    if (this.closed) throw new Error('主控启动服务已关闭。');
    if (!context.preset) return this.ordinary;
    assertPresetBinding(context.preset);
    if (context.preset.targetId !== 'local') throw new Error('主控只支持桥电脑预设。');
    let launch = this.launches.get(context.id);
    if (launch && (await launch).retired) {
      if (this.launches.get(context.id) === launch) this.launches.delete(context.id);
      return this.selected(context);
    }
    if (!launch) {
      const pending = this.runtime.prepareController(context.preset, context.id, context.nativeId, this.command, this.env).then(async prepared => {
        try {
          if (this.closed) throw new Error('主控启动服务已关闭。');
          return { adapter: this.factory(prepared), prepared, binding: JSON.stringify(context.preset), retired: false };
        } catch (error) { await prepared.close(); throw error; }
      });
      this.launches.set(context.id, pending); launch = pending;
      void pending.catch(() => { if (this.launches.get(context.id) === pending) this.launches.delete(context.id); });
    }
    const value = await launch;
    if (value.binding !== JSON.stringify(context.preset)) throw new Error('原主控预设绑定不同，拒绝换线续接。');
    return value.adapter;
  }
  async run(turn: AgentTurn) {
    if (turn.conversation.preset && (turn.conversation.agent !== turn.conversation.preset.agent || turn.conversation.model !== turn.conversation.preset.model))
      throw new Error('主控预设与引擎或模型不一致。');
    return (await this.selected(turn.conversation)).run(turn);
  }
  async getModelInfo(cwd: string, context?: Context): Promise<AgentModelInfo> {
    const adapter = context ? await this.selected(context) : this.ordinary;
    if (!adapter.getModelInfo) throw new Error('主控缺少模型目录能力。');
    const info = await adapter.getModelInfo(cwd, context);
    return context?.preset ? { ...info, defaultModel: context.preset.model,
      models: [{ ...(info.models.find(model => model.id === context.preset!.model) ?? { id: context.preset.model, displayName: context.preset.model }), isDefault: true }] } : info;
  }
  async steer(id: string, input: AgentSupplement): Promise<SteerResult> {
    const adapter = (await this.launches.get(id))?.adapter ?? this.ordinary;
    return await adapter.steer?.(id, input) ?? { status: 'queued', unsupported: true };
  }
  async interrupt(id: string): Promise<void> {
    const launch = await this.launches.get(id);
    if (!launch) return this.ordinary.interrupt(id);
    await launch.adapter.interrupt(id);
    if (await launch.adapter.confirmStopped?.(id)) {
      await launch.adapter.close(); await launch.prepared.close(); launch.retired = true;
    }
  }
  async confirmStopped(id: string): Promise<boolean> {
    const launch = await this.launches.get(id);
    return await (launch?.adapter ?? this.ordinary).confirmStopped?.(id) ?? false;
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([this.ordinary.close(), ...[...this.launches.values()].map(async pending => {
      const value = await pending; await value.adapter.close(); await value.prepared.close();
    })]);
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), '主控启动资源未完全关闭。');
  }
}

/** Shared production construction, also used by isolated launch verification. */
export function createControllerAdapter(config: BridgeConfig, env: NodeJS.ProcessEnv, agent: AgentName,
  metadataAdapter: AgentAdapter, invokeTool: NativeControllerOptions['invokeTool']): AgentAdapter {
  const runtime = new PresetRuntime(workspaceFile(config.contextWorkspace ?? config.workspace, 'agent-presets', 'private'), config.dataDir);
  const ordinaryEnv = agent === 'claude' ? { ...env, CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' } : env;
  const options = { agent, dataDir: config.dataDir, contextWorkspace: config.contextWorkspace ?? config.workspace,
    internalBotCommunicationEnabled: config.internalBotCommunicationEnabled, defaultModels: config.defaultModels,
    identity: { controllerId: config.controllerId, botId: config.botId, aliases: config.aliases ?? [] }, invokeTool };
  return new ControllerLaunchAdapter(new NativeControllerAdapter(config.commands[agent], ordinaryEnv, { ...options, metadataAdapter }),
    runtime, config.commands[agent], ordinaryEnv, launch => new NativeControllerAdapter(launch.command, launch.env, { ...options, isolatedLaunch: true,
      metadataAdapter: agent === 'codex' ? new CodexAdapter(launch.command, launch.env) : new ClaudeAdapter(launch.command, launch.env) }));
}
