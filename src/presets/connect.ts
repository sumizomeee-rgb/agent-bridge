import { createServer, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { AgentProcessStopError } from '../agents/process.js';
import type { PresetTransport } from './types.js';

/** 固定 TCP 转发避免 Windows OpenSSH 的二进制 stdio 阻塞；不解密 TLS。 */
export async function startPresetConnect(transport: Extract<PresetTransport, { kind: 'ssh-connect' }>, destination: string,
  createTunnel: (command: string, args: string[]) => ChildProcess = (command, args) => spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' })):
Promise<{ proxyUrl: string; close(): Promise<void> }> {
  const reservation = createTcpServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('未取得预设转发端口。');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = createTunnel(transport.sshCommand ?? 'ssh', ['-F', transport.sshConfig, '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-n', '-N', '-T', '-L', `127.0.0.1:${port}:${destination}`, transport.alias]);
  child.stdin?.end(); child.stdout?.resume(); child.stderr?.resume();
  let failure: Error | undefined, exited = false, closing = false;
  const sockets = new Set<Socket>();
  child.once('error', () => { failure = new Error('预设 SSH 转发无法启动。'); });
  child.once('close', () => { exited = true; failure ??= new Error('预设 SSH 转发已退出。'); for (const socket of sockets) socket.destroy(); });
  const stopChild = async () => {
    if (exited || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AgentProcessStopError(child.pid)), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill();
    });
  };
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const server: Server = createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, socket: Socket, head) => {
    if (closing || failure || req.url !== destination || sockets.size >= 64) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    track(socket);
    const upstream = track(connect(port, '127.0.0.1'));
    const close = () => { socket.destroy(); upstream.destroy(); };
    socket.once('error', close); upstream.once('error', close); socket.once('close', close); upstream.once('close', close);
    upstream.once('connect', () => { if (closing || failure) { close(); return; } socket.write('HTTP/1.1 200 Connection established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    const deadline = Date.now() + 12_000;
    for (;;) {
      if (failure) throw failure;
      const ready = await new Promise<boolean>(resolve => {
        const probe = connect(port, '127.0.0.1');
        probe.setTimeout(250, () => { probe.destroy(); resolve(false); });
        probe.once('connect', () => { probe.destroy(); resolve(true); }); probe.once('error', () => resolve(false));
      });
      if (failure) throw failure;
      if (ready) break;
      if (Date.now() >= deadline) throw new Error('预设 SSH 转发未在限时内就绪。');
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  } catch (error) { await stopChild(); throw error; }
  const proxy = server.address(); if (!proxy || typeof proxy === 'string') { await stopChild(); throw new Error('预设透明通道未取得端口。'); }
  let closePromise: Promise<void> | undefined;
  return { proxyUrl: `http://127.0.0.1:${proxy.port}`, close: () => closePromise ??= (async () => {
    closing = true; for (const socket of sockets) socket.destroy();
    try { await stopChild(); } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  })() };
}
