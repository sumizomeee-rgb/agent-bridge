import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../src/remote/deployment.js';
import { ownTemporaryDirectory } from './temp-directory.js';

test('deployment captures the real parent exit while a descendant retains its stdout handle', { timeout: 10000 }, async () => {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'deployment-command-')), 'deployment-command-');
  const pidFile = join(root, 'child.pid');
  const script = `const cp=require('node:child_process'),fs=require('node:fs');const c=cp.spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',windowsHide:true,detached:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();console.log('READY');setTimeout(()=>process.exit(0),300);`;
  try {
    const start = Date.now(); assert.equal(await command(process.execPath, ['-e', script], root, 5000), 'READY');
    assert(Date.now() - start < 5000); assert(existsSync(pidFile)); process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
  } finally {
    if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch {}
  }
});
test('deployment failures expose no subprocess secrets and deadlines are bounded', async () => {
  await assert.rejects(command(process.execPath, ['-e', "console.error('PRIVATE_AUTH_SENTINEL');process.exit(7)"], process.cwd()), error => {
    assert.match(String(error), /7/); assert(!String(error).includes('PRIVATE_AUTH_SENTINEL')); return true;
  });
  await assert.rejects(command(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], process.cwd(), 300), /timeout/);
});
