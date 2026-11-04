import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function login(bytes: Buffer): { account: string; expires: number } | null {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value.auth_mode !== 'chatgpt' || value.OPENAI_API_KEY || typeof value.tokens?.account_id !== 'string'
      || !value.tokens.account_id || typeof value.tokens.access_token !== 'string') return null;
    const payload = JSON.parse(Buffer.from(value.tokens.access_token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? { account: value.tokens.account_id, expires: payload.exp * 1000 } : null;
  } catch { return null; }
}

/** Reuse a CLI-renewed login only within this bot's exact source-credential lineage. */
export function refreshControllerCodexLogin(source: string, destination: string): void {
  if (!existsSync(source) || !existsSync(destination)) return;
  const sourceBytes = readFileSync(source), identity = login(sourceBytes);
  if (!identity) return; // API-key profiles and explicit user channel changes stay authoritative.
  const hash = createHash('sha256').update(sourceBytes).digest('hex');
  const home = dirname(destination), root = dirname(home);
  const original = readFileSync(destination);
  let selected = original, current = login(selected);
  if (!current || current.account !== identity.account) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name)) continue;
    const sibling = join(root, entry.name), auth = join(sibling, 'auth.json'), marker = auth + '.source-hash';
    try {
      const authStat = lstatSync(auth), markerStat = lstatSync(marker);
      if (!authStat.isFile() || authStat.size > 1024 * 1024 || !markerStat.isFile() || markerStat.size !== 64
        || readFileSync(marker, 'utf8') !== hash) continue;
      const bytes = readFileSync(auth), candidate = login(bytes);
      if (candidate?.account === identity.account && candidate.expires > Date.now() && candidate.expires > current.expires) {
        selected = bytes; current = candidate;
      }
    } catch { /* A retired session may be reclaimed concurrently; skip it. */ }
  }
  if (selected.equals(original) || !original.equals(readFileSync(destination)) || !sourceBytes.equals(readFileSync(source))) return;
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temporary, selected, { flag: 'wx', mode: 0o600 }); renameSync(temporary, destination); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
