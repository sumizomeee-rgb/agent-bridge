import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateProject } from './profile-migration.js';
import { migrateRemoteData } from './remote-migration.js';
export function listProfiles(local: string): string[] {
  return ['discord', 'feishu'].flatMap(platform => {
    const directory = join(local, 'bots', platform); if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(name)).map(name => platform + '/' + name.slice(0, -5));
  });
}
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  try {
    if (process.argv[2] === 'migrate') {
      const result = await migrateProject(join(root, '.local', 'config.json'), { newRoot: process.argv[3] });
      console.log(`SEMANTIC_MIGRATED discord/default；备份：${result.backupDir}`);
    } else if (process.argv[2] === 'migrate-remote' && process.argv[3] && process.argv[4]) console.log('REMOTE_MIGRATED backup=' + await migrateRemoteData(process.argv[3], process.argv[4]));
    else if (process.argv[2] === 'list') console.log(listProfiles(join(root, '.local')).join('\n'));
    else throw new Error('用法：profile-cli.js migrate [迁移后的项目绝对路径] | list');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Profile 操作失败。'); process.exitCode = 1; }
}
