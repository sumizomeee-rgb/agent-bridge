import type { AgentCommand } from '../types.js';
import type { LaunchProfile, PresetBinding } from './types.js';
import { startPresetConnect } from './connect.js';

/** Routing only: callers own history, tools and configuration directories. */
export async function preparePresetLaunch(profile: LaunchProfile, binding: PresetBinding, credential: Record<string, unknown>, original: AgentCommand, baseEnv: NodeJS.ProcessEnv) {
  const key = (binding.agent === 'codex' ? credential.apiKey : credential.authToken ?? credential.apiKey) as string;
  const env = { ...process.env, ...baseEnv };
  const cleared = new Set(['CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_API_KEY', 'CLAUDE_CONFIG_DIR', 'BRIDGE_PRESET_API_KEY', 'BRIDGE_PRESET_PROVIDER', 'NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);
  for (const name of Object.keys(env)) {
    const key = name.toUpperCase();
    if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(key) || cleared.has(key)) env[name] = undefined;
  }
  // Loopback services (including controller MCP) must never enter the gateway-only SSH proxy.
  // Replace inherited bypasses so the gateway itself cannot accidentally bypass its route.
  env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
  const command = { command: original.command, args: [...original.args] };
  let relay: Awaited<ReturnType<typeof startPresetConnect>> | undefined;
  try {
    if (profile.transport.kind === 'ssh-connect') {
      const url = new URL(profile.baseUrl); relay = await startPresetConnect(profile.transport, `${url.hostname}:${url.port || '443'}`);
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = relay.proxyUrl;
    }
    if (binding.agent === 'codex') {
      env.BRIDGE_PRESET_API_KEY = key;
      const provider = 'bridge_preset';
      env.BRIDGE_PRESET_PROVIDER = provider;
      const values: Record<string, unknown> = { model_provider: provider, model: binding.model,
        [`model_providers.${provider}.name`]: 'Explicit bridge preset', [`model_providers.${provider}.base_url`]: profile.baseUrl,
        [`model_providers.${provider}.env_key`]: 'BRIDGE_PRESET_API_KEY', [`model_providers.${provider}.requires_openai_auth`]: false,
        [`model_providers.${provider}.wire_api`]: 'responses', check_for_update_on_startup: false };
      for (const [name, value] of Object.entries(values)) command.args.push('-c', `${name}=${JSON.stringify(value)}`);
    } else {
      env.ANTHROPIC_BASE_URL = profile.baseUrl;
      env[credential.authToken ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
      env.DISABLE_AUTOUPDATER = '1';
      env.ANTHROPIC_MODEL = binding.model;
      // Main selection alone does not pin background work or family aliases.
      for (const family of ['HAIKU', 'SONNET', 'OPUS', 'FABLE']) env[`ANTHROPIC_DEFAULT_${family}_MODEL`] = binding.model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = binding.model;
      env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
    }
    return { command, env, close: async () => { await relay?.close(); } };
  } catch (error) { await relay?.close(); throw error; }
}
