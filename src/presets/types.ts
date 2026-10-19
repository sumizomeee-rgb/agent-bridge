import type { AgentName } from '../types.js';

export interface PresetBinding {
  id: string; profileId: string; revision: number; fingerprint: string;
  targetId: string; agent: AgentName; model: string;
}
export interface DispatchPreset {
  id: string; aliases: string[]; targetId: string; agent: AgentName; model: string;
  profileId: string; revision: number; enabled: boolean; reason?: string;
}
export interface PresetFilter { targetId?: string; agent?: AgentName; query?: string }
export type PresetTransport = { kind: 'direct' } | { kind: 'ssh-connect'; sshConfig: string; alias: string; sshCommand?: string };
export interface LaunchProfile {
  id: string; revision: number; agent: AgentName; model: string; baseUrl: string;
  credentialId: string; transport: PresetTransport;
}
