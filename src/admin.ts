import type { RequestListener, IncomingMessage } from 'node:http';
import type { Store } from './store.ts';
import type { Settings } from './types.ts';
import { equalSecret } from './receiver.ts';
class AdminError extends Error {
  status: number;
  constructor(status: number) { super('Admin request rejected'); this.status = status; }
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    size += chunk.length; if (size > 1024 * 1024) throw new AdminError(413); chunks.push(chunk);
  }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new AdminError(400); }
}
const revisionId = (value: unknown) => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AdminError(400); return Number(value); };
export function createAdminHandler(store: Store, adminToken: string): RequestListener {
  if (!adminToken) throw new Error('Admin credential required');
  return async (req, res) => {
    try {
      if (typeof req.headers.authorization !== 'string' || !equalSecret(req.headers.authorization, `Bearer ${adminToken}`)) throw new AdminError(401);
      const path = req.url?.split('?')[0], method = req.method;
      let result: unknown;
      if (path === '/admin/config' && method === 'GET') result = store.currentRevision();
      else if (path === '/admin/config' && method === 'PUT') {
        const b = await body(req); result = store.activate(b.settings as Settings, revisionId(b.expectedRevisionId), 'admin');
      } else if (path === '/admin/config/revisions' && method === 'GET') result = store.history();
      else if (path === '/admin/config/rollback' && method === 'POST') {
        const b = await body(req); result = store.rollback(revisionId(b.targetRevisionId), revisionId(b.expectedRevisionId));
      } else if (path === '/admin/notes' && method === 'GET') result = store.listNotes();
      else {
        const match = /^\/admin\/notes\/([0-9a-f-]{36})(?:\/(retry|actions\/(\d+)\/resolve))?$/.exec(path ?? '');
        if (!match) throw new AdminError(404);
        if (!match[2] && method === 'GET') result = store.noteStatus(match[1]);
        else if (match[2] === 'retry' && method === 'POST') { store.retryNote(match[1]); result = store.noteStatus(match[1]); }
        else if (match[3] && method === 'POST') {
          const b = await body(req); if (!['delivered', 'retry'].includes(b.resolution)) throw new AdminError(400);
          store.resolveAction(match[1], revisionId(Number(match[3])), b.resolution); result = store.noteStatus(match[1]);
        } else throw new AdminError(405);
      }
      res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(result));
    } catch (e) {
      req.resume();
      const status = e instanceof AdminError ? e.status : e instanceof Error && ['Stale revision', 'Invalid recovery state'].includes(e.message) ? 409
        : e instanceof Error && e.message.startsWith('Unknown') ? 404 : 422;
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close'}).end(JSON.stringify({error: status === 409 ? 'Stale revision or invalid recovery state' : 'Admin request rejected'}));
    }
  };
}
