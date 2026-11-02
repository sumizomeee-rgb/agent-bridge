import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { randomUUID } from 'node:crypto';

/** config/read and thread/start reload files; CLI -c overrides alone are insufficient. */
export function writeCodexPresetRouting(home: string, model: string, baseUrl: string): void {
  const path = join(home, 'config.toml');
  const config = existsSync(path) ? parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {};
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
  const file = join(source, 'config.toml');
  if (existsSync(file)) {
    const configured = parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const tools: Record<string, unknown> = {};
    for (const key of ['mcp_servers', 'plugins', 'marketplaces', 'features', 'windows', 'projects']) {
      if (key in configured) tools[key] = configured[key];
    }
    const destination = join(home, 'config.toml'), temporary = destination + '.capabilities.tmp';
    if (Object.keys(tools).length || existsSync(destination)) {
      mkdirSync(home, { recursive: true });
      writeFileSync(temporary, stringify(tools), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, destination);
    }
  }
  const plugins = join(source, 'plugins'), destination = join(home, 'plugins');
  if (existsSync(plugins) && !existsSync(destination)) symlinkSync(plugins, destination, process.platform === 'win32' ? 'junction' : 'dir');
}
