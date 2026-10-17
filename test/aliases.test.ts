import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadHostConfig } from '../src/config.js';
import { profileScope, selectProfile } from '../src/profiles.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-aliases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'config.json');
  const commands = { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } };
  const common = { version: 3, startupProfiles: ['feishu/t', 'feishu/m'], workspaceRoot: join(root, 'contexts'), dataDir: join(root, 'data'), commands };
  const bot = (name: string, fields: Record<string, unknown> = {}) => {
    const platform = name.split('/')[0]!;
    const target = join(root, 'bots', name + '.json');
    mkdirSync(join(root, 'bots', platform), { recursive: true });
    writeFileSync(target, JSON.stringify({ platform, applicationId: name === 'feishu/t' ? 'cli_alpha' : 'cli_beta', appSecret: 'private-test-secret', allowedUserIds: ['ou_owner'], ...fields }));
  };
  const config = (value: Record<string, unknown> = common) => writeFileSync(path, JSON.stringify(value));
  bot('feishu/t'); bot('feishu/m'); config();
  return { root, path, common, bot, config, load: () => loadHostConfig(['--config', path], false) };
}

test('optional aliases trim display labels without changing the actual Bot, account or data identity', t => {
  const f = fixture(t), before = f.load();
  assert.deepEqual(before.configs.map(c => c.aliases), [[], []]);
  f.bot('feishu/t', { aliases: ['  Teto  ', '重音'] }); f.bot('feishu/m', { aliases: ['Miku'] });
  const after = f.load();
  assert.deepEqual(after.configs.map(c => c.aliases), [['Teto', '重音'], ['Miku']]);
  assert.deepEqual(after.configs.map(c => ({ botId: c.botId, scope: c.scopePrefix, users: c.allowedUserIds, data: c.dataDir, workspace: c.contextWorkspace })),
    before.configs.map(c => ({ botId: c.botId, scope: c.scopePrefix, users: c.allowedUserIds, data: c.dataDir, workspace: c.contextWorkspace })));
  const legacy = { ...f.common, version: 2, startupProfile: 'feishu/t', workspace: join(f.root, 'legacy-context') };
  f.config(legacy);
  const selected = loadConfig(['--config', f.path], false);
  assert.deepEqual(selected.aliases, ['Teto', '重音']);
  assert.equal(selected.scopePrefix, 'feishu:cli_alpha|');
  const profile = selectProfile(legacy, f.path);
  assert.equal(profileScope({ ...profile, aliases: ['renamed'] }), profileScope(profile));
});

test('aliases reject malformed arrays, blank or oversized labels and embedded control characters', t => {
  const f = fixture(t);
  for (const aliases of [null, 'Miku', {}, [1], [false], [null], [''], [' \t '], ['x'.repeat(65)], ['Mi\nku'], ['Mi\u0000ku'], Array(33).fill('x')]) {
    f.bot('feishu/t', { aliases });
    assert.throws(f.load, /Profile aliases/);
  }
  f.bot('feishu/t', { aliases: ['😀'.repeat(64)] });
  assert.equal(f.load().configs[0]!.aliases?.[0], '😀'.repeat(64));
});

test('aliases cannot duplicate after trimming, Unicode normalization or case folding', t => {
  const f = fixture(t);
  for (const aliases of [['Miku', ' Miku '], ['Miku', 'miku'], ['Ｍｉｋｕ', 'Miku'], ['café', 'cafe\u0301']]) {
    f.bot('feishu/t', { aliases });
    assert.throws(f.load, /aliases 规范化后不能重复/);
  }
});

test('a host rejects aliases shared with another Bot, including a registered inactive platform', t => {
  const f = fixture(t);
  f.bot('feishu/t', { aliases: ['Teto'] }); f.bot('feishu/m', { aliases: ['tEtO'] });
  assert.throws(f.load, /不同 Bot 的 aliases/);
  f.bot('feishu/m', { aliases: ['Miku'] });
  assert.equal(f.load().configs.length, 2);
  f.bot('discord/offline', { applicationId: '123456789012345678', token: 'private-token', allowedUserIds: ['234567890123456789'], aliases: ['Ｔｅｔｏ'] });
  f.config({ ...f.common, registeredProfiles: ['discord/offline'] });
  assert.throws(f.load, /不同 Bot 的 aliases/);
});

test('an alias cannot shadow another Bot identity or Profile and cannot replace an authorized account', t => {
  const f = fixture(t);
  for (const alias of ['feishu:cli_beta', 'feishu/m']) {
    f.bot('feishu/t', { aliases: [alias] }); assert.throws(f.load, /真实 ID／Profile/);
  }
  f.bot('feishu/t', { aliases: ['Teto'] });
  f.config({ ...f.common, principals: [{ id: 'owner', accounts: { 'feishu:cli_alpha': 'Teto' } }] });
  assert.throws(f.load, /白名单账号/);
  f.config({ ...f.common, principals: [{ id: 'owner', accounts: { 'Teto': 'ou_owner' } }] });
  assert.throws(f.load, /已登记 Bot/);
});
