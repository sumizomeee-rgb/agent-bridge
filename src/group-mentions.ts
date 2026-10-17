import { createHash } from 'node:crypto';
import type { IncomingDM } from './types.js';

/** A message observed under one app's credentials; open IDs belong only to that view. */
export interface GroupMentionView {
  messageId: string; spaceId: string; createTime: string; senderId: string; payloadHash: string;
  mentions: Array<{ key: string; id: string }>;
}
export function groupMessagePayloadHash(message: Pick<IncomingDM, 'text' | 'attachments'>): string {
  // Resource keys and account IDs may differ between app views. Compare the normalized
  // message and attachment descriptors, while message/space/time/author are checked separately.
  return createHash('sha256').update(JSON.stringify([message.text, message.attachments.map(a =>
    [a.filename, a.content_type ?? null, a.size])])).digest('hex');
}
export class GroupMentionResolutionError extends Error {
  constructor() { super('本条明确提及的身份或原消息无法可靠核对，未派给任何 Bot；请稍后重试或核对群成员授权。'); }
}
