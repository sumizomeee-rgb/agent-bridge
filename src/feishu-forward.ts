import { copyForwarded, FORWARD_LIMITS, type ForwardedContent, type ForwardedItem } from './forwarded.js';
import type { DiscordAttachment } from './types.js';

type Json = Record<string, any>;
const record = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const messageId = (value: unknown): value is string => typeof value === 'string' && /^om_[a-zA-Z0-9_-]+$/.test(value);
function body(item: Json, depth: number, notes: string[]): ForwardedItem {
  const type = item.msg_type ?? item.message_type;
  let content: Json = {}, text = '';
  try { const raw = type === 'merge_forward' || item.deleted ? {} : JSON.parse(String(item.body?.content ?? item.content ?? '{}')); if (record(raw)) content = raw; else throw new Error(); }
  catch { notes.push('部分转发消息正文格式无效。'); }
  const attachments: DiscordAttachment[] = [];
  const image = (key: unknown) => { if (typeof key === 'string' && key) attachments.push({ id: key, filename: 'image', url: '', size: 0, content_type: 'image/unknown', resourceKey: key, messageId: item.message_id }); };
  if (item.deleted) text = '[消息已撤回或删除]';
  else if (type === 'text') text = typeof content.text === 'string' ? content.text : '';
  else if (type === 'image') image(content.image_key);
  else if (type === 'post') {
    const post = content.content ? content : content.zh_cn ?? content.en_us ?? {};
    if (Array.isArray(post.content) && (post.content.length > 300 || post.content.some((line: unknown) => Array.isArray(line) && line.length > 100))) notes.push('转发富文本内容超过解析上限。');
    text = [typeof post.title === 'string' ? post.title : '', ...(Array.isArray(post.content) ? post.content : []).slice(0, 300).map((line: unknown) => Array.isArray(line) ? line.slice(0, 100).map(node => {
      if (!record(node)) return '';
      if (node.tag === 'img') { image(node.image_key); return ''; }
      if (node.tag === 'a') return `${node.text ?? node.href ?? ''} (${node.href ?? ''})`;
      return typeof node.text === 'string' ? node.text : '';
    }).join('') : '')].filter(Boolean).join('\n');
  } else if (type === 'interactive') {
    const parts: string[] = []; let visited = 0;
    const collect = (value: unknown, level = 0): void => {
      if (level > 12 || visited++ > 500) { notes.push('转发卡片内容超过解析上限。'); return; }
      if (Array.isArray(value)) { if (value.length > 100) notes.push('转发卡片内容超过解析上限。'); for (const child of value.slice(0, 100)) collect(child, level + 1); return; }
      if (!record(value)) return;
      for (const key of ['content', 'text', 'title']) if (typeof value[key] === 'string') parts.push(value[key]);
      for (const key of ['title', 'header', 'body', 'elements', 'fields', 'text', 'content', 'columns']) if (typeof value[key] === 'object') collect(value[key], level + 1);
    };
    collect(content); text = parts.join('\n') || '[转发卡片：接口未提供可读正文]';
    notes.push('转发卡片仅为接口可见的文字投影，不保证包含原卡全部内容。');
  } else if (type === 'merge_forward') text = '[嵌套合并转发]';
  else if (typeof content.file_key === 'string') attachments.push({ id: content.file_key, filename: String(content.file_name ?? type ?? 'file'), url: '', size: 0, content_type: 'application/octet-stream', resourceKey: content.file_key, messageId: item.message_id });
  else { text = `[${String(type ?? 'unknown').slice(0, 64)}：当前未提取正文]`; notes.push('部分转发消息类型尚未支持，未补写内容。'); }
  const sender = record(item.sender) ? item.sender : {};
  const timestamp = Number(item.create_time);
  return { id: item.message_id, depth, text, attachments,
    ...(typeof sender.id === 'string' || typeof sender.sender_name === 'string' || typeof sender.name === 'string' ? { author: {
      ...(typeof sender.id === 'string' ? { id: sender.id } : {}), ...(typeof (sender.sender_name ?? sender.name) === 'string' ? { name: sender.sender_name ?? sender.name } : {}) } } : {}),
    ...(item.create_time != null && Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()) ? { time: new Date(timestamp).toISOString() } : {}) };
}
/** 仅沿已收到合并转发的 upper_message_id 关系展开；不查询原群历史。 */
export async function readFeishuForwarded(id: string, fetchItems: (id: string, signal: AbortSignal) => Promise<unknown>, outerSignal?: AbortSignal): Promise<ForwardedContent> {
  const result: ForwardedContent = { status: 'complete', messageId: id, messages: [], notes: [] };
  if (!messageId(id)) return { ...result, status: 'unavailable', notes: ['转发消息标识无效。'] };
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(outerSignal ? [outerSignal] : [])]);
  const visited = new Set<string>(); let queries = 0;
  const expand = async (parent: string, depth: number, known?: Json[]): Promise<void> => {
    if (visited.has(parent) || depth >= FORWARD_LIMITS.depth || result.messages.length >= FORWARD_LIMITS.messages) { result.notes.push('嵌套转发循环或超过层级、消息数上限。'); return; }
    visited.add(parent);
    let items = known;
    if (!items) {
      if (queries++ >= FORWARD_LIMITS.queries || signal.aborted) { result.notes.push('转发读取超过请求数或时间上限。'); return; }
      try { const raw = await fetchItems(parent, signal); if (!Array.isArray(raw)) throw new Error(); items = raw.filter(record).slice(0, 500); if (raw.length > items.length) result.notes.push('接口返回内容超过解析上限或含无效片段。'); }
      catch { result.notes.push('部分转发正文无法读取：可能无权限、已删除或接口暂不可用；未补写原文。'); return; }
    }
    const children = items.filter(item => messageId(item.message_id) && item.upper_message_id === parent);
    children.sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
    if (!children.length) { result.notes.push('平台未返回可核验的转发子消息。'); return; }
    const seen = new Set<string>();
    for (const item of children) {
      if (seen.has(item.message_id)) continue; seen.add(item.message_id);
      if (result.messages.length >= FORWARD_LIMITS.messages) { result.notes.push('转发消息超过 100 条上限。'); break; }
      result.messages.push(body(item, depth, result.notes));
      if ((item.msg_type ?? item.message_type) === 'merge_forward' && item.deleted !== true) await expand(item.message_id, depth + 1,
        items.some(child => child.upper_message_id === item.message_id) ? items : undefined);
    }
  };
  await expand(id, 0);
  if (result.notes.length) result.status = result.messages.length ? 'partial' : 'unavailable';
  return copyForwarded(result)!;
}
