import type { IncomingNote, Settings, Revision, Job, Plan, ActionOutcome } from './types.ts';
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
      CREATE TABLE IF NOT EXISTS active_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision_id INTEGER NOT NULL REFERENCES revisions(id)) STRICT;
      CREATE TABLE IF NOT EXISTS actions (note_id TEXT NOT NULL REFERENCES notes(note_id), action_index INTEGER NOT NULL,
        pipe_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', revision_id INTEGER, error TEXT,
        updated_at INTEGER NOT NULL, PRIMARY KEY(note_id,action_index)) STRICT;`);
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
  saveTranscript(noteId: string, transcript: string): void {
    this.db.prepare('UPDATE notes SET transcript=?, updated_at=? WHERE note_id=?').run(transcript, Date.now(), noteId);
  }
  savePlan(noteId: string, plan: Plan): void {
    this.transaction(() => {
      if (this.getNote(noteId).plan) throw new Error('Plan already saved');
      this.db.prepare('UPDATE notes SET plan=?, updated_at=? WHERE note_id=?').run(JSON.stringify(plan), Date.now(), noteId);
      const insert = this.db.prepare('INSERT INTO actions (note_id,action_index,pipe_id,updated_at) VALUES (?,?,?,?)');
      plan.actions.forEach((a, index) => insert.run(noteId, index, a.pipeId, Date.now()));
    });
  }
  actionOutcomes(noteId: string): ActionOutcome[] {
    return this.db.prepare('SELECT * FROM actions WHERE note_id=? ORDER BY action_index').all(noteId).map(r => ({index: Number(r.action_index),
      pipeId: String(r.pipe_id), status: r.status as ActionOutcome['status'], revisionId: r.revision_id === null ? null : Number(r.revision_id), error: r.error as string | null}));
  }
  beginAction(noteId: string, index: number): void {
    const result = this.db.prepare("UPDATE actions SET status='in_flight',updated_at=? WHERE note_id=? AND action_index=? AND status='pending'").run(Date.now(), noteId, index);
    if (result.changes !== 1) throw new Error('Action not pending');
  }
  finishAction(noteId: string, index: number, status: 'succeeded' | 'failed' | 'uncertain', error: string | null = null): void {
    this.db.prepare('UPDATE actions SET status=?,error=?,updated_at=? WHERE note_id=? AND action_index=?').run(status, error, Date.now(), noteId, index);
  }
  configureAction(noteId: string, index: number, settings: Settings, expectedRevisionId: number): Revision {
    return this.transaction(() => {
      const outcome = this.actionOutcomes(noteId)[index];
      if (outcome?.status !== 'pending') throw new Error('Configuration action not pending');
      const revision = this.activateInTransaction(settings, expectedRevisionId, 'voice');
      this.db.prepare("UPDATE actions SET status='succeeded',revision_id=?,updated_at=? WHERE note_id=? AND action_index=?").run(revision.id, Date.now(), noteId, index);
      return revision;
    });
  }
  recordAttempt(noteId: string, stage: 'transcription' | 'decision'): number {
    const column = stage === 'transcription' ? 'transcription_attempts' : 'decision_attempts';
    this.db.prepare(`UPDATE notes SET ${column}=${column}+1,updated_at=? WHERE note_id=?`).run(Date.now(), noteId);
    const job = this.getNote(noteId); return stage === 'transcription' ? job.transcriptionAttempts : job.decisionAttempts;
  }
  hold(noteId: string, status: 'retrying' | 'failed' | 'uncertain', error: string, nextAt = 0): void {
    this.db.prepare('UPDATE notes SET status=?,error=?,next_at=?,updated_at=? WHERE note_id=?').run(status, error, nextAt, Date.now(), noteId);
  }
  succeed(noteId: string): void {
    this.transaction(() => {
      if (this.actionOutcomes(noteId).some(a => a.status !== 'succeeded')) throw new Error('Incomplete actions');
      this.db.prepare("UPDATE notes SET status='succeeded',metadata=NULL,audio=NULL,transcript=NULL,plan=NULL,error=NULL,next_at=0,updated_at=? WHERE note_id=?").run(Date.now(), noteId);
    });
  }
  recoverInterrupted(): void {
    this.transaction(() => {
      this.db.exec(`UPDATE notes SET status='uncertain',error='Interrupted webhook delivery' WHERE note_id IN (SELECT note_id FROM actions WHERE status='in_flight');
        UPDATE actions SET status='uncertain',error='Interrupted webhook delivery' WHERE status='in_flight';
        UPDATE notes SET status='queued' WHERE status='running';`);
    });
  }
  close(): void { this.db.close(); }
}
export function openStore(path: string): Store { return new Store(path); }
