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
  return `\n[桥共享工作区产物规则；不扩大任务授权]\n共享工作区：${workspace}。临时脚本、日志、截图、调查材料和待发送附件统一放 ${join(workspace, 'tmp', '<任务名>')}；不在工作区根新建 artifacts、deliveries、archive 或 .local，不为单次任务新增职能目录。正式工程源码仍回所属项目，工程自己的运行环境按其约定维护。保留在用及未交付材料；清理不按目录名或文件年龄直接判垃圾。\n\n`;
}
