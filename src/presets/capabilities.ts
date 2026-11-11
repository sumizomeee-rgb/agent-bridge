import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { randomUUID } from 'node:crypto';

/** config/read and thread/start reload files; CLI -c overrides alone are insufficient. */
export function writeCodexPresetRouting(home: string, model: string, baseUrl: string, source?: string): void {
  const path = join(home, 'config.toml');
  const config = existsSync(path) ? parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {};
  if (source) {
    const file = join(source, 'config.toml');
    const configured = existsSync(file) ? parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
    for (const key of ['mcp_servers', 'plugins', 'marketplaces', 'features', 'windows', 'projects']) {
      delete config[key]; if (key in configured) config[key] = configured[key]!;
    }
  }
  Object.assign(config, {
    model_provider: 'bridge_preset', model, check_for_update_on_startup: false,
    model_providers: { bridge_preset: { name: 'Explicit bridge preset', base_url: baseUrl,
      env_key: 'BRIDGE_PRESET_API_KEY', requires_openai_auth: false, wire_api: 'responses' } },
  });
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, stringify(config), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

/** Inherit installed tools, never the user's model routing, login or conversation history. */
export function inheritCodexCapabilities(home: string, source: string): void {
  mkdirSync(home, { recursive: true });
  for (const name of ['plugins', 'skills']) {
    const from = join(source, name), destination = join(home, name);
    if (existsSync(from) && !existsSync(destination)) symlinkSync(from, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
