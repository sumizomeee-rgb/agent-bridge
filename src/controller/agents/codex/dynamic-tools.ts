import { controllerEntryTools } from '../../tools/entry.js';

/** Preserve the shared catalog and its schemas when registering Codex native tools. */
export function codexDynamicTools(internalBotCommunicationEnabled?: boolean) {
  return controllerEntryTools.map(tool => ({ ...tool, type: 'function' }));
}
