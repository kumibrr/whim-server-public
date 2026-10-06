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
