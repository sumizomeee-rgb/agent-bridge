import { hostname } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { lstat, realpath, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative, dirname, extname, basename } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { CodexAdapter } from '../agents/codex.js';
import { ClaudeAdapter } from '../agents/claude.js';
import { JsonLineProcess, safeError, isObject } from '../agents/process.js';
import { collectOutgoingAttachments } from '../artifacts.js';
import { isModelId } from '../config.js';
import type { AgentAdapter, AgentName, AgentTurn, AgentInput, AgentSupplement, SteerResult } from '../types.js';
import type { RemoteArtifact, RemoteDaemonConfig, RemoteDispatch, RemoteJob, RemoteRequest, RemoteResponse } from './types.js';
import { RemoteStore, fingerprint, type ProcessRecord } from './store.js';

const CHUNK = 192 * 1024;
const MAX_BYTES = 24 * 1024 * 1024;
const identifier = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) throw new Error(`${label}无效。`); return value;
};
function text(value: unknown, label: string, limit = 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new Error(`${label}无效。`); return value;
}
export function remoteDataDirectory(root: string): string { return join(resolve(root), '.local', 'remote'); }
export function remoteEndpoint(root: string): string {
  const hash = createHash('sha256').update(process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\imus-rin-${hash}` : join(remoteDataDirectory(root), `ipc-${hash}.sock`);
}
export function loadRemoteConfig(root: string): RemoteDaemonConfig {
  const value: unknown = JSON.parse(readFileSync(join(remoteDataDirectory(root), 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!isObject(value) || value.version !== 1 || typeof value.expectedHostname !== 'string' || !value.expectedHostname.trim()
    || !isObject(value.engines) || Object.keys(value.engines).some(key => key !== 'codex' && key !== 'claude')) throw new Error('远端执行器登记配置无效。');
  if (value.proxyPort != null && (!Number.isSafeInteger(value.proxyPort) || Number(value.proxyPort) < 1 || Number(value.proxyPort) > 65535)) throw new Error('远端代理端口无效。');
  for (const entry of Object.values(value.engines)) {
    if (!isObject(entry) || !isObject(entry.agentCommand) || typeof entry.agentCommand.command !== 'string'
      || !isAbsolute(entry.agentCommand.command) || !Array.isArray(entry.agentCommand.args)
      || entry.agentCommand.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || typeof entry.defaultCwd !== 'string' || !isAbsolute(entry.defaultCwd)) throw new Error('远端引擎命令或默认目录无效。');
  }
  if (!Object.keys(value.engines).length) throw new Error('远端执行器没有登记引擎。');
  return value as unknown as RemoteDaemonConfig;
}

/** Process identity is checked before signalling a persisted PID; never kill a reused PID. */
export async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') {
    try { const raw = await readFile(`/proc/${pid}/stat`, 'utf8'); return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19] ?? null; }
    catch { return null; }
  }
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop;if($p){[Console]::Write($p.CreationDate.ToUniversalTime().Ticks)}`;
  return new Promise(resolveValue => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); resolveValue(null); }, 8000);
    child.stdout.on('data', part => { if (output.length < 200) output += String(part); });
    child.on('error', () => { clearTimeout(timer); resolveValue(null); });
    child.on('close', () => { clearTimeout(timer); resolveValue(/^\d+$/.test(output.trim()) ? output.trim() : null); });
  });
}
async function stopPersisted(record: ProcessRecord): Promise<boolean> {
  const current = await processIdentity(record.pid);
  if (!current) { try { process.kill(record.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; } return false; }
  if (!record.identity || current !== record.identity) return current !== record.identity && record.identity !== null;
  if (process.platform === 'win32') await new Promise<void>(resolveValue => {
    const child = spawn('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolveValue(); }, 5000);
    child.on('error', () => { clearTimeout(timer); resolveValue(); }); child.on('close', () => { clearTimeout(timer); resolveValue(); });
  });
  else { try { process.kill(-record.pid, 'SIGKILL'); } catch { try { process.kill(record.pid, 'SIGKILL'); } catch {} } }
  for (let i = 0; i < 20; i++) {
    try { process.kill(record.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    const observed = await processIdentity(record.pid); if (observed && observed !== record.identity) return true;
    await new Promise<void>(resolveValue => setTimeout(resolveValue, 100));
  }
  return false;
}

export interface RemoteDaemonOptions {
  /** Test seam only; production always uses target-native adapters and current target environment. */
  adapterFactory?: (agent: AgentName, dispatch: RemoteDispatch, track: (process: JsonLineProcess) => void) => AgentAdapter;
}
export class RemoteDaemon {
  readonly store: RemoteStore;
  readonly dataDirectory: string;
  private readonly active = new Map<string, { adapter: AgentAdapter; abort: AbortController; done: Promise<void> }>();
  private readonly operations = new Map<string, Promise<SteerResult>>();
  private readonly dispatches = new Map<string, { fingerprint: string; promise: Promise<RemoteJob> }>();
  private readonly metadataAdapters = new Set<AgentAdapter>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private httpServer: HttpServer | null = null;
  private closing = false;
  private token: string;
  constructor(readonly root: string, readonly config: RemoteDaemonConfig, private readonly options: RemoteDaemonOptions = {}) {
    if (hostname().toLowerCase() !== config.expectedHostname.toLowerCase()) throw new Error('远端电脑名称与登记不一致，拒绝启动。');
    this.dataDirectory = remoteDataDirectory(root); this.store = new RemoteStore(this.dataDirectory);
    const tokenFile = join(this.dataDirectory, 'ipc-token');
    if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    this.token = readFileSync(tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new Error('远端 IPC 凭据无效。');
  }
  async listen(): Promise<void> {
    this.server = createServer(socket => this.connection(socket));
    await new Promise<void>((resolveValue, reject) => { this.server!.once('error', reject); this.server!.listen(remoteEndpoint(this.root), () => { this.server!.off('error', reject); resolveValue(); }); });
    // Only the daemon that acquired the IPC endpoint may reconcile the journal.
    // A duplicate service launch must never mutate another daemon's live jobs.
    for (const job of this.store.jobs()) if (job.status === 'running') this.store.update(job.dispatchId, { status: 'uncertain', ready: false, error: '远端托管器曾中断，原生进程及结果需核实；未重新执行任务。' });
    this.httpServer = createHttpServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/rpc' || request.headers.authorization !== `Bearer ${this.token}`) {
        request.resume(); response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":{"code":"REMOTE_REJECTED","message":"远端请求未授权。"}}'); return;
      }
      let body = ''; let rejected = false;
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        if (rejected) return;
        body += chunk;
        if (body.length > 4 * 1024 * 1024 && !rejected) { rejected = true; body = ''; response.writeHead(413); response.end('{"error":{"code":"REMOTE_REJECTED","message":"远端协议请求超过限制。"}}'); }
      });
      request.on('error', () => {});
      request.on('end', () => {
        if (rejected) return;
        let message: Record<string, unknown>;
        try { const parsed: unknown = JSON.parse(body); if (!isObject(parsed) || typeof parsed.method !== 'string' || !isObject(parsed.args)) throw new Error('无效协议'); message = parsed; }
        catch { response.writeHead(400); response.end('{"error":{"code":"REMOTE_REJECTED","message":"远端协议格式无效。"}}'); return; }
        void this.handle(message.method as string, message.args).then(result => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ result }));
        }, error => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: {
            code: typeof error?.code === 'string' ? error.code : 'REMOTE_REJECTED', message: safeError(error instanceof Error ? error.message : '', '远端请求失败'),
          } }));
        });
      });
    });
    this.httpServer.requestTimeout = 30_000; this.httpServer.headersTimeout = 10_000;
    await new Promise<void>((resolveValue, reject) => { this.httpServer!.once('error', reject); this.httpServer!.listen(0, '127.0.0.1', () => { this.httpServer!.off('error', reject); resolveValue(); }); });
    const address = this.httpServer.address(); if (!address || typeof address === 'string') throw new Error('无法读取远端 loopback 端口。');
    const metadata = { version: 1, hostname: hostname(), port: address.port, token: this.token };
    const temporary = join(this.dataDirectory, `endpoint-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 }); renameSync(temporary, join(this.dataDirectory, 'endpoint.json'));
  }
  private connection(socket: Socket): void {
    this.sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';
    socket.on('close', () => this.sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', (part: string) => {
      buffer += part; if (buffer.length > 16 * 1024 * 1024) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let request: RemoteRequest;
        try { request = JSON.parse(line) as RemoteRequest; if (!isObject(request) || request.token !== this.token || typeof request.id !== 'string') throw new Error('IPC 请求未授权。'); }
        catch { socket.destroy(); return; }
        void this.handle(request.method, request.args).then(result => this.respond(socket, { id: request.id, result }), error => this.respond(socket, {
          id: request.id, error: { code: typeof error?.code === 'string' ? error.code : 'REMOTE_REJECTED', message: safeError(error instanceof Error ? error.message : '', '远端请求失败') },
        }));
      }
    });
  }
  private respond(socket: Socket, response: RemoteResponse): void { if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`); }
  async handle(method: string, raw: unknown): Promise<unknown> {
    if (!isObject(raw)) throw new Error('远端请求参数无效。');
    if (method === 'hello') return { hostname: hostname(), platform: process.platform, engines: Object.keys(this.config.engines), version: 1 };
    if (method === 'query') {
      const id = identifier(raw.dispatchId, '派发编号');
      const pending = this.dispatches.get(id); if (pending) await pending.promise;
      const job = this.store.job(id); if (!job) throw Object.assign(new Error('此派发编号未在目标电脑登记，未自动重新执行。'), { code: 'DISPATCH_NOT_FOUND' }); return job;
    }
    if (method === 'upload') return this.upload(raw);
    if (method === 'artifact') return this.artifact(raw);
    if (method === 'dispatch') {
      const id = identifier(raw.dispatchId, '派发编号'); const hash = fingerprint(raw); const pending = this.dispatches.get(id);
      if (pending) { if (pending.fingerprint !== hash) throw new Error('同一派发编号的内容冲突。'); return pending.promise; }
      const promise = Promise.resolve().then(() => this.dispatch(raw)).finally(() => this.dispatches.delete(id));
      this.dispatches.set(id, { fingerprint: hash, promise }); return promise;
    }
    if (method === 'steer') return this.steer(raw);
    if (method === 'interrupt') return this.interrupt(identifier(raw.dispatchId, '派发编号'));
    if (method === 'handoff') return this.handoff(raw);
    if (method === 'models') {
      const agent = this.agent(raw.agent); const engine = this.config.engines[agent]!;
      const cwd = await this.directory(raw.cwd ?? engine.defaultCwd); const adapter = this.makeAdapter(agent, { agentCommand: engine.agentCommand } as RemoteDispatch, 'metadata');
      this.metadataAdapters.add(adapter);
      try { if (!adapter.getModelInfo) throw new Error('该远端引擎不支持模型查询。'); return await adapter.getModelInfo(cwd); }
      finally { await adapter.close(); this.metadataAdapters.delete(adapter); }
    }
    throw new Error('未知远端协议操作。');
  }
  private agent(value: unknown): AgentName { if (value !== 'codex' && value !== 'claude' || !this.config.engines[value]) throw new Error('目标电脑未登记此引擎。'); return value; }
  private async directory(value: unknown): Promise<string> { const cwd = text(value, '工作目录', 4000); if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('远端工作目录不存在或不是绝对目录。'); return cwd; }
  private async input(value: unknown): Promise<AgentInput[]> {
    if (!Array.isArray(value) || value.length > 128) throw new Error('原生输入格式无效。');
    const result: AgentInput[] = [];
    for (const item of value) {
      if (!isObject(item)) throw new Error('原生输入格式无效。');
      if (item.type === 'text') result.push({ type: 'text', text: text(item.text, '输入文字') });
      else if (item.type === 'localImage') result.push({ type: 'localImage', path: await this.uploadedPath(item.path) });
      else throw new Error('原生输入类型无效。');
    }
    return result;
  }
  private async uploadedPath(value: unknown): Promise<string> {
    const path = text(value, '附件路径', 4000); const directory = join(this.dataDirectory, 'incoming');
    const actual = await realpath(path); const rel = relative(directory, actual);
    if (!isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel) || (await lstat(path)).isSymbolicLink() || !statSync(path).isFile()) throw new Error('图片未由此远端执行器接收。');
    const expected = /^([a-f0-9]{64})\.[a-z0-9]{1,8}$/.exec(basename(path));
    if (!expected || createHash('sha256').update(await readFile(path)).digest('hex') !== expected[1]) throw new Error('接收的图片尚未完整或校验失败。');
    return path;
  }
  private async dispatch(raw: Record<string, unknown>): Promise<RemoteJob> {
    if (this.closing) throw new Error('远端执行器正在关闭。');
    const id = identifier(raw.dispatchId, '派发编号');
    const old = this.store.job(id);
    if (old) { if (fingerprint(raw) !== fingerprint(this.store.request(id))) throw new Error('同一派发编号的内容冲突。'); return old; }
    const agent = this.agent(raw.agent); const engine = this.config.engines[agent]!;
    if (fingerprint(raw.agentCommand) !== fingerprint(engine.agentCommand)) throw new Error('登记的 CLI 命令与目标执行器配置不一致。');
    const cwd = await this.directory(raw.cwd); const workerId = identifier(raw.workerId, '子任务编号');
    if (this.store.jobs().some(job => job.workerId === workerId && (job.status === 'running' || job.status === 'uncertain'))) throw new Error('同一子会话尚在执行或结果未知，拒绝并发续接。');
    const nativeId = raw.nativeId == null ? null : identifier(raw.nativeId, '原生会话编号');
    if (nativeId) this.store.bindSession(nativeId, workerId, agent, cwd);
    if (raw.model != null && (typeof raw.model !== 'string' || !isModelId(raw.model))) throw new Error('模型选择无效。');
    if (raw.effort != null && (typeof raw.effort !== 'string' || raw.effort.length > 50)) throw new Error('推理强度无效。');
    if (!Array.isArray(raw.imagePaths) || raw.imagePaths.length > 32 || typeof raw.acceptSupplements !== 'boolean') throw new Error('图片或补充选项无效。');
    const imagePaths = await Promise.all(raw.imagePaths.map(path => this.uploadedPath(path)));
    const request: RemoteDispatch = { dispatchId: id, workerId, userId: identifier(raw.userId, '用户编号'), agent, agentCommand: engine.agentCommand, cwd,
      nativeId, text: text(raw.text, '任务文字'), imagePaths, model: raw.model as string | null,
      ...(raw.effort != null ? { effort: raw.effort as string } : {}), acceptSupplements: raw.acceptSupplements,
      ...(raw.input !== undefined ? { input: await this.input(raw.input) } : {}) };
    // Check again after filesystem awaits. The SQLite insert/active check is synchronous.
    const raced = this.store.job(id); if (raced) return this.store.create(request).job;
    if (this.store.jobs().some(job => job.workerId === workerId && (job.status === 'running' || job.status === 'uncertain'))) throw new Error('同一子会话已开始执行，拒绝并发续接。');
    const created = this.store.create(request); if (created.created) this.start(request);
    return created.job;
  }
  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env }; delete env.BRIDGE_TASK_CONTEXT;
    if (this.config.proxyPort != null) for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = `http://127.0.0.1:${this.config.proxyPort}`;
    return env;
  }
  private makeAdapter(agent: AgentName, request: RemoteDispatch, id: string): AgentAdapter {
    const track = (transport: JsonLineProcess): void => {
      const pid = transport.child.pid; if (!pid || id === 'metadata') return;
      const record: ProcessRecord = { dispatchId: id, pid, identity: null, closed: false }; this.store.process(record);
      let closed = false;
      transport.child.once('close', () => { closed = true; if (!this.closing) this.store.process({ ...record, closed: true }); });
      void processIdentity(pid).then(identity => { if (!this.closing) this.store.process({ ...record, identity, closed }); });
    };
    if (this.options.adapterFactory) return this.options.adapterFactory(agent, request, track);
    const factory = (command: RemoteDispatch['agentCommand'], args: string[], cwd: string, env: NodeJS.ProcessEnv) => { const child = new JsonLineProcess(command, args, cwd, env); track(child); return child; };
    return agent === 'codex' ? new CodexAdapter(request.agentCommand, this.environment(), factory) : new ClaudeAdapter(request.agentCommand, this.environment(), factory);
  }
  private start(request: RemoteDispatch): void {
    const adapter = this.makeAdapter(request.agent, request, request.dispatchId); const abort = new AbortController();
    const turn: AgentTurn = { conversation: { id: request.workerId, userId: request.userId, agent: request.agent, nativeId: request.nativeId, model: request.model,
      cwd: request.cwd, title: '远端直属任务', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      text: request.text, imagePaths: request.imagePaths, ...(request.input ? { input: request.input } : {}), ...(request.effort ? { effort: request.effort } : {}),
      acceptSupplements: request.acceptSupplements, signal: abort.signal, onProgress: () => {},
      onReady: () => this.store.update(request.dispatchId, { ready: true }),
      onNativeId: nativeId => { this.store.bindSession(nativeId, request.workerId, request.agent, request.cwd); this.store.update(request.dispatchId, { nativeId }); },
      onModel: actualModel => this.store.update(request.dispatchId, { actualModel }),
      onReasoningEffort: actualEffort => this.store.update(request.dispatchId, { actualEffort }) };
    // Deferring keeps the handle durable before native execution starts.
    const done = Promise.resolve().then(async () => {
      let terminal: Partial<RemoteJob>;
      try {
        const result = await adapter.run(turn);
        this.store.bindSession(result.nativeId, request.workerId, request.agent, request.cwd);
        const captured = await collectOutgoingAttachments(result.text, request.cwd, 10 * 1024 * 1024, MAX_BYTES);
        const artifacts: RemoteArtifact[] = [];
        for (const attachment of [...captured.images.map(item => ({ ...item, image: true })), ...captured.files.map(item => ({ ...item, image: false }))]) {
          const id = randomUUID(); const directory = join(this.dataDirectory, 'artifacts', request.dispatchId); mkdirSync(directory, { recursive: true });
          await writeFile(join(directory, id), attachment.data, { flag: 'wx', mode: 0o600 });
          artifacts.push({ id, filename: attachment.filename, description: attachment.description, image: attachment.image, size: attachment.data.length,
            sha256: createHash('sha256').update(attachment.data).digest('hex') });
        }
        terminal = { status: abort.signal.aborted ? 'cancelled' : 'completed', nativeId: result.nativeId,
          result: { ...result, text: captured.text }, artifacts, ready: false, stopped: true };
      } catch (error) {
        const uncertain = Boolean(error && typeof error === 'object' && 'processStillRunning' in error);
        terminal = { status: uncertain ? 'uncertain' : abort.signal.aborted ? 'cancelled' : 'failed', ready: false,
          error: safeError(error instanceof Error ? error.message : '', '远端任务失败'), stopped: !uncertain };
      }
      this.store.update(request.dispatchId, { ready: false });
      try { await adapter.close(); }
      catch (error) { terminal = { status: 'uncertain', stopped: false, ready: false, error: safeError(error instanceof Error ? error.message : '', 'CLI 退出未确认') }; }
      // Native transport closure is part of completion, not a best-effort postscript.
      this.store.update(request.dispatchId, terminal);
      this.active.delete(request.dispatchId);
    });
    this.active.set(request.dispatchId, { adapter, abort, done });
  }
  private async steer(raw: Record<string, unknown>): Promise<SteerResult> {
    const dispatchId = identifier(raw.dispatchId, '派发编号'); const id = identifier(raw.id, '补充编号');
    const key = `${dispatchId}:${id}`; const old = this.store.receipt(key, raw);
    const inFlight = this.operations.get(key); if (inFlight) return inFlight;
    if (old !== undefined) return old as SteerResult;
    const active = this.active.get(dispatchId); const job = this.store.job(dispatchId);
    if (!active || !job || job.status !== 'running') return { status: 'queued', reason: '该远端任务已结束或结果未知，补充尚未发送。' };
    if (!job.ready) return { status: 'queued', reason: '远端 CLI 尚未进入执行状态，补充尚未发送。' };
    if (!active.adapter.steer) return { status: 'queued', unsupported: true, reason: '此远端引擎不支持实时补充，尚未发送。' };
    const supplement: AgentSupplement = { id, input: await this.input(raw.input) };
    const raced = this.operations.get(key); if (raced) return raced;
    const receipt = this.store.receipt(key, raw); if (receipt !== undefined) return receipt as SteerResult;
    // Persist unknown first. A crash or IPC disconnect cannot authorize duplicate delivery.
    this.store.saveReceipt(key, raw, { status: 'uncertain', reason: '补充已开始提交，尚未确认原生回执。' });
    const operation = active.adapter.steer(job.workerId, supplement).then(result => { this.store.saveReceipt(key, raw, result); return result; }, error => {
      const result: SteerResult = { status: 'uncertain', reason: safeError(error instanceof Error ? error.message : '', '补充回执未知') }; this.store.saveReceipt(key, raw, result); return result;
    }).finally(() => this.operations.delete(key));
    this.operations.set(key, operation); return operation;
  }
  private async interrupt(dispatchId: string): Promise<{ stopped: true }> {
    const job = this.store.job(dispatchId); if (!job) throw new Error('远端任务不存在。');
    const active = this.active.get(dispatchId);
    if (active) {
      await active.adapter.interrupt(job.workerId); active.abort.abort(); await active.done;
      if (this.store.job(dispatchId)?.stopped !== true) throw new Error('未确认目标电脑上的 CLI 已停止。');
      this.store.update(dispatchId, { status: 'cancelled', ready: false, stopped: true });
    } else if (job.status === 'uncertain') {
      const processes = this.store.processes(dispatchId);
      if (!processes.length) throw new Error('没有可靠的远端进程记录，停止结果未知。');
      for (const record of processes) {
        if (!(await stopPersisted(record))) throw new Error('未确认目标电脑上的原生进程已结束。');
        this.store.process({ ...record, closed: true });
      }
      this.store.update(dispatchId, { status: 'cancelled', ready: false, stopped: true });
    } else if (job.stopped !== true) throw new Error('远端停止结果尚未确认。');
    return { stopped: true };
  }
  private async handoff(raw: Record<string, unknown>): Promise<{ stopped: true; nativeId: string }> {
    const nativeId = identifier(raw.nativeId, '原生会话编号'); const agent = this.agent(raw.agent); const cwd = text(raw.cwd, '工作目录', 4000);
    const session = this.store.session(nativeId);
    if (!session || session.agent !== agent || session.cwd !== cwd) throw new Error('远端会话不存在或引擎/工作目录不符。');
    for (const job of this.store.jobs().filter(item => item.nativeId === nativeId)) if (job.status === 'running' || job.status === 'uncertain') await this.interrupt(job.dispatchId);
    this.store.handoff(nativeId); return { stopped: true, nativeId };
  }
  private async upload(raw: Record<string, unknown>): Promise<{ path: string; offset: number; complete: boolean }> {
    const hash = text(raw.sha256, '附件校验', 64); if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('附件校验无效。');
    const name = text(raw.filename, '附件名称', 250); const extension = extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) throw new Error('只接收当前消息声明的图片。');
    const size = Number(raw.size); const offset = Number(raw.offset);
    if (!Number.isSafeInteger(size) || size < 1 || size > 20 * 1024 * 1024 || !Number.isSafeInteger(offset) || offset < 0 || offset > size
      || typeof raw.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data) || raw.data.length > CHUNK * 2) throw new Error('图片分块参数无效。');
    const bytes = Buffer.from(raw.data, 'base64'); if (bytes.length > CHUNK || offset + bytes.length > size) throw new Error('图片分块越界。');
    const directory = join(this.dataDirectory, 'incoming'); mkdirSync(directory, { recursive: true }); const path = join(directory, `${hash}${extension}`);
    const metadataFile = `${path}.json`;
    if (existsSync(metadataFile)) { const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')); if (metadata.size !== size) throw new Error('同一图片校验的大小冲突。'); }
    else writeFileSync(metadataFile, JSON.stringify({ size, sha256: hash }), { flag: 'wx', mode: 0o600 });
    if (existsSync(path) && (await lstat(path)).isSymbolicLink()) throw new Error('接收路径包含链接。');
    const file = await open(path, existsSync(path) ? 'r+' : 'wx', 0o600);
    let current: number;
    try {
      current = (await file.stat()).size;
      if (offset < current) {
        const prior = Buffer.alloc(bytes.length); await file.read(prior, 0, bytes.length, offset);
        if (offset + bytes.length > current || !prior.equals(bytes)) throw new Error('重复图片分块的内容冲突。');
      } else { if (offset !== current) throw new Error('图片分块不连续。'); await file.write(bytes, 0, bytes.length, offset); await file.sync(); current += bytes.length; }
    } finally { await file.close(); }
    const complete = current === size;
    if (complete && createHash('sha256').update(await readFile(path)).digest('hex') !== hash) throw new Error('图片内容校验失败。');
    return { path, offset: current, complete };
  }
  private async artifact(raw: Record<string, unknown>): Promise<{ data: string; offset: number; complete: boolean }> {
    const dispatchId = identifier(raw.dispatchId, '派发编号'); const id = identifier(raw.artifactId, '产物编号');
    const job = this.store.job(dispatchId); const artifact = job?.artifacts?.find(item => item.id === id);
    if (!artifact) throw new Error('此产物没有在任务结果中声明。');
    const offset = Number(raw.offset); if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.size) throw new Error('下载位置无效。');
    const path = join(this.dataDirectory, 'artifacts', dispatchId, id); if ((await lstat(path)).isSymbolicLink()) throw new Error('产物缓存路径包含链接。');
    const file = await open(path, 'r');
    try { const info = await file.stat(); if (info.size !== artifact.size) throw new Error('产物缓存发生变化。'); const bytes = Buffer.alloc(Math.min(CHUNK, artifact.size - offset)); await file.read(bytes, 0, bytes.length, offset); return { data: bytes.toString('base64'), offset: offset + bytes.length, complete: offset + bytes.length === artifact.size }; }
    finally { await file.close(); }
  }
  async close(): Promise<void> {
    if (this.closing) return;
    for (const id of [...this.active.keys()]) await this.interrupt(id);
    // Metadata queries own native CLI transports too. Keep any failed close tracked for retry.
    for (const adapter of [...this.metadataAdapters]) { await adapter.close(); this.metadataAdapters.delete(adapter); }
    this.closing = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.httpServer) { this.httpServer.closeAllConnections(); await new Promise<void>(resolveValue => this.httpServer!.close(() => resolveValue())); }
    if (this.server) await new Promise<void>(resolveValue => this.server!.close(() => resolveValue()));
    this.store.close();
  }
}
