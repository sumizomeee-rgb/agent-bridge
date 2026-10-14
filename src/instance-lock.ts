import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function acquireInstanceLock(root: string, dataDir: string): Promise<Server> {
  const identity = createHash('sha256').update(realpathSync(root).toLowerCase()).digest('hex').slice(0, 24);
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\agent-bridge-project-${identity}` : join(tmpdir(), `agent-bridge-project-${identity}.sock`);
  const guard = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { guard.once('error', reject); guard.listen(path, resolve); });
    return guard;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    let running = '未知平台';
    try { const record = JSON.parse(readFileSync(join(dataDir, 'bridge.pid.json'), 'utf8')); running = `${record.platform ?? '未知平台'} / ${record.profile ?? '未知 Profile'}`; } catch { /* A starting instance may not have published metadata yet. */ }
    throw new Error(`项目已有桥实例运行（${running}），请先正常停止它。`);
  }
}
