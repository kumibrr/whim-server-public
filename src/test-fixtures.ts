import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingNote } from './types.ts';
import type { Settings } from './types.ts';
export function settings(url = 'http://127.0.0.1:9999/webhook'): Settings {
  return {transcriptionModel: 'gpt-4o-mini-transcribe', responsesModel: 'gpt-4.1-mini',
    instructions: 'Send notes to inbox unless asked to configure.', defaultPipeId: 'inbox', pipes: {inbox: {
      description: 'Save a general note', url, method: 'POST', headers: {}, authHeaders: {},
      argsSchema: {type: 'object', properties: {}, required: [], additionalProperties: false},
      body: {format: 'json', mapping: {note_id: {source: 'note', path: 'note_id'}, text: {source: 'transcript'}}},
      options: {folder: 'inbox'}, mutableOptions: ['folder']}}};
}
export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks);
}
export const responsePlan = (value: unknown) => ({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]}]});
export function note(overrides: Record<string, unknown> = {}): IncomingNote {
  const noteId = randomUUID(), attemptId = randomUUID(), audio = Buffer.from([0, 1, 255, 3]);
  const metadata = {schema_version: 1, event: 'note.created', note_id: noteId, attempt_id: attemptId,
    created_at: new Date().toISOString(), duration_ms: 100, source: 'iphone', title: 'Fixture',
    title_source: 'timestamp', capture_outcome: 'completed', workflow_id: 'inbox',
    app: {version: '1', build: '1'}, audio: {sha256: hash(audio), size_bytes: audio.length}, ...overrides};
  return {noteId, attemptId, audio, metadata, metadataBytes: Buffer.from(JSON.stringify(metadata, null, 2))};
}
export function upload(n: IncomingNote, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = new FormData();
  body.set('metadata', new Blob([Uint8Array.from(n.metadataBytes)], {type: 'application/json'}), 'metadata.json');
  body.set('audio', new Blob([Uint8Array.from(n.audio)], {type: 'audio/mp4'}), 'note.m4a');
  const mh = hash(n.metadataBytes), ah = hash(n.audio);
  const headers: Record<string, string> = {'X-Whim-Note-ID': n.noteId, 'X-Whim-Attempt-ID': n.attemptId,
    'X-Whim-Timestamp': timestamp, 'X-Whim-Metadata-SHA256': mh, 'X-Whim-Audio-SHA256': ah,
    Authorization: 'Bearer ingest', 'X-Whim-Signature': 'v1=' + createHmac('sha256', 'hmac').update(
      ['v1', timestamp, n.noteId, n.attemptId, mh, ah].join('\n')).digest('hex')};
  return {method: 'POST', body, headers};
}
export async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(e => e ? reject(e) : resolve()); })};
}
