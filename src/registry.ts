import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentName, BridgePlatform } from './types.js';
import { profileAliasKey, type BotProfile } from './profiles.js';

export interface ControllerRegistration {
  id: string; aliases: string[]; ownerPrincipalId: string;
  backend: { kind: 'native'; agent: AgentName } | { kind: 'external'; endpointId: string };
  channelId?: string; workspace: string; workingCwd: string;
  network?: { proxyPort: number | null };
  wait: { responseMs: number | null }; dataDir: string; configPath: string;
}
export interface ChannelRegistration extends BotProfile {
  id: string; platform: BridgePlatform; applicationId: string; name: string;
  dataDir: string; configPath: string; credentialsPath: string;
}
export interface RegistryPrincipal { id: string; accounts: Record<string,string> }
export interface RegistrySpace { id: string; accounts: Record<string,string> }
export interface WorkspaceRegistry {
  version: 4; workspaceRoot: string; registryRoot: string; hostDataDir: string;
  startupControllers: string[]; controllers: ControllerRegistration[]; channels: ChannelRegistration[];
  principals: RegistryPrincipal[]; spaces: RegistrySpace[];
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const own = (value: unknown): value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
function read(path:string):Record<string,unknown>{
  if(lstatSync(path).isSymbolicLink())throw new Error('登记文件不得是符号链接：'+path);
  const value:unknown=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
  if(!own(value))throw new Error('登记文件必须是JSON对象：'+path);return value;
}
function id(value:unknown,label:string):string{
  if(typeof value!=='string'||!identifier.test(value))throw new Error(label+'必须是稳定英文ID');return value;
}
function list(value:unknown,label:string):string[]{
  if(!Array.isArray(value)||value.some(v=>typeof v!=='string')||new Set(value).size!==value.length)throw new Error(label+'必须是不重复的字符串数组');return value as string[];
}
function channelIdentity(value:unknown):{id:string;platform:BridgePlatform;applicationId:string;directory:string}{
  if(typeof value!=='string')throw new Error('渠道ID必须是platform:applicationId');
  const match=/^(feishu|discord):([^:]+)$/.exec(value);
  if(!match||!(match[1]==='feishu'?/^cli_[A-Za-z0-9]+$/:/^\d{15,22}$/).test(match[2]!))throw new Error('渠道ID无效：'+value);
  return {id:value,platform:match[1] as BridgePlatform,applicationId:match[2]!,directory:match[1]==='feishu'?'lark':'discord'};
}
/** Sole runtime registry. Older project/configuration layouts are migrated offline, never guessed here. */
export function readWorkspaceRegistry(workspaceRoot:string):WorkspaceRegistry{
  workspaceRoot=resolve(workspaceRoot);const registryRoot=join(workspaceRoot,'bridge-registry');
  const index=read(join(registryRoot,'config.json'));
  if(index.version!==4)throw new Error('工作区登记仅支持version:4，请先完成一次性迁移');
  const controllerIds=list(index.controllers,'controllers').map(v=>id(v,'主控ID'));
  const startupControllers=list(index.startupControllers,'startupControllers');
  if(startupControllers.some(v=>!controllerIds.includes(v)))throw new Error('启动主控未登记');
  const channelIds=list(index.channels,'channels');
  const channels=channelIds.map(channelId=>{
    const identity=channelIdentity(channelId),directory=join(registryRoot,'channels',identity.directory,'bots',identity.applicationId);
    const configPath=join(directory,'config.json'),credentialsPath=join(directory,'credentials.json'),raw=read(configPath),credentials=read(credentialsPath);
    if(raw.version!==1||raw.id!==channelId||raw.platform!==identity.platform||raw.applicationId!==identity.applicationId||credentials.version!==1)throw new Error('渠道配置身份或版本不一致：'+channelId);
    if(['workspace','workingCwd','defaultAgent','backend','controllerId','aliases'].some(key=>key in raw))throw new Error('渠道配置不能持有主控身份、工作区或Agent选择');
    const allowedUserIds=list(raw.allowedUserIds,'渠道allowedUserIds');
    const userPattern=identity.platform==='feishu'?/^ou_[A-Za-z0-9_-]+$/:/^\d{15,22}$/;
    if(!allowedUserIds.length||allowedUserIds.some(v=>!userPattern.test(v)))throw new Error('渠道白名单账号无效：'+channelId);
    const profile=raw.profile??identity.platform+'/'+identity.applicationId;
    if(typeof profile!=='string'||!new RegExp('^'+identity.platform+'/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$').test(profile))throw new Error('渠道profile无效');
    const network=raw.network;
    if(network!==undefined&&(!own(network)||Object.keys(network).some(k=>k!=='proxyPort')||network.proxyPort!==null&&(!Number.isInteger(network.proxyPort)||Number(network.proxyPort)<1||Number(network.proxyPort)>65535)))throw new Error('渠道network无效');
    const features=raw.features;
    if(features!==undefined&&(!own(features)||Object.entries(features).some(([k,v])=>!['reactions','nativeCommands','presence'].includes(k)||typeof v!=='boolean')||identity.platform==='feishu'&&Object.entries(features).some(([k,v])=>v&&k!=='reactions')))throw new Error('渠道features无效');
    const token=typeof credentials.token==='string'?credentials.token.trim():'';
    const appSecret=typeof credentials.appSecret==='string'?credentials.appSecret.trim():'';
    if(identity.platform==='feishu'?!appSecret:!token)throw new Error('渠道凭据缺失：'+channelId);
    return {...identity,name:profile,allowedUserIds,token,appSecret,network:network as BotProfile['network'],features:features as BotProfile['features'],dataDir:join(directory,'data'),configPath,credentialsPath};
  });
  if(new Set(channels.map(c=>c.name)).size!==channels.length)throw new Error('渠道profile重复');
  const principalIds=new Set<string>(),accountKeys=new Set<string>();
  if(!Array.isArray(index.principals))throw new Error('principals必须是数组');
  const principals=index.principals.map(value=>{
    if(!own(value)||!own(value.accounts))throw new Error('principal配置无效');const principalId=id(value.id,'principal ID');
    if(principalIds.has(principalId))throw new Error('principal ID重复');principalIds.add(principalId);
    const accounts:Record<string,string>={};
    for(const [channel,user] of Object.entries(value.accounts)){
      const registered=channels.find(c=>c.id===channel),key=channel+'|'+user;
      if(!registered||typeof user!=='string'||!registered.allowedUserIds.includes(user)||accountKeys.has(key))throw new Error('principal账号必须唯一对应已登记渠道白名单');
      accounts[channel]=user;accountKeys.add(key);
    }return {id:principalId,accounts};
  });
  const aliasOwners=new Map<string,string>(),boundChannels=new Set<string>();
  const controllers=controllerIds.map(controllerId=>{
    const directory=join(registryRoot,'controllers',controllerId),configPath=join(directory,'config.json'),raw=read(configPath);
    if(raw.version!==1||raw.id!==controllerId)throw new Error('主控配置身份或版本不一致：'+controllerId);
    const ownerPrincipalId=id(raw.ownerPrincipalId,'ownerPrincipalId');if(!principalIds.has(ownerPrincipalId))throw new Error('主控ownerPrincipalId未登记');
    const network=raw.network;
    if(network!==undefined&&(!own(network)||Object.keys(network).some(k=>k!=='proxyPort')||network.proxyPort!==null&&(!Number.isInteger(network.proxyPort)||Number(network.proxyPort)<1||Number(network.proxyPort)>65535)))throw new Error('主控network无效');
    const aliases=list(raw.aliases??[],'主控aliases').map(value=>value.trim());
    if(aliases.some(v=>!v||Array.from(v).length>64||/[\p{Cc}\p{Cf}]/u.test(v)))throw new Error('主控别名无效');
    for(const alias of [controllerId,...aliases]){const key=profileAliasKey(alias),old=aliasOwners.get(key);if(old&&old!==controllerId)throw new Error('主控别名重复或遮蔽其他主控ID');aliasOwners.set(key,controllerId);}
    const backend=raw.backend;
    if(!own(backend)||!(backend.kind==='native'&&(backend.agent==='codex'||backend.agent==='claude')||backend.kind==='external'&&typeof backend.endpointId==='string'&&identifier.test(backend.endpointId)))throw new Error('主控backend无效');
    const channelId=raw.channelId;
    if(channelId!==undefined){if(typeof channelId!=='string'||!channels.some(c=>c.id===channelId)||boundChannels.has(channelId))throw new Error('主控渠道未登记或被重复绑定');boundChannels.add(channelId);
      if(!principals.find(p=>p.id===ownerPrincipalId)!.accounts[channelId])throw new Error('主控owner在绑定渠道缺少账号映射');}
    const wait=raw.wait??{responseMs:null};
    if(!own(wait)||Object.keys(wait).some(k=>k!=='responseMs')||wait.responseMs!==null&&(!Number.isSafeInteger(wait.responseMs)||Number(wait.responseMs)<1000||Number(wait.responseMs)>30*24*60*60*1000))throw new Error('主控wait.responseMs必须为null或1000至30天的毫秒数');
    for(const key of ['workspace','workingCwd'])if(raw[key]!==undefined&&(typeof raw[key]!=='string'||!String(raw[key]).trim()))throw new Error('主控路径配置无效');
    const workspace=raw.workspace===undefined?workspaceRoot:resolve(workspaceRoot,String(raw.workspace));
    const workingCwd=raw.workingCwd===undefined?workspace:resolve(workspaceRoot,String(raw.workingCwd));
    return {id:controllerId,aliases,ownerPrincipalId,backend:backend as ControllerRegistration['backend'],...(channelId?{channelId:String(channelId)}:{}),workspace,workingCwd,
      network:network as ControllerRegistration['network'],wait:{responseMs:wait.responseMs as number|null},dataDir:join(directory,'data'),configPath};
  });
  if(!Array.isArray(index.spaces))throw new Error('spaces必须是数组');
  const spaceIds=new Set<string>(),spaceAccounts=new Set<string>();
  const spaces=index.spaces.map(value=>{
    if(!own(value)||typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id)||spaceIds.has(value.id)||!own(value.accounts)||!Object.keys(value.accounts).length)throw new Error('space配置无效');spaceIds.add(value.id);
    const accounts:Record<string,string>={};for(const [channel,address] of Object.entries(value.accounts)){const registered=channels.find(c=>c.id===channel),key=channel+'|'+address;
      if(!registered||typeof address!=='string'||!(registered.platform==='feishu'?/^oc_[A-Za-z0-9_-]+$/:/^\d{15,22}$/).test(address)||spaceAccounts.has(key))throw new Error('space账号映射无效或重复');accounts[channel]=address;spaceAccounts.add(key);}
    return {id:value.id,accounts};
  });
  return {version:4,workspaceRoot,registryRoot,hostDataDir:join(workspaceRoot,'bridge-local','host'),startupControllers,controllers,channels,principals,spaces};
}
