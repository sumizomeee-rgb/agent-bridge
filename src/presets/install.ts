import { hostname } from 'node:os';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { installMaterials, materialsHash, ordinaryPath, parseMaterials, privateDirectory } from './materials.js';
import { parseLaunchProfiles } from './runtime.js';

const [mode, root, expected, input, digest] = process.argv.slice(2);
function validateTarget(value: ReturnType<typeof parseMaterials>, root: string): void {
  const config = JSON.parse(readFileSync(join(root, '.local', 'remote', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const profile of value.profiles) {
    const command = config.engines?.[profile.agent]?.agentCommand;
    if (!command || !existsSync(command.command) || !Array.isArray(command.args)
      || command.args.some((arg: string) => isAbsolute(arg) && /\.(?:js|mjs|cjs)$/i.test(arg) && !existsSync(arg))) throw new Error('目标机 Agent 入口不可用。');
    if (profile.transport.kind === 'ssh-connect'
      && (!existsSync(profile.transport.sshConfig) || (profile.transport.sshCommand && !existsSync(profile.transport.sshCommand)))) throw new Error('目标机预设线路路径不存在。');
  }
}
try {
  if (!root || !expected || hostname().toLowerCase() !== expected.toLowerCase()) throw new Error('目标主机不符。');
  const privateRoot = join(resolve(root), '.local', 'agent-presets'), inbox = join(privateRoot, 'inbox');
  if (mode === 'prepare') { privateDirectory(inbox); console.log(JSON.stringify({ prepared: true })); }
  else if (mode === 'verify' && input && digest && /^[a-f0-9]{64}$/.test(input)) {
    const file = join(privateRoot, 'managed', input + '.json'); ordinaryPath(file);
    if (!existsSync(file) || materialsHash(readFileSync(file)) !== digest) console.log(JSON.stringify({ ready: false }));
    else { const value = parseMaterials(JSON.parse(readFileSync(file, 'utf8')), parseLaunchProfiles); validateTarget(value, root); console.log(JSON.stringify({ ready: true, count: value.profiles.length })); }
  } else if (mode === 'install' && input && digest) {
    const file = resolve(input); ordinaryPath(file);
    if (dirname(file) !== inbox || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('配置输入路径无效。');
    try {
      const bytes = readFileSync(file);
      if (bytes.length > 512 * 1024 || materialsHash(bytes) !== digest) throw new Error('配置校验失败。');
      const value = parseMaterials(JSON.parse(bytes.toString('utf8')), parseLaunchProfiles);
      // 核验目标机路径，不能把源电脑的 SSH 配置路径原样误报为就绪。
      validateTarget(value, root);
      console.log(JSON.stringify(await installMaterials(privateRoot, value, parseLaunchProfiles)));
    } finally { if (existsSync(file)) unlinkSync(file); }
  } else throw new Error('配置操作无效。');
} catch {
  // 不输出输入 JSON、密钥、SSH 错误或第三方解析器的原始异常。
  process.stderr.write('自动预设配置准备失败；原有配置和助手未改动。\n'); process.exitCode = 1;
}
