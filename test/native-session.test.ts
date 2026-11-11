import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalizeCodexHistory, codexSessionLaunch } from '../src/agents/native-session.js';
import { readOnlyRuntime } from '../src/agents/readonly.js';
import { migrateNativeSessionHomes, nativeRolloutBytes } from '../src/agents/native-session-migration.js';
import { sessionHomePath } from '../src/agents/session-home.js';
import { WorkerSessionRuntime } from '../src/agents/worker-session.js';

test('native source rewrite preserves every history byte offset and message body', () => {
  const original = Buffer.from('{"type":"session_meta","payload":{"source":"vscode"}}\n{"type":"message","text":"中文 unchanged"}\n');
  const transformed = nativeRolloutBytes(original, 'mcp');
  assert.equal(transformed.length, original.length);
  assert.equal(transformed.indexOf(10), original.indexOf(10));
  assert.equal(JSON.parse(transformed.toString().split('\n')[0]!).payload.source, 'mcp');
  assert.ok(transformed.subarray(original.indexOf(10)).equals(original.subarray(original.indexOf(10))));
});

test('standalone launch retains preset overrides and rejects unsupported flags instead of dropping them', t => {
  const root=mkdtempSync(join(tmpdir(),'native-launch-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const binary=join(root,'server.exe');writeFileSync(binary,'fixture');
  const env={BRIDGE_SESSION_SOURCE:'mcp',BRIDGE_CODEX_APP_SERVER:binary};
  const launch=codexSessionLaunch({command:'node',args:['codex.js','-c','model_provider="preset"']},['app-server','--listen','stdio://'],env);
  assert.equal(launch.command.command,binary);assert.deepEqual(launch.command.args,['-c','model_provider="preset"']);
  assert.deepEqual(launch.args,['--session-source','app-server','--listen','stdio://']);
  assert.throws(()=>codexSessionLaunch({command:'codex',args:['--unsupported']},['app-server'],env),/不支持/);
});

function fixture(t: test.TestContext) {
  const root=mkdtempSync(join(tmpdir(),'native-migration-')),data=join(root,'data'),user=join(root,'user');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=sessionHomePath(data,user,'worker','codex','worker-A'),native=join(user,'.codex');
  mkdirSync(join(home,'sessions'),{recursive:true});
  writeFileSync(join(home,'session-location.json'),JSON.stringify({version:1,visibility:'hidden',profileHome:native,sqliteHome:native}));
  writeFileSync(join(home,'auth.json'),'private old ordinary login');
  const rollout=join(home,'sessions','session.jsonl'),bytes=Buffer.from('{"type":"session_meta","payload":{"source":"vscode"}}\n{"type":"event_msg","payload":{"text":"original"}}\n');
  writeFileSync(rollout,bytes);
  const state=new DatabaseSync(join(home,'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,source TEXT NOT NULL)');
  state.prepare('INSERT INTO threads VALUES(?,?,?)').run('original-native',rollout,'vscode');state.close();
  const history=new DatabaseSync(join(home,'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT,PRIMARY KEY(thread_id,turn_id,item_id))');
  history.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run('original-native','turn','item','{"text":"context"}');history.close();
  return {root,data,user,home,native,bytes};
}

test('offline merge preserves native IDs, paginated turn content and user auth, then retires private homes', async t=>{
  const f=fixture(t);mkdirSync(f.native,{recursive:true});writeFileSync(join(f.native,'auth.json'),'normal user login');
  assert.equal((await migrateNativeSessionHomes(f.data,f.user)).length,1);
  const report=await migrateNativeSessionHomes(f.data,f.user,true);assert.equal(report[0]!.threads,1);
  assert.equal(readFileSync(join(f.native,'auth.json'),'utf8'),'normal user login');
  assert.deepEqual(readdirSync(f.home),['session-location.json']);
  const state=new DatabaseSync(join(f.native,'state_5.sqlite'),{readOnly:true});
  assert.deepEqual({...state.prepare('SELECT * FROM threads').get()},{id:'original-native',rollout_path:join(f.native,'sessions','session.jsonl'),source:'mcp'});state.close();
  const history=new DatabaseSync(join(f.native,'thread_history_1.sqlite'),{readOnly:true});
  assert.equal(history.prepare('SELECT item_json FROM thread_items').get()?.item_json,'{"text":"context"}');history.close();
  const env=new WorkerSessionRuntime(f.data,f.user).prepare('codex','worker-A','original-native','hidden',{});
  assert.equal(env.CODEX_HOME,f.native);assert.equal(env.CODEX_SQLITE_HOME,f.native);assert.equal(env.BRIDGE_SESSION_SOURCE,'mcp');
  assert.deepEqual(await migrateNativeSessionHomes(f.data,f.user,true),[]);
});

test('a native transcript collision stops before retiring original history or configuration',async t=>{
  const f=fixture(t);mkdirSync(join(f.native,'sessions'),{recursive:true});writeFileSync(join(f.native,'sessions','session.jsonl'),'user data');
  await assert.rejects(migrateNativeSessionHomes(f.data,f.user,true),/冲突/);
  assert.ok(existsSync(join(f.home,'auth.json')));assert.ok(readFileSync(join(f.home,'sessions','session.jsonl')).equals(f.bytes));
  assert.equal(JSON.parse(readFileSync(join(f.home,'session-location.json'),'utf8')).version,1);
});

test('retiring a read-only configuration preserves native history and canonicalizes its index before removing links',t=>{
  const root=mkdtempSync(join(tmpdir(),'readonly-history-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'native');mkdirSync(home);writeFileSync(join(home,'config.toml'),'');
  const runtime=readOnlyRuntime('codex',{CODEX_HOME:home,CODEX_SQLITE_HOME:home,BRIDGE_SESSION_SOURCE:'mcp'});
  try{
    const temporary=join(runtime.env.CODEX_HOME!,'sessions','native.jsonl');writeFileSync(temporary,'durable history');
    const db=new DatabaseSync(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');db.prepare('INSERT INTO threads VALUES(?,?)').run('own-thread',temporary);db.close();
    canonicalizeCodexHistory(runtime.env,'own-thread');runtime.cleanup();
    assert.equal(readFileSync(join(home,'sessions','native.jsonl'),'utf8'),'durable history');
    const check=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});assert.equal(check.prepare('SELECT rollout_path FROM threads').get()?.rollout_path,join(home,'sessions','native.jsonl'));check.close();
    assert.equal(existsSync(runtime.env.CODEX_HOME!),false);
  }finally{runtime.cleanup();}
});

test('expired one-shot summary indexes are preserved without pretending their retired transcript exists',async t=>{
  const f=fixture(t),db=new DatabaseSync(join(f.home,'state_5.sqlite'));
  const expired=join(tmpdir(),'bridge-codex-readonly-old123','sessions','expired.jsonl');
  db.prepare('INSERT INTO threads VALUES(?,?,?)').run('expired-summary',expired,'vscode');db.close();
  await migrateNativeSessionHomes(f.data,f.user,true);
  const target=new DatabaseSync(join(f.native,'state_5.sqlite'),{readOnly:true});
  assert.deepEqual({...target.prepare('SELECT * FROM threads WHERE id=?').get('expired-summary')},{id:'expired-summary',rollout_path:expired,source:'mcp'});target.close();
});

test('Windows extended legacy paths resolve to the already relocated transcript', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),db=new DatabaseSync(join(f.home,'state_5.sqlite'));
  const legacy='\\\\?\\'+join(f.data,'worker-homes','codex','worker-A','sessions','session.jsonl');
  db.prepare('UPDATE threads SET rollout_path=?').run(legacy);db.close();
  await migrateNativeSessionHomes(f.data,f.user,true);
  const target=new DatabaseSync(join(f.native,'state_5.sqlite'),{readOnly:true});
  assert.equal(target.prepare('SELECT rollout_path FROM threads').get()?.rollout_path,join(f.native,'sessions','session.jsonl'));target.close();
});

test('a later conflict keeps every source in the batch, including already staged workers',async t=>{
  const f=fixture(t),other=sessionHomePath(f.data,f.user,'worker','codex','worker-B');
  mkdirSync(join(other,'sessions'),{recursive:true});writeFileSync(join(other,'session-location.json'),readFileSync(join(f.home,'session-location.json')));
  writeFileSync(join(other,'sessions','session.jsonl'),'{"type":"session_meta","payload":{"source":"vscode","different":true}}\n');
  await assert.rejects(migrateNativeSessionHomes(f.data,f.user,true),/冲突/);
  assert.ok(existsSync(join(f.home,'auth.json')));assert.ok(existsSync(join(f.home,'state_5.sqlite')));
  assert.equal(JSON.parse(readFileSync(join(f.home,'session-location.json'),'utf8')).version,1);
});

test('Claude imports transcripts by original ID while keeping independent auto-memory away from current user memory',async t=>{
  const f=fixture(t),home=sessionHomePath(f.data,f.user,'worker','claude','claude-A'),native=join(f.user,'.claude'),project='C--Project';
  mkdirSync(join(home,'projects',project,'memory'),{recursive:true});mkdirSync(join(native,'projects',project,'memory'),{recursive:true});
  writeFileSync(join(home,'session-location.json'),JSON.stringify({version:1,visibility:'hidden',profileHome:native,sqliteHome:native}));
  writeFileSync(join(home,'projects',project,'memory','MEMORY.md'),'old worker memory');
  writeFileSync(join(native,'projects',project,'memory','MEMORY.md'),'current user memory');
  writeFileSync(join(home,'projects',project,'original-id.jsonl'),'{"sessionId":"original-id","entrypoint":"sdk-cli"}\n');
  await migrateNativeSessionHomes(f.data,f.user,true);
  assert.equal(readFileSync(join(native,'projects',project,'memory','MEMORY.md'),'utf8'),'current user memory');
  const scope=JSON.parse(readFileSync(join(f.data,'session-home-root.json'),'utf8')).scope;
  assert.equal(readFileSync(join(native,'projects',project,'memory','bridge-imports',scope,'worker-claude-A','MEMORY.md'),'utf8'),'old worker memory');
  assert.equal(readFileSync(join(native,'projects',project,'original-id.jsonl'),'utf8'),'{"sessionId":"original-id","entrypoint":"sdk-cli"}\n');
});
