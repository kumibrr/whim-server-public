import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from './store.ts';
import { processNext } from './process-note.ts';
import { settings, note, listen, readBody, responsePlan } from './test-fixtures.ts';
import type { Plan } from './types.ts';
const inbox: Plan = {actions: [{pipeId: 'inbox', args: {}}]};
function saved(store: ReturnType<typeof openStore>, plan = inbox) {
  const n = note(); store.accept(n); store.claim(0); store.saveTranscript(n.noteId, 'saved transcript'); store.savePlan(n.noteId, plan); return n;
}
test('full flow is sequential, durably saved, and purges content while preserving dedupe', async () => {
  const calls: string[] = [];
  const http = await listen(async (req, res) => {
    await readBody(req); calls.push(req.url!);
    if (req.url === '/hook') { res.writeHead(204).end(); return; }
    res.end(JSON.stringify(req.url === '/audio/transcriptions' ? {text: 'A note'} : responsePlan({routing: 'matched', actions: [...inbox.actions, ...inbox.actions]})));
  });
  const store = openStore(':memory:');
  try {
    store.activate(settings(http.url + '/hook'), 0, 'admin'); const n = note(); store.accept(n);
    assert.equal(await processNext(store, {openaiKey: 'key', openaiBaseUrl: http.url}, 0), true);
    assert.deepEqual(calls, ['/audio/transcriptions', '/responses', '/hook', '/hook']);
    const job = store.getNote(n.noteId); assert.equal(job.status, 'succeeded');
    for (const key of ['audio', 'metadata', 'metadataBytes', 'transcript', 'plan'] as const) assert.equal(job[key], null);
    assert.equal(store.accept(n).duplicate, true); assert.equal(store.actionOutcomes(n.noteId).length, 2);
  } finally { await http.close(); store.close(); }
});
test('restart skips completed effects and turns in-flight deliveries into uncertainty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whim-worker-')); const path = join(dir, 'notes.sqlite'); let store = openStore(path);
  let calls = 0; const http = await listen(async (req, res) => { await readBody(req); calls++; res.writeHead(204).end(); });
  try {
    store.activate(settings(http.url), 0, 'admin');
    const a = saved(store, {actions: [...inbox.actions, ...inbox.actions]});
    store.beginAction(a.noteId, 0); store.finishAction(a.noteId, 0, 'succeeded');
    store.close(); store = openStore(path); store.recoverInterrupted();
    await processNext(store, {}, 0); assert.equal(calls, 1); assert.equal(store.getNote(a.noteId).status, 'succeeded');
    const b = saved(store); store.beginAction(b.noteId, 0);
    store.close(); store = openStore(path); store.recoverInterrupted();
    assert.equal(store.actionOutcomes(b.noteId)[0].status, 'uncertain');
    assert.equal(store.getNote(b.noteId).status, 'uncertain'); assert.ok(store.getNote(b.noteId).audio);
    assert.equal(await processNext(store, {}, 0), false); assert.equal(calls, 1);
  } finally { await http.close(); store.close(); rmSync(dir, {recursive: true, force: true}); }
});
test('lost response is uncertain; explicit error is failed, neither auto-replays', async () => {
  let calls = 0;
  const http = await listen(async (req, res) => { await readBody(req); calls++; if (calls === 1) req.socket.destroy(); else res.writeHead(500).end(); });
  const store = openStore(':memory:');
  try {
    store.activate(settings(http.url), 0, 'admin'); const a = saved(store); store.recoverInterrupted();
    await processNext(store, {}, 0); assert.equal(store.getNote(a.noteId).status, 'uncertain');
    const b = saved(store); store.recoverInterrupted(); await processNext(store, {}, 0);
    assert.equal(store.getNote(b.noteId).status, 'failed'); assert.equal(await processNext(store, {}, 999_999), false); assert.equal(calls, 2);
  } finally { await http.close(); store.close(); }
});
test('bounded provider retries keep the backend pinned and let other Notes progress during waits', async () => {
  const models: string[] = [];
  const http = await listen(async (req, res) => {
    const form = await new Response(Uint8Array.from(await readBody(req)), {headers: {'Content-Type': req.headers['content-type']!}}).formData();
    models.push(String(form.get('model'))); res.writeHead(503).end();
  });
  const store = openStore(':memory:');
  try {
    const first = store.activate(settings(), 0, 'admin'); const a = note(); store.accept(a);
    const secrets = {openaiKey: 'key', openaiBaseUrl: http.url};
    await processNext(store, secrets, 0); assert.equal(store.getNote(a.noteId).nextAt, 30_000);
    store.activate({...settings(), transcriptionModel: 'new-model'}, first.id, 'admin'); const b = note(); store.accept(b);
    await processNext(store, secrets, 0); assert.equal(store.getNote(b.noteId).transcriptionAttempts, 1);
    await processNext(store, secrets, 30_000); assert.equal(store.getNote(a.noteId).nextAt, 150_000);
    await processNext(store, secrets, 150_000); assert.equal(store.getNote(a.noteId).status, 'failed');
    assert.equal(store.getNote(a.noteId).transcriptionAttempts, 3);
    assert.deepEqual(models, [settings().transcriptionModel, 'new-model', settings().transcriptionModel, settings().transcriptionModel]);
  } finally { await http.close(); store.close(); }
});
test('later Retry-After is honored and permanent provider errors retain content', async () => {
  let status = 429;
  const http = await listen(async (req, res) => { await readBody(req); res.writeHead(status, {'Retry-After': '600'}).end(); });
  const store = openStore(':memory:');
  try {
    store.activate(settings(), 0, 'admin'); const n = note(); store.accept(n); const now = Date.now();
    const secrets = {openaiKey: 'key', openaiBaseUrl: http.url};
    await processNext(store, secrets, now); assert.ok(store.getNote(n.noteId).nextAt >= now + 600_000);
    status = 401; await processNext(store, secrets, store.getNote(n.noteId).nextAt);
    assert.equal(store.getNote(n.noteId).status, 'failed'); assert.ok(store.getNote(n.noteId).audio);
  } finally { await http.close(); store.close(); }
});
test('configuration action and outcome commit together, queued work sees updates, and stale commands never mutate', async () => {
  const store = openStore(':memory:');
  try {
    const first = store.activate(settings(), 0, 'admin');
    const plan = {actions: [{pipeId: 'configure', args: {changes: [{path: 'instructions', value: 'Voice changed'}]}}]};
    const a = saved(store, plan); store.recoverInterrupted();
    await processNext(store, {}, 0);
    assert.equal(store.currentRevision().settings.instructions, 'Voice changed');
    assert.equal(store.actionOutcomes(a.noteId)[0].status, 'succeeded');
    const second = store.currentRevision(); const b = saved(store, plan); store.recoverInterrupted();
    store.activate({...settings(), instructions: 'Admin changed'}, second.id, 'admin');
    await processNext(store, {}, 0);
    assert.equal(store.getNote(b.noteId).status, 'failed'); assert.equal(store.currentRevision().settings.instructions, 'Admin changed');
    const c = note(); store.accept(c); assert.equal(store.claim(0)!.revisionId, store.currentRevision().id);
    assert.notEqual(first.id, second.id);
  } finally { store.close(); }
});
test('invalid later mapping fails the complete plan before any earlier effect', async () => {
  let calls = 0; const http = await listen((_req, res) => { calls++; res.writeHead(204).end(); });
  const store = openStore(':memory:');
  try {
    const s = settings(http.url); s.pipes.bad = {...structuredClone(s.pipes.inbox), body: {format: 'text', mapping: {source: 'note', path: 'missing'}}};
    store.activate(s, 0, 'admin'); const n = saved(store, {actions: [{pipeId: 'inbox', args: {}}, {pipeId: 'bad', args: {}}]});
    store.recoverInterrupted(); await processNext(store, {}, 0);
    assert.equal(store.getNote(n.noteId).status, 'failed'); assert.equal(calls, 0);
  } finally { await http.close(); store.close(); }
});
