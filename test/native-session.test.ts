import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codexSessionLaunch } from '../src/agents/native-session.js';
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
