import assert from 'node:assert/strict';
import test from 'node:test';
import { compactControllerReceipt } from '../src/controller/tool-receipt.js';
test('worker receipt preserves outcome and errors while omitting execution configuration; details untouched', () => {
 const value = { workerId: 'w', status: 'uncertain', stopped: false, reason: 'not confirmed', target: { id: 'remote', label: '电脑', transport: 'ssh', sshConfig: 'ssh-path', agentCommand: { command: 'node', args: ['large'] } } };
 const result = compactControllerReceipt('bridge_cancel_worker', value) as typeof value;
 assert.equal(result.reason, value.reason); assert.equal(result.stopped, false); assert.equal(result.status, 'uncertain');
 assert.deepEqual(result.target, { id: 'remote', label: '电脑', transport: 'ssh' });
 assert.ok(value.target.sshConfig); assert.equal(compactControllerReceipt('bridge_list_workers', value), value);
});
