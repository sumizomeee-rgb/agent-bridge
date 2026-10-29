import { harnessText } from './harness.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export const workspaceDirectories = {
  'remote-agents': 'bridge-remote-agents',
  capabilities: 'bridge-capabilities',
  'agent-presets': 'bridge-agent-presets',
  'chat-platforms': 'bridge-chat-platforms',
} as const;

/** Prefer the current layout; existing workspaces remain readable during migration. */
export function workspaceDirectory(workspace: string, role: keyof typeof workspaceDirectories): string {
  const current = join(workspace, workspaceDirectories[role]);
  const legacy = join(workspace, role);
  // A staged migration may expose the new name as a junction to the original
  // ordinary directory. Preserve private preset checks by using that real path.
  // Arbitrary links remain untouched and are rejected by the private reader.
  if (existsSync(current) && lstatSync(current).isSymbolicLink() && existsSync(legacy) && !lstatSync(legacy).isSymbolicLink()) {
    const target = realpathSync(current), expected = join(realpathSync(workspace), role);
    const same = process.platform === 'win32' ? target.toLowerCase() === expected.toLowerCase() : target === expected;
    if (same) return target;
  }
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

export function workspaceFile(workspace: string, role: keyof typeof workspaceDirectories, ...parts: string[]): string {
  return join(workspaceDirectory(workspace, role), ...parts);
}

export function workspaceOutputGuidance(workspace: string): string {
  return harnessText('workspace.output_guidance', { workspace, temporary_directory: join(workspace, 'tmp', '<任务名>') });
}
