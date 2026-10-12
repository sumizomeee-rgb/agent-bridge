import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeAdapter } from '../src/agents/claude.js';
import type { JsonObject } from '../src/agents/process.js';
import type { AgentSupplement, AgentTurn } from '../src/types.js';

class Transport {
  messages = new Set<(message: JsonObject) => void>();
  failures = new Set<(error: Error) => void>();
  writes: JsonObject[] = [];
  ended = false;
  stops = 0;
  mode = 'ack';
  version = '2.1.76';
  onMessage(listener: (message: JsonObject) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onFailure(listener: (error: Error) => void) { this.failures.add(listener); return () => { this.failures.delete(listener); }; }
  emit(value: JsonObject) { for (const listener of this.messages) listener(value); }
  write(value: JsonObject) {
    this.writes.push(value);
    if (value.type === 'control_request') {
      const request = value.request as JsonObject;
      if (request.subtype === 'cancel_async_message' && this.mode !== 'cancel-hang') this.emit({ type: 'control_response',
        response: { subtype: 'success', request_id: value.request_id, response: { cancelled: this.mode !== 'consumed' } } });
    } else if (value.type === 'user' && !value.uuid) {
      this.emit({ type: 'system', subtype: 'init', session_id: 'claude-session', claude_code_version: this.version });
    } else if (value.type === 'user' && this.mode === 'ack') this.ack(value);
  }
  ack(value: JsonObject, session = 'claude-session') { this.emit({ ...value, isReplay: true, session_id: session }); }
  complete() { this.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session', result: 'done' }); }
  endInput() { this.ended = true; }
  async stop() { this.stops++; }
}
async function fixture(version = '2.1.76') {
  const transport = new Transport(); transport.version = version;
  let args: string[] = [];
  const adapter = new ClaudeAdapter({ command: 'unused', args: [] }, {}, (_command, value) => { args = value; return transport; });
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const controller = new AbortController();
  const turn: AgentTurn = { conversation: { id: 'bridge-claude', userId: 'u', agent: 'claude', nativeId: null,
    title: '', cwd: process.cwd(), createdAt: '', updatedAt: '' }, text: 'initial', imagePaths: [],
    acceptSupplements: true, signal: controller.signal, onReady: ready, onProgress: () => {} };
  const run = adapter.run(turn); void run.catch(() => {});
  await readiness;
  const supplement: AgentSupplement = { id: 'a1234567-1234-4567-8901-123456789012', input: [{ type: 'text', text: 'adjust current work' }] };
  return { transport, adapter, controller, run, supplement, args, turn };
}

test('Claude keeps stdin open and confirms current consumption by exact native UUID echo without interrupt/resume', async () => {
  const f = await fixture();
  try {
    assert(f.args.includes('--replay-user-messages')); assert.equal(f.transport.ended, false);
    assert.deepEqual(await f.adapter.steer('bridge-claude', f.supplement), { status: 'accepted' });
    const inputs = f.transport.writes.filter(value => value.type === 'user');
    assert.equal(inputs.length, 2); assert.equal(inputs[1]!.priority, 'next');
    assert.equal(inputs[1]!.uuid, f.supplement.id); assert.equal(inputs[1]!.session_id, 'claude-session');
    assert.equal(f.transport.stops, 0); assert(!f.transport.writes.some(value => value.type === 'control_request'));
    f.transport.complete(); await f.run;
  } finally { await f.adapter.close(); }
});

test('unknown/older Claude protocol explicitly rejects busy input without writing it', async () => {
  const f = await fixture('2.1.75');
  try {
    const result = await f.adapter.steer('bridge-claude', f.supplement);
    assert.equal(result.status, 'queued'); assert('unsupported' in result && result.unsupported);
    assert.equal(f.transport.writes.filter(value => value.type === 'user').length, 1);
    f.transport.complete(); await f.run;
  } finally { await f.adapter.close(); }
});

test('Claude completion retracts unconsumed supplement and never claims it reached the current turn', async () => {
  const f = await fixture(); f.transport.mode = 'wait';
  try {
    const receipt = f.adapter.steer('bridge-claude', f.supplement);
    f.transport.complete(); assert.equal((await receipt).status, 'queued'); await f.run;
    assert.equal(f.transport.writes.filter(value => value.type === 'control_request').length, 1);
  } finally { await f.adapter.close(); }
});

test('Claude waits for native reception point through long tool work without a wall-clock cutoff', async t => {
  const f = await fixture(); f.transport.mode = 'wait';
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const receipt = f.adapter.steer('bridge-claude', f.supplement); t.mock.timers.tick(600_000);
    assert.equal(f.transport.stops, 0); assert(!f.transport.writes.some(value => value.type === 'control_request'));
    f.transport.ack(f.transport.writes.at(-1)!); assert.equal((await receipt).status, 'accepted');
    t.mock.timers.reset(); f.transport.complete(); await f.run;
  } finally { await f.adapter.close(); }
});

test('Claude late or foreign echo remains uncertain; cancellation does not send further input', async () => {
  const f = await fixture(); f.transport.mode = 'wait';
  try {
    const receipt = f.adapter.steer('bridge-claude', f.supplement);
    const input = f.transport.writes.at(-1)!; f.transport.ack(input, 'other-session');
    assert.equal((await receipt).status, 'uncertain');
    f.controller.abort(); await assert.rejects(f.run, { name: 'AbortError' });
    const count = f.transport.writes.length;
    assert.equal((await f.adapter.steer('bridge-claude', f.supplement)).status, 'queued'); assert.equal(f.transport.writes.length, count);
  } finally { await f.adapter.close(); }
});

test('Claude explicit stop settles an unconfirmed in-flight input as uncertain without reissuing it', async () => {
  const f = await fixture(); f.transport.mode = 'wait';
  try {
    const receipt = f.adapter.steer('bridge-claude', f.supplement);
    f.controller.abort(); await assert.rejects(f.run, { name: 'AbortError' });
    assert.equal((await receipt).status, 'uncertain');
    assert.equal(f.transport.writes.filter(value => value.type === 'user').length, 2);
  } finally { await f.adapter.close(); }
});

test('Claude completion with possibly consumed input stays uncertain and cannot be resent' , async () => {
  const f = await fixture(); f.transport.mode = 'consumed';
  try {
    const receipt = f.adapter.steer('bridge-claude', f.supplement); f.transport.complete();
    assert.equal((await receipt).status, 'uncertain'); await f.run;
  } finally { await f.adapter.close(); }
});


test('Claude observes actual tool_use/tool_result lifecycle, excluding partial arguments and nested subagent streams', async () => {
  const f = await fixture(); const activities: unknown[] = []; f.turn.onActivity = activity => activities.push(activity);
  try {
    f.transport.emit({ type: 'stream_event', event: { type: 'message_start' } });
    f.transport.emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE' } } });
    f.transport.emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool', name: 'Bash' } } });
    f.transport.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'SECRET' } } });
    const assistant = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'PRIVATE' } }] } };
    f.transport.emit(assistant); f.transport.emit(assistant);
    f.transport.emit({ ...assistant, parent_tool_use_id: 'nested', message: { content: [{ type: 'tool_use', id: 'nested-tool', name: 'Bash' }] } });
    f.transport.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'PRIVATE OUTPUT', is_error: true }] } });
    f.transport.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'PRIVATE OUTPUT' }] } });
    f.transport.complete(); await f.run;
    assert.deepEqual(activities.map(value => (value as { type: string }).type), ['reasoning', 'tool-started', 'tool-completed']);
    assert.equal((activities[2] as { status: string }).status, 'failed');
    assert.equal(JSON.stringify(activities).includes('PRIVATE'), false); assert.equal(JSON.stringify(activities).includes('SECRET'), false);
  } finally { await f.adapter.close(); }
});
