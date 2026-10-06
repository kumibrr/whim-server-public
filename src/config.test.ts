import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.ts';
import { validateSettings, voiceSettings } from './config.ts';
import { note, settings } from './test-fixtures.ts';
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
