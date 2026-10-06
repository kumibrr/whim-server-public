import { Ajv } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import type { Settings, ConfigChange, JsonSchema, Mapping } from './types.ts';
export const ajv = new Ajv({strict: true, allErrors: false});
const fail = (): never => { throw new Error('Invalid settings'); };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const safe = (k: string) => !['__proto__', 'constructor', 'prototype'].includes(k);
const keys = (o: object, allowed: string[]) => Object.keys(o).every(k => safe(k) && allowed.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function strictSchema(value: unknown, depth = 0): JsonSchema {
  if (!record(value) || depth > 12 || !keys(value, ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description'])) fail();
  const schema = structuredClone(value) as JsonSchema;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || !types.every(t => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t))) fail();
  if (schema.description !== undefined && typeof schema.description !== 'string') fail();
  if (types.includes('object')) {
    if (!record(schema.properties) || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) fail();
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(k => typeof k === 'string' && Object.hasOwn(schema.properties!, k)))) fail();
    schema.properties = Object.fromEntries(Object.entries(schema.properties!).map(([k, v]) => {
      if (!safe(k)) fail(); return [k, strictSchema(v, depth + 1)];
    }));
    schema.required = Object.keys(schema.properties); schema.additionalProperties = false;
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) fail();
  if (types.includes('array')) schema.items = strictSchema(schema.items, depth + 1);
  else if (schema.items !== undefined) fail();
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) fail();
  ajv.compile(schema);
  return schema;
}
function validMapping(value: unknown, depth = 0): value is Mapping {
  if (depth > 15) return false;
  if (Array.isArray(value)) return value.every(v => validMapping(v, depth + 1));
  if (!record(value) || !Object.keys(value).every(safe)) return false;
  if (Object.hasOwn(value, 'source')) {
    if (value.source === 'literal') return keys(value, ['source', 'value']) && Object.hasOwn(value, 'value');
    if (value.source === 'audio' || value.source === 'transcript') return keys(value, ['source']);
    return ['args', 'note', 'options'].includes(value.source) && keys(value, ['source', 'path'])
      && typeof value.path === 'string' && value.path.split('.').every(safe);
  }
  return Object.values(value).every(v => validMapping(v, depth + 1));
}
export function validateSettings(value: unknown): Settings {
  if (!record(value) || !keys(value, ['transcriptionModel', 'responsesModel', 'instructions', 'defaultPipeId', 'pipes'])
    || !text(value.transcriptionModel) || !text(value.responsesModel) || typeof value.instructions !== 'string'
    || !text(value.defaultPipeId) || !record(value.pipes) || !Object.hasOwn(value.pipes, value.defaultPipeId)) fail();
  const settings = structuredClone(value) as Settings;
  if (Object.keys(settings.pipes).length > 30) fail();
  for (const [id, pipe] of Object.entries(settings.pipes)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || id === 'configure' || !safe(id) || !record(pipe)
      || !keys(pipe, ['description', 'url', 'method', 'headers', 'authHeaders', 'argsSchema', 'body', 'options', 'mutableOptions'])
      || !text(pipe.description) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(pipe.method)) fail();
    let url: URL; try { url = new URL(pipe.url); } catch { fail(); }
    if (!['http:', 'https:'].includes(url!.protocol) || url!.username || url!.password) fail();
    for (const headers of [pipe.headers, pipe.authHeaders]) {
      if (!record(headers)) fail();
      for (const [k, v] of Object.entries(headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(k) || !safe(k) || typeof v !== 'string' || /[\r\n]/.test(v)) fail();
        if (headers === pipe.headers && /authorization|cookie|token|secret|api.?key/i.test(k)) fail();
        if (headers === pipe.authHeaders && !text(v)) fail();
        if (['host', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) fail();
      }
    }
    pipe.argsSchema = strictSchema(pipe.argsSchema);
    if (pipe.argsSchema.type !== 'object') fail();
    if (!record(pipe.options) || !Object.entries(pipe.options).every(([k, v]) => safe(k) && /^[a-zA-Z0-9_-]+$/.test(k)
      && ['string', 'number', 'boolean'].includes(typeof v))) fail();
    if (!Array.isArray(pipe.mutableOptions) || !pipe.mutableOptions.every(k => typeof k === 'string' && Object.hasOwn(pipe.options, k))) fail();
    if (!record(pipe.body) || !keys(pipe.body, ['format', 'mapping']) || !['json', 'text', 'form', 'multipart', 'audio'].includes(pipe.body.format)
      || !validMapping(pipe.body.mapping)) fail();
    if (pipe.method === 'GET' && pipe.body.format !== 'json') fail();
  }
  if (!ajv.compile(settings.pipes[settings.defaultPipeId].argsSchema)({})) fail();
  return settings;
}
export function voicePaths(base: Settings): Record<string, JsonSchema> {
  const paths: Record<string, JsonSchema> = {instructions: {type: 'string'}, transcriptionModel: {type: 'string'},
    responsesModel: {type: 'string'}, defaultPipeId: {type: 'string', enum: Object.keys(base.pipes)}};
  for (const [id, pipe] of Object.entries(base.pipes)) for (const k of pipe.mutableOptions)
    paths[`pipes.${id}.options.${k}`] = {type: typeof pipe.options[k] as 'string' | 'number' | 'boolean'};
  return paths;
}
export function voiceSettings(base: Settings, changes: ConfigChange[]): Settings {
  if (!Array.isArray(changes) || !changes.length || changes.length > 32) fail();
  const next = structuredClone(base), paths = voicePaths(base);
  for (const change of changes) {
    if (!record(change) || !keys(change, ['path', 'value']) || !Object.hasOwn(paths, change.path)
      || !ajv.compile(paths[change.path])(change.value)) fail();
    const parts = change.path.split('.');
    let obj: any = next;
    for (const k of parts.slice(0, -1)) obj = obj[k];
    obj[parts.at(-1)!] = change.value;
  }
  return validateSettings(next);
}
export function assertVoiceChange(base: Settings, next: Settings): void {
  const fixed = structuredClone(next);
  for (const path of Object.keys(voicePaths(base))) {
    const parts = path.split('.'); let dest: any = fixed, src: any = base;
    for (const k of parts.slice(0, -1)) { if (!dest?.[k]) fail(); dest = dest[k]; src = src[k]; }
    dest[parts.at(-1)!] = src[parts.at(-1)!];
  }
  if (!isDeepStrictEqual(fixed, base)) fail();
}
