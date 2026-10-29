import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TransactionCursor, TransactionSnapshot } from './sources.js';

export interface HousekeeperRun {
  id: string; epoch: string; phase: 'preparing' | 'worker' | 'summary' | 'uncertain';
  createdAt: string; conversationId: string; workerId?: string; jobId?: string;
  taskId?: string; eventId?: string; eventConversationId?: string;
  snapshot: TransactionSnapshot; inputPath: string; summary?: string; error?: string;
  uncertainty?: 'worker' | 'controller'; retryAt?: string;
}
export interface HousekeeperState {
  version: 1; enabled: boolean; epoch: string; intervalMinutes: number;
  userId: string; channelId: string; authorizationMessageId: string;
  enabledAt: string; nextAt: string; cursor?: TransactionCursor;
  run?: HousekeeperRun; lastRunAt?: string; lastSuccessAt?: string;
  lastCoverage?: string; lastError?: string; failures: number; notifiedError?: string;
}

/** One Bot's switch and acknowledged cursor survive controller replacement. */
export class HousekeeperStore {
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'housekeeper.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL)');
  }
  read(): HousekeeperState | null {
    const row = this.db.prepare('SELECT value_json FROM state WHERE id=1').get();
    return row ? JSON.parse(String(row.value_json)) as HousekeeperState : null;
  }
  save(value: HousekeeperState): void {
    this.db.prepare('INSERT INTO state(id,value_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(JSON.stringify(value));
  }
  close(): void { this.db.close(); }
}
