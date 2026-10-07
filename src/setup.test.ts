import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.ts';
test('setup page is public but templates and saves require the admin credential', async () => {
  const app = await startServer({WHIM_DATABASE: ':memory:', WHIM_HOST: '127.0.0.1', WHIM_PORT: '0', WHIM_ADMIN_TOKEN: 'private-admin'});
  try {
    const page = await fetch(app.url + '/setup'); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await page.text()).includes('private-admin'), false);
    const script = await fetch(app.url + '/setup.js'); assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type')!, /javascript/);
    assert.equal((await fetch(app.url + '/admin/config/template')).status, 401);
    const template = await fetch(app.url + '/admin/config/template', {headers: {Authorization: 'Bearer private-admin'}});
    assert.equal(template.status, 200);
    const data = await template.json();
    assert.equal(data.settings.defaultPipeId, 'inbox');
    assert.deepEqual(data.bodyFormats.audio, {source: 'audio'});
    assert.equal(app.store.history().length, 0);
    const activate = await fetch(app.url + '/admin/config', {method: 'PUT', headers: {'Content-Type': 'application/json', Authorization: 'Bearer private-admin'},
      body: JSON.stringify({settings: data.settings, expectedRevisionId: 0})});
    assert.equal(activate.status, 200);
  } finally { await app.close(); }
});
