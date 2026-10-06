import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver } from './receiver.ts';
import { openStore } from './store.ts';
import { listen, note, upload } from './test-fixtures.ts';
const auth = {bearerToken: 'ingest', hmacSecret: 'hmac'};
test('signed raw bytes, concurrent Attempts, and durable deduplication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whim-')), path = join(dir, 'inbox.sqlite');
  let store = openStore(path), http = await listen(createReceiver(store, auth));
  try {
    const n = note(), attempts = Array.from({length: 12}, () => note({note_id: n.noteId}));
    attempts.forEach(a => { a.noteId = n.noteId; });
    const responses = await Promise.all([n, ...attempts].map(a => fetch(http.url + '/receive', upload(a))));
    assert.ok(responses.every(r => r.status === 200));
    assert.equal(responses[0].headers.get('X-Whim-Note-ID'), n.noteId);
    const bodies = await Promise.all(responses.map(r => r.json()));
    assert.equal(bodies.filter(b => !b.duplicate).length, 1);
    assert.equal(store.listNotes().length, 1);
    await http.close(); store.close();
    store = openStore(path); http = await listen(createReceiver(store, auth));
    assert.deepEqual(await (await fetch(http.url + '/receive', upload(n))).json(), {note_id: n.noteId, duplicate: true});
  } finally { await http.close(); store.close(); rmSync(dir, {recursive: true, force: true}); }
});
test('configuration test with zero duration is acknowledged but never queued', async () => {
  const store = openStore(':memory:'), http = await listen(createReceiver(store, auth));
  try {
    const n = note({event: 'configuration.test', duration_ms: 0});
    assert.equal((await fetch(http.url + '/receive', upload(n))).status, 200);
    assert.equal(store.listNotes().length, 0);
  } finally { await http.close(); store.close(); }
});
test('rejects authentication, hash, identity, timestamp and malformed multipart errors', async () => {
  const store = openStore(':memory:'), http = await listen(createReceiver(store, auth));
  try {
    for (const [header, value, expected] of [['Authorization', 'Bearer wrong', 401],
      ['X-Whim-Signature', 'v1=bad', 401], ['X-Whim-Audio-SHA256', '0'.repeat(64), 401]] as const) {
      const req = upload(note()); req.headers[header] = value;
      assert.equal((await fetch(http.url + '/receive', req)).status, expected);
    }
    assert.equal((await fetch(http.url + '/receive', upload(note(), '1'))).status, 401);
    assert.equal((await fetch(http.url + '/receive', upload(note({note_id: 'mismatch'})))).status, 400);
    const bad = note(); bad.audio = Buffer.from('tampered');
    assert.equal((await fetch(http.url + '/receive', upload(bad))).status, 400);
    const req = upload(note());
    assert.equal((await fetch(http.url + '/receive', {...req, body: 'not multipart'})).status, 400);
    assert.equal(store.listNotes().length, 0);
  } finally { await http.close(); store.close(); }
});
test('rejects requests beyond 32 MiB', async () => {
  const store = openStore(':memory:'), http = await listen(createReceiver(store, {}));
  try {
    const req = upload(note());
    assert.equal((await fetch(http.url + '/receive', {...req, body: Buffer.alloc(32 * 1024 * 1024 + 1)})).status, 413);
  } finally { await http.close(); store.close(); }
});
