import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownTemporaryDirectory } from './temp-directory.js';
import { scanTransactionSources, type TransactionCursor } from '../src/housekeeper/sources.js';

const start = '2026-10-29T00:00:00Z', end = '2026-10-30T00:00:00Z';
const time = (value: string) => Date.parse(value) / 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), 'utf8');
type Row = Record<string, unknown>;
function record(id: string, text = id, extra: Row = {}): Row {
  return { identity: id, scope: 'chat-1', revision: `revision-${id}`, operation: 'upsert', deleted: false,
    occurred_at: time('2026-10-29T10:00:00Z'), text, data: { sender: { name: 'Owner' }, chat_name: 'Project', record_kind: 'message' }, ...extra };
}
function fixture() {
  const root = ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'housekeeper-sources-')), 'housekeeper-sources-');
  mkdirSync(join(root, 'sources'));
  const entries: Row[] = [], manifests = new Map<string, { schema: string; version: number; items: Record<string, any> }>();
  const source = (site: string) => {
    const dir = join(root, 'sources', site); mkdirSync(dir, { recursive: true });
    const manifest = { schema: 'cookiesync-delivery-state', version: 2, items: { item: { source: site, item_id: `${site}-item`, batches: [], record_revisions: {} } } };
    manifests.set(site, manifest); entries.push({ site, label: site, timezone: 'UTC', manifest: `sources/${site}/data.json` });
    json(join(root,'index.json'), { schema: 'bridge-transaction-source-index', version: 1, timezone: 'UTC', sources: entries });
    json(join(dir,'data.json'), manifest);
  };
  const batch = (site: string, published: string, records: Row[]) => {
    const manifest = manifests.get(site)!;
    const value = { schema: 'cookiesync-content-batch', version: 1, source: site, item_id: `${site}-item`, created_at: time(published), records };
    const body = JSON.stringify(value), sha256 = hash(body);
    const folder = published.slice(0,19).replace('T','_').replaceAll(':','-') + '-' + sha256.slice(0,16);
    const dir = join(root,'sources',site,folder); mkdirSync(dir, { recursive: true });
    const file = join(dir,'records.json'); writeFileSync(file,body,'utf8');
    manifest.items.item.batches.push({ folder, sha256 }); json(join(root,'sources',site,'data.json'),manifest);
    return { file, folder, sha256, manifest };
  };
  return { root, source, batch, entries, manifests };
}

test('three platforms are frozen fairly and consumption is a separate caller acknowledgement', async () => {
  const f = fixture();
  for (const site of ['feishu','chatgpt','bilibili']) {
    f.source(site); f.batch(site,'2026-10-29T12:00:00Z',[record(`${site}-1`),record(`${site}-2`)]);
  }
  const options = { enabledAt: start, cutoff: end, limits: { maxRecords: 3 } };
  const first = await scanTransactionSources(f.root,options);
  assert.equal(first.recordCount,3); assert(first.hasMore);
  assert.deepEqual(first.sources.map(s=>s.records.length),[1,1,1]);
  assert.deepEqual(first.sources.map(s=>s.status),['partial','partial','partial']);
  assert.equal(first.text,JSON.stringify({version:first.version,trust:first.trust,window:first.window,sources:first.sources}));
  assert.equal((await scanTransactionSources(f.root,options)).text,first.text,'no implicit acknowledgement');
  const second = await scanTransactionSources(f.root,{...options,cursor:first.nextCursor});
  assert.equal(second.recordCount,3); assert(!second.hasMore);
  const done = await scanTransactionSources(f.root,{...options,cursor:second.nextCursor});
  assert.equal(done.recordCount,0); assert(!done.hasMore);
  assert.deepEqual(first.sources.map(s=>s.records[0]!.source.recordIndex),[1,1,1]);
});

test('publication time controls the window while original event time remains evidence', async () => {
  const f = fixture(); f.source('feishu');
  f.batch('feishu','2026-10-27T20:00:00Z',[record('before','before')]);
  f.batch('feishu','2026-10-29T12:00:00Z',[record('old-event','older event newly published',{occurred_at:time('2026-09-01T10:00:00Z')})]);
  f.batch('feishu','2026-10-30T01:00:00Z',[record('future','future')]);
  const first = await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.deepEqual(first.sources[0]!.records.map(r=>r.identity),['old-event']);
  assert.equal(first.sources[0]!.records[0]!.occurredAt,'2026-09-01T10:00:00.000Z');
  const next = await scanTransactionSources(f.root,{enabledAt:start,cutoff:'2026-10-30T02:00:00Z',cursor:first.nextCursor});
  assert.deepEqual(next.sources[0]!.records.map(r=>r.identity),['future']);
  await assert.rejects(scanTransactionSources(f.root,{enabledAt:'2026-10-29T01:00:00Z',cutoff:end,cursor:first.nextCursor}),/开启窗口/);
});

test('integer-second publications overlapping the millisecond enable boundary are retained',async()=>{
  const f=fixture();f.source('feishu');
  f.batch('feishu','2026-10-28T23:59:59Z',[record('earlier-second')]);
  f.batch('feishu','2026-10-29T00:00:00Z',[record('same-second')]);
  const scan=await scanTransactionSources(f.root,{enabledAt:'2026-10-29T00:00:00.900Z',cutoff:end});
  assert.deepEqual(scan.sources[0]!.records.map(r=>r.identity),['same-second']);
});

test('newest business revision wins over earlier batches and later retracts survive deduplication', async () => {
  const f = fixture(); f.source('feishu');
  f.batch('feishu','2026-10-29T01:00:00Z',[record('same','old',{revision:'r1'})]);
  f.batch('feishu','2026-10-29T02:00:00Z',[record('same','new',{revision:'r2'})]);
  const first = await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.deepEqual(first.sources[0]!.records.map(r=>r.text),['new']);
  assert.equal(first.sources[0]!.coverage.duplicateRecords,1);
  f.batch('feishu','2026-10-29T03:00:00Z',[record('same','',{revision:'r3',deleted:true,operation:'retract'})]);
  const second = await scanTransactionSources(f.root,{enabledAt:start,cutoff:end,cursor:first.nextCursor});
  assert.equal(second.recordCount,1); assert.equal(second.sources[0]!.records[0]!.operation,'retract');
  assert.equal(second.sources[0]!.records[0]!.text,'[该来源记录已撤回或删除]');
  const manifest = f.manifests.get('feishu')!; manifest.items.item.last_success = time(end);
  json(join(f.root,'sources/feishu/data.json'),manifest);
  assert.equal((await scanTransactionSources(f.root,{enabledAt:start,cutoff:end,cursor:second.nextCursor})).recordCount,0);
});

test('long records continue at exact text offsets without splitting surrogate pairs or dropping the tail', async () => {
  const f=fixture();f.source('feishu');
  const body='first😀'+'很长的正文'.repeat(600)+'last😀';f.batch('feishu','2026-10-29T01:00:00Z',[record('long',body)]);
  let cursor: TransactionCursor | undefined, accumulated='';
  for(let i=0;i<30;i++){
    const part=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end,cursor,limits:{maxRecords:1,maxRecordChars:512,maxChars:8000}});
    if(!part.recordCount){assert.equal(accumulated,body);break;}
    const r=part.sources[0]!.records[0]!;assert.equal(r.fragment?.offset??0,accumulated.length);
    assert(!/[\uD800-\uDBFF]$/.test(r.text));accumulated+=r.text;cursor=part.nextCursor;
    if(!part.hasMore){assert.equal(accumulated,body);break;}
  }
  assert.equal(accumulated,body);
});

test('GPT internal and empty events are counted separately from visible conversations', async () => {
  const f=fixture();f.source('chatgpt');
  f.batch('chatgpt','2026-10-29T01:00:00Z',[
    record('tool','tool result',{data:{role:'tool',record_kind:'tool_event',content_type:'text'}}),
    record('thought','thinking',{data:{role:'assistant',record_kind:'assistant_event',content_type:'thoughts'}}),
    record('empty','',{data:{role:'assistant',record_kind:'message'}}),
    record('question','real question',{data:{role:'user',record_kind:'message',conversation_title:'Topic'}}),
    record('answer','model claims finished',{data:{role:'assistant',record_kind:'message',channel:'final'}}),
  ]);
  const scan=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.equal(scan.recordCount,2);assert.equal(scan.sources[0]!.coverage.filteredRecords,3);
  assert.equal(scan.sources[0]!.coverage.unreadRecords,0);
  assert.deepEqual(scan.sources[0]!.records.map(r=>r.role),['user','assistant']);
  assert(!scan.text.includes('tool result'));assert(!scan.text.includes('thinking'));
});

test('Bilibili preserves viewing metadata without leaking raw source content into the body pack',async()=>{
  const f=fixture();f.source('bilibili');
  f.batch('bilibili','2026-10-29T01:00:00Z',[record('watch','Video title',{data:{author:'Uploader',bvid:'BV1example',duration:264,progress:6,video_content_fetched:false,source_content:{token:'not source text'}}})]);
  const scan=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.equal(scan.sources[0]!.records[0]!.metadata?.progress,6);
  assert.equal(scan.sources[0]!.records[0]!.metadata?.author,'Uploader');
  assert(!scan.text.includes('not source text'));
});

test('corrupt and missing sources remain explicit errors while healthy platforms continue',async()=>{
  const f=fixture();f.source('feishu');f.source('chatgpt');f.source('bilibili');
  f.batch('feishu','2026-10-29T01:00:00Z',[record('good')]);
  const bad=f.batch('chatgpt','2026-10-29T01:00:00Z',[record('bad')]);writeFileSync(bad.file,'{}');
  f.entries[2]!.manifest='sources/bilibili/missing.json';json(join(f.root,'index.json'),{timezone:'UTC',sources:f.entries});
  const scan=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.equal(scan.recordCount,1);assert.equal(scan.sources.find(s=>s.site==='chatgpt')!.status,'error');
  assert.match(scan.sources.find(s=>s.site==='chatgpt')!.error!,/SHA256/);
  assert(scan.sources.some(s=>s.site==='bilibili'&&s.status==='error'));
  assert.deepEqual(scan.nextCursor.sources.chatgpt,{batches:{},revisions:{}});
  assert.equal(scan.sources.find(s=>s.site==='feishu')!.status,'ok');
});

test('source manifests reject traversal and linked paths and unknown platforms use the same envelope',async()=>{
  const f=fixture();f.source('calendar');f.batch('calendar','2026-10-29T01:00:00Z',[record('meeting')]);
  json(join(f.root,'index.json'),{timezone:'UTC',sources:[]});
  assert.equal((await scanTransactionSources(f.root,{enabledAt:start,cutoff:end})).sources[0]!.site,'calendar');
  json(join(f.root,'index.json'),{sources:[{site:'escape',manifest:'../outside.json'}]});
  const escaped=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.equal(escaped.sources.find(s=>s.site==='escape')!.status,'error');
  const other=fixture();other.source('feishu');other.batch('feishu','2026-10-29T01:00:00Z',[record('outside')]);
  symlinkSync(join(other.root,'sources/feishu'),join(f.root,'sources/linked'),process.platform==='win32'?'junction':'dir');
  json(join(f.root,'index.json'),{sources:[{site:'feishu',manifest:'sources/linked/data.json'}]});
  const linked=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.equal(linked.sources.find(s=>s.id==='feishu')!.status,'error');
  assert.match(linked.sources.find(s=>s.id==='feishu')!.error!,/链接/);
});

test('byte and file budgets resume instead of losing unread batches; input files remain byte-identical',async()=>{
  const f=fixture();f.source('feishu');
  const first=f.batch('feishu','2026-10-29T01:00:00Z',[record('older')]);
  const latest=f.batch('feishu','2026-10-29T02:00:00Z',[record('newer')]);
  const bytes=readFileSync(latest.file);
  const one=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end,limits:{maxFiles:3}});
  assert.deepEqual(one.sources[0]!.records.map(r=>r.identity),['newer']);assert(one.hasMore);
  const two=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end,cursor:one.nextCursor,limits:{maxFiles:3}});
  assert.deepEqual(two.sources[0]!.records.map(r=>r.identity),['older']);
  assert.deepEqual(readFileSync(latest.file),bytes);assert(readFileSync(first.file).length>0);
  await assert.rejects(scanTransactionSources(f.root,{enabledAt:start,cutoff:end,signal:AbortSignal.abort(new Error('cancelled'))}),/cancelled/);
  await assert.rejects(scanTransactionSources(f.root,{enabledAt:start,cutoff:end,limits:{maxChars:100}}),/过小/);
});

test('an empty or malformed entry cannot masquerade as a successful source scan',async()=>{
  const f=fixture();json(join(f.root,'index.json'),{sources:[]});
  await assert.rejects(scanTransactionSources(f.root,{enabledAt:start,cutoff:end}),/未登记/);
  f.source('feishu');writeFileSync(join(f.root,'sources/feishu/data.json'),'not-json');
  const scan=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.equal(scan.sources[0]!.status,'error');assert.match(scan.sources[0]!.error!,/UTF-8 JSON/);
});

test('producer health failures are explicit while valid content can be acknowledged without being replayed',async()=>{
  const f=fixture();f.source('bilibili');f.batch('bilibili','2026-10-29T01:00:00Z',[record('watch')]);
  const health='sources/bilibili/.cookiesync-source-health.json';f.entries[0]!.health=health;
  json(join(f.root,'index.json'),{timezone:'UTC',sources:f.entries});
  const state={schema:'cookiesync-source-health-v1',version:1,source:'bilibili',item_id:'bilibili-item',generation:1,
    checked_at:time('2026-10-29T02:00:00Z'),observed_at:time('2026-10-29T02:00:00Z'),last_success:time('2026-10-29T01:00:00Z'),status:'failed',code:'login_required'};
  json(join(f.root,health),state);
  const first=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end});
  assert.equal(first.sources[0]!.status,'error');assert.equal(first.recordCount,1);assert.match(first.sources[0]!.error!,/login_required/);
  assert.equal(first.sources[0]!.health!.lastSuccess,'2026-10-29T01:00:00.000Z');
  const next=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end,cursor:first.nextCursor});
  assert.equal(next.recordCount,0);assert.equal(next.sources[0]!.status,'error');
  json(join(f.root,health),{...state,status:'ok',code:null,last_success:time('2026-10-29T03:00:00Z')});
  const recovered=await scanTransactionSources(f.root,{enabledAt:start,cutoff:end,cursor:first.nextCursor});
  assert.equal(recovered.recordCount,0);assert.equal(recovered.sources[0]!.status,'empty');assert.equal(recovered.sources[0]!.health!.code,null);
});
