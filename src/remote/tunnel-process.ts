import { spawn, type ChildProcess } from 'node:child_process';
import { AgentProcessStopError } from '../agents/process.js';
import type { AgentCommand } from '../types.js';

export interface TunnelProcess {
  child: ChildProcess;
  onFailure(callback: (error: Error) => void): () => void;
  stop(graceful?: boolean): Promise<void>;
}
/** SSH/SFTP carry data over TCP/files. NUL stdio avoids Windows OpenSSH pipe stalls. */
export function startTunnelProcess(command: AgentCommand, cwd: string): TunnelProcess {
  const child = spawn(command.command, command.args, { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
  const listeners = new Set<(error: Error) => void>(); let failure: Error | undefined, exited = false, stopping: Promise<void> | undefined;
  const fail = () => { failure ??= new Error('SSH/SFTP 连接进程已结束或无法启动。'); for (const listener of listeners) listener(failure); };
  child.once('error', fail); child.once('close', () => { exited = true; fail(); });
  return { child, onFailure(callback) { listeners.add(callback); if (failure) queueMicrotask(() => { if (listeners.has(callback)) callback(failure!); }); return () => listeners.delete(callback); },
    stop: () => stopping ??= (async () => {
      if (exited || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new AgentProcessStopError(child.pid)), 5000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => child.kill());
        } else child.kill();
      });
    })() };
}
