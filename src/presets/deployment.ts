import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isObject } from '../agents/process.js';
import { listPresets, readPrivateJson } from './registry.js';
import { parseLaunchProfiles } from './runtime.js';
import { materialsHash, parseMaterials, privateDirectory, type PresetMaterials } from './materials.js';
import type { ExecutionTargetBinding } from '../remote/types.js';
import { command, remotePowerShell, ps } from '../remote/deployment.js';

export async function presetMaterials(workspace: string, target: ExecutionTargetBinding): Promise<PresetMaterials | null> {
  const entries = (await listPresets(workspace, { targetId: target.id })).filter(entry => entry.enabled);
  if (!entries.length) return null;
  const directory = join(workspace, 'agent-presets', 'private');
  const raw = await readPrivateJson(join(directory, 'profiles.json')), secrets = await readPrivateJson(join(directory, 'credentials.json'));
  if (!isObject(raw) || !Array.isArray(raw.profiles) || !isObject(secrets) || secrets.version !== 1 || !isObject(secrets.credentials)) throw new Error('工作区预设启动配置或凭据无效。');
  const owner = materialsHash(process.platform === 'win32' ? resolve(workspace).toLowerCase() : resolve(workspace));
  const selected = entries.map(entry => {
    const source = (raw.profiles as unknown[]).find(value => isObject(value) && value.id === entry.profileId);
    if (!isObject(source)) throw new Error('工作区缺少预设启动配置。');
    if (source.targets !== undefined && !isObject(source.targets)) throw new Error('工作区预设目标线路格式无效。');
    const override = isObject(source.targets) ? source.targets[target.id] : undefined;
    if (override !== undefined && (!isObject(override) || Object.keys(override).some(key => key !== 'transport'))) throw new Error('工作区预设目标线路只能覆盖传输配置。');
    const profile = parseLaunchProfiles({ version: 1, profiles: [{ ...source, ...(isObject(override) ? override : {}) }] })[0]!;
    if (profile.agent !== entry.agent || profile.model !== entry.model || profile.revision !== entry.revision) throw new Error('工作区预设清单与启动配置不一致。');
    return profile;
  });
  const credentials: PresetMaterials['credentials'] = {}, profiles = new Map<string, typeof selected[number]>();
  for (const profile of selected) {
    const credentialId = 'managed-' + owner.slice(0, 16) + '-' + materialsHash(profile.credentialId).slice(0, 16);
    credentials[credentialId] = secrets.credentials[profile.credentialId] as PresetMaterials['credentials'][string];
    profiles.set(profile.id, { ...profile, credentialId });
  }
  return parseMaterials({ version: 1, owner, profiles: [...profiles.values()], credentials }, parseLaunchProfiles);
}

export async function deployPresets(target: ExecutionTargetBinding, workspace: string): Promise<number> {
  const materials = await presetMaterials(workspace, target); if (!materials) return 0;
  const payload = JSON.stringify(materials), digest = materialsHash(payload);
  // 相同配置只做远端核验；凭据不进入发布包、参数、日志或派工记录。
  const probe = JSON.parse(await remotePowerShell(target, `$r=Get-Content -LiteralPath (Join-Path ${ps(target.remoteRoot!)} '.local/remote/active-release.json') -Raw -Encoding UTF8|ConvertFrom-Json;& ${ps(target.nodePath!)} (Join-Path $r.path 'dist/src/presets/install.js') verify ${ps(target.remoteRoot!)} ${ps(target.expectedHostname!)} ${ps(materials.owner)} ${ps(digest)};if($LASTEXITCODE -ne 0){throw 'Preset verification failed'}`, workspace));
  if (probe.ready === true && probe.count === materials.profiles.length) return materials.profiles.length;
  const temporary = mkdtempSync(join(workspace, 'agent-presets', '.deploy-')); privateDirectory(temporary);
  const file = join(temporary, 'payload.json'), remote = target.remoteRoot!.replaceAll('\\', '/') + '/.local/agent-presets/inbox/' + temporary.split(/[\\/]/).pop() + '.json';
  try {
    writeFileSync(file, payload, { mode: 0o600, flag: 'wx' });
    const prepare = `$r=Get-Content -LiteralPath (Join-Path ${ps(target.remoteRoot!)} '.local/remote/active-release.json') -Raw -Encoding UTF8|ConvertFrom-Json;& ${ps(target.nodePath!)} (Join-Path $r.path 'dist/src/presets/install.js') prepare ${ps(target.remoteRoot!)} ${ps(target.expectedHostname!)};if($LASTEXITCODE -ne 0){throw 'Preset directory preparation failed'}`;
    await remotePowerShell(target, prepare, workspace);
    await command('scp', ['-q', '-F', target.sshConfig!, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', file, `${target.alias}:${remote}`], workspace);
    const result = JSON.parse(await remotePowerShell(target, `$r=Get-Content -LiteralPath (Join-Path ${ps(target.remoteRoot!)} '.local/remote/active-release.json') -Raw -Encoding UTF8|ConvertFrom-Json;& ${ps(target.nodePath!)} (Join-Path $r.path 'dist/src/presets/install.js') install ${ps(target.remoteRoot!)} ${ps(target.expectedHostname!)} ${ps(remote)} ${ps(digest)};if($LASTEXITCODE -ne 0){throw 'Preset installation failed'}`, workspace));
    if (result.count !== materials.profiles.length) throw new Error('预设配置部署结果不一致。'); return result.count;
  } finally {
    if (existsSync(file)) unlinkSync(file); rmdirSync(temporary);
    await remotePowerShell(target, `if(Test-Path -LiteralPath ${ps(remote)}){Remove-Item -LiteralPath ${ps(remote)} -Force}`, workspace).catch(() => {});
  }
}
