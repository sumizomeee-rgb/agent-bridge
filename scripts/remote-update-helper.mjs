import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const [mode, rootValue, expected, release] = process.argv.slice(2), root = resolve(rootValue);
if (hostname().toLowerCase() !== expected.toLowerCase()) throw Error('Wrong executor hostname');
const data = join(root, '.local/remote');
export function rpc(root, method, args = {}) {
  const endpoint = JSON.parse(readFileSync(join(root, '.local/remote/endpoint.json'), 'utf8').replace(/^\uFEFF/, ''));
  return new Promise((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port: endpoint.port, path: '/rpc', method: 'POST',
      headers: { Authorization: 'Bearer ' + endpoint.token, 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', s => { body += s; if (body.length > 1024 * 1024) res.destroy(); });
      res.on('end', () => { try { const value = JSON.parse(body); if (value.error) throw Error('Executor rejected maintenance'); done(value.result); } catch (e) { fail(e); } });
    });
    req.setTimeout(5000, () => req.destroy(Error('Executor maintenance timed out'))); req.on('error', fail); req.end(JSON.stringify({ method, args }));
  });
}
export function legacyIdle(directory) {
  const path = join(directory, 'controller.sqlite');
  if (!existsSync(path)) return false; // Missing journal is not proof of an idle legacy daemon.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const jobs = db.prepare('SELECT data FROM jobs').all().map(r => JSON.parse(r.data));
    return !jobs.some(j => j.status === 'running' || j.stopped !== true)
      && Number(db.prepare('SELECT count(*) n FROM processes WHERE closed=0').get().n) === 0;
  } finally { db.close(); }
}
if (mode === 'verify') {
  const folder = resolve(data, 'releases', release), manifest = JSON.parse(readFileSync(join(folder, 'release.json'), 'utf8'));
  if (manifest.id !== release || !/^[a-f0-9]{64}$/.test(release)) throw Error('Release manifest mismatch');
  for (const [name, digest] of Object.entries(manifest.files)) {
    const path = resolve(folder, name), rel = relative(folder, path);
    if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel) || realpathSync(path) !== path) throw Error('Unsafe release file');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== digest) throw Error('Release file checksum mismatch');
  }
  console.log(JSON.stringify({ verified: true }));
} else if (mode === 'inspect' || mode === 'hello') {
  let hello = null; try { hello = await rpc(root, 'hello'); } catch {}
  console.log(JSON.stringify({ release: hello?.deployment?.release ?? null, maintenance: hello?.deployment?.maintenance === 1,
    online: !!hello, idle: legacyIdle(data) }));
} else if (mode === 'prepare' || mode === 'stop' || mode === 'cancel') {
  console.log(JSON.stringify(await rpc(root, 'maintenance/' + mode, { lease: release })));
} else throw Error('Unknown executor maintenance operation');
