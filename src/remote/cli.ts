import { connect } from 'node:net';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { RemoteDaemon, loadRemoteConfig, remoteDataDirectory, remoteEndpoint } from './daemon.js';
import { isObject, safeError } from '../agents/process.js';
import { ensureRemoteSemanticData } from '../remote-migration.js';

export async function runRemoteCli(argv: string[]): Promise<void> {
  const mode = argv[0]; const rootIndex = argv.indexOf('--root');
  if ((mode !== '--serve' && mode !== '--stdio') || rootIndex < 0 || !argv[rootIndex + 1] || argv.length !== 3) throw new Error('用法：--serve|--stdio --root <已登记远端运行目录>');
  const root = resolve(argv[rootIndex + 1]!);
  if (mode === '--serve') {
    ensureRemoteSemanticData(root);
    const daemon = new RemoteDaemon(root, loadRemoteConfig(root), { onMaintenanceStop: () => stop() }); await daemon.listen();
    const stop = () => { void daemon.close().then(() => process.exit(0), () => process.exit(2)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    // This process is launched independently of SSH; stdout contains no IPC credential.
    process.stderr.write('iMUS Rin 远端执行器已就绪。\n');
    return;
  }
  const token = readFileSync(join(remoteDataDirectory(root), 'ipc-token'), 'utf8').trim();
  const socket = connect(remoteEndpoint(root));
  await new Promise<void>((resolveValue, reject) => { socket.once('connect', resolveValue); socket.once('error', reject); });
  socket.on('error', () => { process.exitCode = 2; });
  socket.on('close', () => { lines.close(); process.stdin.destroy(); });
  socket.pipe(process.stdout);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (line.length > 16 * 1024 * 1024) { socket.destroy(); return; }
    try {
      const request: unknown = JSON.parse(line);
      if (!isObject(request) || typeof request.id !== 'string' || typeof request.method !== 'string' || !isObject(request.args)) throw new Error('无效协议');
      socket.write(`${JSON.stringify({ ...request, token })}\n`);
    } catch { socket.destroy(); }
  });
  lines.on('close', () => socket.end());
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  void runRemoteCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${safeError(error instanceof Error ? error.message : '', '远端执行器启动失败')}\n`); process.exitCode = 2; });
}
