import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentProcessStopError, JsonLineProcess, processStopFailure, stopEvidenceFromError, type JsonObject } from '../src/agents/process.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const launcher = String.raw`
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=process.argv[2];fs.writeFileSync(path.join(root,'launcher.json'),JSON.stringify({pid:process.pid}));
const child=spawn(process.execPath,[path.join(root,'native.cjs'),root],{stdio:'inherit',windowsHide:true});
child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));
`;
const native = String.raw`
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=process.argv[2],options=JSON.parse(fs.readFileSync(path.join(root,'options.json'),'utf8'));
fs.writeFileSync(path.join(root,'native.json'),JSON.stringify({pid:process.pid}));
let child;const keep=setInterval(()=>{},1000);
if(options.background) {child=spawn(process.execPath,[path.join(root,'background.cjs'),root],{stdio:options.backgroundStdioIgnore?'ignore':['ignore','inherit','inherit'],windowsHide:true,detached:options.detached!==false});child.unref();}
const ready=setInterval(()=>{
 if(child&&!fs.existsSync(path.join(root,'background.json')))return;clearInterval(ready);
 process.stdout.write(JSON.stringify({type:'completed',nativePid:process.pid,backgroundPid:child?.pid})+'\n',()=>{if(options.exitOnReport)process.exit(0);});
},10);
process.stdin.resume();process.stdin.on('end',()=>{if(!options.ignoreEof)setTimeout(()=>process.exit(0),options.exitDelay??0);});
setTimeout(()=>process.exit(0),20000).unref();
`;
const background = String.raw`
const fs=require('node:fs'),path=require('node:path'),root=process.argv[2],options=JSON.parse(fs.readFileSync(path.join(root,'options.json'),'utf8'));
fs.writeFileSync(path.join(root,'background.json'),JSON.stringify({pid:process.pid}));let writes=0;
if(options.ignoreTerm)process.on('SIGTERM',()=>{});
for(const stream of [process.stdout,process.stderr])stream.on('error',e=>{fs.writeFileSync(path.join(root,'background-error.json'),JSON.stringify({code:e.code}));process.exit(2);});
const writing=setInterval(()=>{writes++;process.stdout.write(JSON.stringify({type:'background',writes})+'\n');process.stderr.write('background '+writes+'\n');},40);
setTimeout(()=>{clearInterval(writing);fs.writeFileSync(path.join(root,'background-done.json'),JSON.stringify({pid:process.pid,writes,natural:true}));process.exit(0);},options.backgroundMs??1800);
`;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeout = 9000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!condition()) { assert(performance.now() < deadline, 'isolated process fixture did not settle'); await pause(15); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
function fixture(options: { background?: boolean; backgroundMs?: number; backgroundStdioIgnore?: boolean; ignoreTerm?: boolean; detached?: boolean; ignoreEof?: boolean; exitDelay?: number; exitOnReport?: boolean } = {}) {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-process-retirement-')), 'bridge-process-retirement-');
  for (const [name, contents] of [['launcher.cjs', launcher], ['native.cjs', native], ['background.cjs', background], ['options.json', JSON.stringify(options)]]) writeFileSync(join(root, name!), contents!);
  const transport = new JsonLineProcess({ command: process.execPath, args: [join(root, 'launcher.cjs'), root] }, [], root, {});
  const messages: JsonObject[] = [];
  const report = new Promise<{ nativePid: number; backgroundPid?: number }>(resolve => transport.onMessage(message => {
    messages.push(message); if (message.type === 'completed') resolve(message as { nativePid: number; backgroundPid?: number });
  }));
  const cleanup = async () => {
    // Only this fixture's still-owned root handle is signalled on test failure.
    if (transport.child.exitCode === null && transport.child.signalCode === null) transport.child.kill('SIGKILL');
    await until(() => transport.child.exitCode !== null || transport.child.signalCode !== null);
    const marker = join(root, 'background.json');
    if (existsSync(marker)) await until(() => !alive(JSON.parse(readFileSync(marker, 'utf8')).pid));
  };
  return { root, transport, messages, report, cleanup };
}

test('completed Windows launcher retires inherited stdio without killing or breaking writing business background', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture({ background: true });
  try {
    const report = await f.report; let notices = 0; f.transport.onStopped(() => { notices++; });
    const started = performance.now(); await f.transport.stop(true); const elapsedMs = Math.round(performance.now() - started);
    assert(elapsedMs < 1000, `normal retirement took ${elapsedMs} ms`); assert.equal(notices, 1);
    assert.equal(f.transport.confirmStopped(), true); assert.equal(f.transport.stopEvidence.completion, 'graceful-exit');
    assert.equal(f.transport.stopEvidence.taskkillAttempted, false); assert.equal(f.transport.stopEvidence.exitObserved, true);
    assert.equal(f.transport.stopEvidence.closeObserved, false); assert.equal(alive(report.nativePid), false); assert.equal(alive(report.backgroundPid!), true);
    const received = f.messages.length; await pause(200); assert.equal(f.messages.length, received, 'retired output is drained without protocol callbacks');
    let late = 0; f.transport.onStopped(() => { late++; }); await pause(0); await f.transport.stop(true); assert.equal(late, 1);
    await until(() => existsSync(join(f.root, 'background-done.json'))); assert.equal(existsSync(join(f.root, 'background-error.json')), false);
    assert(JSON.parse(readFileSync(join(f.root, 'background-done.json'), 'utf8')).writes > 10);
    t.diagnostic(`normal retirement ${elapsedMs} ms; background continued stdout/stderr and finished naturally`);
  } finally { await f.cleanup(); }
});

test('graceful completion allows a real 1.5 second EOF shutdown delay without force or an uncertain result', async () => {
  const f = fixture({ exitDelay: 1500 });
  try {
    await f.report; const started = performance.now(); await f.transport.stop(true);
    assert(performance.now() - started >= 1400); assert.equal(f.transport.stopEvidence.taskkillAttempted, false);
    assert.equal(f.transport.confirmStopped(), true); assert.equal(f.transport.stopEvidence.completion, 'graceful-exit');
  } finally { await f.cleanup(); }
});

test('exit after the bounded graceful wait becomes queryable proof without restarting, forcing or waiting for inherited pipes', async () => {
  const f = fixture({ exitDelay: 5500, background: true, backgroundMs: 7000 });
  try {
    const report = await f.report; let notices = 0; f.transport.onStopped(() => { notices++; });
    await assert.rejects(f.transport.stop(true), error => {
      assert(error instanceof AgentProcessStopError); const evidence = stopEvidenceFromError(error)!;
      assert.equal(evidence.exitObserved, false); assert.equal(evidence.taskkillAttempted, false); assert.equal(evidence.completion, 'unconfirmed');
      assert.deepEqual(stopEvidenceFromError(processStopFailure(error, { nativeId: 'fixture', text: 'retained' })), evidence); return true;
    });
    assert.equal(f.transport.confirmStopped(), false);
    await until(() => f.transport.confirmStopped()); assert.equal(notices, 1); assert.equal(alive(report.backgroundPid!), true);
    assert.equal(f.transport.stopEvidence.closeObserved, false); assert.equal(f.transport.stopEvidence.completion, 'graceful-exit');
    await f.transport.stop(true);
  } finally { await f.cleanup(); }
});

test('explicit cancellation upgrades a pending graceful stop once and proves the real live Windows CLI tree ended', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture({ background: true, detached: false, ignoreEof: true, backgroundMs: 10000 });
  try {
    const report = await f.report; const graceful = f.transport.stop(true); await pause(80);
    const cancelled = f.transport.stop(false), duplicate = f.transport.stop(false); assert.equal(cancelled, duplicate);
    await Promise.all([graceful, cancelled, duplicate]);
    const evidence = f.transport.stopEvidence;
    assert.equal(evidence.completion, 'tree-stop'); assert.equal(evidence.graceful, false); assert.equal(evidence.taskkillAttempted, true);
    assert.equal(evidence.taskkillExitCode, 0); assert.equal(evidence.exitObserved, true);
    assert.equal(alive(f.transport.child.pid!), false); assert.equal(alive(report.nativePid), false); assert.equal(alive(report.backgroundPid!), false);
    assert.equal(f.transport.confirmStopped(), true);
  } finally { await f.cleanup(); }
});

test('a root that already exited never authorizes a stale PID tree kill or claims its live writing descendant stopped', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture({ background: true, exitOnReport: true });
  try {
    const report = await f.report; await until(() => f.transport.child.exitCode !== null);
    assert.equal(f.transport.stopEvidence.closeObserved, false);
    await assert.rejects(f.transport.stop(false), error => {
      const evidence = stopEvidenceFromError(error)!; assert.equal(evidence.exitObserved, true);
      assert.equal(evidence.taskkillAttempted, false); assert.equal(evidence.completion, 'unconfirmed'); return true;
    });
    assert.equal(f.transport.confirmStopped(), false); assert.equal(alive(report.backgroundPid!), true);
    await until(() => existsSync(join(f.root, 'background-done.json'))); assert.equal(existsSync(join(f.root, 'background-error.json')), false);
  } finally { await f.cleanup(); }
});

test('an unexpected launcher close cannot prove its detached CLI descendant stopped', async () => {
  const f = fixture({ background: true, backgroundStdioIgnore: true, exitOnReport: true });
  try {
    const report = await f.report; await until(() => f.transport.stopEvidence.closeObserved);
    assert.equal(alive(report.backgroundPid!), true); assert.equal(f.transport.confirmStopped(), false);
    await assert.rejects(f.transport.stop(false), AgentProcessStopError);
    assert.equal(f.transport.stopEvidence.taskkillAttempted, false); assert.equal(f.transport.confirmStopped(), false);
  } finally { await f.cleanup(); }
});

test('POSIX root exit cannot prove that a same-group descendant ignoring SIGTERM stopped', { skip: process.platform === 'win32' }, async () => {
  const f = fixture({ background: true, detached: false, ignoreEof: true, ignoreTerm: true });
  try {
    const report = await f.report;
    await assert.rejects(f.transport.stop(false), AgentProcessStopError);
    assert.equal(f.transport.stopEvidence.exitObserved, true); assert.equal(alive(report.backgroundPid!), true);
    assert.equal(f.transport.confirmStopped(), false);
  } finally { await f.cleanup(); }
});
