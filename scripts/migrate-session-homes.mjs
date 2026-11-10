import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { migrateSessionHomes } from '../dist/src/agents/session-home-migration.js';

const args = process.argv.slice(2), apply = args.includes('--offline-apply');
const roots = args.filter(arg => arg !== '--offline-apply');
if (!roots.length || roots.some(arg => arg.startsWith('--'))) throw new Error('Usage: node scripts/migrate-session-homes.mjs [--offline-apply] <data-root> ...');
for (const root of roots) {
  const homes = migrateSessionHomes(resolve(root), homedir(), apply);
  console.log(JSON.stringify({ root: resolve(root), apply, homes: homes.length,
    migrated: homes.filter(home => home.migrated).length,
    diagnosticBytesRemoved: homes.reduce((sum, home) => sum + home.diagnosticBytesRemoved, 0) }));
}
