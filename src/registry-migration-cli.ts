import { resolve } from 'node:path';
import { migrateWorkspaceRegistry } from './registry-migration.js';
import { migrateControllerOwnership } from './controller-ownership-migration.js';

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | undefined, workspaceRoot: string | undefined, hostBootAt: string | undefined, apply = false;
  const controllerIds: Record<string, string> = {}, owners: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--config' || arg === '--workspace' || arg === '--host-boot-at') {
      const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(arg + ' 缺少路径。');
      if (arg === '--config') configPath = resolve(value); else if(arg==='--workspace')workspaceRoot = resolve(value); else hostBootAt=value;
    } else if (arg === '--controller' || arg === '--owner') {
      const value = args[++index], offset = value?.indexOf('=') ?? -1;
      if (!value || offset < 1 || offset === value.length - 1) throw new Error(arg + ' 需要 botId=值。');
      const target = arg === '--controller' ? controllerIds : owners, key = value.slice(0, offset);
      if (target[key]) throw new Error(arg + ' 重复指定：' + key);
      target[key] = value.slice(offset + 1);
    } else throw new Error('未知参数：' + arg);
  }
  if (!configPath) throw new Error('需要 --config；默认只预览，--apply 执行停机迁移。');
  const plan = await migrateWorkspaceRegistry({ configPath, workspaceRoot, hostBootAt, controllerIds, owners, dryRun: !apply, migrateHost: migrateControllerOwnership });
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  if (plan.blockers.length) process.exitCode = 2;
}
run().catch(error => { process.stderr.write((error instanceof Error ? error.message : '工作区迁移失败') + '\n'); process.exitCode = 1; });
