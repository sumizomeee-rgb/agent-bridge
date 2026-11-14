import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ExternalControllerAdapter } from './external.js';

export interface ExternalControllerEndpoint {
  id: string; adapter: ExternalControllerAdapter; submit: (requestId: string, text: string) => Promise<void>;
  hasInput?: (requestId: string) => boolean;
  handoff?: (operationId:string,previousSessionId:string,sessionId:string)=>Promise<string>;
}
export interface ExternalControllerServerOptions { hostDataDir: string; controllers: ExternalControllerEndpoint[] }
export interface ExternalServerLocation { host: '127.0.0.1'; port: number; manifestPath: string }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function field(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\0]/.test(value)) throw new HttpError(400, label + '无效');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求必须是JSON对象');
  return value as Record<string, unknown>;
}
/** Local capability endpoint. Transport identity and ownership are supplied by the host, never by callers. */
export class ExternalControllerServer {
  private server?: Server;
  private database?: DatabaseSync;
  private readonly endpoints = new Map<string, ExternalControllerEndpoint>();
  private readonly tokens = new Map<string, string>();
  private readonly activeInputs = new Set<Promise<unknown>>();
  private location?: ExternalServerLocation;
  constructor(private readonly options: ExternalControllerServerOptions) {
    for (const endpoint of options.controllers) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(endpoint.id) || this.endpoints.has(endpoint.id)) throw new Error('外部主控ID无效或重复');
      this.endpoints.set(endpoint.id, endpoint);
    }
  }
  async start(): Promise<ExternalServerLocation> {
    if (this.location) return this.location;
    mkdirSync(this.options.hostDataDir, { recursive: true });
    const staleManifest = join(this.options.hostDataDir, 'external-api.json'); if (existsSync(staleManifest)) unlinkSync(staleManifest);
    const privateDir = join(this.options.hostDataDir, 'external-api'); mkdirSync(privateDir, { recursive: true });
    for (const id of this.endpoints.keys()) {
      const path = join(privateDir, id + '.json'); let token: string;
      if (existsSync(path)) {
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        if (saved.version !== 1 || saved.controllerId !== id || typeof saved.token !== 'string' || !/^[a-f0-9]{64}$/.test(saved.token)) throw new Error('外部主控凭据登记无效');
        token = saved.token;
      } else { token = randomBytes(32).toString('hex'); writeFileSync(path, JSON.stringify({ version: 1, controllerId: id, token }), { flag: 'wx', mode: 0o600 }); }
      this.tokens.set(id, token);
    }
    this.database = new DatabaseSync(join(this.options.hostDataDir, 'external-input.sqlite'));
    this.database.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS inputs(controller_id TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(controller_id,request_id));");
    const server = this.server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地API未取得端口');
    this.location = { host: '127.0.0.1', port: address.port, manifestPath: join(this.options.hostDataDir, 'external-api.json') };
    writeFileSync(this.location.manifestPath, JSON.stringify({ version: 1, status: 'ready', host: this.location.host, port: address.port,
      controllers: [...this.endpoints.keys()].map(id => ({ id, url: `http://127.0.0.1:${address.port}/controllers/${id}`, token: this.tokens.get(id) })) }, null, 2), { mode: 0o600 });
    return this.location;
  }
  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (Number(request.headers['content-length'] ?? 0) > 65536) throw new HttpError(413, '请求超过64KiB');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > 65536) throw new HttpError(413, '请求超过64KiB'); chunks.push(bytes); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON无效'); }
  }
  private send(response: ServerResponse, status: number, value: unknown): void {
    if (!response.headersSent) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value ?? null)); }
  }
  private async input(endpoint: ExternalControllerEndpoint, requestId: string, text: string): Promise<unknown> {
    const signature = createHash('sha256').update(JSON.stringify({ text })).digest('hex');
    const row = this.database!.prepare('SELECT signature,status FROM inputs WHERE controller_id=? AND request_id=?').get(endpoint.id, requestId);
    if (row) { if (row.signature !== signature) throw new HttpError(409, 'requestId参数冲突'); return { status: row.status === 'accepted' ? 'accepted' : 'unknown', duplicate: true }; }
    this.database!.prepare("INSERT INTO inputs VALUES(?,?,?,'unknown')").run(endpoint.id, requestId, signature);
    const submit = Promise.resolve().then(() => endpoint.submit(requestId, text)); this.activeInputs.add(submit);
    try { await submit; this.database!.prepare("UPDATE inputs SET status='accepted' WHERE controller_id=? AND request_id=?").run(endpoint.id, requestId); return { status: 'accepted', duplicate: false }; }
    catch { return { status: 'unknown', duplicate: false }; }
    finally { this.activeInputs.delete(submit); }
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.socket.remoteAddress !== '127.0.0.1') throw new HttpError(403, '仅限本机');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1'), match = /^\/controllers\/([A-Za-z0-9_.-]+)\/(connect|events|accept|call|finish|input|status|handoff)$/.exec(url.pathname);
      if (!match) throw new HttpError(404, '接口不存在');
      const endpoint = this.endpoints.get(match[1]!); if (!endpoint) throw new HttpError(404, '主控不存在');
      const expected = this.tokens.get(endpoint.id)!, supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!/^[a-f0-9]{64}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new HttpError(401, '认证失败');
      const action = match[2]!;
      if(action==='status'){
        if(request.method!=='GET')throw new HttpError(405,'需要GET');
        const requestId=url.searchParams.get('requestId'),decisionId=url.searchParams.get('decisionId'),callId=url.searchParams.get('callId');
        if(callId&&!decisionId)throw new HttpError(400,'callId需要decisionId');
        const result=endpoint.adapter.status({...(decisionId?{decisionId:field(decisionId,'decisionId')}:{}),...(callId?{callId:field(callId,'callId')}:{})});
        if(requestId){
          field(requestId,'requestId');
          const row=this.database!.prepare('SELECT status FROM inputs WHERE controller_id=? AND request_id=?').get(endpoint.id,requestId);
          let status=row?String(row.status):'not_found';
          if(status==='unknown'&&endpoint.hasInput?.(requestId)){
            this.database!.prepare("UPDATE inputs SET status='accepted' WHERE controller_id=? AND request_id=?").run(endpoint.id,requestId);status='accepted';
          }
          result.input={requestId,status};
        }
        this.send(response,200,result);return;
      }
      if (action === 'events') {
        if (request.method !== 'GET') throw new HttpError(405, '需要GET');
        const after = Number(url.searchParams.get('after') ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after无效');
        this.send(response, 200, endpoint.adapter.events(field(url.searchParams.get('lease'), 'lease'), after)); return;
      }
      if (request.method !== 'POST') throw new HttpError(405, '需要POST');
      const body = await this.body(request); let result: unknown;
      if (action === 'connect') result = endpoint.adapter.connect(field(body.instanceId, 'instanceId'), field(body.sessionId, 'sessionId'));
      else if(action==='handoff'){
        if(Object.keys(body).some(key=>!['lease','previousSessionId','instanceId','sessionId'].includes(key)))throw new HttpError(400,'交接参数无效');
        if(!endpoint.handoff)throw new HttpError(409,'主控未提供交接入口');
        result=await endpoint.adapter.handoff(field(body.lease,'lease'),field(body.previousSessionId,'previousSessionId'),field(body.instanceId,'instanceId'),field(body.sessionId,'sessionId'),endpoint.handoff);
      }
      else if (action === 'input') {
        if (Object.keys(body).some(key => key !== 'requestId' && key !== 'text')) throw new HttpError(400, '输入仅接受requestId和text');
        result = await this.input(endpoint, field(body.requestId, 'requestId'), field(body.text, 'text', 65536));
      } else {
        const lease = field(body.lease, 'lease'), decisionId = field(body.decisionId, 'decisionId');
        if (action === 'accept') { endpoint.adapter.accept(lease, decisionId); result = { status: 'accepted' }; }
        else if (action === 'finish') result = await endpoint.adapter.finish(lease, decisionId);
        else result = await endpoint.adapter.call(lease, decisionId, field(body.callId, 'callId'), field(body.name, 'name'), object(body.args));
      }
      this.send(response, 200, result);
    } catch (error) { request.resume(); this.send(response, error instanceof HttpError ? error.status : 409, { error: error instanceof Error ? error.message : '接口处理失败' }); }
  }
  async close(): Promise<void> {
    if (this.location && existsSync(this.location.manifestPath)) unlinkSync(this.location.manifestPath);
    const server = this.server; this.server = undefined; this.location = undefined;
    if (server) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    await Promise.allSettled(this.activeInputs); this.database?.close(); this.database = undefined; this.tokens.clear();
  }
}
