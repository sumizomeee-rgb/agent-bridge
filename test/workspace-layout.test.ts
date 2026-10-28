import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceDirectory, workspaceFile, workspaceOutputGuidance } from '../src/workspace-layout.js';
import { TargetCatalogService } from '../src/remote/catalog.js';
import { listPresets } from '../src/presets/registry.js';
import { presetMaterials } from '../src/presets/deployment.js';
import { parseCapabilityRegistry } from '../src/capabilities.js';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';

for (const layout of ['canonical', 'legacy', 'migration-links']) test(`real catalog and private preset materials remain usable: ${layout}`, async t => {
  const prefix = layout === 'canonical' ? 'bridge-' : '';
  const root = mkdtempSync(join(tmpdir(), 'bridge-flat-layout-'));
  let catalog: TargetCatalogService | undefined;
  t.after(async () => { await catalog?.close(); rmSync(root, { recursive: true, force: true }); });
  const write = (role: string, name: string, value: unknown) => {
    const path = join(root, prefix + role, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value));
  };
  const command = { command: process.execPath, args: [] };
  write('remote-agents', 'registry.json', { version: 1, targets: [{ id: 'station', label: 'registered computer', expectedHostname: 'fixture',
    sshConfig: join(root, 'ssh_config'), alias: 'fixture', remoteRoot: root, nodePath: process.execPath,
    engines: { codex: { agentCommand: command, defaultCwd: root } } }] });
  write('agent-presets', 'registry.json', { version: 1, presets: [{ id: 'local-sol', targetId: 'local', aliases: ['本机 Sol'],
    agent: 'codex', model: 'gpt-6.1-sol', profileId: 'sol', revision: 1, enabled: true }] });
  write('agent-presets', 'private/profiles.json', { version: 1, profiles: [{ id: 'sol', revision: 1, agent: 'codex', model: 'gpt-6.1-sol',
    baseUrl: 'https://example.invalid', credentialId: 'key', transport: { kind: 'direct' } }] });
  write('agent-presets', 'private/credentials.json', { version: 1, credentials: { key: { apiKey: 'isolated-fixture-only' } } });
  write('capabilities', 'registry.json', { version: 1, capabilities: [] });
  if (layout === 'migration-links') for (const role of ['agent-presets', 'remote-agents', 'capabilities'])
    symlinkSync(join(root, role), join(root, 'bridge-' + role), process.platform === 'win32' ? 'junction' : 'dir');
  const config: BridgeConfig = { token: '', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace: root, proxyUrl: null,
    dataDir: join(root, 'data'), attachmentsDir: root, logsDir: root, maxImageBytes: 10, commands: { codex: command, claude: command } };
  const adapter: AgentAdapter = { async run() { throw Error('No model calls in directory migration verification'); }, async interrupt() {}, async close() {} };
  catalog = new TargetCatalogService(config, { codex: adapter, claude: adapter });
  assert.deepEqual((await catalog.listTargets(root, true)).map(t => t.id), ['local', 'station']);
  assert.equal((await catalog.resolveTarget(root, 'station', 'codex')).cwd, root);
  const preset = await catalog.resolvePreset(root, 'local-sol'); assert.equal(preset.preset!.model, 'gpt-6.1-sol');
  assert.equal((await listPresets(root))[0]!.id, 'local-sol');
  const materials = await presetMaterials(root, preset); assert.equal(materials!.profiles.length, 1);
  assert.equal(Object.values(materials!.credentials)[0]!.apiKey, 'isolated-fixture-only');
  assert.equal(workspaceDirectory(root, 'agent-presets'), join(root, prefix + 'agent-presets'));
  const raw = JSON.parse(readFileSync(workspaceFile(root, 'capabilities', 'registry.json'), 'utf8'));
  assert.deepEqual(parseCapabilityRegistry(raw), []);
  assert(workspaceOutputGuidance(root).includes(join(root, 'tmp', '<任务名>')));
});

test('canonical registry errors are not hidden by a legacy fallback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-flat-layout-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['agent-presets', 'bridge-agent-presets']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'agent-presets/registry.json'), JSON.stringify({ version: 1, presets: [] }));
  writeFileSync(join(root, 'bridge-agent-presets/registry.json'), '{broken');
  await assert.rejects(listPresets(root));
});
