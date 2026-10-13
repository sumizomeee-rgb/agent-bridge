import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, win32, posix } from 'node:path';
import { isObject } from '../agents/process.js';
import type { AgentAdapter, AgentCommand, AgentName, BridgeConfig } from '../types.js';
import type { ExecutionTargetBinding, RemoteHandoff, RemoteTargetRegistration, TargetSummary } from './types.js';
import { RemoteAgentAdapter, type RemoteAdapterOptions } from './adapter.js';
import { fingerprint } from './store.js';
import { NativeSessionService, type NativeSessionAdoptArgs, type NativeSessionAdoption, type NativeSessionPage, type NativeSessionQuery, type NativeSessionRead, type NativeSessionReadOptions, type NativeSessionRef } from '../native-sessions.js';
import type { ComputerOverview } from '../overview.js';

const targetId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || value === 'local') throw new Error('远端登记 id 无效或与本机保留名称冲突。'); return value;
};
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}无效。`); return value;
}
function remoteAbsolute(value: unknown, label: string): string {
  const path = string(value, label); if (!win32.isAbsolute(path) && !posix.isAbsolute(path)) throw new Error(`${label}必须为绝对路径。`); return path;
}
function command(value: unknown): AgentCommand {
  if (!isObject(value) || !Array.isArray(value.args) || value.args.length > 100 || value.args.some(item => typeof item !== 'string' || item.length > 4000 || /[\x00-\x1f]/.test(item))) throw new Error('登记的 CLI 参数无效。');
  return { command: remoteAbsolute(value.command, 'CLI 命令'), args: value.args as string[] };
}
export function parseTargetRegistry(raw: unknown): RemoteTargetRegistration[] {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.targets) || raw.targets.length > 100) throw new Error('agents.json 需要 version:1 和 targets 数组。');
  const ids = new Set<string>();
  return raw.targets.map(value => {
    if (!isObject(value)) throw new Error('远端登记格式无效。');
    const id = targetId(value.id); if (ids.has(id)) throw new Error('远端登记 id 重复。'); ids.add(id);
    const sshConfig = string(value.sshConfig, 'SSH 配置'); if (!isAbsolute(sshConfig)) throw new Error('SSH 配置必须为此桥电脑上的绝对路径。');
    const alias = string(value.alias, 'SSH 别名'); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(alias)) throw new Error('SSH 别名无效。');
    const expectedHostname = string(value.expectedHostname, '电脑名称'); if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(expectedHostname)) throw new Error('登记的电脑名称无效。');
    if (!isObject(value.engines) || !Object.keys(value.engines).length || Object.keys(value.engines).some(name => name !== 'codex' && name !== 'claude')) throw new Error('远端登记的 engines 无效。');
    const engines: RemoteTargetRegistration['engines'] = {};
    for (const agent of ['codex', 'claude'] as const) {
      const engine = value.engines[agent]; if (engine == null) continue;
      if (!isObject(engine)) throw new Error('远端引擎格式无效。');
      engines[agent] = { agentCommand: command(engine.agentCommand), defaultCwd: remoteAbsolute(engine.defaultCwd, '远端默认目录') };
    }
    // Credentials and extra policy fields are not copied into a persisted worker binding.
    return { id, label: string(value.label, '目标名称'), expectedHostname, sshConfig, alias,
      remoteRoot: remoteAbsolute(value.remoteRoot, '远端运行目录'), nodePath: remoteAbsolute(value.nodePath, '远端 Node 命令'), engines,
      ...(value.allowedUserIds === undefined ? {} : { allowedUserIds: (() => {
        if (!Array.isArray(value.allowedUserIds) || value.allowedUserIds.length > 100 || value.allowedUserIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,199}$/.test(id))) throw new Error('目标电脑 allowedUserIds 无效。');
        return [...new Set(value.allowedUserIds as string[])];
      })() }) };
  });
}
export class TargetCatalogService {
  private readonly cache = new Map<string, RemoteTargetRegistration[]>();
  private readonly remote = new Map<string, RemoteAgentAdapter>();
  private readonly local = new Map<AgentName, AgentAdapter>();
  private readonly overviewCache = new Map<string, ComputerOverview[]>();
  private readonly nativeSessions: NativeSessionService;
  constructor(private readonly config: BridgeConfig, private readonly localAdapters: Record<AgentName, AgentAdapter>, private readonly options: RemoteAdapterOptions & { nativeSessions?: NativeSessionService } = {}) {
    this.nativeSessions = options.nativeSessions ?? new NativeSessionService(config.dataDir, {
      codex: { agentCommand: config.commands.codex, defaultCwd: config.workspace }, claude: { agentCommand: config.commands.claude, defaultCwd: config.workspace },
    });
  }
  private async registrations(workspace: string, refresh = false): Promise<RemoteTargetRegistration[]> {
    const cached = this.cache.get(workspace); if (!refresh && cached) return cached;
    let entries: RemoteTargetRegistration[];
    try {
      const path = join(workspace, 'agents.json'); const info = await stat(path); if (!info.isFile() || info.size > 512 * 1024) throw new Error('agents.json 不是普通小型登记文件。');
      entries = parseTargetRegistry(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = []; else throw error; }
    this.cache.set(workspace, entries); return entries;
  }
  async listTargets(workspace: string, refresh = false): Promise<TargetSummary[]> {
    return [{ id: 'local', label: '当前桥电脑', transport: 'local', engines: ['codex', 'claude'], availability: 'local' },
      ...(await this.registrations(workspace, refresh)).map(value => ({ id: value.id, label: value.label, transport: 'ssh' as const,
        expectedHostname: value.expectedHostname, engines: Object.keys(value.engines) as AgentName[], availability: 'registered' as const }))];
  }
  async resolveTarget(workspace: string, id: string, agent: AgentName, cwd?: string): Promise<ExecutionTargetBinding> {
    if (agent !== 'codex' && agent !== 'claude') throw new Error('引擎名称无效。');
    if (id === 'local') {
      const localCwd = cwd ?? workspace; if (!isAbsolute(localCwd) || !(await stat(localCwd)).isDirectory()) throw new Error('本机工作目录无效。');
      return { id: 'local', label: '当前桥电脑', transport: 'local', agent, agentCommand: this.config.commands[agent], cwd: localCwd };
    }
    const registration = (await this.registrations(workspace)).find(value => value.id === id); if (!registration) throw new Error('目标电脑未在 agents.json 登记。');
    const engine = registration.engines[agent]; if (!engine) throw new Error('此目标电脑未登记所选引擎。');
    const remoteCwd = cwd === undefined ? engine.defaultCwd : remoteAbsolute(cwd, '远端工作目录');
    return { id: registration.id, label: registration.label, transport: 'ssh', expectedHostname: registration.expectedHostname,
      sshConfig: registration.sshConfig, alias: registration.alias, remoteRoot: registration.remoteRoot, nodePath: registration.nodePath,
      agent, agentCommand: engine.agentCommand, cwd: remoteCwd };
  }
  adapterFor(binding: ExecutionTargetBinding): AgentAdapter {
    if (binding.transport === 'local') {
      let wrapper = this.local.get(binding.agent); if (wrapper) return wrapper;
      const adapter = this.localAdapters[binding.agent], service = this.nativeSessions, agent = binding.agent;
      wrapper = {
        run: async turn => {
          if (turn.conversation.nativeId) await service.assertRunOwnership({ agent, profile: 'default', nativeId: turn.conversation.nativeId }, turn.conversation.userId, turn.conversation.id);
          return adapter.run({ ...turn, onNativeId: nativeId => {
            service.bindRunOwnership({ agent, profile: 'default', nativeId }, turn.conversation.userId, turn.conversation.id); turn.onNativeId?.(nativeId);
          } });
        },
        interrupt: id => adapter.interrupt(id), close: () => adapter.close(),
        ...(adapter.steer ? { steer: (id, message) => adapter.steer!(id, message) } : {}),
        ...(adapter.confirmStopped ? { confirmStopped: id => adapter.confirmStopped!(id) } : {}),
        ...(adapter.getModelInfo ? { getModelInfo: cwd => adapter.getModelInfo!(cwd) } : {}),
      };
      this.local.set(agent, wrapper); return wrapper;
    }
    const key = fingerprint(binding); let adapter = this.remote.get(key);
    if (!adapter) { adapter = new RemoteAgentAdapter(binding, this.config, this.options); this.remote.set(key, adapter); } return adapter;
  }
  async authorizeNativeAccess(workspace: string, userId: string, id: string): Promise<void> {
    if (!this.config.allowedUserIds.includes(userId)) throw new Error('用户不在机器人白名单中。');
    const owner = this.config.allowedUserIds[0];
    const registration = id === 'local' ? null : (await this.registrations(workspace)).find(item => item.id === id);
    if (id !== 'local' && !registration) throw new Error('目标电脑未登记。');
    const allowed = registration?.allowedUserIds ?? (owner ? [owner] : []);
    if (!allowed.includes(userId)) throw new Error('用户未获此电脑原生会话历史的访问权限。');
  }
  async listNativeSessions(binding: ExecutionTargetBinding, userId: string, query: Omit<NativeSessionQuery, 'agent' | 'userId'>): Promise<NativeSessionPage> {
    return binding.transport === 'ssh' ? (this.adapterFor(binding) as RemoteAgentAdapter).listNativeSessions(userId, query)
      : this.nativeSessions.list({ ...query, userId, agent: binding.agent });
  }
  async readNativeSession(binding: ExecutionTargetBinding, userId: string, ref: NativeSessionRef, options?: NativeSessionReadOptions): Promise<NativeSessionRead> {
    if (ref.agent !== binding.agent) throw new Error('原生会话引擎与目标登记不一致。');
    return binding.transport === 'ssh' ? (this.adapterFor(binding) as RemoteAgentAdapter).readNativeSession(userId, ref, options) : this.nativeSessions.read(userId, ref, options);
  }
  async adoptNativeSession(binding: ExecutionTargetBinding, userId: string, args: NativeSessionAdoptArgs): Promise<NativeSessionAdoption> {
    if (args.ref.agent !== binding.agent) throw new Error('原生会话引擎与目标登记不一致。');
    return binding.transport === 'ssh' ? (this.adapterFor(binding) as RemoteAgentAdapter).adoptNativeSession(userId, args) : this.nativeSessions.adopt(userId, args);
  }
  async computerOverview(workspace: string, refresh = false): Promise<ComputerOverview[]> {
    const cached = this.overviewCache.get(workspace); if (!refresh && cached) return cached;
    const targets = await this.listTargets(workspace, refresh); const results: ComputerOverview[] = [];
    for (const target of targets) {
      const item: ComputerOverview = { targetId: target.id, label: target.label, transport: target.transport, connection: 'unknown', checkedAt: new Date().toISOString(), agents: target.engines.map(agent => ({ agent, cli: 'unknown' })) };
      if (target.transport === 'local') {
        item.connection = 'connected'; item.agents = target.engines.map(agent => ({ agent, cli: existsSync(this.config.commands[agent].command) && this.config.commands[agent].args.filter(arg => isAbsolute(arg) && /\.(?:js|mjs|cjs)$/i.test(arg)).every(arg => existsSync(arg)) ? 'ready' : 'unavailable' }));
      } else {
        try {
          const binding = await this.resolveTarget(workspace, target.id, target.engines[0]!);
          const hello = await (this.adapterFor(binding) as RemoteAgentAdapter).probeEntries(); item.connection = 'connected';
          item.agents = target.engines.map(agent => ({ agent, cli: hello.cliEntries?.[agent] ?? 'unknown' }));
        } catch { item.connection = 'unreachable'; item.reason = '目标执行器或 SSH 连接未就绪；未启动模型任务。'; }
      }
      results.push(item);
    }
    this.overviewCache.set(workspace, results); return results;
  }
  async handoff(binding: ExecutionTargetBinding, nativeId: string, cwd: string, agent: AgentName): Promise<RemoteHandoff> {
    if (binding.agent !== agent || binding.cwd !== cwd || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(nativeId)) throw new Error('交接的会话或目标与登记不一致。');
    if (binding.transport === 'ssh') await (this.adapterFor(binding) as RemoteAgentAdapter).handoff(nativeId, cwd);
    else this.nativeSessions.leases.release({ agent, profile: 'default', nativeId });
    // Runtime invokes local handoff only after its native adapter has completed/closed.
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const args = agent === 'codex' ? ['resume', nativeId] : ['--resume', nativeId];
    const resumeCommand = `Set-Location -LiteralPath ${quote(cwd)}; & ${[binding.agentCommand.command, ...binding.agentCommand.args, ...args].map(quote).join(' ')}`;
    return { targetId: binding.id, nativeId, cwd, agent, resumeCommand, stopped: true };
  }
  /** Only local SSH clients close; target-native daemons and their tasks remain independent. */
  async close(): Promise<void> { const adapters = [...this.remote.values()]; this.remote.clear(); await Promise.all(adapters.map(adapter => adapter.close())); this.nativeSessions.close(); }
}
