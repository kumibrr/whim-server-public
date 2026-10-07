import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from './store.ts';
import { createAdminHandler } from './admin.ts';
import { runCli } from './cli.ts';
import { spawn } from 'node:child_process';
import { listen, settings } from './test-fixtures.ts';
async function terminalSetup(env: NodeJS.ProcessEnv, answers: string[]) {
  const child = spawn(process.execPath, ['src/cli.ts', 'config', 'setup'], {env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  child.stdin.on('error', () => {}); child.stdin.end(answers.join('\n') + '\n');
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return {code, output};
}
test('interactive terminal setup reviews and activates one recipe, refusing to overwrite it', async () => {
  const store = openStore(':memory:'); const http = await listen(createAdminHandler(store, 'admin'));
  const env = {WHIM_SERVER_URL: http.url, WHIM_ADMIN_TOKEN: 'admin'};
  try {
    const result = await terminalSetup(env, ['https://example.com/inbox', 'POST', 'text', 'destinationAuth', '', '', 'Send all notes to inbox.', 'yes']);
    assert.equal(result.code, 0, result.output);
    const saved = store.currentRevision().settings;
    assert.equal(saved.pipes.inbox.url, 'https://example.com/inbox');
    assert.deepEqual(saved.pipes.inbox.body, {format: 'text', mapping: {source: 'transcript'}});
    assert.deepEqual(saved.pipes.inbox.authHeaders, {Authorization: 'destinationAuth'});
    assert.equal(saved.instructions, 'Send all notes to inbox.');
    assert.equal((await terminalSetup(env, [])).code, 1);
    assert.equal(store.history().length, 1);
  } finally { await http.close(); store.close(); }
});
test('terminal setup cancellation and invalid destinations leave the server unconfigured', async () => {
  const store = openStore(':memory:'); const http = await listen(createAdminHandler(store, 'admin'));
  const env = {WHIM_SERVER_URL: http.url, WHIM_ADMIN_TOKEN: 'admin'};
  try {
    assert.equal((await terminalSetup(env, ['https://example.com/inbox', '', '', '', '', '', '', 'no'])).code, 0);
    assert.equal((await terminalSetup(env, ['file:///tmp/hook', '', '', '', '', '', '', 'yes'])).code, 1);
    assert.equal(store.history().length, 0);
  } finally { await http.close(); store.close(); }
});
test('CLI import provisions an empty server and preserves explicit revision conflicts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whim-cli-')), file = join(dir, 'config.json');
  const store = openStore(':memory:'); const http = await listen(createAdminHandler(store, 'admin'));
  const env = {WHIM_SERVER_URL: http.url, WHIM_ADMIN_TOKEN: 'admin'};
  try {
    writeFileSync(file, JSON.stringify(settings()));
    assert.equal(await runCli(['config', 'import', file], env), 0);
    assert.equal(store.currentRevision().settings.defaultPipeId, 'inbox');
    assert.equal(await runCli(['config', 'import', file, '0'], env), 1);
    assert.equal(store.history().length, 1);
  } finally { await http.close(); store.close(); rmSync(dir, {recursive: true, force: true}); }
});
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
