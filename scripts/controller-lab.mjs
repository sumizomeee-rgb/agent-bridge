import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, config: { type: 'string' },
  agent: { type: 'string', default: 'codex' }, 'runtime-root': { type: 'string' },
} });
const root = resolve(values['runtime-root'] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
if (!['codex', 'claude', 'both'].includes(values.agent)) throw new Error('--agent must be codex, claude or both');
if (values.live && !values.config) throw new Error('--live requires an explicit --config (routing only; production databases are never opened)');
const runDir = join(root, '.local', 'controller-lab', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
mkdirSync(runDir, { recursive: true });
const evidence = { version: 1, startedAt: new Date().toISOString(), mode: values.live ? 'live' : 'deterministic',
  runDir, runtimeHashes: {}, harnessHashes: {}, cases: [], status: 'running',
  scope: { platform: 'local receipt sink; no Feishu/Discord connection', isolation: 'fresh databases, native homes and workspace; same CLI/auth/provider routing',
    excluded: ['production conversation history', 'real platform delivery', 'cross-machine execution', 'business tools', 'cross-day stability'] } };
for (const file of ['controller/native.js', 'controller/runtime.js', 'manager.js', 'store.js', 'agents/process.js']) {
  evidence.runtimeHashes[file] = createHash('sha256').update(readFileSync(join(root, 'dist/src', file))).digest('hex');
}
for (const file of ['controller-lab.mjs', 'controller-lab/live.mjs', 'controller-lab/faults.mjs']) {
  evidence.harnessHashes[file] = createHash('sha256').update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), file))).digest('hex');
}
const save = () => writeFileSync(join(runDir, 'report.json'), JSON.stringify(evidence, null, 2));
save(); console.log(JSON.stringify({ runDir, mode: evidence.mode }));
try {
  if (!values.live) {
    // Known unrelated remote-stop regressions are deliberately outside this named suite.
    const files = ['controller-resilience', 'controller-native', 'controller-feedback', 'private-input-manager', 'private-input-store', 'presentation-lifecycle', 'controller-native-delivery', 'task-manager', 'restart-manager', 'maintenance-drain'];
    const output = [];
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', join(dirname(fileURLToPath(import.meta.url)), 'controller-lab/faults.test.mjs'), ...files.map(name => join(root, 'dist/test', name + '.test.js'))],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => output.push(bytes));
    const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept); });
    const log = Buffer.concat(output).toString('utf8'); writeFileSync(join(runDir, 'deterministic.tap'), log);
    const count = key => Number(log.match(new RegExp('^# ' + key + ' (\\d+)', 'm'))?.[1] ?? 0);
    evidence.cases.push({ name: 'deterministic fault and queue suite', files, status: code === 0 && count('tests') > 0 ? 'passed' : 'failed',
      exitCode: code, tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped') });
  } else {
    const { runLive } = await import('./controller-lab/live.mjs');
    for (const agent of values.agent === 'both' ? ['codex', 'claude'] : [values.agent]) {
      await runLive({ root, runDir, configPath: resolve(values.config), agent, evidence, save });
    }
  }
  evidence.status = evidence.cases.length > 0 && evidence.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  // Do not print config, native prompts, auth environment or raw subprocess output.
  evidence.status = 'failed'; evidence.harnessError = { name: error.name, message: String(error.message).slice(0, 300) };
} finally {
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, cases: evidence.cases.map(({ name, status }) => ({ name, status })), report: join(runDir, 'report.json') }));
  if (evidence.status !== 'passed') process.exitCode = 1;
}
