import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { listen, settings, note, upload, readBody, decisionAnswers } from '../src/test-fixtures.ts';
const run = promisify(execFile), dir = mkdtempSync(join(tmpdir(), 'whim-image-'));
const suffix = `${process.pid}-${Date.now()}`, name = `whim-smoke-${suffix}`, volume = `whim-smoke-${suffix}`;
const calls: string[] = [];
const mock = await listen(async (req, res) => {
  await readBody(req); calls.push(req.url!);
  if (req.url === '/hook') { res.writeHead(204).end(); return; }
  res.end(JSON.stringify(req.url === '/audio/transcriptions' ? {text: 'Container recording'} : decisionAnswers({inbox: 0.1, configure: 0.01})));
});
const reserved = await listen((_req, res) => res.end()); const url = reserved.url;
const port = new URL(url).port; await reserved.close();
writeFileSync(join(dir, 'bootstrap.json'), JSON.stringify(settings(mock.url + '/hook')));
const docker = (...args: string[]) => run('docker', args, {maxBuffer: 1024 * 1024});
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await delay(100); }
  throw new Error('Container did not reach expected state');
}
try {
  await docker('volume', 'create', volume);
  await docker('run', '-d', '--name', name, '--network', 'host', '--mount', `source=${volume},target=/data`,
    '--mount', `type=bind,source=${join(dir, 'bootstrap.json')},target=/bootstrap.json,readonly`,
    '-e', 'WHIM_BOOTSTRAP_FILE=/bootstrap.json', '-e', `WHIM_PORT=${port}`, '-e', 'WHIM_HOST=127.0.0.1',
    '-e', 'WHIM_ADMIN_TOKEN=admin', '-e', 'WHIM_BEARER_TOKEN=ingest', '-e', 'WHIM_HMAC_SECRET=hmac',
    '-e', 'OPENAI_API_KEY=fixture-key', '-e', `OPENAI_BASE_URL=${mock.url}`, '-e', 'WHIM_POLL_MS=20', 'whim-server:v1');
  await until(async () => (await fetch(url + '/healthz')).ok);
  const admin = (path: string) => fetch(url + '/admin/' + path, {headers: {Authorization: 'Bearer admin'}});
  const n = note(); const accepted = await fetch(url + '/receive', upload(n));
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).duplicate, false);
  await until(async () => (await (await admin('notes/' + n.noteId)).json()).status === 'succeeded');
  assert.deepEqual(calls, ['/audio/transcriptions', '/decisions', '/hook']);
  const query = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/whim.sqlite'); console.log(JSON.stringify(db.prepare('SELECT metadata,audio,transcript,plan FROM notes WHERE note_id=?').get('${n.noteId}'))); db.close();`;
  const stored = JSON.parse((await docker('exec', name, 'node', '--input-type=module', '-e', query)).stdout);
  assert.deepEqual(stored, {metadata: null, audio: null, transcript: null, plan: null});
  const cfg = await (await admin('config')).json();
  const changed = {...cfg.settings, instructions: 'Temporary instructions'};
  assert.equal((await fetch(url + '/admin/config', {method: 'PUT', headers: {Authorization: 'Bearer admin', 'Content-Type': 'application/json'}, body: JSON.stringify({settings: changed, expectedRevisionId: cfg.id})})).status, 200);
  await docker('exec', '-e', `WHIM_SERVER_URL=${url}`, name, 'node', 'dist/cli.js', 'config', 'rollback', String(cfg.id));
  assert.deepEqual((await (await admin('config')).json()).settings, cfg.settings);
  await docker('restart', '-t', '15', name); await until(async () => (await fetch(url + '/healthz')).ok);
  const again = await fetch(url + '/receive', upload(n)); assert.equal((await again.json()).duplicate, true);
  await delay(100); assert.equal(calls.length, 3);
  console.log('PASS: actual image signed acceptance, OpenAI fixtures, webhook, cleanup, CLI rollback, restart and dedupe.');
} catch (e) {
  const logs = await docker('logs', name).catch(() => ({stdout: '', stderr: ''}));
  console.error(logs.stdout, logs.stderr); throw e;
} finally {
  await docker('rm', '-f', name).catch(() => {}); await docker('volume', 'rm', volume).catch(() => {});
  await mock.close(); rmSync(dir, {recursive: true, force: true});
}
