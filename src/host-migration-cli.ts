import { resolve } from 'node:path';
import { inspectHostStoppedExecution, migrateHostConfig, restoreHostMigration } from './host-migration.js';
import { safeError } from './config.js';

async function run(): Promise<void> {
  const argv = process.argv.slice(2); let configPath: string | undefined, apply = false, restore: string | undefined, inspectJob: string | undefined, nativePath: string | undefined;
  const owners: Record<string, string> = {}, principalIds: Record<string, string> = {}, startupProfiles: string[] = [], includeProfiles: string[] = [], stoppedExecutionProofs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') configPath = argv[++i];
    else if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--restore') restore = argv[++i];
    else if (arg === '--stopped-proof') { const path = argv[++i]; if (!path) throw new Error('--stopped-proof 缺少值。'); stoppedExecutionProofs.push(resolve(path)); }
    else if (arg === '--inspect-stopped-job') { if (inspectJob) throw new Error('--inspect-stopped-job 不能重复。'); inspectJob = argv[++i]; if (!inspectJob) throw new Error('--inspect-stopped-job 缺少值。'); }
    else if (arg === '--native-session') { if (nativePath) throw new Error('--native-session 不能重复。'); nativePath = argv[++i]; if (!nativePath) throw new Error('--native-session 缺少值。'); }
    else if (arg === '--profile') { const name = argv[++i]; if (!name) throw new Error('--profile 缺少值。'); startupProfiles.push(name); }
    else if (arg === '--include-profile') { const name = argv[++i]; if (!name) throw new Error('--include-profile 缺少值。'); includeProfiles.push(name); }
    else if (arg === '--owner' || arg === '--principal') {
      const value = argv[++i], offset = value?.indexOf('=') ?? -1; if (!value || offset < 1 || offset === value.length - 1) throw new Error(`${arg} 需要 botId=值。`);
      (arg === '--owner' ? owners : principalIds)[value.slice(0, offset)] = value.slice(offset + 1);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (restore) { if (configPath || apply || startupProfiles.length || includeProfiles.length || stoppedExecutionProofs.length || inspectJob || nativePath || Object.keys(owners).length || Object.keys(principalIds).length) throw new Error('--restore 不能与迁移参数混用。'); restoreHostMigration(resolve(restore)); process.stdout.write('宿主配置已恢复，失败数据保留在备份中。\n'); return; }
  if (!configPath) throw new Error('需要 --config；默认仅预览，使用 --apply 才执行离线迁移。');
  const options = { dryRun: !apply, owners, principalIds, stoppedExecutionProofs, ...(startupProfiles.length ? { startupProfiles } : {}), ...(includeProfiles.length ? { includeProfiles } : {}) };
  if (inspectJob || nativePath) {
    if (!inspectJob || !nativePath || apply || stoppedExecutionProofs.length) throw new Error('只读证明生成需要 --inspect-stopped-job 与 --native-session，不能与 --apply/--stopped-proof 混用。');
    process.stdout.write(JSON.stringify(inspectHostStoppedExecution(resolve(configPath), inspectJob, resolve(nativePath), options), null, 2) + '\n'); return;
  }
  const result = await migrateHostConfig(resolve(configPath), options);
  // Plans contain identity/path/count metadata; credentials never enter this output.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
run().catch(error => { process.stderr.write(safeError(error) + '\n'); process.exitCode = 1; });