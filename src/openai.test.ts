import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, decide, validatePlan, ApiFailure } from './openai.ts';
import { listen, readBody, responsePlan, decisionAnswers, settings } from './test-fixtures.ts';
test('original M4A transcription then Decisions routing and strict Responses extraction without destination credentials', async () => {
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
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/audio/transcriptions' ? {text: 'Save this note'}
      : req.url === '/decisions' ? decisionAnswers() : responsePlan({routing: 'matched', actions: [{pipeId: 'inbox', args: {}}]})));
  });
  try {
    const s = settings(); s.pipes.inbox.authHeaders.Authorization = 'private-reference';
    const transcript = await transcribe(Buffer.from([0, 1, 255]), s, 'api-key', {baseUrl: http.url});
    const plan = await decide(transcript, s, 'api-key', {baseUrl: http.url});
    assert.equal(plan.actions[0].pipeId, 'inbox');
    assert.deepEqual(requests.map(r => r.url), ['/audio/transcriptions', '/decisions', '/responses']);
    assert.equal(requests[1].body.model, 'gpt-6-luna'); assert.equal(requests[1].body.input, transcript);
    assert.deepEqual(requests[1].body.questions.map((q: any) => [q.type, q.name]), [['predicate', 'inbox'], ['predicate', 'configure']]);
    assert.equal(requests[2].body.text.format.type, 'json_schema'); assert.equal(requests[2].body.text.format.strict, true);
    assert.equal(requests[2].body.store, false);
    for (const request of requests.slice(1)) {
      assert.equal(JSON.stringify(request.body).includes('private-reference'), false);
      assert.equal(JSON.stringify(request.body).includes(s.pipes.inbox.url), false);
    }
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
    const http = await listen((req, res) => res.end(JSON.stringify(req.url === '/decisions' ? decisionAnswers() : body)));
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
test('unclear routing uses the default without Responses, including ambiguous configuration intent', async () => {
  const calls: string[] = [];
  const http = await listen(async (req, res) => {
    await readBody(req); calls.push(req.url!);
    res.end(JSON.stringify(req.url === '/decisions' ? decisionAnswers({inbox: 0.3, configure: 0.79})
      : responsePlan({routing: 'matched', actions: [{pipeId: 'configure', args: {changes: [{path: 'instructions', value: 'Unsafe change'}]}}]})));
  });
  try {
    assert.deepEqual(await decide('Maybe change something', settings(), 'key', {baseUrl: http.url}), {actions: [{pipeId: 'inbox', args: {}}]});
    assert.deepEqual(calls, ['/decisions']);
  } finally { await http.close(); }
});
test('multiple selected pipes are extracted in transcript order and unselected pipes are excluded from the schema', async () => {
  const s = settings(); s.pipes.tasks = {...structuredClone(s.pipes.inbox), description: 'Create a task',
    argsSchema: {type: 'object', properties: {title: {type: 'string'}}, required: ['title'], additionalProperties: false}};
  s.pipes.unselected = structuredClone(s.pipes.inbox);
  let schemaIds: string[] = [];
  const actions = [{pipeId: 'tasks', args: {title: 'Buy milk'}}, {pipeId: 'inbox', args: {}}];
  const http = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString());
    if (req.url === '/responses') schemaIds = body.text.format.schema.properties.actions.items.anyOf.map((v: any) => v.properties.pipeId.enum[0]);
    res.end(JSON.stringify(req.url === '/decisions' ? decisionAnswers({inbox: 0.95, tasks: 0.99, unselected: 0.1, configure: 0.01})
      : responsePlan({routing: 'matched', actions})));
  });
  try {
    assert.deepEqual(await decide('Create a task to buy milk, then save the note', s, 'key', {baseUrl: http.url}), {actions});
    assert.deepEqual(schemaIds, ['inbox', 'tasks']);
  } finally { await http.close(); }
});
test('Responses cannot add, omit, or override Decisions selections', async () => {
  const invalid = [{routing: 'default', actions: []}, {routing: 'matched', actions: [{pipeId: 'other', args: {}}]},
    {routing: 'matched', actions: [{pipeId: 'inbox', args: {}}, {pipeId: 'configure', args: {changes: [{path: 'instructions', value: 'Change'}]}}]}];
  const s = settings(); s.pipes.other = structuredClone(s.pipes.inbox);
  for (const plan of invalid) {
    const http = await listen((req, res) => res.end(JSON.stringify(req.url === '/decisions'
      ? decisionAnswers({inbox: 0.99, other: 0.01, configure: 0.01}) : responsePlan(plan))));
    try { await assert.rejects(decide('note', s, 'key', {baseUrl: http.url}), e => e instanceof ApiFailure && !e.retryable); }
    finally { await http.close(); }
  }
  const http = await listen((req, res) => res.end(JSON.stringify(req.url === '/decisions'
    ? decisionAnswers({inbox: 0.99, other: 0.99, configure: 0.01}) : responsePlan({routing: 'matched', actions: [{pipeId: 'inbox', args: {}}]}))));
  try { await assert.rejects(decide('note', s, 'key', {baseUrl: http.url}), ApiFailure); }
  finally { await http.close(); }
});
test('refused, missing, reordered, duplicated, unknown and malformed Decisions fail before extraction', async () => {
  const valid = decisionAnswers();
  const invalid = [null, {}, {...valid, answers: []}, {...valid, answers: [{type: 'refusal', name: 'inbox'}, valid.answers[1]]},
    {...valid, answers: valid.answers.toReversed()}, {...valid, answers: [valid.answers[0], valid.answers[0]]},
    decisionAnswers({missing: 0.99, configure: 0.01}), decisionAnswers({inbox: 1.01, configure: 0.01}),
    decisionAnswers({inbox: -0.01, configure: 0.01}), {...valid, answers: [{type: 'choice', name: 'inbox', choice: true}, valid.answers[1]]},
    {...valid, answers: [{type: 'predicate', name: 'inbox', probability: '0.99'}, valid.answers[1]]}];
  for (const body of invalid) {
    const calls: string[] = [];
    const http = await listen(async (req, res) => { await readBody(req); calls.push(req.url!); res.end(JSON.stringify(body)); });
    try {
      await assert.rejects(decide('note', settings(), 'key', {baseUrl: http.url}), e => e instanceof ApiFailure && !e.retryable);
      assert.deepEqual(calls, ['/decisions']);
    } finally { await http.close(); }
  }
});
test('configured Decisions model and inclusive threshold control configuration extraction', async () => {
  const calls: string[] = [];
  const actions = [{pipeId: 'configure', args: {changes: [{path: 'instructions', value: 'Send to inbox'}]}}];
  const http = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString()); calls.push(req.url!);
    if (req.url === '/decisions') {
      assert.equal(body.model, 'custom-decision-model');
      res.end(JSON.stringify(decisionAnswers({inbox: 0.01, configure: 0.95})));
    } else res.end(JSON.stringify(responsePlan({routing: 'matched', actions})));
  });
  try {
    assert.deepEqual(await decide('Change routing instructions to send to inbox', {...settings(), decisionModel: 'custom-decision-model',
      decisionThreshold: 0.95}, 'key', {baseUrl: http.url}), {actions});
    assert.deepEqual(calls, ['/decisions', '/responses']);
  } finally { await http.close(); }
});
