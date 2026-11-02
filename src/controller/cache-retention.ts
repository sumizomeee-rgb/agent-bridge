import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ControllerJob, ControllerWorker } from './runtime-types.js';

export const workerPluginCacheRetentionMs = 3 * 24 * 60 * 60 * 1000;
export interface WorkerPluginCacheCleanup { files: number; bytes: number; workers: number; errors: string[] }

/** Startup-only maintenance. Native profiles, transcripts and databases are never removed. */
export function pruneWorkerPluginCatalogCaches(dataDir: string, workers: ControllerWorker[], jobs: ControllerJob[],
  isStopped: (workerId: string) => boolean, now = Date.now()): WorkerPluginCacheCleanup {
  const result: WorkerPluginCacheCleanup = { files: 0, bytes: 0, workers: 0, errors: [] };
  const root = resolve(dataDir), cutoff = now - workerPluginCacheRetentionMs;
  if (!Number.isFinite(cutoff)) return result;
  const byWorker = new Map<string, ControllerJob[]>();
  for (const job of jobs) { const list = byWorker.get(job.workerId) ?? []; list.push(job); byWorker.set(job.workerId, list); }
  for (const worker of workers) {
    if (worker.agent !== 'codex' || worker.target?.transport === 'ssh' || worker.ownership === 'user' || worker.handoffPending
      || worker.blocked || worker.adoption?.status === 'pending' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(worker.id)) continue;
    const history = byWorker.get(worker.id) ?? [], latest = history.at(-1);
    if (!latest || latest.processStopped !== true || history.some(job => ['queued', 'running', 'uncertain'].includes(job.status)) || !isStopped(worker.id)) continue;
    const dates = [worker.updatedAt, ...history.map(job => job.updatedAt)].map(value => Date.parse(value));
    if (dates.some(value => !Number.isFinite(value)) || Math.max(...dates) >= cutoff) continue;
    const parts = [worker.target?.preset ? 'preset-homes' : 'worker-homes', 'codex', worker.id, 'cache', 'remote_plugin_catalog'];
    const directory = resolve(root, ...parts);
    if (!directory.startsWith(root + sep)) continue;
    try {
      let current = root, safe = true;
      for (const part of ['', ...parts]) {
        if (part) current = join(current, part);
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) { safe = false; break; }
      }
      if (!safe) continue;
      let removed = false;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue;
        const file = join(directory, entry.name), info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
        unlinkSync(file); result.files++; result.bytes += info.size; removed = true;
      }
      if (removed) result.workers++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.errors.push(`${worker.id}: ${(error as NodeJS.ErrnoException).code ?? 'cache cleanup failed'}`);
    }
  }
  return result;
}
