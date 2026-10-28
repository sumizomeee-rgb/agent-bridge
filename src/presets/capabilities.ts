import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';

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
