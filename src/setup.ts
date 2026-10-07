import type { Mapping, Settings, WebhookRecipe } from './types.ts';
import { validateSettings } from './config.ts';

// Both setup clients use these recipes; credentials remain environment references.
export const bodyFormats: Record<WebhookRecipe['body']['format'], Mapping> = {
  json: {note_id: {source: 'note', path: 'note_id'}, title: {source: 'note', path: 'title'}, text: {source: 'transcript'}},
  text: {source: 'transcript'},
  form: {note_id: {source: 'note', path: 'note_id'}, title: {source: 'note', path: 'title'}, text: {source: 'transcript'}},
  multipart: {note_id: {source: 'note', path: 'note_id'}, text: {source: 'transcript'}, audio: {source: 'audio'}},
  audio: {source: 'audio'},
};
export interface SetupInput {
  url: string;
  method?: string;
  format?: string;
  credential?: string;
  transcriptionModel?: string;
  responsesModel?: string;
  instructions?: string;
}
export function initialSettings(input: SetupInput): Settings {
  const method = input.method ?? 'POST', format = input.format ?? 'json';
  if (!Object.hasOwn(bodyFormats, format)) throw new Error('Invalid settings');
  return validateSettings({
    transcriptionModel: input.transcriptionModel ?? 'gpt-4o-mini-transcribe',
    responsesModel: input.responsesModel ?? 'gpt-4.1-mini',
    instructions: input.instructions ?? 'Send ordinary notes to inbox. Apply configuration changes only when explicitly and unambiguously requested.',
    defaultPipeId: 'inbox',
    pipes: {inbox: {
      description: 'Save any note to my inbox', url: input.url, method,
      headers: {}, authHeaders: input.credential ? {Authorization: input.credential} : {},
      argsSchema: {type: 'object', properties: {}, required: [], additionalProperties: false},
      body: method === 'GET' ? {format: 'json', mapping: {}} : {format, mapping: bodyFormats[format as keyof typeof bodyFormats]},
      options: {}, mutableOptions: [],
    }},
  });
}
