import type { Action, Job, Settings, Secrets, Mapping } from './types.ts';
import { ajv } from './config.ts';
export class DeliveryFailure extends Error {
  uncertain: boolean;
  constructor(code: string, uncertain: boolean) { super(code); this.uncertain = uncertain; }
}
function map(value: Mapping, action: Action, job: Job, settings: Settings): unknown {
  if (Array.isArray(value)) return value.map(v => map(v, action, job, settings));
  if (Object.hasOwn(value, 'source')) {
    const ref = value as {source: string; value?: unknown; path?: string};
    if (ref.source === 'literal') return ref.value;
    if (ref.source === 'transcript') { if (job.transcript === null) throw new Error('Transcript missing'); return job.transcript; }
    if (ref.source === 'audio') { if (!job.audio) throw new Error('Audio missing'); return job.audio; }
    let source: any = ref.source === 'args' ? action.args : ref.source === 'note' ? job.metadata : settings.pipes[action.pipeId].options;
    if (!ref.path) return source;
    for (const part of ref.path.split('.')) {
      if (!source || typeof source !== 'object' || !Object.hasOwn(source, part) || ['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error('Mapping value missing');
      source = source[part];
    }
    return source;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, map(v as Mapping, action, job, settings)]));
}
const field = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v);
function containsAudio(value: unknown): boolean {
  return value instanceof Uint8Array || (Array.isArray(value) ? value.some(containsAudio) : !!value && typeof value === 'object' && Object.values(value).some(containsAudio));
}
export function buildWebhookRequest(action: Action, job: Job, settings: Settings, secrets: Secrets): {url: string; init: RequestInit} {
  const pipe = settings.pipes[action.pipeId];
  if (!pipe || !ajv.compile(pipe.argsSchema)(action.args)) throw new Error('Invalid webhook arguments');
  const headers = new Headers(pipe.headers);
  for (const [header, reference] of Object.entries(pipe.authHeaders)) {
    const value = secrets.credentials?.[reference];
    if (!value) throw new Error('Destination credential missing');
    headers.set(header, value);
  }
  const value = map(pipe.body.mapping, action, job, settings);
  let body: BodyInit;
  switch (pipe.body.format) {
    case 'json':
      if (containsAudio(value)) throw new Error('Audio requires multipart or audio format');
      body = JSON.stringify(value); if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json'); break;
    case 'text':
      if (containsAudio(value)) throw new Error('Audio requires multipart or audio format');
      body = field(value); if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/plain; charset=utf-8'); break;
    case 'audio':
      if (!(value instanceof Uint8Array)) throw new Error('Audio mapping required');
      body = Uint8Array.from(value); if (!headers.has('Content-Type')) headers.set('Content-Type', 'audio/mp4'); break;
    case 'form':
    case 'multipart': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) throw new Error('Field mappings required');
      const form = pipe.body.format === 'multipart' ? new FormData() : new URLSearchParams();
      for (const [k, v] of Object.entries(value)) {
        if (v instanceof Uint8Array && form instanceof FormData) form.set(k, new Blob([Uint8Array.from(v)], {type: 'audio/mp4'}), 'note.m4a');
        else { if (containsAudio(v)) throw new Error('Invalid field mapping'); form.set(k, field(v)); }
      }
      if (form instanceof FormData) headers.delete('Content-Type');
      else if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded');
      body = form; break;
    }
  }
  return {url: pipe.url, init: {method: pipe.method, headers, ...(pipe.method === 'GET' ? {} : {body}), redirect: 'manual'}};
}
export async function sendWebhook(request: {url: string; init: RequestInit}, timeoutMs = 30_000): Promise<void> {
  let response: Response;
  try { response = await fetch(request.url, {...request.init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)}); }
  catch { throw new DeliveryFailure('Webhook response lost', true); }
  await response.body?.cancel().catch(() => {});
  if (!response.ok) throw new DeliveryFailure(`Webhook HTTP ${response.status}`, false);
}
