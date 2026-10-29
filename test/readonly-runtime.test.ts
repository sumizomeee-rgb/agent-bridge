import test from 'node:test';
import { ownTemporaryDirectory } from './temp-directory.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { readOnlyRuntime } from '../src/agents/readonly.js';

test('只读Codex配置只继承模型路由，移除可写MCP、hooks和插件，认证副本随临时home清理', () => {
  const source = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-readonly-source-')), 'bridge-readonly-source-');
  writeFileSync(join(source, 'config.toml'), 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://gateway.invalid"\n[mcp_servers.write_anywhere]\ncommand="never-run"\n[features]\nhooks=true\nplugins=true\n[plugins]\nenabled=true\n');
  writeFileSync(join(source, 'auth.json'), '{"fake":"credential"}');
  const runtime = readOnlyRuntime('codex', { CODEX_HOME: source });
  try {
    const filtered = parse(readFileSync(join(runtime.env.CODEX_HOME!, 'config.toml'), 'utf8'));
    assert.equal(filtered.model_provider, 'custom'); assert.equal(filtered.mcp_servers, undefined); assert.equal(filtered.plugins, undefined);
    assert.equal(filtered.sandbox_mode, 'read-only'); assert.equal(filtered.approval_policy, 'never');
    const features = filtered.features as Record<string, unknown>;
    assert.equal(features.hooks, false); assert.equal(features.plugins, false); assert.equal(features.multi_agent, false);
    assert.equal(features.unified_exec, true); assert.equal(features.code_mode_host, true);
    assert.equal(readFileSync(join(runtime.env.CODEX_HOME!, 'auth.json'), 'utf8'), '{"fake":"credential"}');
    assert(existsSync(join(source, 'auth.json')));
  } finally { runtime.cleanup(); }
  assert.equal(existsSync(runtime.env.CODEX_HOME!), false); assert(existsSync(join(source, 'auth.json')));
});
