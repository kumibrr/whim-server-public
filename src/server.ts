import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from './store.ts';
import { createReceiver } from './receiver.ts';
import { createAdminHandler } from './admin.ts';
import { processNext } from './process-note.ts';
import type { Store } from './store.ts';
import type { Secrets } from './types.ts';
const positive = (value: string | undefined, fallback: number, allowZero = false) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) throw new Error('Invalid numeric setting'); return n;
};
export async function startServer(env: NodeJS.ProcessEnv): Promise<{url: string; store: Store; close(): Promise<void>}> {
  const path = env.WHIM_DATABASE ?? './data/whim.sqlite';
  const secrets: Secrets = {bearerToken: env.WHIM_BEARER_TOKEN, hmacSecret: env.WHIM_HMAC_SECRET, adminToken: env.WHIM_ADMIN_TOKEN,
    openaiKey: env.OPENAI_API_KEY, openaiBaseUrl: env.OPENAI_BASE_URL,
    credentials: JSON.parse(env.WHIM_CREDENTIALS_JSON ?? '{}')};
  if (!secrets.adminToken) throw new Error('WHIM_ADMIN_TOKEN required');
  if ([secrets.bearerToken, secrets.hmacSecret, secrets.openaiKey].filter(Boolean).includes(secrets.adminToken)) throw new Error('Admin credential must be separate');
  if (!secrets.credentials || typeof secrets.credentials !== 'object' || Array.isArray(secrets.credentials) || !Object.values(secrets.credentials).every(v => typeof v === 'string')) throw new Error('Invalid credential provisioning');
  const port = positive(env.WHIM_PORT, 8788, true), pollMs = positive(env.WHIM_POLL_MS, 1000), shutdownMs = positive(env.WHIM_SHUTDOWN_MS, 10_000);
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const store = openStore(path);
  try {
    if (!store.history().length && env.WHIM_BOOTSTRAP_FILE) store.activate(JSON.parse(readFileSync(env.WHIM_BOOTSTRAP_FILE, 'utf8')), 0, 'admin');
    store.recoverInterrupted();
    const receive = createReceiver(store, secrets), admin = createAdminHandler(store, secrets.adminToken);
    let stopping = false;
    const server = createServer((req, res) => {
      if (stopping) { res.writeHead(503, {Connection: 'close'}).end(); return; }
      const route = req.url?.split('?')[0];
      if (route === '/healthz' && req.method === 'GET') { res.writeHead(200, {'Content-Type': 'application/json'}).end('{"ok":true}'); return; }
      if (route?.startsWith('/admin/')) admin(req, res); else receive(req, res);
    });
    server.requestTimeout = 120_000; server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, env.WHIM_HOST ?? '0.0.0.0', resolve); });
    const io = new AbortController(), sleep = new AbortController();
    const worker = (async () => {
      while (!stopping) {
        const worked = await processNext(store, secrets, Date.now(), io.signal);
        if (!worked && !stopping) await delay(pollMs, undefined, {signal: sleep.signal}).catch(() => {});
      }
    })();
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      stopping = true; sleep.abort();
      const timeout = setTimeout(() => { io.abort(); server.closeAllConnections(); }, shutdownMs);
      const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
      try { await Promise.all([worker, httpClosed]); store.recoverInterrupted(); }
      finally { clearTimeout(timeout); store.close(); }
    })();
    return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, close};
  } catch (e) { store.close(); throw e; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.umask(0o077);
    const app = await startServer(process.env);
    console.log('Whim server listening');
    const shutdown = () => { void app.close().catch(() => { console.error('Shutdown failed'); process.exitCode = 1; }); };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  } catch { console.error('Server startup failed; check provisioning'); process.exitCode = 1; }
}
