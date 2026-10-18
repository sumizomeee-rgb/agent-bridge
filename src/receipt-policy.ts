import { parseCommand } from './commands.js';
import type { BridgeConfig, BridgeMessage } from './types.js';

/** Text and area come from the durable source message, so restart needs no receipt cache. */
export type ReceiptMessage = Pick<BridgeMessage, 'id' | 'channelId'> & { text?: string; isGroup?: boolean };

/** Missing text preserves legacy callers; ordinary controller DMs need no message reactions. */
export function shouldShowMessageReceipts(config: Pick<BridgeConfig, 'controllerMode'>,
  message: { text?: string; isGroup?: boolean; space?: unknown }): boolean {
  return config.controllerMode !== true || message.isGroup === true || !!message.space
    || typeof message.text !== 'string' || parseCommand(message.text) !== null;
}
