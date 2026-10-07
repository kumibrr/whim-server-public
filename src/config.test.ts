import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { validateSettings, voiceSettings } from './config.ts';
import { note, settings } from './test-fixtures.ts';
import { execFileSync } from 'node:child_process';
test('validated revisions pin at claim, activate atomically, and rollback appends', () => {
  const store = openStore(':memory:');
  try {
    const original = store.activate(settings(), 0, 'admin');
    store.accept(note());
    const active = store.activate({...settings(), instructions: 'New routing'}, original.id, 'admin');
    assert.equal(store.claim(0)!.revisionId, active.id);
    assert.throws(() => store.activate(settings(), original.id, 'voice'));
    const rolled = store.rollback(original.id, active.id);
    assert.deepEqual(rolled.settings, original.settings);
    assert.notEqual(rolled.id, original.id);
    assert.equal(store.currentRevision().id, rolled.id);
  } finally { store.close(); }
});
test('invalid settings and unsupported argument schemas preserve active revision', () => {
  const store = openStore(':memory:');
  try {
    const first = store.activate(settings(), 0, 'admin');
    for (const edit of [(s: any) => s.defaultPipeId = 'missing', (s: any) => s.openaiKey = 'secret',
      (s: any) => s.pipes.inbox.argsSchema.patternProperties = {}, (s: any) => s.pipes.inbox.headers.Authorization = 'secret',
      (s: any) => s.pipes.inbox.argsSchema = {type: 'object', properties: {required: {type: 'string'}}, required: ['required']}]) {
      const value = settings(); edit(value);
      assert.throws(() => store.activate(value, first.id, 'admin'));
      assert.equal(store.currentRevision().id, first.id);
    }
    assert.deepEqual(validateSettings(settings()), settings());
  } finally { store.close(); }
});
test('voice allowlist permits live options but forbids destinations, credentials, and permission expansion', () => {
  const base = settings();
  const updated = voiceSettings(base, [{path: 'instructions', value: 'New instruction'},
    {path: 'pipes.inbox.options.folder', value: 'work'}]);
  assert.equal(updated.pipes.inbox.options.folder, 'work');
  assert.equal(base.pipes.inbox.options.folder, 'inbox');
  for (const path of ['pipes.inbox.url', 'pipes.inbox.authHeaders.Authorization', 'pipes.inbox.mutableOptions', 'pipes.new']) {
    assert.throws(() => voiceSettings(base, [{path, value: 'changed'}]));
  }
  const store = openStore(':memory:');
  try {
    const first = store.activate(base, 0, 'admin');
    assert.throws(() => store.activate({...base, pipes: {}}, first.id, 'voice'));
    const malicious = structuredClone(base); malicious.pipes.inbox.url = 'http://new.test';
    assert.throws(() => store.activate(malicious, first.id, 'voice'));
    assert.equal(store.activate(updated, first.id, 'voice').settings.instructions, 'New instruction');
  } finally { store.close(); }
});
test('repeated Note validation and changing configurations retain bounded memory', () => {
  const output = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import {validatePlan} from './src/openai.ts';
    import {validateSettings} from './src/config.ts';
    import {settings} from './src/test-fixtures.ts';
    for(let i=0;i<10;i++) validatePlan({routing:'default',actions:[]},settings());
    global.gc(); const before=process.memoryUsage().heapUsed;
    for(let i=0;i<500;i++) {
      const cfg=settings(); cfg.pipes['pipe'+i]=cfg.pipes.inbox;
      validatePlan({routing:'default',actions:[]},validateSettings(cfg));
    }
    global.gc(); console.log(process.memoryUsage().heapUsed-before);
  `], {encoding: 'utf8'});
  assert.ok(Number(output.trim()) < 12 * 1024 * 1024, `retained heap growth: ${output.trim()}`);
});
test('aggregate Responses enum, nesting, property and string limits reject configuration activation', () => {
  const store = openStore(':memory:');
  try {
    const first = store.activate(settings(), 0, 'admin');
    const invalid = [];
    const enums = settings(); enums.pipes.extra = {...structuredClone(enums.pipes.inbox), argsSchema: {type: 'object', properties: {
      x: {type: 'string', enum: Array.from({length: 1001}, (_, i) => String(i))}}}}; invalid.push(enums);
    const combined = settings();
    for (const id of ['one', 'two']) combined.pipes[id] = {...structuredClone(combined.pipes.inbox), argsSchema: {type: 'object', properties: {
      x: {type: 'string', enum: Array.from({length: 501}, (_, i) => String(i))}}}};
    invalid.push(combined);
    const deep = settings(); let schema: any = {type: 'string'};
    for (let i = 0; i < 8; i++) schema = {type: 'object', properties: {nested: schema}};
    deep.pipes.extra = {...structuredClone(deep.pipes.inbox), argsSchema: schema}; invalid.push(deep);
    const wide = settings(); wide.pipes.extra = {...structuredClone(wide.pipes.inbox), argsSchema: {type: 'object', properties:
      Object.fromEntries(Array.from({length: 5000}, (_, i) => ['field' + i, {type: 'string'}]))}}; invalid.push(wide);
    const long = settings(); long.pipes.extra = {...structuredClone(long.pipes.inbox), argsSchema: {type: 'object', properties: {
      x: {type: 'string', enum: Array.from({length: 251}, (_, i) => 'x'.repeat(60) + i)}}}}; invalid.push(long);
    const total = settings(); total.pipes.extra = {...structuredClone(total.pipes.inbox), argsSchema: {type: 'object', properties: {
      x: {type: 'string', enum: ['x'.repeat(120_001)]}}}}; invalid.push(total);
    for (const value of invalid) {
      assert.throws(() => store.activate(value, first.id, 'admin'));
      assert.equal(store.currentRevision().id, first.id);
    }
    assert.deepEqual(validateSettings(settings()), settings());
  } finally { store.close(); }
});
test('GET trigger recipes reject content-bearing mappings before data can be silently discarded', () => {
  const s = settings(); s.pipes.inbox.method = 'GET';
  assert.throws(() => validateSettings(s));
  s.pipes.inbox.body.mapping = {}; assert.equal(validateSettings(s).pipes.inbox.method, 'GET');
  s.pipes.inbox.body.mapping = {source: 'transcript'}; assert.throws(() => validateSettings(s));
});
test('Decisions settings validate and existing configurations remain usable', () => {
  const base = settings();
  assert.deepEqual(validateSettings(base), base);
  assert.equal(validateSettings({...base, decisionModel: 'gpt-6-luna', decisionThreshold: 0.9}).decisionThreshold, 0.9);
  for (const patch of [{decisionModel: ''}, {decisionModel: null}, {decisionThreshold: 0}, {decisionThreshold: 1.1},
    {decisionThreshold: '0.8'}, {decisionThreshold: NaN}]) {
    assert.throws(() => validateSettings({...base, ...patch}));
  }
  const next = voiceSettings(base, [{path: 'decisionModel', value: 'gpt-6-luna'}, {path: 'decisionThreshold', value: 0.95}]);
  const store = openStore(':memory:');
  try {
    const first = store.activate(base, 0, 'admin');
    assert.equal(store.activate(next, first.id, 'voice').settings.decisionThreshold, 0.95);
    assert.deepEqual(store.rollback(first.id, store.currentRevision().id).settings, base);
  } finally { store.close(); }
});
