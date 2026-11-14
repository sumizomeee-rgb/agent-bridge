import { harnessText } from './harness.js';
import { join } from 'node:path';

export const workspaceDirectories = {
  'remote-agents': 'bridge-computers',
  capabilities: 'bridge-capabilities',
  'agent-presets': 'bridge-agent-presets',
  'chat-platforms': 'bridge-registry/channels',
} as const;

/** Only the current workspace layout is readable; migration is an offline operation. */
export function workspaceDirectory(workspace: string, role: keyof typeof workspaceDirectories): string {
  return join(workspace, workspaceDirectories[role]);
}

export function workspaceFile(workspace: string, role: keyof typeof workspaceDirectories, ...parts: string[]): string {
  return join(workspaceDirectory(workspace, role), ...parts);
}

export function workspaceOutputGuidance(workspace: string): string {
  return harnessText('workspace.output_guidance', { workspace, temporary_directory: join(workspace, 'tmp', '<任务名>') });
}
