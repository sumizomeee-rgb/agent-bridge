// Lab-only protocol boundary faults. The underlying CLI is real; injected events
// are explicitly recorded and must never be described as provider failures.
export class Faults {
  constructor(record) { this.record = record; this.pending = null; }
  arm(kind, count = 1) {
    if (this.pending?.remaining) throw new Error('Previous lab fault was not exercised');
    this.pending = { kind, remaining: count, hits: 0 };
    return this.pending;
  }
  hit(kind) {
    if (this.pending?.kind !== kind || !this.pending.remaining) return false;
    this.pending.remaining--; this.pending.hits++;
    this.record({ kind, at: new Date().toISOString(), source: 'lab-injection' });
    return true;
  }
  wrap(raw, agent) {
    const write = raw.write.bind(raw);
    const messages = new Set(), failures = new Set();
    let muted = false, initialization, turnRequest, thread;
    const emit = message => { for (const callback of messages) callback(message); };
    raw.onMessage(message => {
      if (muted) return;
      if (message.id === initialization && initialization !== undefined) {
        if (this.hit('initialize-timeout')) { initialization = undefined; return; }
      }
      if (agent === 'codex' && turnRequest !== undefined && message.id === turnRequest && message.result?.turn?.id) {
        emit(message);
        if (this.hit('accepted-failure')) {
          muted = true;
          queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: thread,
            turn: { id: message.result.turn.id, status: 'failed', error: { message: 'LAB injected capacity failure' } } } }));
        } else if (this.hit('transport-lost')) {
          muted = true; queueMicrotask(() => { for (const callback of failures) callback(new Error('LAB injected transport disconnect')); });
        }
        return;
      }
      emit(message);
    });
    raw.onFailure(error => { for (const callback of failures) callback(error); });
    return Object.assign(raw, {
      onMessage: callback => { messages.add(callback); return () => messages.delete(callback); },
      onFailure: callback => { failures.add(callback); return () => failures.delete(callback); },
      write: message => {
        if (message.method === 'initialize') initialization = message.id;
        if (message.method === 'turn/start') { turnRequest = message.id; thread = message.params.threadId; }
        write(message);
        if (agent === 'claude' && message.type === 'user' && message.parent_tool_use_id == null) {
          if (this.hit('accepted-failure')) {
            muted = true;
            queueMicrotask(() => emit({ type: 'result', subtype: 'error_during_execution', is_error: true,
              session_id: message.session_id, result: 'LAB injected capacity failure' }));
          } else if (this.hit('transport-lost')) {
            muted = true; queueMicrotask(() => { for (const callback of failures) callback(new Error('LAB injected transport disconnect')); });
          }
        }
      },
    });
  }
}
