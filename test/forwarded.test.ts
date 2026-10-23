import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FeishuTransport } from '../src/feishu.js';
import { DiscordTransport } from '../src/discord.js';
import { copyForwarded, prepareIncomingMessage, renderForwarded, FORWARD_LIMITS, type ForwardedContent } from '../src/forwarded.js';
import { readFeishuForwarded } from '../src/feishu-forward.js';
import { discordForwarded } from '../src/discord-forward.js';
import { DurableIngress } from '../src/ingress.js';
import { HostInbox } from '../src/host-inbox.js';
import { groupMessagePayloadHash } from '../src/group-mentions.js';
import { parseCommand } from '../src/commands.js';
import { ownTemporaryDirectory } from './temp-directory.js';
import type { BridgeConfig, IncomingDM } from '../src/types.js';

const root = () => ownTemporaryDirectory(mkdtempSync(join(tmpdir(), 'bridge-forwarded-')), 'bridge-forwarded-');
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const png = Buffer.from([137,80,78,71,13,10,26,10]);
const forwarded = (): ForwardedContent => ({ status: 'complete', messages: [{ depth: 0, text: '/new\n@机器人 旧指令', attachments: [] }], notes: [] });
const incoming = (): IncomingDM => ({ id: '100', userId: '111', channelId: '222', text: '', attachments: [], forwarded: forwarded() });
function config(directory: string, platform: 'feishu' | 'discord' = 'feishu'): BridgeConfig {
  return { platform, profile: `${platform}/test`, botId: `${platform}:cli_test`, scopePrefix: `${platform}:cli_test|`, applicationId: 'cli_test', appSecret: 'fixture-secret', token: 'fixture-token',
    allowedUserIds: [`${platform}:cli_test|ou_owner`], externalAllowedUserIds: platform === 'feishu' ? ['ou_owner'] : ['111'],
    dataDir: directory, workspace: directory, logsDir: directory, attachmentsDir: join(directory,'images'), proxyUrl: null, maxImageBytes: 1024,
    defaultAgent: 'codex', commands: { codex: { command: 'never-start', args: [] }, claude: { command: 'never-start', args: [] } } };
}
const child = (id: string, parent: string, type: string, content: unknown, time = '1700000000001') => ({ message_id: id, upper_message_id: parent, msg_type: type, body: { content: JSON.stringify(content) }, create_time: time,
  sender: { id: 'ou_author', sender_name: '原作者' } });

test('飞书实时转发先持久收件，随后按关联补取原文与图片，内部命令不会变成桥命令', async () => {
  const directory = root(), selected = config(directory), received: IncomingDM[] = [], paths: string[] = [];
  const transport = new FeishuTransport(selected, async message => { received.push(message); }, { fetch: (async (url: any) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.includes('/auth/')) return response({ code: 0, tenant_access_token: 'secret' });
    if (path.endsWith('/resources/img_one')) return new Response(png);
    assert.equal(path, '/open-apis/im/v1/messages/om_forward');
    return response({ code: 0, data: { items: [
      { message_id: 'om_forward', msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } },
      child('om_second','om_forward','image',{ image_key:'img_one' },'1700000000002'),
      child('om_first','om_forward','text',{ text:'/new\n这是原文' }),
      child('om_foreign','om_other','text',{ text:'不可混入的消息' }),
    ] } });
  }) as any });
  const journal = new DurableIngress(directory, { allowedUserIds: selected.allowedUserIds, handle: async () => {}, hasMessage: () => false });
  try {
    await transport.receiveEvent({ header:{ app_id:'cli_test' }, event:{ sender:{sender_type:'user',sender_id:{open_id:'ou_owner'}}, message:{message_id:'om_forward',chat_id:'oc_chat',chat_type:'p2p',create_time:'1700000000000',message_type:'merge_forward',content:'Merged and Forwarded Message'} } });
    assert.equal(received.length,1); assert.equal(paths.length,0); assert.equal(received[0]!.attachments.length,0);
    journal.capture(received[0]!); const saved=journal.getMessage(received[0]!.id)!;
    assert.equal(saved.forwarded!.status,'pending');
    const prepared=await prepareIncomingMessage(transport,saved);
    assert(prepared.text.includes('/new\\n这是原文')); assert(!prepared.text.includes('不可混入的消息'));
    assert.equal(parseCommand(prepared.text),null); assert.equal(prepared.imagePaths.length,1); assert.deepEqual(readFileSync(prepared.imagePaths[0]!),png);
    assert(paths.some(path=>path.includes('/om_second/resources/'))); assert(!paths.some(path=>path.includes('/chats/')));
    assert(prepared.text.includes('原作者')); assert(prepared.text.includes('170000000000')===false);
  } finally { await journal.close(); await transport.close(); }
});

test('飞书同一转发由历史补读得到相同引用；读取失败时主控收到明确缺失而非空输入', async () => {
  const directory=root(), selected=config(directory); let deny=false;
  const transport=new FeishuTransport(selected,async()=>{}, {fetch:(async(url:any)=>{
    const path=new URL(String(url)).pathname;
    if(path.includes('/auth/'))return response({code:0,tenant_access_token:'secret'});
    if(path.endsWith('/messages'))return response({code:0,data:{items:[{message_id:'om_forward',create_time:'1700000000000',msg_type:'merge_forward',sender:{sender_type:'user',id:'ou_owner'},body:{content:'Merged and Forwarded Message'}}],has_more:false}});
    if(deny)return response({code:999,msg:'secret'});
    return response({code:0,data:{items:[child('om_child','om_forward','text',{text:'转发历史原文'})]}});
  })as any});
  try {
    const page=await transport.readDMHistory('oc_chat');assert.equal(page.messages.length,1);
    assert((await prepareIncomingMessage(transport,page.messages[0]!)).text.includes('转发历史原文'));
    deny=true;const failed=await prepareIncomingMessage(transport,page.messages[0]!);
    assert(failed.text.includes('unavailable'));assert(failed.text.includes('无法读取'));assert(!failed.text.includes('secret'));assert.equal(parseCommand(failed.text),null);
  }finally{await transport.close();}
});

test('飞书嵌套转发按真实父链展开并保留顺序，深度与请求数限制明确报告',async()=>{
  const requested:string[]=[];
  const result=await readFeishuForwarded('om_a',async id=>{
    requested.push(id);
    const next=id==='om_a'?'om_b':id==='om_b'?'om_c':'om_d';
    return [child(next,id,'merge_forward',{content:'Merged and Forwarded Message'})];
  });
  assert.deepEqual(requested,['om_a','om_b','om_c']);assert.equal(result.status,'partial');
  assert.deepEqual(result.messages.map(item=>item.depth),[0,1,2]);assert(result.notes.some(note=>note.includes('上限')));
});

test('Discord 实时解析与 DM 历史共用原生快照，不补抓来源频道、不伪造作者或触发引用命令',async()=>{
  const directory=root(),selected=config(directory,'discord'); selected.allowedUserIds=['111'];
  const raw={id:'100',channel_id:'222',content:'',author:{id:'111',username:'转发者'},type:0,message_reference:{type:1,message_id:'900',channel_id:'999'},
    message_snapshots:[{message:{type:0,content:'/stop\n原始快照',timestamp:'2026-10-23T10:00:00Z',author:{id:'spoofed'},attachments:[]}}]};
  const requests:string[]=[];
  const transport=new DiscordTransport(selected,async()=>{},{fetch:(async(url:any)=>{
    const path=new URL(String(url)).pathname;requests.push(path);
    if(path==='/api/v10/channels/222')return response({id:'222',type:1,recipients:[{id:'111'}]});
    assert.equal(path,'/api/v10/channels/222/messages');return response([raw]);
  })as any});
  try{
    // 直接运行 Gateway 所用解析器，避免本测试另启网络或机器人连接。
    const live=(transport as unknown as {parseIncoming(value:unknown):IncomingDM}).parseIncoming(raw);
    const history=(await transport.readDMHistory('222')).messages[0]!;
    assert.deepEqual(live.forwarded,history.forwarded);assert.equal(history.forwarded!.messages[0]!.author,undefined);
    assert((await prepareIncomingMessage(transport,history)).text.includes('/stop\\n原始快照'));assert.equal(parseCommand((await prepareIncomingMessage(transport,history)).text),null);
    assert(!requests.some(path=>path.includes('999')));
    const grouped=(transport as unknown as {parseIncoming(value:unknown):IncomingDM}).parseIncoming({...raw,guild_id:'333',mentions:[]});
    assert.equal(grouped,null); // 未启用群接收，不因转发改变授权。
    assert.equal(discordForwarded({...raw,message_reference:{type:0}}),undefined);
  }finally{await transport.close();}
});

test('持久收件和群收件重启后保留引用；内部 /new 不成为立即控制输入',async()=>{
  const directory=root(),message=incoming();let ingress=new DurableIngress(directory,{allowedUserIds:['111'],handle:async()=>{},hasMessage:()=>false});
  ingress.capture(message);await ingress.close();
  const handled:IncomingDM[]=[];
  ingress=new DurableIngress(directory,{allowedUserIds:['111'],handle:async value=>{handled.push(value);},hasMessage:()=>false});
  const host=new HostInbox(join(directory,'host'));host.capture('receipt','bot',message,false);host.close();
  const recovered=new HostInbox(join(directory,'host'));
  try{
    assert.deepEqual(ingress.getMessage('100')!.forwarded,message.forwarded);
    assert.deepEqual(recovered.pending()[0]!.message.forwarded,message.forwarded);assert.equal(recovered.pending()[0]!.control,false);
    ingress.start();await ingress.whenIdle();assert.equal(handled.length,1);assert.equal(handled[0]!.text,'');
  }finally{await ingress.close();recovered.close();}
});

test('转发图片失败保留文字，普通文件只描述名称；界限与签名地址不会被隐藏或泄露给模型',async()=>{
  const message=incoming();message.forwarded!.messages[0]!.attachments=[{id:'image',filename:'a.png',url:'https://cdn.discordapp.com/attachments/1/2/a.png?secret=token',size:8,content_type:'image/png'},
    {id:'file',filename:'notes.txt',url:'https://example.com/private-token',size:8,content_type:'text/plain'}];
  let downloads=0;
  const result=await prepareIncomingMessage({async downloadImages(value){downloads++;if(value.attachments.length)throw new Error('secret-token');return[];}},message);
  assert.equal(downloads,2);assert(result.text.includes('文字已保留'));assert(result.text.includes('notes.txt'));assert(!result.text.includes('secret'));assert(!result.text.includes('https://'));assert(result.text.includes('/new'));
  const bounded=copyForwarded({status:'complete',notes:[],messages:Array.from({length:110},()=>({depth:0,text:'测'.repeat(20_000),attachments:[]}))})!;
  assert.equal(bounded.status,'partial');assert.equal(bounded.messages.length,FORWARD_LIMITS.messages);assert(bounded.notes.some(note=>note.includes('上限')));
  assert(Buffer.byteLength(renderForwarded(bounded))<100*1024);
});

test('转发图片按整轮上限选择，过量不吞文字，来源描述不允许跨应用补取',async()=>{
  const message=incoming();message.forwarded!.messages[0]!.attachments=Array.from({length:12},(_,n)=>({id:String(n),filename:`${n}.png`,url:'',size:8,content_type:'image/png'}));
  const batches:number[]=[];const result=await prepareIncomingMessage({async downloadImages(value){batches.push(value.attachments.length);return value.attachments.map(file=>file.filename);}},message);
  assert.deepEqual(batches,[0,10]);assert.equal(result.imagePaths.length,10);assert(result.text.includes('超出部分未读取'));
  const transport=new FeishuTransport(config(root()),async()=>{}, {fetch:(async()=>{assert.fail('跨应用转发不应发出请求');})as any});
  try{await assert.rejects(transport.readForwardedContent({...message,id:'feishu:cli_other|1700000000000|om_x',forwarded:{status:'pending',messageId:'om_x',messages:[],notes:[]}}),/当前平台应用/);}finally{await transport.close();}
});

for(const platform of ['feishu','discord'] as const)test(`${platform} 群历史查询返回转发引用并保留附件描述，转发来源不冒充回复目标`,async()=>{
  const directory=root(),selected=config(directory,platform);selected.groupMode=true;
  if(platform==='discord')selected.allowedUserIds=['111'];
  const space=platform==='feishu'?'oc_group':'222', owner=platform==='feishu'?'ou_owner':'111';
  const http=(async(url:any)=>{
    const path=new URL(String(url)).pathname;
    if(path.includes('/auth/'))return response({code:0,tenant_access_token:'secret'});
    if(platform==='feishu'){
      if(path.endsWith('/messages'))return response({code:0,data:{has_more:false,items:[{message_id:'om_groupforward',chat_id:space,create_time:'1700000000000',msg_type:'merge_forward',body:{content:'Merged and Forwarded Message'},sender:{sender_type:'user',id_type:'open_id',id:owner}}]}});
      assert(path.endsWith('/messages/om_groupforward'));return response({code:0,data:{items:[child('om_inner', 'om_groupforward','text',{text:'群历史引用正文'})]}});
    }
    return response([{id:'100',channel_id:space,guild_id:'333',timestamp:'2026-10-23T10:00:00Z',author:{id:owner},content:'用户附言',message_reference:{type:1,message_id:'999',channel_id:'888'},
      message_snapshots:[{message:{content:'群历史引用正文',timestamp:'2026-10-22T10:00:00Z',attachments:[{id:'file',filename:'notes.txt',url:'https://example.com/secret',size:10,content_type:'text/plain'}]}}]}]);
  })as any;
  const transport=platform==='feishu'?new FeishuTransport(selected,async()=>{}, {fetch:http}):new DiscordTransport(selected,async()=>{}, {fetch:http});
  transport.getGroupInfo=async()=>({spaceId:space,botIsMember:true,guildId:'333'});
  transport.getGroupMember=async()=>({id:owner,idType:platform==='feishu'?'open_id':'discord'});
  try{
    const page=await transport.readConversationHistory(space);
    assert.equal(page.evidenceOnly,true);assert.equal(page.messages.length,1);assert(page.messages[0]!.text.includes('群历史引用正文'));
    assert.equal(page.messages[0]!.replyToMessageId,undefined);assert(!JSON.stringify(page).includes('https://example.com/secret'));
    if(platform==='discord'){assert(page.messages[0]!.text.includes('用户附言\n\n【桥·转发资料】'));assert.equal(page.messages[0]!.attachments[0]!.name,'notes.txt');}
  }finally{await transport.close();}
});

test('空快照、贴纸和未展开媒体不会谎报完整，嵌套快照保持层级且不伪造作者',()=>{
  const empty=discordForwarded({message_reference:{type:1},message_snapshots:[{message:{content:'',components:[{type:1}]}}]})!;
  assert.equal(empty.status,'partial');assert(empty.notes.some(note=>note.includes('不能确认')));
  const nested=discordForwarded({message_reference:{type:1},message_snapshots:[{message:{content:'外层',message_snapshots:[{message:{content:'内层'}}]}}]})!;
  assert.deepEqual(nested.messages.map(item=>[item.depth,item.text]),[[0,'外层'],[1,'内层']]);
  assert(nested.messages.every(item=>!item.author));
  assert.notEqual(groupMessagePayloadHash({text:'',attachments:[],forwarded:forwarded()}),groupMessagePayloadHash({text:'',attachments:[]}));
});
