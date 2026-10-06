import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, decide, validatePlan, ApiFailure } from './openai.ts';
import { listen, readBody, responsePlan, settings } from './test-fixtures.ts';
test('original M4A transcription then one strict Responses request without destination credentials', async () => {
  const requests: {url: string; body: any}[] = [];
  const http = await listen(async (req, res) => {
    const bytes = await readBody(req);
    let body: any;
    if (req.url === '/audio/transcriptions') {
      const form = await new Response(Uint8Array.from(bytes), {headers: {'Content-Type': req.headers['content-type']!}}).formData();
      const file = form.get('file') as File;
      assert.equal(file.type, 'audio/mp4'); assert.equal(file.name, 'note.m4a');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from([0, 1, 255]));
      assert.equal(form.get('model'), settings().transcriptionModel);
      body = 'multipart';
    } else body = JSON.parse(bytes.toString());
    assert.equal(req.headers.authorization, 'Bearer api-key'); requests.push({url: req.url!, body});
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/audio/transcriptions' ? {text: 'Save this note'} : responsePlan({routing: 'matched', actions: [{pipeId: 'inbox', args: {}}]})));
  });
  try {
    const s = settings(); s.pipes.inbox.authHeaders.Authorization = 'private-reference';
    const transcript = await transcribe(Buffer.from([0, 1, 255]), s, 'api-key', {baseUrl: http.url});
    const plan = await decide(transcript, s, 'api-key', {baseUrl: http.url});
    assert.equal(plan.actions[0].pipeId, 'inbox');
    assert.deepEqual(requests.map(r => r.url), ['/audio/transcriptions', '/responses']);
    assert.equal(requests[1].body.text.format.type, 'json_schema'); assert.equal(requests[1].body.text.format.strict, true);
    assert.equal(requests[1].body.store, false);
    assert.equal(JSON.stringify(requests[1].body).includes('private-reference'), false);
    assert.equal(JSON.stringify(requests[1].body).includes(s.pipes.inbox.url), false);
  } finally { await http.close(); }
});
test('default routing and typed arguments are validated as a complete plan', () => {
  const s = settings(); s.pipes.tasks = {...structuredClone(s.pipes.inbox), argsSchema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title'], additionalProperties: false}};
  assert.equal(validatePlan({routing: 'default', actions: []}, s).actions[0].pipeId, s.defaultPipeId);
  assert.equal(validatePlan({routing: 'matched', actions: [{pipeId: 'tasks', args: {title: 'Task'}}, {pipeId: 'inbox', args: {}}]}, s).actions.length, 2);
  for (const actions of [[{pipeId: 'tasks', args: {}}], [{pipeId: 'missing', args: {}}],
    [{pipeId: 'configure', args: {changes: [{path: 'pipes.inbox.url', value: 'http://other'}]}}]]) {
    assert.throws(() => validatePlan({routing: 'matched', actions}, s));
  }
  assert.equal(validatePlan({routing: 'matched', actions: [{pipeId: 'configure', args: {changes: [{path: 'instructions', value: 'New instructions'}]}}]}, s).actions.length, 1);
});
test('refusal and incomplete or malformed Responses fail without accepting actions', async () => {
  for (const body of [{status: 'incomplete', output: []}, {status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: 'No'}]}]},
    responsePlan({routing: 'matched', actions: [{pipeId: 'inbox', args: {unexpected: 'value'}}]})]) {
    const http = await listen((_req, res) => res.end(JSON.stringify(body)));
    try { await assert.rejects(decide('note', settings(), 'key', {baseUrl: http.url}), ApiFailure); }
    finally { await http.close(); }
  }
});
test('provider failures expose retry metadata, permanent errors, and the file cap without hidden retries', async () => {
  let count = 0, status = 429;
  const http = await listen(async (req, res) => { await readBody(req); count++; res.writeHead(status, {'Retry-After': '600'}).end('secret vendor diagnostic'); });
  try {
    const before = Date.now();
    await assert.rejects(transcribe(Buffer.from('a'), settings(), 'key', {baseUrl: http.url}), e => e instanceof ApiFailure && e.retryable && e.retryAfter! >= before + 600_000 && !e.message.includes('secret'));
    assert.equal(count, 1); status = 401;
    await assert.rejects(decide('note', settings(), 'key', {baseUrl: http.url}), e => e instanceof ApiFailure && !e.retryable);
    await assert.rejects(transcribe(Buffer.alloc(25_000_001), settings(), 'key', {baseUrl: http.url}), e => e instanceof ApiFailure && !e.retryable);
    assert.equal(count, 2);
  } finally { await http.close(); }
});
test('interrupted successful response bodies retry; complete malformed JSON is permanent', async () => {
  let malformed = false;
  const http = await listen(async (req, res) => {
    await readBody(req); res.writeHead(200, {'Content-Type': 'application/json'}); res.write('{"text":');
    if (malformed) res.end(); else setTimeout(() => res.destroy(), 10);
  });
  try {
    await assert.rejects(transcribe(Buffer.from('a'), settings(), 'key', {baseUrl: http.url}), e => e instanceof ApiFailure && e.retryable);
    malformed = true;
    await assert.rejects(transcribe(Buffer.from('a'), settings(), 'key', {baseUrl: http.url}), e => e instanceof ApiFailure && !e.retryable);
  } finally { await http.close(); }
});
