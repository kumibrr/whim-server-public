export interface IncomingNote {
  noteId: string;
  attemptId: string;
  metadataBytes: Uint8Array;
  metadata: Record<string, unknown>;
  audio: Uint8Array;
}
export interface Secrets {
  bearerToken?: string;
  hmacSecret?: string;
  adminToken?: string;
  openaiKey?: string;
  credentials?: Record<string, string>;
  openaiBaseUrl?: string;
}
export type Json = null | boolean | number | string | Json[] | {[key: string]: Json};
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  enum?: Json[];
  description?: string;
}
export type Mapping = {source: 'literal'; value: Json} | {source: 'args' | 'note' | 'options'; path: string}
  | {source: 'transcript' | 'audio'} | {[key: string]: Mapping} | Mapping[];
export interface WebhookRecipe {
  description: string;
  url: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET';
  headers: Record<string, string>;
  authHeaders: Record<string, string>;
  argsSchema: JsonSchema;
  body: {format: 'json' | 'text' | 'form' | 'multipart' | 'audio'; mapping: Mapping};
  options: Record<string, string | number | boolean>;
  mutableOptions: string[];
}
export interface Settings {
  transcriptionModel: string;
  responsesModel: string;
  decisionModel?: string;
  decisionThreshold?: number;
  instructions: string;
  defaultPipeId: string;
  pipes: Record<string, WebhookRecipe>;
}
export interface Revision {id: number; settings: Settings; createdAt: number; source: string}
export interface ConfigChange {path: string; value: Json}
export interface Action {pipeId: string; args: Record<string, Json>}
export interface Plan {actions: Action[]}
export type NoteStatus = 'queued' | 'running' | 'retrying' | 'failed' | 'uncertain' | 'succeeded';
export interface Job {
  noteId: string; attemptId: string; acceptedAt: number; updatedAt: number; status: NoteStatus;
  revisionId: number | null; metadataBytes: Uint8Array | null; metadata: Record<string, unknown> | null;
  audio: Uint8Array | null; transcript: string | null; plan: Plan | null;
  nextAt: number; transcriptionAttempts: number; decisionAttempts: number; error: string | null;
}
export interface ActionOutcome {
  index: number; pipeId: string; status: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'uncertain';
  revisionId: number | null; error: string | null;
}
