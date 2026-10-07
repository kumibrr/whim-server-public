import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { initialSettings } from './setup.ts';
export async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const base = env.WHIM_SERVER_URL ?? 'http://127.0.0.1:8788';
    if (!env.WHIM_ADMIN_TOKEN) throw new Error('WHIM_ADMIN_TOKEN required');
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const res = await fetch(base.replace(/\/$/, '') + '/admin/' + path, {method, redirect: 'error',
        signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${env.WHIM_ADMIN_TOKEN}`, 'Content-Type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      if (!res.ok) { await res.body?.cancel(); throw new Error(`Admin HTTP ${res.status}`); }
      return res.json();
    };
    const [group, command, target, resolution] = args;
    let result: unknown;
    if (group === 'config') {
      if (command === 'setup' && args.length === 2) {
        const current = await request('config');
        if (current.id !== 0) throw new Error('Setup already complete; use config import to update settings');
        console.log('Whim initial setup\nProvision OPENAI_API_KEY and WHIM_BEARER_TOKEN and/or WHIM_HMAC_SECRET in the server environment.\nDestination credentials belong in WHIM_CREDENTIALS_JSON; enter only their reference name here.');
        const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
        const answers = lines[Symbol.asyncIterator]();
        const ask = async (label: string, fallback?: string) => {
          process.stdout.write(label + (fallback === undefined ? '' : ` [${fallback}]`) + ': ');
          const answer = await answers.next(); if (answer.done) throw new Error('Setup cancelled: input ended');
          return answer.value.trim() || fallback || '';
        };
        try {
          const defaults = initialSettings({url: 'https://example.com/webhook'});
          const url = await ask('Destination URL');
          const method = (await ask('HTTP method (POST, PUT, PATCH, DELETE, GET)', 'POST')).toUpperCase();
          const format = method === 'GET' ? 'json' : (await ask('Body format (json, text, form, multipart, audio)', 'json')).toLowerCase();
          const credential = await ask('Authorization credential reference (optional)');
          const transcriptionModel = await ask('Transcription model', defaults.transcriptionModel);
          const responsesModel = await ask('Responses model', defaults.responsesModel);
          const instructions = await ask('Instructions', defaults.instructions);
          const settings = initialSettings({url, method, format, credential, transcriptionModel, responsesModel, instructions});
          console.log('\nReview settings:\n' + JSON.stringify(settings, null, 2));
          if ((await ask('Save initial configuration? Type yes to confirm', 'no')).toLowerCase() !== 'yes') {
            console.log('Setup cancelled; nothing saved.'); return 0;
          }
          result = await request('config', 'PUT', {settings, expectedRevisionId: 0});
          console.log('Setup complete. Set Whim’s endpoint to ' + base.replace(/\/$/, '') + '/receive (use your public HTTPS address).');
        } finally { lines.close(); }
      }
      else if (command === 'show') result = await request('config');
      else if (command === 'history') result = await request('config/revisions');
      else if (command === 'export' && target) { const current = await request('config'); if (!current.settings) throw new Error('Configuration required'); await writeFile(target, JSON.stringify(current.settings, null, 2) + '\n', {mode: 0o600}); return 0; }
      else if (command === 'import' && target) {
        const settings = JSON.parse(await readFile(target, 'utf8')); const current = await request('config');
        result = await request('config', 'PUT', {settings, expectedRevisionId: resolution === undefined ? current.id : Number(resolution)});
      } else if (command === 'rollback' && target) {
        const current = await request('config'); result = await request('config/rollback', 'POST', {targetRevisionId: Number(target), expectedRevisionId: current.id});
      } else throw new Error('Usage: config setup|show|history|export FILE|import FILE [EXPECTED_REVISION]|rollback REVISION');
    } else if (group === 'notes') {
      if (command === 'list') result = await request('notes');
      else if (command === 'show' && target) result = await request(`notes/${encodeURIComponent(target)}`);
      else if (command === 'retry' && target) result = await request(`notes/${encodeURIComponent(target)}/retry`, 'POST', {});
      else if (command === 'resolve' && target && resolution && ['delivered', 'retry'].includes(args[4]))
        result = await request(`notes/${encodeURIComponent(target)}/actions/${encodeURIComponent(resolution)}/resolve`, 'POST', {resolution: args[4]});
      else throw new Error('Usage: notes list|show ID|retry ID|resolve ID INDEX delivered|retry');
    } else throw new Error('Usage: config ... | notes ...');
    console.log(JSON.stringify(result, null, 2)); return 0;
  } catch (e) {
    // Never include fetch diagnostics or input content in errors.
    console.error(e instanceof Error && /^(Usage:|Admin HTTP|WHIM_ADMIN_TOKEN|Setup |Configuration required|Invalid settings)/.test(e.message) ? e.message : 'CLI request failed'); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2), process.env);
