import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { CapabilityHealthService, parseCapabilityRegistry, startupSummary, type CapabilityHealthOptions, type CapabilityHealthReport } from '../src/capabilities.js';
import type { BridgeConfig } from '../src/types.js';

const extensionId = 'hehggadaopoacecdllhhajmbjkdcmajg';
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-capabilities-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'MEMORY.md'), 'private-work-habits'); writeFileSync(join(workspace, 'README.md'), 'private-business-navigation');
  const config: BridgeConfig = { token: 'private-bot-token', allowedUserIds: ['123456789012345678'], defaultAgent: 'codex', workspace, proxyUrl: null,
    commands: { codex: { command: process.execPath, args: [] }, claude: { command: process.execPath, args: [] } }, dataDir: join(root, 'data'), logsDir: join(root, 'logs'), attachmentsDir: join(root, 'files'), maxImageBytes: 1024 };
  const registry = (capabilities: unknown[]) => writeFileSync(join(workspace, 'capabilities.json'), JSON.stringify({ version: 1, capabilities }));
  registry([]);
  const browser = (fields: Record<string, unknown> = {}, profileName = 'Default') => {
    const profilePath = join(root, profileName); mkdirSync(join(profilePath, 'Extensions', extensionId, '1.0.0'), { recursive: true });
    writeFileSync(join(profilePath, 'Extensions', extensionId, '1.0.0', 'manifest.json'), '{}');
    writeFileSync(join(profilePath, 'Secure Preferences'), JSON.stringify({ cookies: 'private-cookie-value', profile: { secret: 'private-profile-field' }, extensions: { settings: { [extensionId]: fields } } }));
    const nativeHost = join(root, `${profileName}-native-host.json`); const executable = join(root, `${profileName}-host.exe`); writeFileSync(executable, 'fixture');
    writeFileSync(nativeHost, JSON.stringify({ name: 'com.openai.codexextension', path: executable, allowed_origins: [`chrome-extension://${extensionId}/`], secret: 'private-manifest-extra' }));
    return { id: `browser-${profileName}`, label: '笔记本 Chrome 原有登录 profile', targetId: 'local', agent: 'codex', kind: 'browser', browser: { profilePath, extensionId, nativeHostManifests: [nativeHost] } };
  };
  const service = (options?: CapabilityHealthOptions) => new CapabilityHealthService(config, options);
  return { root, workspace, config, registry, browser, service };
}
function entry(report: CapabilityHealthReport, entryId: string) { const value = report.items.find(value => value.id === entryId); assert.ok(value, entryId); return value; }

test('empty capability registry is valid and unsafe relative browser paths or ambiguous acceptance scopes are rejected', () => {
  assert.deepEqual(parseCapabilityRegistry({ version: 1, capabilities: [] }), []);
  const base = { id: 'chrome', label: 'Chrome', targetId: 'local', kind: 'browser', browser: { profilePath: 'relative/profile', extensionId } };
  assert.throws(() => parseCapabilityRegistry({ version: 1, capabilities: [base] }), /绝对路径/);
  assert.throws(() => parseCapabilityRegistry({ version: 1, capabilities: [{ ...base, browser: { ...base.browser, profilePath: 'C:\\Chrome', nativeHostManifests: ['manifest.json'] } }] }), /绝对路径/);
  assert.throws(() => parseCapabilityRegistry({ version: 1, capabilities: [{ id: 'app', label: 'App', targetId: 'local', kind: 'web-app', acceptance: { checkedAt: '2026-10-12T01:00:00Z', status: 'passed' } }] }), /scope/);
  assert.throws(() => parseCapabilityRegistry({ version: 1, capabilities: [{ id: 'app', label: 'App', targetId: 'local', kind: 'wrong' }] }), /kind/);
  assert.throws(() => parseCapabilityRegistry({ version: 1, capabilities: [{ id: 'app', label: 'App', targetId: 'local', kind: 'web-app' }, { id: 'app', label: 'Another', targetId: 'local', kind: 'web-app' }] }), /重复/);
});

test('Chrome newAllowFileAccess is recognized while missing enable-state fields remain unknown rather than disabled', async t => {
  const f = fixture(t); const registered = f.browser({ newAllowFileAccess: true, allow_file_access: false }); f.registry([registered]);
  const report = await f.service().query(); const chrome = entry(report, registered.id);
  assert.equal(chrome.checks.find(value => value.name === 'file-access')?.status, 'ready');
  assert.equal(chrome.checks.find(value => value.name === 'extension')?.status, 'unknown');
  assert.match(chrome.checks.find(value => value.name === 'extension')!.note, /不等于已禁用/);
  assert.equal(chrome.checks.find(value => value.name === 'native-host')?.status, 'ready');
  assert.equal(chrome.runtimeStatus, 'unknown'); assert.equal(report.scope, 'static-prerequisites');
  assert.equal(entry(report, 'workspace').status, 'ready');
  assert.deepEqual(entry(report, 'workspace').checks.map(value => value.name).sort(), ['MEMORY.md', 'README.md', 'directory']);
  const serialized = JSON.stringify(report);
  for (const secret of ['private-cookie-value', 'private-profile-field', 'private-manifest-extra', 'private-bot-token', 'private-work-habits', 'private-business-navigation']) assert.ok(!serialized.includes(secret));
});

test('legacy Chrome file access fields and explicit disable reasons report independent prerequisite failures', async t => {
  const f = fixture(t);
  const first = f.browser({ state: 1, allow_file_access: true }, 'legacy');
  const second = f.browser({ disable_reasons: [], file_access: true }, 'legacy2');
  const third = f.browser({ state: 1, disable_reasons: ['user_action'], newAllowFileAccess: false }, 'disabled');
  f.registry([first, second, third]); const report = await f.service().query();
  assert.equal(entry(report, first.id).status, 'ready'); assert.equal(entry(report, second.id).status, 'ready');
  assert.equal(entry(report, third.id).checks.find(value => value.name === 'extension')?.status, 'missing');
  assert.equal(entry(report, third.id).checks.find(value => value.name === 'file-access')?.status, 'missing');
});

test('browser checks use the exact configured profile and do not borrow another profile permission or history', async t => {
  const f = fixture(t); const working = f.browser({ state: 1, newAllowFileAccess: true }, 'working');
  const absent = { ...working, id: 'different-profile', browser: { ...working.browser, profilePath: join(f.root, 'NotConfigured') } };
  f.registry([working, absent]); const report = await f.service().query();
  assert.equal(entry(report, working.id).status, 'ready'); assert.equal(entry(report, absent.id).status, 'missing');
  assert.equal(entry(report, absent.id).checks.find(value => value.name === 'file-access')?.status, 'unknown');
});

test('corrupt Chrome settings and native host origin mismatch are visible without echoing source contents', async t => {
  const f = fixture(t); const browser = f.browser({ state: 1, newAllowFileAccess: true });
  writeFileSync(join(browser.browser.profilePath, 'Secure Preferences'), 'BROKEN private-cookie-value');
  writeFileSync(browser.browser.nativeHostManifests[0]!, JSON.stringify({ name: 'com.openai.codexextension', path: process.execPath, allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'] }));
  f.registry([browser]); const report = await f.service().query(); const chrome = entry(report, browser.id);
  assert.equal(chrome.checks.find(value => value.name === 'extension')?.status, 'unknown');
  assert.equal(chrome.checks.find(value => value.name === 'native-host')?.status, 'missing');
  assert.ok(!JSON.stringify(report).includes('BROKEN'));
});

test('CLI prerequisite check detects missing explicit entrypoint without executing the configured command', async t => {
  const f = fixture(t); const trap = join(f.root, 'never-run.cjs'); const marker = join(f.root, 'executed');
  writeFileSync(trap, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');`);
  f.config.commands.codex.args = [trap]; f.config.commands.claude.args = [join(f.root, 'missing-claude.cjs')];
  const report = await f.service().query(); assert.equal(entry(report, 'cli-codex').status, 'ready'); assert.equal(entry(report, 'cli-claude').status, 'missing');
  assert.ok(!readdirSync(f.root).includes('executed'));
});

test('historical scoped acceptance is separate from current web app login, delivery, and desktop lock status', async t => {
  const f = fixture(t); f.registry([
    { id: 'feishu', label: '飞书', targetId: 'local', agent: 'codex', kind: 'web-app', acceptance: { checkedAt: '2026-10-12T01:00:00Z', status: 'passed', scope: 'app-read', note: '历史可读公司消息' } },
    { id: 'desktop', label: '锁屏桌面操作', targetId: 'local', kind: 'desktop' },
  ]); const report = await f.service().query();
  assert.equal(entry(report, 'feishu').status, 'registered'); assert.equal(entry(report, 'feishu').runtimeStatus, 'unknown');
  assert.equal(entry(report, 'feishu').acceptance?.scope, 'app-read'); assert.equal(entry(report, 'feishu').acceptance?.status, 'passed');
  assert.equal(entry(report, 'desktop').status, 'unknown'); assert.match(entry(report, 'desktop').checks[0]!.note, /未观察/);
});

test('remote registrations and non-loopback proxy never trigger external network or SSH/CLI work', async t => {
  const f = fixture(t); let probes = 0; f.config.proxyUrl = 'http://example.test:7898';
  f.registry([{ id: 'remote-chrome', label: '工位 Claude 浏览器待验收', targetId: 'workstation', agent: 'claude', kind: 'browser', browser: { profilePath: 'Z:\\Unavailable', extensionId, nativeHostManifests: ['Z:\\NoManifest.json'] } }]);
  const report = await f.service({ probeTcp: async () => { probes++; return false; } }).query();
  assert.equal(probes, 0); assert.equal(entry(report, 'remote-chrome').status, 'registered'); assert.equal(entry(report, 'remote-chrome').runtimeStatus, 'unknown');
  assert.equal(entry(report, 'proxy').status, 'unknown');
});

test('proxy checks use one local TCP connection and do not send a request body', async t => {
  const f = fixture(t); let received = '';
  const listener = createServer(socket => socket.on('data', bytes => { received += bytes.toString(); }));
  await new Promise<void>(resolveReady => listener.listen(0, '127.0.0.1', resolveReady));
  t.after(() => listener.close()); const address = listener.address(); assert.ok(address && typeof address === 'object');
  f.config.proxyUrl = `http://127.0.0.1:${address.port}`; const report = await f.service().query();
  assert.equal(entry(report, 'proxy').status, 'ready'); assert.equal(received, '');
});

test('cache is scoped to exact workspace, preserves checkedAt, and becomes explicitly stale without retry storms', async t => {
  const f = fixture(t); let now = Date.parse('2026-10-12T01:00:00Z'); let probes = 0; f.config.proxyUrl = 'http://127.0.0.1:7898';
  const health = f.service({ now: () => now, staleAfterMs: 1000, probeTcp: async () => { probes++; return true; } });
  const before = await health.query(); f.registry([{ id: 'new-app', label: 'New', targetId: 'local', kind: 'web-app' }]); now += 1500;
  const old = await health.query(); assert.equal(old.checkedAt, before.checkedAt); assert.equal(old.stale, true); assert.equal(probes, 1); assert.ok(!old.items.some(value => value.id === 'new-app'));
  const fresh = await health.query(f.workspace, { refresh: true }); assert.equal(fresh.stale, false); assert.equal(probes, 2); entry(fresh, 'new-app');
  const second = join(f.root, 'second-workspace'); mkdirSync(second); writeFileSync(join(second, 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
  const separate = await health.query(second); assert.ok(!separate.items.some(value => value.id === 'new-app')); assert.equal(probes, 3);
  const saved = readdirSync(join(f.config.dataDir, 'capability-health')); assert.equal(saved.filter(value => value.endsWith('.json')).length, 2);
  for (const filename of saved) assert.ok(!readFileSync(join(f.config.dataDir, 'capability-health', filename), 'utf8').includes('private-bot-token'));
});

test('concurrent refreshes share one bounded local probe', async t => {
  const f = fixture(t); f.config.proxyUrl = 'http://127.0.0.1:7898'; let probes = 0; let unblock!: () => void;
  const gate = new Promise<void>(resolveGate => { unblock = resolveGate; });
  const health = f.service({ probeTcp: async () => { probes++; await gate; return true; } });
  const first = health.refresh(); const second = health.refresh(); unblock(); await Promise.all([first, second]); assert.equal(probes, 1);
});

test('filtered reports have a bounded UTF-8 payload, preserve machine/agent selection and can find omitted capability details', async t => {
  const f = fixture(t); f.registry(Array.from({ length: 64 }, (_, index) => ({ id: `app-${index}`, label: '需要明确检查定位的已登记应用'.repeat(5), targetId: index % 2 ? 'workstation' : 'local', agent: index % 2 ? 'claude' : 'codex', kind: 'web-app', acceptance: { checkedAt: '2026-10-12T01:00:00Z', status: 'passed', scope: 'app-read', note: '历史验收说明'.repeat(30) } })));
  const health = f.service(); const report = await health.query();
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 8 * 1024); assert.ok(report.omitted > 0); assert.equal(report.total, 68);
  const only = await health.query(f.workspace, { targetId: 'workstation', agent: 'claude', capabilityId: 'app-63' }); assert.equal(only.items.length, 1); assert.equal(only.omitted, 0); assert.equal(only.items[0]?.id, 'app-63');
});

test('missing and malformed registries are reported without exposing rejected values, and relative workspace queries fail', async t => {
  const f = fixture(t); rmSync(join(f.workspace, 'capabilities.json')); const health = f.service();
  assert.equal(entry(await health.query(), 'registry').status, 'unknown');
  writeFileSync(join(f.workspace, 'capabilities.json'), '{bad private-bot-token');
  const broken = await health.query(f.workspace, { refresh: true }); assert.equal(entry(broken, 'registry').status, 'missing'); assert.ok(!JSON.stringify(broken).includes('private-bot-token'));
  await assert.rejects(() => health.query('relative/workspace'), /绝对路径/); assert.match(startupSummary(broken), /缺项/);
});

test('persisted cache is re-whitelisted on restart instead of returning arbitrary writable fields', async t => {
  const f = fixture(t); await f.service().query(); const directory = join(f.config.dataDir, 'capability-health'); const path = join(directory, readdirSync(directory)[0]!);
  const cache = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; cache.secret = 'private-cache-extra'; (cache.items as Record<string, unknown>[])[0]!.cookie = 'private-cache-cookie'; writeFileSync(path, JSON.stringify(cache));
  const report = await f.service().query(); assert.ok(!JSON.stringify(report).includes('private-cache'));
});
