import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonLineProcess, retireCompletedTurn } from '../src/agents/process.js';
import { ownTemporaryDirectory } from './temp-directory.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 12000) {
  const end = Date.now() + ms;
  while (!check()) { assert(Date.now() < end, 'owned process did not settle'); await pause(20); }
}

for (const mode of ['leaf', 'auxiliary', 'business']) test(`completed CLI retirement: ${mode}`, { skip: process.platform !== 'win32' }, async t => {
  const background = mode === 'business', auxiliary = mode === 'auxiliary';
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-completed-cli-')), 'bridge-completed-cli-');
  mkdirSync(join(root, 'bin')); copyFileSync(process.execPath, join(root, 'codex.exe'));
  if (background) writeFileSync(join(root, 'with-preview'), '1');
  if (auxiliary) {
    copyFileSync(process.execPath, join(root, 'codex-code-mode-host.exe'));
    writeFileSync(join(root, 'with-auxiliary'), '1');
    writeFileSync(join(root, 'auxiliary.cjs'), "require('node:fs').writeFileSync('auxiliary.pid',String(process.pid));setInterval(()=>{},1000);");
  }
  writeFileSync(join(root, 'bin', 'codex.js'), `const {spawn}=require('node:child_process'),path=require('node:path');
const child=spawn(path.join(process.cwd(),'codex.exe'),['native.cjs'],{stdio:'inherit',windowsHide:true});
child.on('exit',()=>process.exit(0));`);
  writeFileSync(join(root, 'native.cjs'), `const {spawn}=require('node:child_process'),fs=require('node:fs');
fs.writeFileSync('native.pid',String(process.pid));
if(fs.existsSync('with-preview')){const preview=spawn(process.execPath,['preview.cjs'],{stdio:['ignore','inherit','inherit'],windowsHide:true});preview.on('exit',(code,signal)=>fs.writeFileSync('preview-exit',JSON.stringify({code,signal})));}
if(fs.existsSync('with-auxiliary'))spawn(require('node:path').join(process.cwd(),'codex-code-mode-host.exe'),['auxiliary.cjs'],{stdio:'inherit',windowsHide:true});
process.stdin.resume();setInterval(()=>{if(fs.existsSync('allow-exit'))process.exit(0)},50);setTimeout(()=>process.exit(1),45000).unref();`);
  writeFileSync(join(root, 'preview.cjs'), `const fs=require('node:fs');fs.writeFileSync('preview.pid',String(process.pid));
let n=0;process.stdout.on('error',()=>{fs.writeFileSync('broken','1');process.exit(2)});
setInterval(()=>{if(fs.existsSync('stop-preview'))process.exit(0);fs.writeFileSync('heartbeat',String(++n));process.stdout.write('{}\\n')},50);
setTimeout(()=>process.exit(1),30000).unref();`);
  const transport = new JsonLineProcess({ command: process.execPath, args: [join(root, 'bin', 'codex.js')] }, [], root, {});
  let native = 0, preview = 0;
  try {
    await until(() => existsSync(join(root, 'native.pid')) && (!background || existsSync(join(root, 'preview.pid'))) && (!auxiliary || existsSync(join(root, 'auxiliary.pid'))));
    native = Number(readFileSync(join(root, 'native.pid'), 'utf8')); if (background) preview = Number(readFileSync(join(root, 'preview.pid'), 'utf8'));
    // This reproduces the previous failure: EOF plus five seconds never released the CLI.
    await assert.rejects(transport.stop(true), /退出待核对/);
    assert(alive(native)); assert.equal(transport.confirmStopped(), false);
    if (background) {
      assert(alive(preview), 'preview must be alive before retirement');
      await assert.rejects(transport.retireCompleted(), /退出待核对/);
      const report = { nativeId: 'fixture', text: 'saved', processStopped: false }; let released = 0;
      retireCompletedTurn(transport, report, () => { released++; });
      assert.equal(transport.confirmStopped(), false); assert(alive(native)); assert(alive(preview));
      const heartbeat = readFileSync(join(root, 'heartbeat'), 'utf8'); await pause(200);
      assert.notEqual(readFileSync(join(root, 'heartbeat'), 'utf8'), heartbeat);
      assert.equal(existsSync(join(root, 'broken')), false);
      writeFileSync(join(root, 'stop-preview'), '1'); await until(() => !alive(preview));
      writeFileSync(join(root, 'allow-exit'), '1'); await until(() => transport.confirmStopped());
      await until(() => report.processStopped); assert.equal(released, 1); assert(!alive(native));
    } else {
      await transport.retireCompleted();
      assert.equal(transport.confirmStopped(), true); assert.equal(transport.stopEvidence.completion, 'cli-stop');
      assert.equal(transport.stopEvidence.taskkillAttempted, false); assert(!alive(native));
      if (auxiliary) assert(!alive(Number(readFileSync(join(root, 'auxiliary.pid'), 'utf8'))));
      await transport.retireCompleted();
    }
  } catch (error) {
    t.diagnostic(JSON.stringify({ root, native, preview, broken: existsSync(join(root, 'broken')), previewExit: existsSync(join(root, 'preview-exit')) ? readFileSync(join(root, 'preview-exit'), 'utf8') : null, evidence: transport.stopEvidence }));
    throw error;
  } finally {
    writeFileSync(join(root, 'stop-preview'), '1');
    if (preview) await until(() => !alive(preview));
    if (!transport.confirmStopped()) await transport.stop(false).catch(() => {});
  }
});
