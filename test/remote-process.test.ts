import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RemoteDaemon } from '../src/remote/daemon.js';
import { JsonLineProcess, deferred } from '../src/agents/process.js';
import type { AgentName } from '../src/types.js';
import type { RemoteDispatch, RemoteJob } from '../src/remote/types.js';
import { requestRemoteHttp } from '../src/remote/client.js';

// Executes the production adapters and actual child-process trees, without any auth or model calls.
const nativeFixture = String.raw`
const fs=require('node:fs'); const path=require('node:path'); const readline=require('node:readline');
const {spawn}=require('node:child_process'); const root=process.cwd(); const codex=process.argv.includes('app-server');
let session='native-process-fixture', turn='turn-fixture'; let keep=setInterval(()=>{},1000);
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const start=()=>{
 fs.writeFileSync(path.join(root,'started.json'),JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
 if(fs.existsSync(path.join(root,'cancel-mode'))){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(root,'grandchild.json'),JSON.stringify({pid:child.pid}));return;}
 setTimeout(()=>{fs.writeFileSync(path.join(root,'completed.txt'),'owned native completed');
  if(codex){send({method:'item/completed',params:{threadId:session,turnId:turn,item:{type:'agentMessage',phase:'final_answer',id:'final',text:'真实进程完成'}}});send({method:'turn/completed',params:{threadId:session,turn:{id:turn,status:'completed',items:[]}}});}
  else{send({type:'result',subtype:'success',is_error:false,result:'真实进程完成',session_id:session});process.exit(0);}
 },350);
};
const input=readline.createInterface({input:process.stdin});input.on('line',line=>{const msg=JSON.parse(line);
 if(codex){
  if(msg.method==='initialize'){
   if(fs.existsSync(path.join(root,'metadata-hang'))){fs.writeFileSync(path.join(root,'metadata-pid.json'),JSON.stringify({pid:process.pid}));return;}
   send({id:msg.id,result:{}});
  }
  if(msg.method==='config/read')send({id:msg.id,result:{config:{model_provider:'fixture'}}});
  if(msg.method==='thread/start'||msg.method==='thread/resume'){session=msg.params.threadId||session;send({id:msg.id,result:{thread:{id:session},modelProvider:msg.params.modelProvider}});}
  if(msg.method==='turn/start'){send({id:msg.id,result:{turn:{id:turn}}});start();}
  if(msg.method==='turn/interrupt'){send({id:msg.id,result:{}});send({method:'turn/completed',params:{threadId:session,turn:{id:turn,status:'interrupted',items:[]}}});}
 }else if(msg.type==='user'){let at=process.argv.indexOf('--resume');if(at>=0)session=process.argv[at+1];send({type:'system',subtype:'init',session_id:session,model:'haiku',version:'2.1.76'});start();}
});input.on('close',()=>{if(codex){clearInterval(keep);process.exit(0);}});
`;
const pause = (ms: number) => new Promise<void>(resolveValue => setTimeout(resolveValue, ms));
async function until(condition: () => boolean, ms = 10_000): Promise<void> { const deadline = Date.now() + ms; while (!condition()) { if (Date.now() > deadline) throw new Error('fixture timed out'); await pause(10); } }
function fixture(agent: AgentName) {
  const root = mkdtempSync(join(tmpdir(), `remote-real-${agent}-`)); const script = join(root, 'native.cjs'); writeFileSync(script, nativeFixture);
  const command = { command: process.execPath, args: [script] };
  const daemon = new RemoteDaemon(root, { version: 1, expectedHostname: hostname(), engines: { [agent]: { agentCommand: command, defaultCwd: root } } });
  const request: RemoteDispatch = { dispatchId: randomUUID(), workerId: randomUUID(), userId: 'owner', agent, agentCommand: command, nativeId: null,
    cwd: root, text: '仅隔离目录任务', imagePaths: [], model: null, acceptSupplements: true };
  return { root, daemon, request };
}
function stdioClient(root: string) {
  const entry = resolve(fileURLToPath(new URL('../src/remote/cli.js', import.meta.url)));
  const transport = new JsonLineProcess({ command: process.execPath, args: [entry] }, ['--stdio', '--root', root], root, {});
  return { transport, request: (method: string, args: unknown): Promise<unknown> => {
    const id = randomUUID(); const completed = deferred<unknown>();
    const remove = transport.onMessage(msg => { if (msg.id === id) { if (msg.error) completed.reject(new Error(JSON.stringify(msg.error))); else completed.resolve(msg.result); } });
    const failed = transport.onFailure(error => completed.reject(error));
    transport.write({ id, method, args }); return completed.promise.finally(() => { remove(); failed(); });
  } };
}
for (const agent of ['codex', 'claude'] as const) {
  test(`${agent}: actual stdio client exit leaves target-owned native CLI alive, reconnect retrieves its completion`, async () => {
    const f = fixture(agent); await f.daemon.listen(); const first = stdioClient(f.root); let second: ReturnType<typeof stdioClient> | null = null;
    try {
      await first.request('dispatch', f.request); await until(() => existsSync(join(f.root, 'started.json')));
      const pid = JSON.parse(readFileSync(join(f.root, 'started.json'), 'utf8')).pid as number;
      process.kill(pid, 0); await first.transport.stop(true);
      assert.equal(f.daemon.store.job(f.request.dispatchId)!.status, 'running'); process.kill(pid, 0);
      await until(() => f.daemon.store.job(f.request.dispatchId)!.status === 'completed'); second = stdioClient(f.root);
      const result = await second.request('query', { dispatchId: f.request.dispatchId }) as RemoteJob;
      assert.equal(result.result?.text, '真实进程完成'); assert.equal(result.stopped, true); assert.equal(result.nativeId, 'native-process-fixture');
      assert.equal(readFileSync(join(f.root, 'completed.txt'), 'utf8'), 'owned native completed');
      assert.throws(() => process.kill(pid, 0));
    } finally { await first.transport.stop(true); await second?.transport.stop(true); await f.daemon.close(); }
  });
  test(`${agent}: actual remote cancellation confirms native CLI and owned descendant are gone`, async () => {
    const f = fixture(agent); writeFileSync(join(f.root, 'cancel-mode'), '1');
    try {
      await f.daemon.handle('dispatch', f.request); await until(() => existsSync(join(f.root, 'grandchild.json')) && f.daemon.store.job(f.request.dispatchId)!.ready);
      const pid = JSON.parse(readFileSync(join(f.root, 'started.json'), 'utf8')).pid as number;
      const descendant = JSON.parse(readFileSync(join(f.root, 'grandchild.json'), 'utf8')).pid as number;
      assert.deepEqual(await f.daemon.handle('interrupt', { dispatchId: f.request.dispatchId }), { stopped: true });
      assert.throws(() => process.kill(pid, 0)); assert.throws(() => process.kill(descendant, 0));
      assert.equal(f.daemon.store.job(f.request.dispatchId)!.status, 'cancelled'); assert.ok(!existsSync(join(f.root, 'completed.txt')));
    } finally { await f.daemon.close(); }
  });
}

test('authenticated loopback HTTP transport reaches the daemon and rejects incorrect credentials', async () => {
  const f = fixture('codex'); await f.daemon.listen();
  const endpoint = JSON.parse(readFileSync(join(f.daemon.dataDirectory, 'endpoint.json'), 'utf8')) as { port: number; token: string };
  try {
    assert.equal((await requestRemoteHttp<{ hostname: string }>(endpoint.port, endpoint.token, 'hello', {})).hostname, hostname());
    await assert.rejects(requestRemoteHttp(endpoint.port, 'incorrect-token', 'dispatch', f.request), /未授权/);
    assert.equal(f.daemon.store.jobs().length, 0);
  } finally { await f.daemon.close(); }
});

test('remote startup script is UTF-8 with BOM and parses in Windows PowerShell 5', { skip: process.platform !== 'win32' }, () => {
  const path = fileURLToPath(new URL('../../scripts/start-remote-agent.ps1', import.meta.url));
  assert.deepEqual([...readFileSync(path).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const script = `$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors);if($errors.Count){exit 1};[Console]::Write('ok')`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'ok');
});

test('daemon shutdown actually terminates an in-flight metadata CLI before resolving', async () => {
  const f = fixture('codex'); writeFileSync(join(f.root, 'metadata-hang'), '1');
  const query = f.daemon.handle('models', { agent: 'codex', cwd: f.root }); const outcome = query.catch(error => error);
  try {
    await until(() => existsSync(join(f.root, 'metadata-pid.json')));
    const pid = JSON.parse(readFileSync(join(f.root, 'metadata-pid.json'), 'utf8')).pid as number;
    process.kill(pid, 0); await f.daemon.close(); assert.throws(() => process.kill(pid, 0)); assert.ok(await outcome instanceof Error);
  } finally { await f.daemon.close(); }
});

test('HTTP request disconnect does not kill the hosted native turn; later authenticated query returns it once', async () => {
  const f = fixture('codex'); await f.daemon.listen();
  const endpoint = JSON.parse(readFileSync(join(f.daemon.dataDirectory, 'endpoint.json'), 'utf8')) as { port: number; token: string };
  try {
    const first = await requestRemoteHttp<RemoteJob>(endpoint.port, endpoint.token, 'dispatch', f.request);
    assert.equal(first.status, 'running'); await until(() => existsSync(join(f.root, 'started.json')));
    // Each request uses an independent HTTP connection. Ending the dispatch request owns no native process.
    const repeat = await requestRemoteHttp<RemoteJob>(endpoint.port, endpoint.token, 'dispatch', f.request); assert.equal(repeat.dispatchId, f.request.dispatchId);
    await until(() => f.daemon.store.job(f.request.dispatchId)!.status === 'completed');
    const completed = await requestRemoteHttp<RemoteJob>(endpoint.port, endpoint.token, 'query', { dispatchId: f.request.dispatchId });
    assert.equal(completed.result?.text, '真实进程完成'); assert.equal(completed.stopped, true); assert.equal(f.daemon.store.jobs().length, 1);
  } finally { await f.daemon.close(); }
});
