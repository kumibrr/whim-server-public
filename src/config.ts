import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { isDeepStrictEqual } from 'node:util';
import type { Settings, ConfigChange, JsonSchema, Mapping } from './types.ts';
const validators = new Map<string, ValidateFunction>();
// Each compiled validator owns a scoped Ajv instance; evicted instances can be collected.
export function compileSchema(schema: object): ValidateFunction {
  const key = JSON.stringify(schema), cached = validators.get(key);
  if (cached) { validators.delete(key); validators.set(key, cached); return cached; }
  const validator = new Ajv({strict: true, allErrors: false}).compile(schema);
  if (key.length <= 64 * 1024) {
    validators.set(key, validator);
    while (validators.size > 16) validators.delete(validators.keys().next().value!);
  }
  return validator;
}
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
  if (!record(value) || !keys(value, ['transcriptionModel', 'responsesModel', 'decisionModel', 'decisionThreshold', 'instructions', 'defaultPipeId', 'pipes'])
    || !text(value.transcriptionModel) || !text(value.responsesModel) || typeof value.instructions !== 'string'
    || (Object.hasOwn(value, 'decisionModel') && !text(value.decisionModel))
    || (Object.hasOwn(value, 'decisionThreshold') && (typeof value.decisionThreshold !== 'number'
      || !Number.isFinite(value.decisionThreshold) || value.decisionThreshold <= 0 || value.decisionThreshold > 1))
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
    if (pipe.method === 'GET' && (pipe.body.format !== 'json' || !record(pipe.body.mapping)
      || Object.keys(pipe.body.mapping).length !== 0)) fail();
  }
  assertOutputLimits(planSchema(settings));
  for (const pipe of Object.values(settings.pipes)) compileSchema(pipe.argsSchema);
  if (!compileSchema(settings.pipes[settings.defaultPipeId].argsSchema)({})) fail();
  return settings;
}
export function voicePaths(base: Settings): Record<string, JsonSchema> {
  const paths: Record<string, JsonSchema> = {instructions: {type: 'string'}, transcriptionModel: {type: 'string'},
    responsesModel: {type: 'string'}, decisionModel: {type: 'string'}, decisionThreshold: {type: 'number'},
    defaultPipeId: {type: 'string', enum: Object.keys(base.pipes)}};
  for (const [id, pipe] of Object.entries(base.pipes)) for (const k of pipe.mutableOptions)
    paths[`pipes.${id}.options.${k}`] = {type: typeof pipe.options[k] as 'string' | 'number' | 'boolean'};
  return paths;
}
export function voiceSettings(base: Settings, changes: ConfigChange[]): Settings {
  if (!Array.isArray(changes) || !changes.length || changes.length > 32) fail();
  const next = structuredClone(base), paths = voicePaths(base);
  for (const change of changes) {
    if (!record(change) || !keys(change, ['path', 'value']) || !Object.hasOwn(paths, change.path)
      || !compileSchema(paths[change.path])(change.value)) fail();
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
    const key = parts.at(-1)!;
    if (Object.hasOwn(src, key)) dest[key] = src[key]; else delete dest[key];
  }
  if (!isDeepStrictEqual(fixed, base)) fail();
}

const object = (properties: Record<string, unknown>) => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
export function planSchema(settings: Settings, selectedPipeIds?: string[]) {
  const actions = Object.entries(settings.pipes).filter(([id]) => !selectedPipeIds || selectedPipeIds.includes(id))
    .map(([id, pipe]) => object({pipeId: {type: 'string', enum: [id]}, args: pipe.argsSchema}));
  const changes = Object.entries(voicePaths(settings)).map(([path, value]) => object({path: {type: 'string', enum: [path]}, value}));
  if (!selectedPipeIds || selectedPipeIds.includes('configure'))
    actions.push(object({pipeId: {type: 'string', enum: ['configure']}, args: object({changes: {type: 'array', items: {anyOf: changes}}})}));
  return object({routing: {type: 'string', enum: selectedPipeIds ? ['matched'] : ['matched', 'default']}, actions: {type: 'array', items: {anyOf: actions}}});
}
function assertOutputLimits(schema: object): void {
  let properties = 0, enumValues = 0, stringLength = 0;
  function visit(node: any, depth: number): void {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    const nextDepth = depth + (types.includes('object') || types.includes('array') ? 1 : 0);
    if (nextDepth > 10) fail();
    if (node.enum) {
      enumValues += node.enum.length;
      const chars = node.enum.reduce((sum: number, v: unknown) => sum + (typeof v === 'string' ? v.length : 0), 0);
      stringLength += chars;
      if (node.enum.length > 250 && chars > 15_000) fail();
    }
    if (node.properties) {
      properties += Object.keys(node.properties).length;
      for (const [name, child] of Object.entries(node.properties)) { stringLength += name.length; visit(child, nextDepth); }
    }
    if (node.items) visit(node.items, nextDepth);
    if (node.anyOf) for (const child of node.anyOf) visit(child, depth);
    if (properties > 5000 || enumValues > 1000 || stringLength > 120_000) fail();
  }
  visit(schema, 0);
}
