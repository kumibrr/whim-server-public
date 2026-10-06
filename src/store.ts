import type { IncomingNote, Settings, Revision, Job } from './types.ts';
import { DatabaseSync } from 'node:sqlite';
import { validateSettings, assertVoiceChange } from './config.ts';
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
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY, settings TEXT NOT NULL, created_at INTEGER NOT NULL, source TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS active_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision_id INTEGER NOT NULL REFERENCES revisions(id)) STRICT;`);
  }
  accept(note: IncomingNote): {duplicate: boolean} {
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO notes (note_id, attempt_id, accepted_at, updated_at, metadata, audio)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(note_id) DO NOTHING`).run(
        note.noteId, note.attemptId, now, now, note.metadataBytes, note.audio);
    return {duplicate: result.changes === 0};
  }
  listNotes() { return this.db.prepare('SELECT note_id, status, accepted_at, revision_id FROM notes ORDER BY accepted_at, rowid').all(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  revision(id: number): Revision {
    const row = this.db.prepare('SELECT * FROM revisions WHERE id=?').get(id);
    if (!row) throw new Error('Unknown revision');
    return {id: Number(row.id), settings: JSON.parse(String(row.settings)), createdAt: Number(row.created_at), source: String(row.source)};
  }
  currentRevision(): Revision {
    const row = this.db.prepare('SELECT revision_id FROM active_config WHERE singleton=1').get();
    if (!row) throw new Error('Configuration required');
    return this.revision(Number(row.revision_id));
  }
  activate(settings: Settings, expectedRevisionId: number, source: 'admin' | 'voice' | 'rollback'): Revision {
    return this.transaction(() => this.activateInTransaction(settings, expectedRevisionId, source));
  }
  activateInTransaction(settings: Settings, expectedRevisionId: number, source: 'admin' | 'voice' | 'rollback'): Revision {
    const validated = validateSettings(settings);
    const row = this.db.prepare('SELECT revision_id FROM active_config WHERE singleton=1').get();
    const current = row ? Number(row.revision_id) : 0;
    if (current !== expectedRevisionId) throw new Error('Stale revision');
    if (source === 'voice') assertVoiceChange(this.revision(current).settings, validated);
    const result = this.db.prepare('INSERT INTO revisions (settings,created_at,source) VALUES (?,?,?)').run(JSON.stringify(validated), Date.now(), source);
    const id = Number(result.lastInsertRowid);
    this.db.prepare('INSERT INTO active_config VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET revision_id=excluded.revision_id').run(id);
    return this.revision(id);
  }
  rollback(targetRevisionId: number, expectedRevisionId: number): Revision {
    return this.activate(this.revision(targetRevisionId).settings, expectedRevisionId, 'rollback');
  }
  claim(now: number): Job | null {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM notes WHERE status='running'").get()) return null;
      const row = this.db.prepare("SELECT note_id FROM notes WHERE status IN ('queued','retrying') AND next_at<=? ORDER BY accepted_at,rowid LIMIT 1").get(now);
      if (!row) return null;
      this.db.prepare("UPDATE notes SET status='running', revision_id=COALESCE(revision_id,?), updated_at=? WHERE note_id=?").run(this.currentRevision().id, now, row.note_id!);
      return this.getNote(String(row.note_id));
    });
  }
  getNote(noteId: string): Job {
    const row = this.db.prepare('SELECT * FROM notes WHERE note_id=?').get(noteId);
    if (!row) throw new Error('Unknown Note');
    const metadataBytes = row.metadata as Uint8Array | null;
    return {noteId: String(row.note_id), attemptId: String(row.attempt_id), acceptedAt: Number(row.accepted_at), updatedAt: Number(row.updated_at),
      status: row.status as Job['status'], revisionId: row.revision_id === null ? null : Number(row.revision_id), metadataBytes,
      metadata: metadataBytes ? JSON.parse(Buffer.from(metadataBytes).toString('utf8')) : null, audio: row.audio as Uint8Array | null,
      transcript: row.transcript as string | null, plan: row.plan ? JSON.parse(String(row.plan)) : null, nextAt: Number(row.next_at),
      transcriptionAttempts: Number(row.transcription_attempts), decisionAttempts: Number(row.decision_attempts), error: row.error as string | null};
  }
  close(): void { this.db.close(); }
}
export function openStore(path: string): Store { return new Store(path); }
