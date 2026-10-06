import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from './store.ts';
import { createAdminHandler } from './admin.ts';
import { runCli } from './cli.ts';
import { listen, settings } from './test-fixtures.ts';
test('CLI imports, exports, lists revisions, and rolls back through the admin API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whim-cli-')), file = join(dir, 'config.json');
  const store = openStore(':memory:'); const first = store.activate(settings(), 0, 'admin'); const http = await listen(createAdminHandler(store, 'admin'));
  const env = {WHIM_SERVER_URL: http.url, WHIM_ADMIN_TOKEN: 'admin', OPENAI_API_KEY: 'must-not-export'};
  try {
    writeFileSync(file, JSON.stringify({...settings(), instructions: 'from file'}));
    assert.equal(await runCli(['config', 'import', file], env), 0);
    assert.equal(await runCli(['config', 'export', file], env), 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).instructions, 'from file');
    assert.equal(readFileSync(file, 'utf8').includes(env.OPENAI_API_KEY), false);
    assert.equal(await runCli(['config', 'history'], env), 0);
    assert.equal(await runCli(['config', 'rollback', String(first.id)], env), 0);
    assert.deepEqual(store.currentRevision().settings, first.settings);
    assert.equal(await runCli(['notes', 'list'], env), 0);
    assert.equal(await runCli(['config', 'show'], {...env, WHIM_ADMIN_TOKEN: 'wrong'}), 1);
    assert.equal(await runCli(['unknown'], env), 1);
  } finally { await http.close(); store.close(); rmSync(dir, {recursive: true, force: true}); }
});
