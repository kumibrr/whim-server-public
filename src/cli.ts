import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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
      if (command === 'show') result = await request('config');
      else if (command === 'history') result = await request('config/revisions');
      else if (command === 'export' && target) { const current = await request('config'); await writeFile(target, JSON.stringify(current.settings, null, 2) + '\n', {mode: 0o600}); return 0; }
      else if (command === 'import' && target) {
        const settings = JSON.parse(await readFile(target, 'utf8')); const current = await request('config');
        result = await request('config', 'PUT', {settings, expectedRevisionId: resolution === undefined ? current.id : Number(resolution)});
      } else if (command === 'rollback' && target) {
        const current = await request('config'); result = await request('config/rollback', 'POST', {targetRevisionId: Number(target), expectedRevisionId: current.id});
      } else throw new Error('Usage: config show|history|export FILE|import FILE [EXPECTED_REVISION]|rollback REVISION');
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
    console.error(e instanceof Error && /^(Usage:|Admin HTTP|WHIM_ADMIN_TOKEN)/.test(e.message) ? e.message : 'CLI request failed'); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2), process.env);
