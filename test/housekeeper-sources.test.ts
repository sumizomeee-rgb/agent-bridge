import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, utimesSync, unlinkSync, renameSync, symlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownTemporaryDirectory } from './temp-directory.js';
import { scanTransactionSources, type TransactionCursor, type TransactionSourceOptions } from '../src/housekeeper/sources.js';

const start='2026-10-29T00:00:00Z', end='2026-10-30T00:00:00Z';
function fixture(){
  const root=ownTemporaryDirectory(mkdtempSync(join(tmpdir(),'housekeeper-sources-')),'housekeeper-sources-');
  const file=(path:string,text:string|Buffer,mtime='2026-10-29T12:00:00Z')=>{
    const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text);utimesSync(target,new Date(mtime),new Date(mtime));return target;
  };
  const scan=(options:Partial<TransactionSourceOptions>={})=>scanTransactionSources(root,{enabledAt:start,cutoff:end,...options});
  return{root,file,scan};
}
const rows=(scan:Awaited<ReturnType<typeof scanTransactionSources>>)=>scan.sources.flatMap(s=>s.records);

test('readable files are platform-agnostic, recursively discovered, fairly paged and acknowledged separately',async()=>{
  const f=fixture();
  for(const site of ['chatgpt','feishu','bilibili']){f.file(site+'/a.md',site+' original text');f.file(site+'/nested/b.txt',site+' second text');}
  const first=await f.scan({limits:{maxRecords:3}});assert.equal(first.recordCount,3);assert(first.hasMore);
  assert.deepEqual(first.sources.map(s=>s.records.length),[1,1,1]);assert(first.text.includes('feishu original text'));
  assert(first.text.includes('未读提示'));assert(!first.text.startsWith('{'));
  assert.equal((await f.scan({limits:{maxRecords:3}})).text,first.text,'reader must not commit implicitly');
  const second=await f.scan({cursor:first.nextCursor,limits:{maxRecords:3}});assert.equal(second.recordCount,3);assert(!second.hasMore);
  const done=await f.scan({cursor:second.nextCursor});assert.equal(done.recordCount,0);assert(!done.hasMore);
  assert(done.sources.every(s=>s.coverage.filesRead===0),'unchanged files must not be reopened or rehashed');
});


test('retention keeps the exact ten-day boundary and expired cleanup never becomes a withdrawal',async()=>{
  const f=fixture(),enabledAt='2026-10-01T00:00:00Z';
  f.file('source/expired.md','expired body','2026-10-19T23:59:59Z');
  const boundary=f.file('source/boundary.md','retained at the boundary','2026-10-20T00:00:00Z');
  const first=await f.scan({enabledAt});assert.deepEqual(rows(first).map(r=>r.text),['retained at the boundary']);
  assert(!first.nextCursor.files!['source/expired.md']);
  unlinkSync(boundary);
  const next=await f.scan({enabledAt,cutoff:'2026-10-31T00:00:00Z',cursor:first.nextCursor});
  assert.equal(next.recordCount,0);assert(!next.hasMore);assert(!next.nextCursor.files!['source/boundary.md']);
});

test('retention expires unread fragments without replaying them or inventing retractions',async()=>{
  const f=fixture(),enabledAt='2026-10-01T00:00:00Z';
  f.file('source/long.md','retained fragment '.repeat(1000),'2026-10-20T12:00:00Z');
  const first=await f.scan({enabledAt,limits:{maxRecords:1,maxRecordChars:128}});
  assert.equal(first.recordCount,1);assert(first.hasMore);
  const next=await f.scan({enabledAt,cutoff:'2026-10-31T12:00:00Z',cursor:first.nextCursor});
  assert.equal(next.recordCount,0);assert(!next.hasMore);assert(!next.nextCursor.files!['source/long.md']);
});

test('file publication mtime governs the on window; copied historical content and JSON metadata never become recent text',async()=>{
  const f=fixture();f.file('any-platform/history.md','three months of old history','2026-08-01T00:00:00Z');
  f.file('any-platform/new.txt','Original message time: 2026-08-01; newly published correction');
  f.file('any-platform/future.log','future','2026-11-01T00:00:00Z');f.file('index.json','not even valid JSON');
  f.file('.internal/secret.md','hidden payload');f.file('any-platform/.health-state.json','raw protocol');
  f.file('any-platform/.hidden.txt','not published');f.file('any-platform/raw.bin','not text');
  const first=await f.scan();assert.equal(first.recordCount,1);assert.equal(rows(first)[0]!.text,'Original message time: 2026-08-01; newly published correction');
  assert.equal(first.sources[0]!.coverage.skippedBeforeWindow,1);assert(!first.text.includes('three months'));assert(!first.text.includes('raw protocol'));
  // A migration can replace the bytes/ctime while preserving its original publication mtime.
  f.file('any-platform/history.md','old history reformatted','2026-08-01T00:00:00Z');
  assert.equal((await f.scan({cursor:first.nextCursor})).recordCount,0);
  await assert.rejects(f.scan({enabledAt:'2026-10-29T01:00:00Z',cursor:first.nextCursor}),/开启窗口/);
});

test('whole-second publication precision retains the same-second enable overlap',async()=>{
  const f=fixture();f.file('source/before.md','before','2026-10-28T23:59:59Z');f.file('source/overlap.md','overlap',start);
  const scan=await f.scan({enabledAt:'2026-10-29T00:00:00.900Z'});assert.deepEqual(rows(scan).map(r=>r.text),['overlap']);
});

test('sub-millisecond filesystem mtime at the cutoff is included without including the next millisecond',async()=>{
  const f=fixture(),same=f.file('source/same-ms.md','same millisecond'),future=f.file('source/next-ms.md','next millisecond');
  const cutoff=Date.parse(end),sameSeconds=(cutoff+0.5)/1000,futureSeconds=(cutoff+1.5)/1000;
  utimesSync(same,sameSeconds,sameSeconds);utimesSync(future,futureSeconds,futureSeconds);
  assert(statSync(same).mtimeMs>cutoff&&statSync(same).mtimeMs<cutoff+1,'fixture must retain a fractional millisecond');
  const scan=await f.scan();assert.deepEqual(rows(scan).map(r=>r.text),['same millisecond']);
  const next=await f.scan({cursor:scan.nextCursor,cutoff:new Date(cutoff+1).toISOString()});
  assert.deepEqual(rows(next).map(r=>r.text),['next millisecond']);
});

test('opaque text is delivered verbatim without interpreting sender, platform, markdown, or embedded JSON schemas',async()=>{
  const f=fixture(),body='# 任意平台\n作者和会话由来源说明\n```json\n{"data":{"role":"tool"},"operation":"retract"}\n```\n正文 😀\n';
  f.file('new-calendar-format/free-form.log',body);const scan=await f.scan();assert.equal(rows(scan)[0]!.text,body);
  assert.equal(scan.sources[0]!.site,'new-calendar-format');assert.equal(rows(scan)[0]!.operation,'upsert');
  assert(scan.text.includes(body));assert.equal(rows(scan)[0]!.source.file,'new-calendar-format/free-form.log');
});

test('append verifies the consumed prefix and returns only the new suffix',async()=>{
  const f=fixture(),target=f.file('notes/events.log','已读原文😀\n'),first=await f.scan();
  appendFileSync(target,'新增尾部😀\n');utimesSync(target,new Date(end),new Date(end));
  const next=await f.scan({cursor:first.nextCursor});assert.equal(next.recordCount,1);assert.equal(rows(next)[0]!.change,'append');
  assert.equal(rows(next)[0]!.text,'新增尾部😀\n');assert.equal(rows(next)[0]!.source.byteOffset,Buffer.byteLength('已读原文😀\n'));
  assert.equal((await f.scan({cursor:next.nextCursor})).recordCount,0);
});

test('rewrite is detected even when size grows, and shorter replacements are delivered as explicit revisions',async()=>{
  const f=fixture(),original='A'.repeat(9000)+'old tail',target=f.file('source/change.md',original),first=await f.scan();
  // Changing the middle cannot be mistaken for an append merely because head/tail probes match.
  const replacement='A'.repeat(4300)+'CHANGED'+'A'.repeat(4693)+'old tail plus appended';
  writeFileSync(target,replacement);utimesSync(target,new Date(end),new Date(end));
  const changed=await f.scan({cursor:first.nextCursor});assert.equal(rows(changed)[0]!.change,'rewrite');assert.equal(rows(changed).map(r=>r.text).join(''),replacement);
  writeFileSync(target,'short revised');utimesSync(target,new Date(end),new Date(end));
  const short=await f.scan({cursor:changed.nextCursor});assert.equal(rows(short)[0]!.change,'rewrite');assert.equal(rows(short)[0]!.text,'short revised');
});

test('long UTF-8 files continue at byte offsets without corrupting multibyte text or losing unseen tails',async()=>{
  const f=fixture(),body='first😀'+'汉字与emoji😀'.repeat(1600)+'last😀';f.file('platform/large.txt',body);
  let cursor:TransactionCursor|undefined,actual='',offset=0;
  for(let n=0;n<100;n++){
    const scan=await f.scan({cursor,limits:{maxRecords:1,maxRecordChars:512,maxChars:4000}});
    for(const record of rows(scan)){assert.equal(record.source.byteOffset,offset);assert(!/[\uD800-\uDBFF]$/.test(record.text));actual+=record.text;offset+=Buffer.byteLength(record.text);}
    cursor=scan.nextCursor;if(!scan.hasMore)break;
  }
  assert.equal(actual,body);assert.equal(offset,Buffer.byteLength(body));assert.equal((await f.scan({cursor})).recordCount,0);
});

test('changed-prefix verification itself is bounded and can continue across technical acknowledgements',async()=>{
  const f=fixture(),target=f.file('source/log.txt','prefix '.repeat(5000)),first=await f.scan();
  appendFileSync(target,'only this appended');utimesSync(target,new Date(end),new Date(end));
  let cursor=first.nextCursor,body='',technical=0;
  for(let n=0;n<30;n++){
    const scan=await f.scan({cursor,limits:{maxTotalBytes:8192}});cursor=scan.nextCursor;
    if(!scan.recordCount&&scan.hasMore)technical++;
    body+=rows(scan).map(r=>r.text).join('');if(!scan.hasMore)break;
  }
  assert(technical>0);assert.equal(body,'only this appended');
});

test('deletion and rename of consumed files produce explicit withdrawals; an unconsumed historical file does not',async()=>{
  const f=fixture();f.file('source/consumed.md','known fact');const historical=f.file('source/history.txt','old','2026-08-01T00:00:00Z');
  const first=await f.scan();renameSync(join(f.root,'source/consumed.md'),join(f.root,'source/renamed.md'));unlinkSync(historical);
  const next=await f.scan({cursor:first.nextCursor});assert.equal(next.recordCount,2);
  const removed=rows(next).find(r=>r.change==='delete'&&r.source.file==='source/consumed.md');assert(removed);
  assert.match(removed.text,/仅确认文件消失，不代表其中历史内容均被撤回/);
  assert(rows(next).some(r=>r.change==='new'&&r.source.file==='source/renamed.md'));
  assert.equal((await f.scan({cursor:next.nextCursor})).recordCount,0);
});

test('file and record limits retain pending work and rotate fairly between sources',async()=>{
  const f=fixture();for(const source of ['alpha','beta','gamma'])for(let n=0;n<3;n++)f.file(source+'/'+n+'.md',source+n);
  let cursor:TransactionCursor|undefined;const seen:string[]=[];
  for(let n=0;n<12;n++){
    const scan=await f.scan({cursor,limits:{maxFiles:1,maxRecords:1}});seen.push(...rows(scan).map(r=>r.text));cursor=scan.nextCursor;if(!scan.hasMore)break;
  }
  assert.deepEqual(seen.slice(0,3),['alpha0','beta0','gamma0']);assert.equal(new Set(seen).size,9);
});

test('invalid text and oversized files remain source errors while other platforms continue',async()=>{
  const f=fixture();f.file('good/a.md','safe content');f.file('bad/b.txt',Buffer.from([0xff,0xff,0x80]));f.file('large/c.log','x'.repeat(5000));
  const scan=await f.scan({limits:{maxFileBytes:4096}});assert.equal(scan.sources.find(s=>s.id==='bad')!.status,'error');
  assert.equal(scan.sources.find(s=>s.id==='large')!.status,'error');assert.equal(rows(scan)[0]!.text,'safe content');
  assert.equal(scan.nextCursor.files!['bad/b.txt'],undefined);assert.equal(scan.nextCursor.files!['large/c.log'],undefined);
});

test('links, hidden paths and path traversal in saved cursors are never followed',async()=>{
  const f=fixture(),outside=fixture();outside.file('outside.md','private secret');f.file('safe/a.md','visible');
  symlinkSync(outside.root,join(f.root,'linked'),process.platform==='win32'?'junction':'dir');
  const scan=await f.scan();assert.equal(scan.recordCount,1);assert(!scan.text.includes('private secret'));
  const malicious:TransactionCursor={version:2,enabledAt:start,sources:{},files:{'../escape.md':{version:'x',mtime:1,size:0,offset:0,blocks:[]}}};
  await assert.rejects(f.scan({cursor:malicious}),/越界/);
  await assert.rejects(scanTransactionSources(join(f.root,'linked'),{enabledAt:start,cutoff:end}),/链接/);
});

test('source discovery errors cannot falsely withdraw previously consumed files',async()=>{
  const f=fixture();f.file('source/nested/doc.md','previously seen');f.file('healthy/a.md','healthy');const first=await f.scan();
  const scan=await f.scan({cursor:first.nextCursor,limits:{maxDepth:1}});
  assert.equal(scan.sources.find(s=>s.id==='source')!.status,'error');assert(!rows(scan).some(r=>r.change==='delete'));
  assert.deepEqual(scan.nextCursor.files!['source/nested/doc.md'],first.nextCursor.files!['source/nested/doc.md']);
});

test('legacy progress cannot be silently baselined, while an empty old cursor migrates without losing unread files',async()=>{
  const f=fixture();f.file('platform/new.md','unread');
  const old:TransactionCursor={version:1,enabledAt:start,sources:{platform:{batches:{old:{next:4}},revisions:{}}}};
  const blocked=await f.scan({cursor:old});assert.equal(blocked.recordCount,0);assert.equal(blocked.sources[0]!.status,'error');
  assert.match(blocked.text,/旧格式进度无法自动映射，未消费任何文本/);assert.deepEqual(blocked.nextCursor,old);
  const empty:TransactionCursor={version:1,enabledAt:start,sources:{platform:{batches:{},revisions:{}}}};
  const migrated=await f.scan({cursor:empty});assert.equal(migrated.nextCursor.version,2);assert.equal(migrated.recordCount,1);
});

test('missing root, global inventory overflow and cancellation are explicit; reading never modifies source bytes',async()=>{
  const f=fixture(),target=f.file('source/a.md','untouched'),before=readFileSync(target);
  await f.scan();assert.deepEqual(readFileSync(target),before);
  await assert.rejects(scanTransactionSources(join(f.root,'missing'),{enabledAt:start,cutoff:end}),/ENOENT/);
  await assert.rejects(f.scan({limits:{maxEntries:1}}),/目录项超过上限/);
  await assert.rejects(f.scan({signal:AbortSignal.abort(new Error('cancelled'))}),/cancelled/);
});
