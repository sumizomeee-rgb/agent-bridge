import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshControllerCodexLogin } from '../src/controller/codex-credentials.js';

function auth(account: string, expires: number): string {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: account,
    access_token: 'test.' + Buffer.from(JSON.stringify({ exp: expires })).toString('base64url') + '.test', refresh_token: 'test-' + expires } });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-controller-credentials-'));
  const source = join(root, 'source.json'), homes = join(root, 'homes'); mkdirSync(homes);
  const expired = auth('same-account', Math.floor(Date.now() / 1000) - 3600);
  const fresh = auth('same-account', Math.floor(Date.now() / 1000) + 86400);
  writeFileSync(source, expired);
  const home = (name: string, content: string, seed = expired) => {
    const directory = join(homes, name); mkdirSync(directory);
    const path = join(directory, 'auth.json'); writeFileSync(path, content);
    writeFileSync(path + '.source-hash', createHash('sha256').update(seed).digest('hex')); return path;
  };
  return { source, home, expired, fresh, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('new controller inherits renewed same-account login after an expired source was copied', () => {
  const f = fixture();
  try {
    f.home('old-session', f.fresh); const next = f.home('new-session', f.expired);
    refreshControllerCodexLogin(f.source, next);
    assert.equal(readFileSync(next, 'utf8'), f.fresh);
    assert.equal(readFileSync(f.source, 'utf8'), f.expired);
    assert.equal(readFileSync(next + '.source-hash', 'utf8'), createHash('sha256').update(f.expired).digest('hex'));
  } finally { f.cleanup(); }
});

test('different accounts, changed source lineage, expired and malformed logins are excluded', () => {
  const f = fixture();
  try {
    f.home('other-account', auth('other-account', Math.floor(Date.now() / 1000) + 172800));
    f.home('previous-login', f.fresh, f.expired + ' ');
    f.home('expired', auth('same-account', Math.floor(Date.now() / 1000) - 1));
    f.home('broken', '{invalid'); const next = f.home('new-session', f.expired);
    refreshControllerCodexLogin(f.source, next); assert.equal(readFileSync(next, 'utf8'), f.expired);
  } finally { f.cleanup(); }
});

test('newest valid rotation wins and an already fresher destination is preserved', () => {
  const f = fixture();
  try {
    f.home('old-session', f.fresh); const newest = auth('same-account', Math.floor(Date.now() / 1000) + 172800);
    const next = f.home('new-session', newest);
    refreshControllerCodexLogin(f.source, next); assert.equal(readFileSync(next, 'utf8'), newest);
  } finally { f.cleanup(); }
});

test('API-key channel and removed source cannot resurrect a ChatGPT login', () => {
  const f = fixture();
  try {
    f.home('old-session', f.fresh); const key = '{"OPENAI_API_KEY":"test-only-placeholder"}';
    writeFileSync(f.source, key); const next = f.home('new-session', key, key);
    refreshControllerCodexLogin(f.source, next); assert.equal(readFileSync(next, 'utf8'), key);
    rmSync(f.source); refreshControllerCodexLogin(f.source, next); assert.equal(readFileSync(next, 'utf8'), key);
  } finally { f.cleanup(); }
});
