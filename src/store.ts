import type { IncomingNote } from './types.ts';
import { DatabaseSync } from 'node:sqlite';
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path, {timeout: 5000});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS notes (
        note_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, accepted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued', revision_id INTEGER,
        metadata BLOB, audio BLOB, transcript TEXT, plan TEXT, next_at INTEGER NOT NULL DEFAULT 0,
        transcription_attempts INTEGER NOT NULL DEFAULT 0, decision_attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT
      ) STRICT;`);
  }
  accept(note: IncomingNote): {duplicate: boolean} {
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO notes (note_id, attempt_id, accepted_at, updated_at, metadata, audio)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(note_id) DO NOTHING`).run(
        note.noteId, note.attemptId, now, now, note.metadataBytes, note.audio);
    return {duplicate: result.changes === 0};
  }
  listNotes() { return this.db.prepare('SELECT note_id, status, accepted_at, revision_id FROM notes ORDER BY accepted_at, rowid').all(); }
  close(): void { this.db.close(); }
}
export function openStore(path: string): Store { return new Store(path); }
