// Raw multipart/signature validation adapted from Whim (MIT); see THIRD_PARTY_NOTICES.md.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener } from 'node:http';
import type { Store } from './store.ts';
import type { Secrets } from './types.ts';

export const equalSecret = (actual: string, expected: string) => timingSafeEqual(Buffer.from(hash(actual), 'hex'), Buffer.from(hash(expected), 'hex'));
class RequestError extends Error {
  status: number;
  constructor(status: number) { super('Request rejected'); this.status = status; }
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex = /^[0-9a-f]{64}$/;

// Whim's two-part contract is parsed as bytes: text-field decoding would
// normalize malformed UTF-8 before the signed metadata digest is verified.
function multipartParts(body: Buffer, contentType: string): Map<string, Buffer> {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"\r\n]{1,70})"|([^;\s]{1,70}))\s*$/i.exec(contentType);
  if (!match) throw new RequestError(400);
  const marker = Buffer.from(`--${match[1] ?? match[2]}`);
  const separator = Buffer.concat([Buffer.from('\r\n'), marker]);
  const parts = new Map<string, Buffer>();
  let cursor = 0;
  while (true) {
    if (!body.subarray(cursor, cursor + marker.length).equals(marker)) throw new RequestError(400);
    cursor += marker.length;
    const suffix = body.subarray(cursor, cursor + 2).toString('ascii');
    if (suffix === '--') {
      const remainder = body.subarray(cursor + 2).toString('ascii');
      if (remainder !== '' && remainder !== '\r\n') throw new RequestError(400);
      return parts;
    }
    if (suffix !== '\r\n') throw new RequestError(400);
    const headerStart = cursor + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0 || headerEnd - headerStart > 8192) throw new RequestError(400);
    const headers = new Map<string, string>();
    for (const line of body.subarray(headerStart, headerEnd).toString('ascii').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) throw new RequestError(400);
      const name = line.slice(0, colon).toLowerCase();
      if (headers.has(name)) throw new RequestError(400);
      headers.set(name, line.slice(colon + 1).trim());
    }
    const disposition = /^form-data;\s*name="(metadata|audio)"(?:;\s*filename="[^"\r\n]*")?$/i.exec(headers.get('content-disposition') ?? '');
    if (!disposition || parts.has(disposition[1])) throw new RequestError(400);
    const name = disposition[1];
    const mediaType = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if ((name === 'audio' && mediaType !== 'audio/mp4') || (name === 'metadata' && mediaType && mediaType !== 'application/json')) throw new RequestError(400);
    const contentStart = headerEnd + 4;
    let next = body.indexOf(separator, contentStart);
    while (next >= 0) {
      const ending = body.subarray(next + separator.length, next + separator.length + 2).toString('ascii');
      if (ending === '--' || ending === '\r\n') break;
      next = body.indexOf(separator, next + separator.length);
    }
    if (next < 0) throw new RequestError(400);
    parts.set(name, body.subarray(contentStart, next));
    cursor = next + 2;
  }
}

async function readNote(request: IncomingMessage, options: Secrets) {
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === 'string' ? value : '';
  };
  if (options.bearerToken && !equalSecret(header('authorization'), `Bearer ${options.bearerToken}`)) throw new RequestError(401);
  const noteID = header('x-whim-note-id');
  const attemptID = header('x-whim-attempt-id');
  const timestamp = header('x-whim-timestamp');
  const metadataHash = header('x-whim-metadata-sha256');
  const audioHash = header('x-whim-audio-sha256');
  if (!uuid.test(noteID) || !uuid.test(attemptID) || !/^\d+$/.test(timestamp)
      || !hex.test(metadataHash) || !hex.test(audioHash)) throw new RequestError(400);
  if (options.hmacSecret) {
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds) || Math.abs((Date.now() / 1000) - seconds) > 300) throw new RequestError(401);
    const canonical = ['v1', timestamp, noteID, attemptID, metadataHash, audioHash].join('\n');
    const signature = `v1=${createHmac('sha256', options.hmacSecret).update(canonical).digest('hex')}`;
    if (!equalSecret(header('x-whim-signature'), signature)) throw new RequestError(401);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new RequestError(413);
    chunks.push(chunk);
  }
  const parts = multipartParts(Buffer.concat(chunks), header('content-type'));
  const metadata = parts.get('metadata');
  const audio = parts.get('audio');
  if (!metadata || !audio || parts.size !== 2) throw new RequestError(400);
  if (hash(metadata) !== metadataHash || hash(audio) !== audioHash) throw new RequestError(400);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)); } catch { throw new RequestError(400); }
  if (!parsed || parsed.schema_version !== 1 || !['note.created', 'configuration.test'].includes(parsed.event)
      || parsed.note_id !== noteID || parsed.attempt_id !== attemptID
      || parsed.audio?.sha256 !== audioHash || parsed.audio?.size_bytes !== audio.length
      || !Number.isSafeInteger(parsed.duration_ms) || parsed.duration_ms < 0
      || typeof parsed.title !== 'string' || typeof parsed.created_at !== 'string' || !Number.isFinite(Date.parse(parsed.created_at))
      || !['iphone', 'apple_watch'].includes(parsed.source)
      || !['transcription', 'timestamp', 'recovered'].includes(parsed.title_source)
      || !['completed', 'interrupted', 'recovered'].includes(parsed.capture_outcome)
      || typeof parsed.workflow_id !== 'string' || typeof parsed.app?.version !== 'string' || typeof parsed.app?.build !== 'string') {
    throw new RequestError(400);
  }
  return { noteId: noteID.toLowerCase(), attemptId: attemptID.toLowerCase(), event: parsed.event, metadataBytes: metadata, metadata: parsed, audio };
}

export function createReceiver(store: Store, secrets: Secrets): RequestListener {
  return async (request, response) => {
    try {
      if (request.url?.split('?')[0] !== '/receive') throw new RequestError(404);
      if (request.method !== 'POST') throw new RequestError(405);
      const note = await readNote(request, secrets);
      const duplicate = note.event === 'note.created' ? store.accept(note).duplicate : false;
      response.writeHead(200, {'Content-Type': 'application/json', 'X-Whim-Note-ID': note.noteId});
      response.end(JSON.stringify({note_id: note.noteId, duplicate}));
    } catch (error) {
      request.resume();
      response.writeHead(error instanceof RequestError ? error.status : 500,
        {'Content-Type': 'application/json', Connection: 'close'}).end(JSON.stringify({error: 'Request rejected'}));
    }
  };
}
