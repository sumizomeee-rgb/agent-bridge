import { randomUUID } from 'node:crypto';
import { win32, posix, join } from 'node:path';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { JsonLineProcess, isObject } from '../agents/process.js';
import type { ExecutionTargetBinding, RemoteClient } from './types.js';

interface Endpoint { version: 1; hostname: string; port: number; token: string }
/** Private metadata is transferred by SFTP; it never appears in a command argument or registry. */
export function remoteMetadataSpec(binding: ExecutionTargetBinding): string {
  const windows = /^[A-Za-z]:[\\/]/.test(binding.remoteRoot!);
  const path = windows ? win32.join(binding.remoteRoot!, '.local', 'remote', 'endpoint.json').replaceAll('\\', '/') : posix.join(binding.remoteRoot!, '.local', 'remote', 'endpoint.json');
  if (/[\x00-\x1f"\r\n]/.test(path)) throw new Error('远端元数据路径无效。');
  return `${binding.alias}:${path}`;
}
export function requestRemoteHttp<T>(port: number, token: string, method: string, args: unknown, timeoutMs = 20_000): Promise<T> {
  const body = JSON.stringify({ method, args });
  return new Promise<T>((resolveValue, reject) => {
    // node:http always connects directly; bridge/global HTTP proxy settings cannot intercept this token.
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/rpc', method: 'POST', agent: false,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let data = ''; response.setEncoding('utf8');
      response.on('data', (chunk: string) => { data += chunk; if (data.length > 16 * 1024 * 1024) response.destroy(new Error('远端单条回执超过限制。')); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value: unknown = JSON.parse(data);
          if (!isObject(value)) throw new Error('远端返回无效协议。');
          if (isObject(value.error)) throw Object.assign(new Error(typeof value.error.message === 'string' ? value.error.message : '远端请求失败。'), { code: value.error.code });
          if (response.statusCode !== 200 || !('result' in value)) throw new Error('远端返回无效状态。');
          resolveValue(value.result as T);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('远端协议响应超时。'), { code: 'TRANSPORT_UNKNOWN' })));
    request.on('error', reject); request.end(body);
  });
}
async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveValue, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveValue); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法分配本地隧道端口。');
  const port = address.port; await new Promise<void>(resolveValue => server.close(() => resolveValue())); return port;
}
export class SshRemoteClient implements RemoteClient {
  private transport: JsonLineProcess | null = null;
  private metadataCopy: JsonLineProcess | null = null;
  private endpoint: Endpoint | null = null;
  private port = 0;
  private startup: Promise<void> | null = null;
  private closed = false;
  constructor(private readonly binding: ExecutionTargetBinding, private readonly cwd: string, private readonly timeoutMs = 20_000) {}
  private async initialize(): Promise<void> {
    if (this.closed) throw new Error('远端隧道客户端已关闭。');
    const directory = await mkdtemp(join(tmpdir(), 'rin-remote-endpoint-')); const path = join(directory, `${randomUUID()}.json`);
    try {
      await new Promise<void>((resolveValue, reject) => {
        const copy = new JsonLineProcess({ command: 'scp', args: ['-q', '-F', this.binding.sshConfig!, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', remoteMetadataSpec(this.binding), path] }, [], this.cwd, {});
        this.metadataCopy = copy;
        const timer = setTimeout(() => { void copy.stop(false).catch(() => {}); reject(new Error('获取远端连接元数据超时。')); }, this.timeoutMs);
        copy.child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动远端连接元数据传输。')); });
        copy.child.on('close', code => { clearTimeout(timer); this.metadataCopy = null; code === 0 ? resolveValue() : reject(new Error('获取远端连接元数据失败；请确认目标执行器已启动。')); });
      });
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isObject(raw) || raw.version !== 1 || typeof raw.hostname !== 'string' || raw.hostname.toLowerCase() !== this.binding.expectedHostname!.toLowerCase()
        || !Number.isSafeInteger(raw.port) || Number(raw.port) < 1 || Number(raw.port) > 65535 || typeof raw.token !== 'string' || !/^[a-f0-9]{64}$/.test(raw.token)) throw new Error('远端连接元数据与目标登记不一致。');
      this.endpoint = raw as unknown as Endpoint;
    } finally { await unlink(path).catch(() => {}); await rmdir(directory).catch(() => {}); }
    if (this.closed) throw new Error('远端隧道客户端已关闭。');
    this.port = await freeLoopbackPort();
    if (this.closed) throw new Error('远端隧道客户端已关闭。');
    this.transport = new JsonLineProcess({ command: 'ssh', args: ['-F', this.binding.sshConfig!, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-N', '-n', '-T',
      '-L', `127.0.0.1:${this.port}:127.0.0.1:${this.endpoint!.port}`, this.binding.alias!] }, [], this.cwd, {});
    let failed: Error | null = null; this.transport.onFailure(error => { failed = error; });
    const deadline = Date.now() + this.timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      if (failed) throw failed;
      try {
        const hello = await requestRemoteHttp<{ hostname: string; version: number }>(this.port, this.endpoint!.token, 'hello', {}, 750);
        if (hello.version !== 1 || hello.hostname.toLowerCase() !== this.binding.expectedHostname!.toLowerCase()) throw Object.assign(new Error('隧道目标电脑名称不符。'), { code: 'REMOTE_REJECTED' });
        return;
      } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'REMOTE_REJECTED') throw error; }
      await new Promise<void>(resolveValue => setTimeout(resolveValue, 100));
    }
    throw new Error('远端认证 loopback 隧道连接超时。');
  }
  async request<T = unknown>(method: string, args: unknown): Promise<T> {
    if (this.closed) throw new Error('远端隧道客户端已关闭。');
    this.startup ??= this.initialize(); await this.startup;
    return requestRemoteHttp<T>(this.port, this.endpoint!.token, method, args, this.timeoutMs);
  }
  async close(): Promise<void> { this.closed = true; await this.metadataCopy?.stop(false); await this.transport?.stop(false); this.transport = null; this.endpoint = null; }
}
