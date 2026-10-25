import type { DatabaseSync } from 'node:sqlite';

export type ControllerSubmission = 'not-submitted' | 'unknown' | 'accepted';
export interface ControllerTurnState {
  attempt: number;
  phase: 'preparing' | 'retrying' | 'submitting' | 'accepted' | 'reply-recovery' | 'completed' | 'failed';
  submission: ControllerSubmission;
  /** Redacted execution evidence only; never prompt or raw transport data. */
  diagnostic?: string;
}

/** Written synchronously before transport submission. A crash never grants replay permission. */
export class ControllerLifecycleJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS controller_lifecycle (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, attempt INTEGER NOT NULL, phase TEXT NOT NULL,
      submission TEXT NOT NULL, diagnostic TEXT, recorded_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS controller_lifecycle_source ON controller_lifecycle(source_id,sequence);`);
  }
  record(sourceId: string, conversationId: string, state: ControllerTurnState): void {
    this.db.prepare(`INSERT INTO controller_lifecycle(source_id,conversation_id,attempt,phase,submission,diagnostic,recorded_at)
      VALUES(?,?,?,?,?,?,?)`).run(sourceId, conversationId, state.attempt, state.phase, state.submission, state.diagnostic ?? null, new Date().toISOString());
  }
  latest(sourceId: string): ControllerTurnState | null {
    const row = this.db.prepare('SELECT attempt,phase,submission,diagnostic FROM controller_lifecycle WHERE source_id=? ORDER BY sequence DESC LIMIT 1').get(sourceId);
    return row ? { attempt: Number(row.attempt), phase: row.phase as ControllerTurnState['phase'], submission: row.submission as ControllerSubmission,
      ...(typeof row.diagnostic === 'string' ? { diagnostic: row.diagnostic } : {}) } : null;
  }
}
