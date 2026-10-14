/** Platform IDs are opaque; only the platform's declared ordering component is compared. */
export function validMessageId(value: unknown): value is string {
  return typeof value === 'string' && (/^\d{1,20}$/.test(value)
    || /^discord:\d{15,22}\|\d{1,20}$/.test(value)
    || /^feishu:cli_[a-zA-Z0-9]+\|\d{10,16}\|om_[a-zA-Z0-9_-]+$/.test(value));
}
export function validChannelId(value: unknown): value is string {
  return typeof value === 'string' && (/^\d{1,20}$/.test(value)
    || /^discord:\d{15,22}\|\d{1,20}$/.test(value)
    || /^feishu:cli_[a-zA-Z0-9]+\|oc_[a-zA-Z0-9_-]+$/.test(value));
}
export function compareMessageIds(left: string, right: string): number {
  if (!validMessageId(left) || !validMessageId(right)) throw new Error('收件排序标识无效。');
  const ordinal = (id: string) => BigInt(id.startsWith('feishu:') ? id.split('|')[1]! : id.split('|').at(-1)!);
  const a = ordinal(left), b = ordinal(right);
  return a < b ? -1 : a > b ? 1 : left.localeCompare(right, 'en');
}
export function laterMessageId(left: string, right: string): string { return compareMessageIds(left, right) >= 0 ? left : right; }
export function scopeId(scope: string, id: string): string { return scope + id; }
export function externalId(scope: string, id: string): string {
  if (scope && !id.startsWith(scope)) throw new Error('回复地址不属于当前运行的 bot；结果保留在原入口。');
  if (!scope && id.includes('|')) throw new Error('回复地址不属于当前运行的 bot；结果保留在原入口。');
  return scope ? id.slice(scope.length) : id;
}
