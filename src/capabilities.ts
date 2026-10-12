import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, mkdir, writeFile, rename, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join, resolve, win32, posix } from 'node:path';
import type { AgentName, BridgeConfig } from './types.js';

export type CapabilityKind = 'cli' | 'browser' | 'web-app' | 'desktop';
export type HealthStatus = 'ready' | 'missing' | 'unknown' | 'registered';
export interface CapabilityAcceptance {
  checkedAt: string;
  status: 'passed' | 'failed';
  scope: 'cli' | 'dom' | 'file-selection' | 'app-read' | 'app-write' | 'file-delivery' | 'desktop';
  note?: string;
}
export interface CapabilityRegistration {
  id: string;
  label: string;
  targetId: string;
  agent?: AgentName;
  kind: CapabilityKind;
  browser?: { profilePath: string; extensionId: string; nativeHostManifests?: string[] };
  acceptance?: CapabilityAcceptance;
}
export interface CapabilityCheck { name: string; status: HealthStatus; note: string }
export interface CapabilityHealthItem {
  id: string; label: string; targetId: string; agent?: AgentName; kind: CapabilityKind | 'workspace' | 'proxy' | 'registry';
  /** ready verifies static prerequisites only, never current login/DOM/upload delivery. */
  status: HealthStatus; verification: 'static' | 'registration'; runtimeStatus: 'unknown';
  checks: CapabilityCheck[]; acceptance?: CapabilityAcceptance;
}
export interface CapabilityHealthReport {
  version: 1; workspace: string; checkedAt: string; stale: boolean; scope: 'static-prerequisites';
  items: CapabilityHealthItem[]; total: number; omitted: number;
}
export interface CapabilityHealthQuery { targetId?: string; agent?: AgentName; capabilityId?: string; refresh?: boolean }
export interface CapabilityHealthOptions {
  now?: () => number;
  staleAfterMs?: number;
  /** Tests can supply a loopback-only listener probe; never a URL fetch or a CLI turn. */
  probeTcp?: (host: string, port: number) => Promise<boolean>;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const MAX_REPORT_BYTES = 8 * 1024;
const MAX_REGISTRY_BYTES = 128 * 1024;
function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name}无效。`);
  return value;
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 64); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(result)) throw new Error(`${name}无效。`); return result;
}
function absolute(value: unknown, name: string): string {
  const result = text(value, name, 4000); if (!win32.isAbsolute(result) && !posix.isAbsolute(result)) throw new Error(`${name}必须为绝对路径。`); return result;
}
export function parseCapabilityRegistry(raw: unknown): CapabilityRegistration[] {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.capabilities) || raw.capabilities.length > 64) throw new Error('capabilities.json 需要 version:1 和最多 64 项 capabilities 数组。');
  const seen = new Set<string>();
  return raw.capabilities.map(value => {
    if (!object(value)) throw new Error('能力登记格式无效。');
    const entryId = id(value.id, '能力 id'); if (seen.has(entryId)) throw new Error('能力 id 重复。'); seen.add(entryId);
    if (!['cli', 'browser', 'web-app', 'desktop'].includes(String(value.kind))) throw new Error('能力 kind 无效。');
    if (value.agent != null && value.agent !== 'codex' && value.agent !== 'claude') throw new Error('能力 agent 只能是 codex 或 claude。');
    const result: CapabilityRegistration = { id: entryId, label: text(value.label, '能力名称', 100), targetId: id(value.targetId, '目标 id'), kind: value.kind as CapabilityKind };
    if (value.agent != null) result.agent = value.agent as AgentName;
    if (value.browser != null) {
      if (!object(value.browser)) throw new Error('browser 登记无效。');
      const extensionId = text(value.browser.extensionId, 'Chrome 扩展 id', 32);
      if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Chrome 扩展 id 无效。');
      result.browser = { profilePath: absolute(value.browser.profilePath, 'Chrome profilePath'), extensionId };
      if (value.browser.nativeHostManifests != null) {
        if (!Array.isArray(value.browser.nativeHostManifests) || value.browser.nativeHostManifests.length > 4) throw new Error('nativeHostManifests 必须为最多 4 项绝对路径数组。');
        result.browser.nativeHostManifests = value.browser.nativeHostManifests.map(path => absolute(path, 'Native host manifest'));
      }
    }
    if (value.acceptance != null) {
      const accepted = value.acceptance;
      if (!object(accepted) || typeof accepted.checkedAt !== 'string' || !Number.isFinite(Date.parse(accepted.checkedAt)) || !['passed', 'failed'].includes(String(accepted.status))
        || !['cli', 'dom', 'file-selection', 'app-read', 'app-write', 'file-delivery', 'desktop'].includes(String(accepted.scope))) throw new Error('历史验收需要 checkedAt、status 和明确 scope。');
      result.acceptance = { checkedAt: new Date(accepted.checkedAt).toISOString(), status: accepted.status as CapabilityAcceptance['status'], scope: accepted.scope as CapabilityAcceptance['scope'] };
      if (accepted.note != null) result.acceptance.note = text(accepted.note, '历史验收说明', 240);
    }
    return result;
  });
}
async function regularFile(path: string): Promise<boolean> { try { return (await stat(path)).isFile(); } catch { return false; } }
async function directory(path: string): Promise<boolean> { try { return (await stat(path)).isDirectory(); } catch { return false; } }
async function jsonFile(path: string, limit: number): Promise<unknown> {
  const info = await stat(path); if (!info.isFile() || info.size > limit) throw new Error('登记或设置文件过大／不是普通文件。');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
}
async function loopbackProbe(host: string, port: number): Promise<boolean> {
  return new Promise(resolveProbe => {
    const socket = connect({ host, port }); let done = false;
    const finish = (value: boolean) => { if (done) return; done = true; socket.destroy(); resolveProbe(value); };
    socket.setTimeout(800); socket.once('connect', () => finish(true)); socket.once('timeout', () => finish(false)); socket.once('error', () => finish(false));
  });
}
function check(name: string, status: HealthStatus, note: string): CapabilityCheck { return { name, status, note }; }
function combined(checks: CapabilityCheck[]): HealthStatus { return checks.some(item => item.status === 'missing') ? 'missing' : checks.some(item => item.status === 'unknown') ? 'unknown' : 'ready'; }
function item(entry: Pick<CapabilityHealthItem, 'id' | 'label' | 'targetId' | 'kind' | 'agent'>, checks: CapabilityCheck[], verification: CapabilityHealthItem['verification'] = 'static'): CapabilityHealthItem {
  return { ...entry, status: verification === 'registration' ? 'registered' : combined(checks), verification, runtimeStatus: 'unknown', checks };
}
export class CapabilityHealthService {
  private readonly cache = new Map<string, CapabilityHealthReport>();
  private readonly inFlight = new Map<string, Promise<CapabilityHealthReport>>();
  private readonly now: () => number;
  private readonly probe: (host: string, port: number) => Promise<boolean>;
  private readonly staleAfterMs: number;
  constructor(private readonly config: BridgeConfig, options: CapabilityHealthOptions = {}) {
    this.now = options.now ?? Date.now; this.probe = options.probeTcp ?? loopbackProbe; this.staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000;
  }
  startupSummary(report: CapabilityHealthReport): string { return startupSummary(report); }
  private workspacePath(workspace: string): string {
    if (!isAbsolute(workspace)) throw new Error('能力检查工作区必须为本机绝对路径。'); return resolve(workspace);
  }
  async refresh(workspace = this.config.workspace): Promise<CapabilityHealthReport> {
    const path = this.workspacePath(workspace); const pending = this.inFlight.get(path); if (pending) return structuredClone(await pending);
    const operation = this.inspect(path); this.inFlight.set(path, operation);
    try { return structuredClone(await operation); } finally { this.inFlight.delete(path); }
  }
  async query(workspace = this.config.workspace, query: CapabilityHealthQuery = {}): Promise<CapabilityHealthReport> {
    const path = this.workspacePath(workspace);
    if (query.agent != null && query.agent !== 'codex' && query.agent !== 'claude') throw new Error('agent 无效。');
    if (query.targetId != null) id(query.targetId, '目标 id'); if (query.capabilityId != null) id(query.capabilityId, '能力 id');
    const report = query.refresh ? await this.refresh(path) : this.cache.get(path) ?? await this.cachedOrInspect(path);
    const filtered = report.items.filter(value => (!query.targetId || value.targetId === query.targetId) && (!query.agent || value.agent === query.agent) && (!query.capabilityId || value.id === query.capabilityId));
    const result: CapabilityHealthReport = { ...report, workspace: report.workspace.length > 400 ? `${report.workspace.slice(0, 397)}...` : report.workspace,
      stale: this.now() - Date.parse(report.checkedAt) > this.staleAfterMs, items: structuredClone(filtered.slice(0, 32)), total: filtered.length, omitted: Math.max(0, filtered.length - 32) };
    // Result receipts and user browser preferences never enter this compact, whitelisted report.
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_REPORT_BYTES && result.items.length) { result.items.pop(); result.omitted++; }
    return result;
  }
  private cachePath(workspace: string): string { return join(this.config.dataDir, 'capability-health', `${createHash('sha256').update(workspace).digest('hex')}.json`); }
  private async cachedOrInspect(workspace: string): Promise<CapabilityHealthReport> {
    try {
      const raw = await jsonFile(this.cachePath(workspace), 512 * 1024);
      // Do not trust writable persisted fields enough to return them to a model.
      if (object(raw) && raw.version === 1 && raw.workspace === workspace && typeof raw.checkedAt === 'string' && Number.isFinite(Date.parse(raw.checkedAt)) && Array.isArray(raw.items)) {
        const saved = this.sanitizeCached(raw, workspace); if (saved) { this.cache.set(workspace, saved); return saved; }
      }
    } catch { /* Missing or invalid cache is rebuilt once, without CLI calls. */ }
    return this.refresh(workspace);
  }
  private sanitizeCached(raw: Record<string, unknown>, workspace: string): CapabilityHealthReport | null {
    if (!Array.isArray(raw.items) || raw.items.length > 72) return null;
    const items: CapabilityHealthItem[] = [];
    try {
      for (const value of raw.items) {
        if (!object(value) || !Array.isArray(value.checks) || value.checks.length > 8 || !['cli', 'browser', 'web-app', 'desktop', 'workspace', 'proxy', 'registry'].includes(String(value.kind))
          || !['ready', 'missing', 'unknown', 'registered'].includes(String(value.status)) || !['static', 'registration'].includes(String(value.verification))) return null;
        const checks = value.checks.map(entry => {
          if (!object(entry) || !['ready', 'missing', 'unknown', 'registered'].includes(String(entry.status))) throw new Error('缓存检查无效。');
          return check(text(entry.name, '检查项', 80), entry.status as HealthStatus, text(entry.note, '检查说明', 400));
        });
        const saved = item({ id: id(value.id, '能力 id'), label: text(value.label, '能力名称', 100), targetId: id(value.targetId, '目标 id'), kind: value.kind as CapabilityHealthItem['kind'] }, checks, value.verification as CapabilityHealthItem['verification']);
        saved.status = value.status as HealthStatus;
        if (value.agent === 'codex' || value.agent === 'claude') saved.agent = value.agent;
        if (value.acceptance != null) saved.acceptance = parseCapabilityRegistry({ version: 1, capabilities: [{ id: saved.id, label: saved.label, targetId: saved.targetId, kind: 'cli', acceptance: value.acceptance }] })[0]?.acceptance;
        items.push(saved);
      }
      return { version: 1, workspace, checkedAt: raw.checkedAt as string, stale: true, scope: 'static-prerequisites', items, total: items.length, omitted: 0 };
    } catch { return null; }
  }
  private async inspect(workspace: string): Promise<CapabilityHealthReport> {
    const entries: CapabilityHealthItem[] = [];
    const present = await directory(workspace);
    entries.push(item({ id: 'workspace', label: '工作区入口', targetId: 'local', kind: 'workspace' }, [
      check('directory', present ? 'ready' : 'missing', present ? '工作区目录存在。' : '工作区目录不存在。'),
      check('AGENTS.md', await regularFile(join(workspace, 'AGENTS.md')) ? 'ready' : 'missing', '主控工作区导航入口；不读取正文。'),
      check('README.md', await regularFile(join(workspace, 'README.md')) ? 'ready' : 'missing', '工作区说明入口；不读取正文。'),
    ]));
    for (const agent of ['codex', 'claude'] as const) entries.push(await this.cli(agent, `cli-${agent}`));
    entries.push(await this.proxy());
    let registrations: CapabilityRegistration[] = [];
    try {
      registrations = parseCapabilityRegistry(await jsonFile(join(workspace, 'capabilities.json'), MAX_REGISTRY_BYTES));
      if (registrations.some(value => ['workspace', 'cli-codex', 'cli-claude', 'proxy', 'registry'].includes(value.id))) throw new Error('能力 id 与内置检查名称冲突。');
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      entries.push(item({ id: 'registry', label: '能力登记', targetId: 'local', kind: 'registry' }, [check('capabilities.json', missing ? 'unknown' : 'missing', missing ? '尚未登记应用／浏览器能力；可生成空骨架后补充。' : '能力登记无效；检查 version、必填字段与绝对路径。')]));
    }
    const browserChecks = new Map<string, Promise<CapabilityCheck[]>>();
    for (const registration of registrations) {
      let result: CapabilityHealthItem;
      if (registration.targetId !== 'local') result = item(registration, [check('remote', 'registered', '只读取远端登记；未连接 SSH 或验证远端登录／权限。')], 'registration');
      else if (registration.kind === 'cli' && registration.agent) result = await this.cli(registration.agent, registration.id, registration.label);
      else if (registration.kind === 'browser') {
        const key = JSON.stringify(registration.browser ?? null);
        let pending = browserChecks.get(key);
        if (!pending) { pending = this.browser(registration).then(value => value.checks); browserChecks.set(key, pending); }
        result = item(registration, structuredClone(await pending));
      }
      else if (registration.kind === 'desktop') result = item(registration, [check('lock-screen', 'unknown', '未观察桌面解锁状态；桌面视觉操作可能依赖登录会话，网页原生通道应单独验收。')]);
      else result = item(registration, [check('current-session', 'unknown', registration.kind === 'cli' ? '未登记所用 Agent，无法检查 CLI 入口。' : '应用已登记；当前登录、读取／写入及文件交付需实际验收。')], 'registration');
      if (registration.acceptance) result.acceptance = registration.acceptance;
      entries.push(result);
    }
    const report: CapabilityHealthReport = { version: 1, workspace, checkedAt: new Date(this.now()).toISOString(), stale: false, scope: 'static-prerequisites', items: entries, total: entries.length, omitted: 0 };
    this.cache.set(workspace, report);
    const file = this.cachePath(workspace); await mkdir(join(this.config.dataDir, 'capability-health'), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(report), { encoding: 'utf8', flag: 'wx' }); await rename(temporary, file);
    return report;
  }
  private async cli(agent: AgentName, entryId: string, label = `${agent} 本机 CLI`): Promise<CapabilityHealthItem> {
    const command = this.config.commands[agent]; const executable = await regularFile(command.command);
    const paths = command.args.filter(value => isAbsolute(value) && /\.(?:[cm]?js|exe|ps1|cmd|bat|py)$/i.test(value));
    const checks = [check('runtime', executable ? 'ready' : 'missing', executable ? '配置的 CLI 运行时文件存在；未启动模型。' : '配置的 CLI 运行时文件缺失；检查本机安装路径。')];
    for (const path of paths.slice(0, 4)) {
      const exists = await regularFile(path);
      checks.push(check('cli-entry', exists ? 'ready' : 'missing', exists ? '参数指定的 CLI 入口文件存在。' : '参数指定的 CLI 入口文件缺失；更新本机命令登记。'));
    }
    return item({ id: entryId, label, targetId: 'local', agent, kind: 'cli' }, checks);
  }
  private async proxy(): Promise<CapabilityHealthItem> {
    if (!this.config.proxyUrl) return item({ id: 'proxy', label: '本机代理', targetId: 'local', kind: 'proxy' }, [check('port', 'unknown', '桥未配置代理；是否需要代理取决于当前网络。')]);
    let url: URL; try { url = new URL(this.config.proxyUrl); } catch { return item({ id: 'proxy', label: '本机代理', targetId: 'local', kind: 'proxy' }, [check('port', 'missing', '代理 URL 格式无效。')]); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return item({ id: 'proxy', label: '本机代理', targetId: 'local', kind: 'proxy' }, [check('port', 'unknown', '非回环代理只记录配置；静态体检不连接外网。')]);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80)); let open = false;
    try { open = await this.probe(host === 'localhost' ? '127.0.0.1' : host, port); } catch { /* A closed listener is a prerequisite failure, not an authentication failure. */ }
    return item({ id: 'proxy', label: '本机代理', targetId: 'local', kind: 'proxy' }, [check('port', open ? 'ready' : 'missing', open ? `本机 ${port} 端口接受 TCP；未验证外网／供应商额度。` : `本机 ${port} 端口未响应；先启动代理／隧道。`)]);
  }
  private async browser(registration: CapabilityRegistration): Promise<CapabilityHealthItem> {
    const browser = registration.browser;
    if (!browser) return item(registration, [check('profile', 'unknown', '未登记 Chrome profilePath、extensionId；无法定位已登录浏览器。')]);
    const checks: CapabilityCheck[] = []; const profilePresent = await directory(browser.profilePath);
    checks.push(check('profile', profilePresent ? 'ready' : 'missing', profilePresent ? '指定 Chrome profile 存在；未验证网页当前登录。' : '指定 Chrome profile 不存在；核对使用中的浏览器用户配置。'));
    let extension: Record<string, unknown> | undefined; let readable = false;
    for (const filename of ['Preferences', 'Secure Preferences']) {
      try {
        const preferences = await jsonFile(join(browser.profilePath, filename), 16 * 1024 * 1024);
        readable = true;
        const extensions = object(preferences) && object(preferences.extensions) ? preferences.extensions : undefined;
        const settings = extensions && object(extensions.settings) ? extensions.settings : undefined;
        const registered = settings?.[browser.extensionId]; if (object(registered)) extension = { ...extension, ...registered };
      } catch { /* Missing and malformed settings are reported without returning their contents. */ }
    }
    let installed = false;
    try {
      const path = join(browser.profilePath, 'Extensions', browser.extensionId);
      for (const version of (await readdir(path, { withFileTypes: true })).slice(0, 16)) if (version.isDirectory() && await regularFile(join(path, version.name, 'manifest.json'))) { installed = true; break; }
    } catch { /* Local directory only; no Chrome process or browser API invocation. */ }
    const disabled = extension?.state === 0 || extension?.state === '0' || extension?.enabled === false
      || (Array.isArray(extension?.disable_reasons) && extension.disable_reasons.length > 0)
      || (typeof extension?.disable_reasons === 'number' && extension.disable_reasons !== 0);
    const explicitlyEnabled = extension?.state === 1 || extension?.state === '1' || extension?.enabled === true
      || (Array.isArray(extension?.disable_reasons) && extension.disable_reasons.length === 0);
    const extensionStatus: HealthStatus = !installed ? 'missing' : disabled ? 'missing' : !extension || !readable ? 'unknown' : explicitlyEnabled ? 'ready' : 'unknown';
    checks.push(check('extension', extensionStatus, !installed ? '指定 profile 未找到扩展安装文件。' : disabled ? '扩展明确处于禁用状态；在该 Chrome profile 启用。' : extensionStatus === 'ready' ? '扩展已安装，设置显示启用。' : '扩展已安装，但设置未提供明确启用状态；缺字段不等于已禁用。'));
    const permissionValues = [extension?.newAllowFileAccess, extension?.allow_file_access, extension?.file_access].filter(value => typeof value === 'boolean');
    // New Chrome field takes precedence when both new and legacy keys are present.
    const permission = typeof extension?.newAllowFileAccess === 'boolean' ? extension.newAllowFileAccess : permissionValues[0];
    checks.push(check('file-access', permission === true ? 'ready' : permission === false ? 'missing' : 'unknown', permission === true ? '允许访问文件网址已开启；静态权限不代表飞书图片已发送。' : permission === false ? '在 Chrome 扩展详细信息开启“允许访问文件网址”。' : '未读到明确文件权限；在指定 profile 核对“允许访问文件网址”。'));
    if (!browser.nativeHostManifests?.length) checks.push(check('native-host', 'unknown', '未登记 Native host manifest；不能据扩展安装推定原生连接就绪。'));
    else {
      let hostStatus: HealthStatus = 'missing';
      for (const path of browser.nativeHostManifests) {
        try {
          const manifest = await jsonFile(path, 128 * 1024);
          if (!object(manifest) || manifest.name !== 'com.openai.codexextension' || typeof manifest.path !== 'string' || !isAbsolute(manifest.path)
            || !Array.isArray(manifest.allowed_origins) || !manifest.allowed_origins.includes(`chrome-extension://${browser.extensionId}/`)) continue;
          if (await regularFile(manifest.path)) { hostStatus = 'ready'; break; }
        } catch { /* Read only the explicit manifest and its executable existence. */ }
      }
      checks.push(check('native-host', hostStatus, hostStatus === 'ready' ? 'Manifest、允许的扩展 origin 与本机执行文件存在；未验证实时连接。' : 'Native host manifest／扩展 origin／执行文件缺失或不匹配；修复本机插件安装。'));
    }
    return item(registration, checks);
  }
}
export function startupSummary(report: CapabilityHealthReport): string {
  const counts = { ready: 0, missing: 0, unknown: 0, registered: 0 };
  for (const entry of report.items) counts[entry.status]++;
  const problems = report.items.filter(entry => entry.status === 'missing' || entry.status === 'unknown').slice(0, 8).map(entry => `${entry.targetId}/${entry.agent ?? 'common'}/${entry.id}:${entry.status}`);
  return `静态能力体检 ${report.checkedAt}：就绪 ${counts.ready}，缺项 ${counts.missing}，未知 ${counts.unknown}，仅登记 ${counts.registered}。${problems.length ? ` ${problems.join('；')}。` : ''}未验证网页实时登录／DOM／文件交付。`;
}
