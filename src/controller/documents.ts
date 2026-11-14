import { harnessText } from '../harness.js';
import { controllerToolIndexText } from './tools/entry.js';
import { workspaceDocuments, type WorkspaceDocumentOptions } from './workspace-documents.js';

/** Native ports use workspace instructions; external clients own their behavioral instructions. */
export function controllerDocuments(workspace?: string, options: WorkspaceDocumentOptions = {}) {
  if (options.agent !== 'external') return { kind: 'workspace' as const, ...workspaceDocuments(workspace, options) };
  return {
    kind: 'client-protocol' as const,
    text: harnessText('controller.external_protocol') + '\n\n' + controllerToolIndexText(options.internalBotCommunicationEnabled),
    files: [] as string[], errors: [] as string[],
  };
}
