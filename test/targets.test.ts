import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, BridgeConfig } from '../src/types.js';
import { TargetCatalogService, parseTargetRegistry } from '../src/remote/catalog.js';
import { remoteMetadataSpec } from '../src/remote/client.js';
import type { ExecutionTargetBinding } from '../src/remote/types.js';

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-targets-'));
  const command = { command: process.execPath, args: [] };
  const config: BridgeConfig = { token: 'unused', allowedUserIds: ['owner'], defaultAgent: 'codex', workspace, proxyUrl: null,
    commands: { codex: command, claude: command }, dataDir: workspace, attachmentsDir: workspace, logsDir: workspace, maxImageBytes: 20 };
  const local: AgentAdapter = { run: async () => { throw new Error('unexpected native run'); }, interrupt: async () => {}, close: async () => {} };
  const entry = { id: 'station', label: '工位', expectedHostname: '11032022110008', sshConfig: join(workspace, 'station-ssh-config'), alias: 'administrator',
    remoteRoot: 'E:\\Agent Runtime', nodePath: 'D:\\Node\\node.exe', engines: { codex: { agentCommand: { command: 'D:\\Node\\node.exe', args: ['D:\\CLI\\codex.js'] }, defaultCwd: 'E:\\Work' } }, password: 'do-not-copy', token: 'do-not-copy' };
  return { workspace, config, local, entry, catalog: new TargetCatalogService(config, { codex: local, claude: local }) };
}
test('target catalog supplies local builtin without agents.json and makes no remote probe', async () => {
  const f = fixture(); let connections = 0;
  const catalog = new TargetCatalogService(f.config, { codex: f.local, claude: f.local }, { clientFactory: () => { connections++; throw new Error('not allowed to probe'); } });
  assert.deepEqual((await catalog.listTargets(f.workspace)).map(value => value.id), ['local']);
  assert.equal((await catalog.resolveTarget(f.workspace, 'local', 'codex')).cwd, f.workspace); assert.equal(connections, 0);
  assert.equal(catalog.adapterFor(await catalog.resolveTarget(f.workspace, 'local', 'claude')), f.local);
  await assert.rejects(catalog.resolveTarget(f.workspace, 'missing', 'codex'), /未在/);
});
test('remote catalog snapshots only registered fields and never stats a target cwd on the bridge computer', async () => {
  const f = fixture(); writeFileSync(join(f.workspace, 'agents.json'), JSON.stringify({ version: 1, targets: [f.entry] }));
  const summary = (await f.catalog.listTargets(f.workspace))[1]!; assert.equal(summary.availability, 'registered'); assert.deepEqual(summary.engines, ['codex']);
  const binding = await f.catalog.resolveTarget(f.workspace, 'station', 'codex', 'Z:\\Does-Not-Exist-On-Notebook');
  assert.equal(binding.cwd, 'Z:\\Does-Not-Exist-On-Notebook'); assert.ok(!JSON.stringify(binding).includes('do-not-copy'));
  assert.equal(f.catalog.adapterFor(binding), f.catalog.adapterFor(binding));
  await assert.rejects(f.catalog.resolveTarget(f.workspace, 'station', 'claude'), /未登记/);
  await assert.rejects(f.catalog.resolveTarget(f.workspace, 'station', 'codex', '..\\escape'), /绝对/);
  await f.catalog.close();
});
test('catalog refresh is explicit and a saved worker binding is unaffected by registry edits', async () => {
  const f = fixture(); const path = join(f.workspace, 'agents.json'); writeFileSync(path, JSON.stringify({ version: 1, targets: [f.entry] }));
  const old = await f.catalog.resolveTarget(f.workspace, 'station', 'codex');
  writeFileSync(path, JSON.stringify({ version: 1, targets: [{ ...f.entry, label: '新名称', engines: { codex: { ...f.entry.engines.codex, defaultCwd: 'E:\\Other' } } }] }));
  assert.equal((await f.catalog.resolveTarget(f.workspace, 'station', 'codex')).cwd, 'E:\\Work');
  await f.catalog.listTargets(f.workspace, true); assert.equal((await f.catalog.resolveTarget(f.workspace, 'station', 'codex')).cwd, 'E:\\Other');
  assert.equal(old.cwd, 'E:\\Work'); assert.equal(old.label, '工位');
});
test('registry rejects duplicate/local ids, option-like ssh aliases, malformed schemas and relative remote commands', () => {
  const f = fixture(); const parse = (targets: unknown[]) => parseTargetRegistry({ version: 1, targets });
  assert.throws(() => parse([{ ...f.entry, id: 'local' }]), /保留/);
  assert.throws(() => parse([f.entry, f.entry]), /重复/);
  assert.throws(() => parse([{ ...f.entry, alias: '-oProxyCommand=calc' }]), /别名/);
  assert.throws(() => parse([{ ...f.entry, engines: { shell: f.entry.engines.codex } }]), /engines/);
  assert.throws(() => parse([{ ...f.entry, remoteRoot: '..' }]), /绝对/);
  assert.throws(() => parse([{ ...f.entry, engines: { codex: { agentCommand: { command: 'codex', args: [] }, defaultCwd: 'E:\\Work' } } }]), /绝对/);
  assert.throws(() => parseTargetRegistry({ targets: [] }), /version/);
});
test('SSH transport uses only the registered metadata path, with no shell program, task text or credential arguments', () => {
  const binding: ExecutionTargetBinding = { id: 'station', label: 'target', transport: 'ssh', expectedHostname: 'station', sshConfig: 'C:\\ssh_config', alias: 'station',
    remoteRoot: "E:\\O'Hare $test `literal`", nodePath: 'D:\\Node Runtime\\node.exe', agent: 'codex', agentCommand: { command: 'D:\\codex.exe', args: [] }, cwd: 'E:\\Work' };
  const spec = remoteMetadataSpec(binding);
  assert.equal(spec, "station:E:/O'Hare $test `literal`/.local/remote/endpoint.json");
  assert.ok(!spec.includes('--stdio')); assert.ok(!spec.includes('token')); assert.ok(!spec.includes('powershell'));
});
test('handoff gives exact native resume command; mismatched agent/native identity is refused', async () => {
  const f = fixture(); const binding = await f.catalog.resolveTarget(f.workspace, 'local', 'codex');
  const result = await f.catalog.handoff(binding, 'native-id', f.workspace, 'codex');
  assert.equal(result.stopped, true); assert.ok(result.resumeCommand.includes("'resume' 'native-id'"));
  await assert.rejects(f.catalog.handoff(binding, 'id', f.workspace, 'claude'), /不一致/);
  await assert.rejects(f.catalog.handoff(binding, 'id;calc', f.workspace, 'codex'), /不一致/);
});
