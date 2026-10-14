import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentEnvironment, loadConfig, redactText, safeError } from '../src/config.js';

test('explicit proxy port reaches all agent proxy variables and preserves local bypass', () => {
  const env = agentEnvironment({ proxyUrl: 'http://127.0.0.1:7898' } as Parameters<typeof agentEnvironment>[0]);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7898');
  assert.equal(env.http_proxy, env.HTTPS_PROXY);
  assert.equal(env.ALL_PROXY, env.HTTPS_PROXY);
  assert.ok(env.NO_PROXY?.split(',').includes('10.101.0.8'));
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path')!;
  assert.equal(env[pathKey], process.env[pathKey]);
});
test('port override and invalid ports are validated without printing token', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-config-'));
  try {
    const path = join(root, 'config.json');
    mkdirSync(join(root, 'bots', 'discord'), { recursive: true });
    writeFileSync(join(root, 'bots', 'discord', 'default.json'), JSON.stringify({ applicationId: '123456789012345678', token: 'private-test-value', allowedUserIds: ['123456789012345678'] }));
    writeFileSync(path, JSON.stringify({ version: 2, startupProfile: 'discord/default', workspace: join(root, 'workspace'), dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'files'), commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } }, proxyPort: 7898 }));
    assert.equal(loadConfig(['--config', path, '--proxy-port', '7899']).proxyUrl, 'http://127.0.0.1:7899');
    assert.throws(() => loadConfig(['--config', path, '--proxy-port', '0']), /1–65535/);
    assert.throws(() => loadConfig(['--config', path, '--proxy-port', 'bad']), /1–65535/);
  } finally { rmSync(root, { recursive: true }); }
});
test('redaction preserves long replies while limiting diagnostic errors', () => {
  const long = 'a'.repeat(5000) + 'secret';
  assert.equal(redactText(long, ['secret']).length, 5010);
  assert.equal(safeError(long, ['secret']).length, 1500);
  assert.ok(!redactText('Bot abc.def secret', ['secret']).includes('abc.def'));
  assert.equal(redactText('READY bot=黄永熙 BridgeBot agent=codex'), 'READY bot=黄永熙 BridgeBot agent=codex');
});

test('ordinary file limit defaults to 20 MiB and validates configuration before startup', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-config-'));
  try {
    const path = join(root, 'config.json');
    mkdirSync(join(root, 'bots', 'discord'), { recursive: true });
    writeFileSync(join(root, 'bots', 'discord', 'default.json'), JSON.stringify({ applicationId: '123456789012345678', token: 'private-test-value', allowedUserIds: ['123456789012345678'] }));
    const base = { version: 2, startupProfile: 'discord/default', workspace: join(root, 'workspace'),
      dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'files'),
      commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } } };
    writeFileSync(path, JSON.stringify(base));
    assert.equal(loadConfig(['--config', path]).maxFileBytes, 20 * 1024 * 1024);
    for (const limit of [1, 1024, 24 * 1024 * 1024]) {
      writeFileSync(path, JSON.stringify({ ...base, maxFileBytes: limit }));
      assert.equal(loadConfig(['--config', path]).maxFileBytes, limit);
    }
    for (const limit of [0, -1, 1.5, '100', 24 * 1024 * 1024 + 1]) {
      writeFileSync(path, JSON.stringify({ ...base, maxFileBytes: limit }));
      assert.throws(() => loadConfig(['--config', path]), /maxFileBytes/);
    }
  } finally { rmSync(root, { recursive: true }); }
});
