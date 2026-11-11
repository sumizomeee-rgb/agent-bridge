import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { migrateSessionHomes } from '../dist/src/agents/session-home-migration.js';
import { migrateNativeSessionHomes } from '../dist/src/agents/native-session-migration.js';
const args=process.argv.slice(2), apply=args.includes('--offline-apply');
const roots=args.filter(v=>v!=='--offline-apply');
if(!roots.length||roots.some(v=>v.startsWith('--')))throw new Error('Usage: node scripts/migrate-native-sessions.mjs [--offline-apply] <data-root> ...');
for(const root of roots){
 if(apply)migrateSessionHomes(resolve(root),homedir(),true);
 const report=await migrateNativeSessionHomes(resolve(root),homedir(),apply);
 console.log(JSON.stringify({root,apply,homes:report.length,threads:report.reduce((n,h)=>n+h.threads,0),files:report.reduce((n,h)=>n+h.files,0)}));
}
