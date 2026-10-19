import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseLaunchProfiles } from '../dist/src/presets/runtime.js';
import { readPrivateJson, presetId } from '../dist/src/presets/registry.js';

// An explicit, one-time import. Runtime dispatch never opens CC Switch databases.
const [specPath, replace] = process.argv.slice(2);
try {
  if (!specPath || (replace !== undefined && replace !== '--replace')) throw new Error('用法：node scripts/import-preset-profiles.mjs <非秘密导入清单.json> [--replace]');
  const spec = await readPrivateJson(resolve(specPath));
  if (!spec || typeof spec.privateRoot !== 'string' || !isAbsolute(spec.privateRoot) || !Array.isArray(spec.imports)) throw new Error('导入清单需要绝对 privateRoot 和 imports。');
  const profiles = parseLaunchProfiles({ version: 1, profiles: spec.profiles });
  const credentials = {};
  for (const source of spec.imports) {
    const credentialId = presetId(source.credentialId);
    if (!['codex', 'claude'].includes(source.appType) || typeof source.dbPath !== 'string' || !isAbsolute(source.dbPath)
      || typeof source.providerId !== 'string' || !source.providerId || credentials[credentialId]) throw new Error('导入源必须明确数据库、后端、供应商 ID 和唯一凭据引用。');
    const db = new DatabaseSync(source.dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT settings_config FROM providers WHERE id = ? AND app_type = ?').get(source.providerId, source.appType);
      if (!row) throw new Error('指定供应商不存在，未读取当前供应商替代。');
      const settings = JSON.parse(row.settings_config);
      const token = source.appType === 'claude' ? settings.env?.ANTHROPIC_AUTH_TOKEN : undefined;
      const key = token ?? (source.appType === 'codex' ? settings.auth?.OPENAI_API_KEY : settings.env?.ANTHROPIC_API_KEY);
      if (typeof key !== 'string' || !key || /[\r\n\0]/.test(key)) throw new Error('指定供应商没有有效认证材料。');
      credentials[credentialId] = token ? { authToken: key } : { apiKey: key };
    } finally { db.close(); }
  }
  if (profiles.some(profile => !credentials[profile.credentialId])) throw new Error('启动配置引用了未导入的凭据。');
  const root = resolve(spec.privateRoot);
  if (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())) throw new Error('私有目录必须是普通目录。');
  const destinations = ['credentials.json', 'profiles.json'].map(file => join(root, file));
  if (destinations.some(path => existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()))) throw new Error('私有文件不能是链接或目录。');
  if (!replace && destinations.some(existsSync)) throw new Error('私有配置已存在；核对后使用 --replace 显式更新。');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.stdout?.match(/S-1-5-[\d-]+/)?.[0];
    if (identity.status !== 0 || !sid) throw new Error('无法核对私有目录 ACL 身份。');
    const acl = spawnSync('icacls.exe', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true });
    if (acl.status !== 0) throw new Error('私有目录 ACL 设置失败，未写入密钥。');
  }
  for (const [index, value] of [{ version: 1, credentials }, { version: 1, profiles }].entries()) {
    const temporary = join(root, `.import-${randomUUID()}.tmp`);
    try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, destinations[index]); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  process.stdout.write(JSON.stringify({ imported: profiles.length, credentialReferences: Object.keys(credentials), privateRoot: root }) + '\n');
} catch (error) {
  // Do not include database values, API errors or serialized secrets in output.
  process.stderr.write(error instanceof SyntaxError ? '导入失败：JSON 格式无效。\n' : `导入失败：${error instanceof Error && !/sqlite|database/i.test(error.message) ? error.message : '数据库不可读取。'}\n`);
  process.exitCode = 1;
}
