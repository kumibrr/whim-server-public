import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebhookRequest, sendWebhook, DeliveryFailure } from './pipes.ts';
import { validatePlan } from './openai.ts';
import { openStore } from './store.ts';
import { listen, note, readBody, settings } from './test-fixtures.ts';
test('recipes serialize JSON, text, form, multipart and original audio to a local destination', async () => {
  const received: {type: string; body: Buffer; auth?: string}[] = [];
  const http = await listen(async (req, res) => { received.push({type: req.headers['content-type']!, body: await readBody(req), auth: req.headers.authorization}); res.writeHead(204).end(); });
  const store = openStore(':memory:');
  try {
    const s = settings(http.url); s.pipes.inbox.authHeaders.Authorization = 'hook';
    store.activate(s, 0, 'admin'); const n = note(); store.accept(n); const job = store.claim(0)!; job.transcript = 'hello';
    const action = {pipeId: 'inbox', args: {}};
    await sendWebhook(buildWebhookRequest(action, job, s, {credentials: {hook: 'Bearer destination'}}));
    assert.deepEqual(JSON.parse(received[0].body.toString()), {note_id: n.noteId, text: 'hello'});
    assert.equal(received[0].auth, 'Bearer destination');
    s.pipes.inbox.body = {format: 'text', mapping: {source: 'transcript'}};
    await sendWebhook(buildWebhookRequest(action, job, s, {credentials: {hook: 'token'}}));
    assert.equal(received[1].body.toString(), 'hello');
    s.pipes.inbox.body = {format: 'form', mapping: {text: {source: 'transcript'}, folder: {source: 'options', path: 'folder'}}};
    await sendWebhook(buildWebhookRequest(action, job, s, {credentials: {hook: 'token'}}));
    assert.equal(new URLSearchParams(received[2].body.toString()).get('folder'), 'inbox');
    s.pipes.inbox.body = {format: 'multipart', mapping: {file: {source: 'audio'}, text: {source: 'transcript'}}};
    await sendWebhook(buildWebhookRequest(action, job, s, {credentials: {hook: 'token'}}));
    const form = await new Response(Uint8Array.from(received[3].body), {headers: {'Content-Type': received[3].type}}).formData();
    assert.equal(form.get('text'), 'hello'); assert.deepEqual(Buffer.from(await (form.get('file') as File).arrayBuffer()), Buffer.from(n.audio));
    s.pipes.inbox.body = {format: 'audio', mapping: {source: 'audio'}};
    await sendWebhook(buildWebhookRequest(action, job, s, {credentials: {hook: 'token'}}));
    assert.deepEqual(received[4].body, Buffer.from(n.audio));
    assert.throws(() => buildWebhookRequest(action, job, s, {}));
    assert.throws(() => validatePlan({routing: 'matched', actions: [{pipeId: 'inbox', args: {}}, {pipeId: 'missing', args: {}}]}, s));
    assert.equal(received.length, 5);
  } finally { await http.close(); store.close(); }
});
test('explicit non-success is failed; lost responses and redirects are uncertain with no replay', async () => {
  let calls = 0;
  const http = await listen(async (req, res) => { await readBody(req); calls++; if (req.url === '/lost') req.socket.destroy(); else res.writeHead(req.url === '/redirect' ? 302 : 500, {Location: '/ok'}).end(); });
  try {
    await assert.rejects(sendWebhook({url: http.url + '/fail', init: {method: 'POST', body: 'a'}}), e => e instanceof DeliveryFailure && !e.uncertain);
    await assert.rejects(sendWebhook({url: http.url + '/lost', init: {method: 'POST', body: 'a'}}), e => e instanceof DeliveryFailure && e.uncertain);
    await assert.rejects(sendWebhook({url: http.url + '/redirect', init: {method: 'POST', body: 'a'}}), DeliveryFailure);
    assert.equal(calls, 3);
  } finally { await http.close(); }
});
