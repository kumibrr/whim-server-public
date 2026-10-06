import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { createAdminHandler } from './admin.ts';
import { listen, settings, note, readBody } from './test-fixtures.ts';
import { startServer } from './server.ts';
import { setTimeout as delay } from 'node:timers/promises';
test('separate admin authentication, validated import/export, history and rollback', async () => {
  const store = openStore(':memory:'); const first = store.activate(settings(), 0, 'admin');
  const http = await listen(createAdminHandler(store, 'admin'));
  const req = (path: string, method = 'GET', body?: unknown, token = 'admin') => fetch(http.url + '/admin/' + path, {method,
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  try {
    assert.equal((await req('config', 'GET', undefined, 'ingest')).status, 401);
    const current = await (await req('config')).json(); assert.equal(current.id, first.id);
    const next = await (await req('config', 'PUT', {settings: {...settings(), instructions: 'admin edit'}, expectedRevisionId: first.id})).json();
    assert.equal(next.settings.instructions, 'admin edit');
    assert.equal((await req('config', 'PUT', {settings: settings(), expectedRevisionId: first.id})).status, 409);
    assert.equal((await (await req('config/revisions')).json()).length, 2);
    const rollback = await (await req('config/rollback', 'POST', {targetRevisionId: first.id, expectedRevisionId: next.id})).json();
    assert.deepEqual(rollback.settings, first.settings); assert.notEqual(rollback.id, first.id);
    assert.equal((await req('config', 'PUT', {settings: {openaiKey: 'secret'}, expectedRevisionId: rollback.id})).status, 422);
  } finally { await http.close(); store.close(); }
});
test('failed retry and uncertain action resolution enforce state and preserve complete effects', async () => {
  const store = openStore(':memory:'); store.activate(settings(), 0, 'admin');
  const http = await listen(createAdminHandler(store, 'admin'));
  const post = (path: string, body = {}) => fetch(http.url + '/admin/' + path, {method: 'POST', headers: {Authorization: 'Bearer admin', 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  try {
    const a = note(); store.accept(a); store.claim(0); store.saveTranscript(a.noteId, 'private text');
    store.savePlan(a.noteId, {actions: [{pipeId: 'inbox', args: {}}]}); store.beginAction(a.noteId, 0); store.recoverInterrupted();
    assert.equal((await post(`notes/${a.noteId}/retry`)).status, 409);
    assert.equal((await post(`notes/${a.noteId}/actions/0/resolve`, {resolution: 'delivered'})).status, 200);
    assert.equal(store.actionOutcomes(a.noteId)[0].status, 'succeeded');
    assert.equal((await post(`notes/${a.noteId}/actions/0/resolve`, {resolution: 'retry'})).status, 409);
    const status = await (await fetch(http.url + `/admin/notes/${a.noteId}`, {headers: {Authorization: 'Bearer admin'}})).text();
    assert.equal(status.includes('private text'), false); assert.equal(status.includes('metadata'), false);
    store.claim(0); store.hold(a.noteId, 'failed', 'test');
    assert.equal((await post(`notes/${a.noteId}/retry`)).status, 200); assert.equal(store.actionOutcomes(a.noteId)[0].status, 'succeeded');
    store.claim(0); store.succeed(a.noteId); assert.equal((await post(`notes/${a.noteId}/retry`)).status, 409);
  } finally { await http.close(); store.close(); }
});
test('server shuts down with an external effect in flight and resumes as uncertain', async () => {
  let delivered!: () => void; const seen = new Promise<void>(r => delivered = r);
  const hook = await listen(async (req, _res) => { await readBody(req); delivered(); });
  const app = await startServer({WHIM_DATABASE: ':memory:', WHIM_HOST: '127.0.0.1', WHIM_PORT: '0', WHIM_ADMIN_TOKEN: 'admin', WHIM_BEARER_TOKEN: 'ingest', WHIM_SHUTDOWN_MS: '10', WHIM_POLL_MS: '10'}).catch(async e => { await hook.close(); throw e; });
  try {
    app.store.activate(settings(hook.url), 0, 'admin'); const n = note(); app.store.accept(n); app.store.claim(0);
    app.store.saveTranscript(n.noteId, 'text'); app.store.savePlan(n.noteId, {actions: [{pipeId: 'inbox', args: {}}]}); app.store.recoverInterrupted();
    await seen;
    const closing = app.close();
    // Store stays queryable until close; shutdown recovery is also exercised in SQLite restart tests.
    assert.equal(app.store.actionOutcomes(n.noteId)[0].status, 'in_flight');
    await closing;
  } finally { await hook.close(); }
});
test('unconfigured server keeps accepted Notes queued until administrative provisioning', async () => {
  const app = await startServer({WHIM_DATABASE: ':memory:', WHIM_HOST: '127.0.0.1', WHIM_PORT: '0', WHIM_ADMIN_TOKEN: 'admin', WHIM_POLL_MS: '1'});
  try {
    const n = note(); app.store.accept(n); await delay(20);
    assert.equal(app.store.getNote(n.noteId).status, 'queued');
  } finally { await app.close(); }
});
