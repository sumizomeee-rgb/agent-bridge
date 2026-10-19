import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { startTunnelProcess } from '../src/remote/tunnel-process.js';

test('SSH transport process has NUL stdio and shutdown confirms its owned process exited', async () => {
  const tunnel = startTunnelProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, tmpdir());
  await new Promise<void>((resolve, reject) => { tunnel.child.once('spawn', resolve); tunnel.child.once('error', reject); });
  assert.equal(tunnel.child.stdin, null); assert.equal(tunnel.child.stdout, null); assert.equal(tunnel.child.stderr, null);
  const pid = tunnel.child.pid!; process.kill(pid, 0); await tunnel.stop();
  assert.throws(() => process.kill(pid, 0)); await tunnel.stop();
});
test('SSH transport startup errors notify both current and later listeners without exposing command contents', async () => {
  const tunnel = startTunnelProcess({ command: 'bridge-nonexistent-tunnel-command', args: [] }, tmpdir());
  const error = await new Promise<Error>(resolve => tunnel.onFailure(resolve));
  assert.match(error.message, /SSH\/SFTP/);
  const repeated = await new Promise<Error>(resolve => tunnel.onFailure(resolve)); assert.equal(error, repeated);
  await tunnel.stop();
});
