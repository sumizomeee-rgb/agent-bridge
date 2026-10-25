import test from 'node:test';
import assert from 'node:assert/strict';
import { Faults } from './faults.mjs';
class Raw {
  messages = []; failures = []; writes = [];
  onMessage(fn) { this.messages.push(fn); }
  onFailure(fn) { this.failures.push(fn); }
  write(value) { this.writes.push(value); }
  emit(value) { this.messages.forEach(fn => fn(value)); }
}
test('fault proxy preserves real process identity and fails only the armed accepted turn', async () => {
  const history = [], faults = new Faults(e => history.push(e)), raw = new Raw();
  const originalEmit = raw.emit.bind(raw), proxy = faults.wrap(raw, 'codex'), delivered = [];
  assert.equal(proxy, raw); proxy.onMessage(e => delivered.push(e));
  const armed = faults.arm('accepted-failure');
  proxy.write({ id: 7, method: 'turn/start', params: { threadId: 'same-native' } });
  originalEmit({ id: 6, result: {} }); assert.equal(armed.hits, 0);
  originalEmit({ id: 7, result: { turn: { id: 'real-turn' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(armed.hits, 1); assert.equal(history.length, 1);
  assert.equal(delivered.at(-1).params.turn.status, 'failed');
  assert.equal(delivered.at(-1).params.threadId, 'same-native');
  originalEmit({ method: 'item/tool/call' }); assert.equal(delivered.length, 3);
});
test('initialization timeout drops the real response once; cannot overwrite unexercised fault', () => {
  const faults = new Faults(() => {}), raw = new Raw(), emit = raw.emit.bind(raw);
  const proxy = faults.wrap(raw, 'codex'), delivered = []; proxy.onMessage(e => delivered.push(e));
  const fault = faults.arm('initialize-timeout'); assert.throws(() => faults.arm('accepted-failure'));
  proxy.write({ id: 1, method: 'initialize' }); emit({ id: 1, result: {} });
  assert.equal(fault.hits, 1); assert.equal(delivered.length, 0);
  emit({ id: 2, result: {} }); assert.equal(delivered.length, 1);
});
test('Claude failure is explicitly injected after forwarding the real input', async () => {
  const faults = new Faults(() => {}), raw = new Raw(), proxy = faults.wrap(raw, 'claude'), delivered = [];
  proxy.onMessage(e => delivered.push(e)); faults.arm('accepted-failure');
  proxy.write({ type: 'user', session_id: 'same-native', parent_tool_use_id: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(raw.writes.length, 1); assert.equal(delivered[0].is_error, true);
  assert.equal(delivered[0].session_id, 'same-native');
});
