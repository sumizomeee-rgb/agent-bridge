/** Limits belong to the sending platform, not shared file preparation. */
export const FILE_LIMITS = {
  discord: { defaultBytes: 20 * 1024 * 1024, maxBytes: 24 * 1024 * 1024 },
  feishu: { defaultBytes: 30 * 1000 * 1000, maxBytes: 30 * 1000 * 1000 },
} as const;

export function configuredFileLimit(platform: keyof typeof FILE_LIMITS, value?: unknown): number {
  const policy = FILE_LIMITS[platform];
  const limit = value ?? policy.defaultBytes;
  if (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > policy.maxBytes) {
    throw new Error(`maxFileBytes (${platform}) 必须是 1–${policy.maxBytes} 的整数。`);
  }
  return limit as number;
}
