import { after } from 'node:test';
import { rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const directories = new Set<string>();
/** Run after every test's resource hooks, including resources added by later fixture calls. */
export function ownTemporaryDirectory(path: string, prefix: string): string {
  const absolute = resolve(path), parent = resolve(tmpdir());
  const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(dirname(absolute)) !== comparable(parent) || !basename(absolute).startsWith(prefix)) throw new Error('Unexpected test temporary directory');
  directories.add(absolute); return path;
}
after(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); });
