import { controllerToolsForCommunication } from '../../tools/catalog.js';

/** Preserve the shared catalog and its schemas when registering Codex native tools. */
export function codexDynamicTools(internalBotCommunicationEnabled?: boolean) {
  return controllerToolsForCommunication(internalBotCommunicationEnabled).map(tool => ({ ...tool, type: 'function' }));
}
