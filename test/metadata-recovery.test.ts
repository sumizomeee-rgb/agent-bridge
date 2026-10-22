import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { MetadataProbeError } from '../src/agents/metadata.js';
import { AgentProcessStopError, type AgentStopEvidence, type JsonObject } from '../src/agents/process.js';
import { NativeControllerAdapter } from '../src/controller/native.js';

class Probe {
  messages = new Set<(m: JsonObject) => void>(); failures = new Set<(e: Error) => void>();
  held = false; buffered: JsonObject[] = [];
  release() { this.held = false; for (const message of this.buffered.splice(0)) this.emit(message); }
  written: JsonObject[] = []; stopped = false; lateExit = false; stopFails = false; fail: Error | null = null;
  onMessage(fn: (m: JsonObject) => void) { this.messages.add(fn); return () => { this.messages.delete(fn); }; }
  onFailure(fn: (e: Error) => void) { this.failures.add(fn); return () => { this.failures.delete(fn); }; }
  emit(m: JsonObject) { if (this.held) { this.buffered.push(m); return; } queueMicrotask(() => this.messages.forEach(fn => fn(m))); }
  write(m: JsonObject) {
    this.written.push(m);
    if (this.fail) { queueMicrotask(() => this.failures.forEach(fn => fn(this.fail!))); return; }
    if (m.type === 'control_request') this.emit({ type: 'control_response', response: { request_id: 'bridge-models', subtype: 'success', response: { model: 'fixture', models: [] } } });
    else if (m.method === 'initialize') this.emit({ id: m.id, result: {} });
    else if (m.method === 'config/read') this.emit({ id: m.id, result: { config: { model: 'fixture' } } });
    else if (m.method === 'model/list') this.emit({ id: m.id, result: { data: [] } });
  }
  endInput() {}
  confirmStopped() { return this.stopped; }
  get stopEvidence(): AgentStopEvidence { return { pid: 19, graceful: false, exitObserved: this.lateExit, closeObserved: this.lateExit,
    exitCode: this.lateExit ? 0 : null, signalCode: null, taskkillAttempted: false, taskkillExitCode: null, durationMs: 1, phaseMs: {}, completion: this.stopped ? 'tree-stop' : 'unconfirmed' }; }
  async stop() { if (this.stopFails) throw new AgentProcessStopError(19, undefined, undefined, this.stopEvidence); this.stopped = true; }
}
for (const backend of ['codex', 'claude'] as const) {
  test(`${backend} independent concurrent metadata probes never retire another in-flight probe`, async () => {
    const probes: Probe[] = [], make = () => { const p = new Probe(); p.held = true; probes.push(p); return p; };
    const command = { command: 'never-spawn', args: [] };
    const adapter = backend === 'codex' ? new CodexAdapter(command, {}, make) : new ClaudeAdapter(command, {}, undefined, make);
    try {
      const first = adapter.getModelInfo('.'), second = adapter.getModelInfo('.');
      assert.equal(probes.length, 2); assert(probes.every(p => !p.stopped));
      probes.forEach(p => p.release()); const values = await Promise.all([first, second]);
      assert(values.every(v => v.defaultModel === 'fixture'));
    } finally { probes.forEach(p => p.release()); await adapter.close(); }
  });
  test(`${backend} metadata keeps the initial failure and removes listeners even when retirement fails; late exit permits a fresh read-only probe`, async () => {
    const probes: Probe[] = [], primary = new Error('initial metadata timeout Bearer fixture-private-value');
    const make = () => { const p = new Probe(); if (!probes.length) { p.fail = primary; p.stopFails = true; } probes.push(p); return p; };
    const command = { command: 'never-spawn', args: [] };
    const adapter = backend === 'codex' ? new CodexAdapter(command, {}, make) : new ClaudeAdapter(command, {}, undefined, make);
    try {
      await assert.rejects(adapter.getModelInfo('.'), error => {
        assert(error instanceof MetadataProbeError); assert.equal(error.cause, primary); assert.equal(error.processStopped, false);
        assert.equal(error.processStillRunning, true); assert.match(error.cleanupError!, /退出待核对/); assert.equal(error.stopEvidence?.exitObserved, false); return true;
      });
      assert.equal(probes[0]!.messages.size, 0); assert.equal(probes[0]!.failures.size, 0);
      await assert.rejects(adapter.getModelInfo('.'), MetadataProbeError); assert.equal(probes.length, 1);
      probes[0]!.lateExit = true;
      const info = await adapter.getModelInfo('.'); assert.equal(info.defaultModel, 'fixture'); assert.equal(probes.length, 2);
      assert(probes.flatMap(p => p.written).every(m => m.type !== 'user' && !['turn/start', 'thread/start', 'thread/resume'].includes(String(m.method))));
    } finally { probes[0]!.lateExit = true; await adapter.close(); }
  });
  test(`${backend} failed metadata with confirmed retirement is explicitly safe to retry, while successful generation is never involved`, async () => {
    const primary = new Error('initialization timeout'), p = new Probe(); p.fail = primary;
    const command = { command: 'never-spawn', args: [] };
    const adapter = backend === 'codex' ? new CodexAdapter(command, {}, () => p) : new ClaudeAdapter(command, {}, undefined, () => p);
    try { await assert.rejects(adapter.getModelInfo('.'), e => e instanceof MetadataProbeError && e.cause === primary && e.processStopped); }
    finally { await adapter.close(); }
  });
}
for (const scenario of ['recover', 'twice', 'unknown', 'ordinary'] as const) test(`controller metadata retry policy: ${scenario}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-preflight-')); let attempts = 0, launches = 0;
  const adapter = new NativeControllerAdapter({ command: 'never-spawn', args: [] }, {}, { agent: 'codex', dataDir: dir, invokeTool: async () => { throw new Error('no management'); },
    metadataAdapter: { run: async () => { throw new Error('metadata only'); }, interrupt: async () => {}, close: async () => {}, getModelInfo: async () => {
      attempts++; if (scenario === 'recover' && attempts === 2) return { models: [], defaultModel: 'fixture' };
      const primary = new Error('metadata wait timed out Bearer fixture-private-value');
      throw scenario === 'ordinary' ? primary : new MetadataProbeError(primary, scenario !== 'unknown');
    } }, createTransport: () => { launches++; throw new Error('must never submit'); } });
  try {
    if (scenario === 'recover') assert.equal((await adapter.getModelInfo(dir)).defaultModel, 'fixture');
    else await assert.rejects(adapter.getModelInfo(dir));
    assert.equal(attempts, ['recover', 'twice'].includes(scenario) ? 2 : 1); assert.equal(launches, 0);
    const text = readFileSync(join(dir, 'controller-preflight-diagnostic.jsonl'), 'utf8'); assert(!text.includes('fixture-private-value'));
    const records = text.trim().split('\n').map(l => JSON.parse(l)); assert.match(records[0].evidence, /timed out/);
    assert.equal(records[0].retry, ['recover', 'twice'].includes(scenario));
  } finally { await adapter.close(); rmSync(dir, { recursive: true, force: true }); }
});
