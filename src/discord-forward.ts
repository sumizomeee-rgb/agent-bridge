import { copyForwarded, FORWARD_LIMITS, type ForwardedContent, type ForwardedItem } from './forwarded.js';

type Json = Record<string, any>;
const record = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
/** 原生快照不包含作者字段，不根据来源消息 ID 推测或补抓原频道。 */
export function discordForwarded(message: Json): ForwardedContent | undefined {
  if (message.message_reference?.type !== 1) return undefined;
  const content: ForwardedContent = { status: 'complete', messages: [], notes: ['平台转发快照未提供原作者身份。'] };
  const visit = (raw: Json, depth: number): void => {
    if (depth >= FORWARD_LIMITS.depth || content.messages.length >= FORWARD_LIMITS.messages) { content.status = 'partial'; content.notes.push('嵌套转发超过层级或消息数上限。'); return; }
    if (!Array.isArray(raw.message_snapshots) || !raw.message_snapshots.length) { content.status = content.messages.length ? 'partial' : 'unavailable'; content.notes.push('平台未提供转发快照正文。'); return; }
    if (raw.message_snapshots.length > FORWARD_LIMITS.messages) { content.status = 'partial'; content.notes.push('转发快照超过消息数上限。'); }
    for (const snapshot of raw.message_snapshots.slice(0, FORWARD_LIMITS.messages)) {
      if (content.messages.length >= FORWARD_LIMITS.messages) { content.status = 'partial'; content.notes.push('转发快照超过消息数上限。'); break; }
      if (!record(snapshot) || !record(snapshot.message)) { content.status = 'partial'; content.notes.push('部分转发快照格式无效，未读取。'); continue; }
      const data = snapshot.message;
      const item: ForwardedItem = { depth, text: typeof data.content === 'string' ? data.content : '', attachments: [],
        ...(typeof data.timestamp === 'string' ? { time: data.timestamp } : {}) };
      if (Array.isArray(data.embeds)) {
        if (data.embeds.length > 20 || data.embeds.some((embed: unknown) => record(embed) && Array.isArray(embed.fields) && embed.fields.length > 25)) { content.status = 'partial'; content.notes.push('转发嵌入内容超过解析上限。'); }
        const parts = data.embeds.filter(record).slice(0, 20).flatMap(embed => [embed.title, embed.description,
          ...(Array.isArray(embed.fields) ? embed.fields.filter(record).slice(0, 25).flatMap(field => [field.name, field.value]) : [])]).filter((part): part is string => typeof part === 'string');
        if (parts.length) item.text += (item.text ? '\n' : '') + parts.join('\n');
      }
      if (Array.isArray(data.attachments) && data.attachments.length > 100) { content.status = 'partial'; content.notes.push('转发附件超过数量上限。'); }
      if (Array.isArray(data.attachments)) item.attachments = data.attachments.filter(record).filter(file => typeof file.id === 'string' && typeof file.filename === 'string' && typeof file.url === 'string')
        .slice(0, 100).map(file => ({ id: file.id, filename: file.filename, url: file.url, size: Number(file.size) || 0, ...(typeof file.content_type === 'string' ? { content_type: file.content_type } : {}) }));
      if (data.components?.length || data.sticker_items?.length || data.stickers?.length || Array.isArray(data.embeds) && data.embeds.some((embed: unknown) => record(embed) && (embed.image || embed.video || embed.thumbnail))) {
        content.status = 'partial'; content.notes.push('转发中的交互组件、贴纸或嵌入媒体未读取。');
      }
      const nested = data.message_reference?.type === 1 || Array.isArray(data.message_snapshots);
      if (!item.text && !item.attachments.length && !nested) { content.status = 'partial'; content.notes.push('快照没有可读正文或附件，不能确认内容完整。'); }
      content.messages.push(item);
      if (nested) visit(data, depth + 1);
    }
  };
  visit(message, 0);
  return copyForwarded(content);
}
