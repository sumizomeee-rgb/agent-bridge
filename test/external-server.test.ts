import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalControllerServer } from '../src/controller/external-server.js';
import type { ExternalControllerAdapter } from '../src/controller/external.js';

async function fixture(t: import('node:test').TestContext, submit: (id: string, text: string) => Promise<void> = async () => {}, hasInput?: (requestId:string)=>boolean) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-external-api-')), calls: unknown[] = [];
  const adapter = { connect: (...args: unknown[]) => { calls.push(['connect', ...args]); return { lease: 'lease-a' }; },
    events: (...args: unknown[]) => { calls.push(['events', ...args]); return [{ sequence: 1 }]; },
    accept: (...args: unknown[]) => { calls.push(['accept', ...args]); },
    call: async (...args: unknown[]) => { calls.push(['call', ...args]); return { ok: true }; },
    finish: async (...args: unknown[]) => { calls.push(['finish', ...args]); return { status: 'done' }; } } as unknown as ExternalControllerAdapter;
  const server = new ExternalControllerServer({ hostDataDir: root, controllers: [{ id: 'dot', adapter, submit, hasInput, handoff:async()=> 'new-conversation' }, { id: 'other', adapter, submit }] });
  const location = await server.start(), manifest = JSON.parse(readFileSync(location.manifestPath, 'utf8'));
  const base = manifest.controllers[0].url, token = manifest.controllers[0].token;
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  const post = (action: string, body: unknown, bearer = token) => fetch(base + '/' + action, { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { root, calls, server, location, base, token, post, manifest, adapter };
}

test('loopback scoped authentication precedes JSON parsing and dispatches only adapter methods', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('connect', '{malformed', 'invalid')).status, 401);
  assert.equal((await f.post('connect', '{malformed', f.manifest.controllers[1].token)).status, 401);
  assert.deepEqual(await (await f.post('connect', { instanceId: 'instance', sessionId: 'native' })).json(), { lease: 'lease-a' });
  assert.equal((await f.post('accept', { lease: 'lease-a', decisionId: 'decision' })).status, 200);
  assert.deepEqual(await (await f.post('call', { lease: 'lease-a', decisionId: 'decision', callId: 'c', name: 'tools', args: {} })).json(), { ok: true });
  assert.deepEqual(await (await f.post('finish', { lease: 'lease-a', decisionId: 'decision' })).json(), { status: 'done' });
  assert.equal((await fetch(f.base + '/events?lease=lease-a&after=3', { headers: { authorization: 'Bearer ' + f.token } })).status, 200);
  assert.deepEqual(f.calls.map(value => (value as string[])[0]), ['connect', 'accept', 'call', 'finish', 'events']);
  assert.equal((await f.post('input', { requestId: 'r', text: 'x'.repeat(65536) })).status, 413);
  assert.equal((await f.post('input', { requestId: 'r', text: 'hello', userId: 'spoof' })).status, 400);
  await f.server.close(); assert(!existsSync(f.location.manifestPath));
});

test('input IDs survive restart, deduplicate success and reject changed text', async t => {
  const submitted: string[] = [], f = await fixture(t, async (id, text) => { submitted.push(id + ':' + text); });
  assert.deepEqual(await (await f.post('input', { requestId: 'r', text: 'hello' })).json(), { status: 'accepted', duplicate: false });
  assert.deepEqual(await (await f.post('input', { requestId: 'r', text: 'hello' })).json(), { status: 'accepted', duplicate: true });
  assert.equal((await f.post('input', { requestId: 'r', text: 'changed' })).status, 409);
  await f.server.close();
  const restarted = new ExternalControllerServer({ hostDataDir: f.root, controllers: [{ id: 'dot', adapter: f.adapter, submit: async () => { throw new Error('must not resubmit'); } }] });
  t.after(() => restarted.close()); const location = await restarted.start();
  const response = await fetch(`http://127.0.0.1:${location.port}/controllers/dot/input`, { method: 'POST', headers: { authorization: 'Bearer ' + f.token }, body: JSON.stringify({ requestId: 'r', text: 'hello' }) });
  assert.deepEqual(await response.json(), { status: 'accepted', duplicate: true }); assert.deepEqual(submitted, ['r:hello']);
  await restarted.close();
});

test('unknown submit outcome never replays the same request', async t => {
  let count = 0; const f = await fixture(t, async () => { count++; throw new Error('submission outcome uncertain'); });
  assert.deepEqual(await (await f.post('input', { requestId: 'r', text: 'hello' })).json(), { status: 'unknown', duplicate: false });
  assert.deepEqual(await (await f.post('input', { requestId: 'r', text: 'hello' })).json(), { status: 'unknown', duplicate: true });
  assert.equal(count, 1);
});


test('scoped status reconciles persisted input and exposes original call results without bearer credentials', async t=>{
  const f=await fixture(t,async()=>{throw new Error('submit response lost after persistence');},()=>true);
  const queries:unknown[]=[];
  f.adapter.status=query=>{queries.push(query);return {binding:{instanceId:'i',sessionId:'s',generation:1,lease:'scoped-lease'},decisions:[],eventSequence:3,call:{status:'done',result:{workerId:'existing-worker'}}};};
  assert.equal((await f.post('input',{requestId:'r',text:'goal'})).status,200);
  const url=f.base+'/status?requestId=r&decisionId=decision&callId=call';
  assert.equal((await fetch(url,{headers:{authorization:'Bearer wrong'}})).status,401);
  const response=await fetch(url,{headers:{authorization:'Bearer '+f.token}});
  const body=await response.json() as any;
  assert.equal(body.input.status,'accepted');assert.equal(body.binding.lease,'scoped-lease');
  assert.deepEqual(body.call,{status:'done',result:{workerId:'existing-worker'}});
  assert.deepEqual(queries,[{decisionId:'decision',callId:'call'}]);
  assert(!JSON.stringify(body).includes(f.token));
  assert.equal((await fetch(f.base+'/status?callId=orphan',{headers:{authorization:'Bearer '+f.token}})).status,400);
  assert.equal((await f.post('input',{requestId:'r',text:'goal'})).status,200);
});

test('handoff route passes explicit old lease and real sessions to the scoped transfer',async t=>{
  const f=await fixture(t);let observed:unknown[]=[];
  f.adapter.handoff=async(lease,previous,instance,session,transfer)=>{
    observed=[lease,previous,instance,session];return {status:'handed-off',conversationId:await transfer('operation',previous,session),lease:'new-lease'};
  };
  const result=await f.post('handoff',{lease:'old-lease',previousSessionId:'real-a',instanceId:'new-instance',sessionId:'real-b'});
  assert.equal(result.status,200);assert.deepEqual(observed,['old-lease','real-a','new-instance','real-b']);
  assert.equal((await result.json() as any).conversationId,'new-conversation');
  assert.equal((await f.post('handoff',{lease:'l',previousSessionId:'a',instanceId:'i',sessionId:'b',controllerId:'spoof'})).status,400);
});
