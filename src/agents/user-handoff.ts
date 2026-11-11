import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentCommand } from '../types.js';
import { NativeSessionLeaseStore, type NativeSessionRead, type NativeSessionRef, type NativeSessionExecution } from '../native-sessions.js';
import { PresetRuntime } from '../presets/runtime.js';
import { WorkerSessionRuntime } from './worker-session.js';

interface UserHandoff {
  version: 1; dataRoot: string; privateRoot: string; leasePath: string; command: AgentCommand;
  ref: NativeSessionRef; cwd: string; transcriptPath: string; execution: NativeSessionExecution;
}
/** No credentials in the command or descriptor; they are loaded on the target at launch. */
export function userHandoffCommand(dataRoot: string, privateRoot: string, command: AgentCommand,
  info: NativeSessionRead, transcriptPath: string, leasePath: string): string {
  if (!info.ownership) throw new Error('会话缺少已核实的持有者。');
  const execution = info.execution ?? { workerId: info.ownership.workerId, model: info.model, effort: info.effort };
  const directory = join(dataRoot, 'user-handoffs', info.ref.agent); mkdirSync(directory, { recursive: true });
  const path = join(directory, info.nativeId + '.json'), temporary = path + '.' + randomUUID() + '.tmp';
  const value: UserHandoff = { version: 1, dataRoot, privateRoot, leasePath, command, ref: info.ref, cwd: info.cwd, transcriptPath, execution };
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
  const args = [process.execPath, fileURLToPath(import.meta.url), path];
  const quote = process.platform === 'win32' ? (v: string) => `'${v.replaceAll("'", "''")}'` : (v: string) => `'${v.replaceAll("'", `'"'"'`)}'`;
  return `${process.platform === 'win32' ? '& ' : ''}${args.map(quote).join(' ')}`;
}

export async function runUserHandoff(path: string, prompt?: string): Promise<number> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as UserHandoff;
  if (value.version !== 1 || !value.execution || !value.transcriptPath) throw new Error('会话交接文件无效。');
  // Hold the actual transcript throughout user control. Bump the lease revision
  // after opening it, so an adoption inspected just before this launch is stale.
  const file = openSync(value.transcriptPath, 'r');
  let prepared: Awaited<ReturnType<PresetRuntime['prepare']>> | undefined;
  try {
    const leases = new NativeSessionLeaseStore(value.leasePath);
    try { leases.startUser(value.ref, value.execution.workerId); } finally { leases.close(); }
    const execution = value.execution, agent = value.ref.agent;
    let command = value.command, env = { ...process.env };
    if (execution.preset) {
      prepared = await new PresetRuntime(value.privateRoot, value.dataRoot).prepare(execution.preset, execution.workerId, value.ref.nativeId, command, env, execution.sessionVisibility);
      command = prepared.command; env = prepared.env;
    } else if (execution.sessionVisibility) {
      env = new WorkerSessionRuntime(value.dataRoot).prepare(agent, execution.workerId, value.ref.nativeId, execution.sessionVisibility, env);
    }
    const selection = [...(execution.model ? ['--model', execution.model] : []),
      ...(execution.effort ? agent === 'codex' ? ['-c', `model_reasoning_effort=${JSON.stringify(execution.effort)}`] : ['--effort', execution.effort] : [])];
    const args = agent === 'codex'
      ? prompt === undefined ? ['resume', value.ref.nativeId, ...selection] : ['exec', 'resume', '--json', '--skip-git-repo-check', ...selection, value.ref.nativeId, prompt]
      : prompt === undefined ? ['--resume', value.ref.nativeId, ...selection] : ['--print', prompt, '--resume', value.ref.nativeId, ...selection, '--output-format', 'json', '--tools', ''];
    return await new Promise<number>((accept, reject) => {
      const child = spawn(command.command, [...command.args, ...args], { cwd: value.cwd, env, stdio: 'inherit' });
      child.once('error', reject); child.once('exit', code => accept(code ?? 1));
    });
  } finally { try { await prepared?.close(); } finally { closeSync(file); } }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const promptIndex = process.argv.indexOf('--prompt', 3);
  runUserHandoff(process.argv[2]!, promptIndex < 0 ? undefined : process.argv[promptIndex + 1])
    .then(code => { process.exitCode = code; }, error => { console.error(error instanceof Error ? error.message : '会话交接启动失败。'); process.exitCode = 1; });
}
