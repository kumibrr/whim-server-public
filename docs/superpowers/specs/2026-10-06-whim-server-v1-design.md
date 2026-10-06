# Whim server v1 — OpenAI only

Date: 2026-10-06

Status: Revised at the owner's request to simplify the previous design. Awaiting review of this replacement specification.

## Purpose and shape

A small server for one owner receives Whim recordings, uses OpenAI to interpret them, and sends the results to configured webhooks. Spoken commands can update live settings. The owner can restore earlier settings without relying on voice processing.

Ship one Node 24+/TypeScript process in Docker, with SQLite on one persistent volume and a Fly.io configuration. Use ordinary modules for HTTP, OpenAI calls, persistence, processing, configuration, and pipes. No provider registry, interchangeable adapter framework, separate extraction service, custom plugin system, or Workers implementation.

## The whole flow

`Whim audio → save → OpenAI transcription → OpenAI Responses → execute pipes → delete successful Note content`

1. Verify the Whim request and save its audio, metadata, and work record before acknowledging it.
2. One background worker takes the next eligible Note and pins the current settings revision.
3. Send the original M4A file to OpenAI's transcription endpoint.
4. Make one Responses call with the transcript, routing instructions, and available pipes. A schema-constrained result supplies the selected pipe IDs and their arguments, including any proposed settings change. This combines decisions and extraction.
5. Validate the whole result, save it, and execute its actions sequentially. Record completed actions so recovery does not repeat them.
6. After every action succeeds, delete the recording, transcript, metadata, and generated payloads. Retain Note/action identities and operational statuses for deduplication and inspection.

An unclear destination uses the configured default webhook. An unclear settings command never changes configuration. Invalid model output or missing required arguments fails processing before effects; it is not a reason to invent values.

The OpenAI integration uses the documented [file transcription API](https://developers.openai.com/api/docs/guides/speech-to-text) and [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). “Decisions API” describes our use of Responses; it is not a separate verified endpoint. Configure the transcription and Responses model names. One provisioned OpenAI API key supplies both calls.

## Whim compatibility

Use `POST /receive` and follow the [existing Whim v1 contract](../../../../whim/docs/webhook-contract-v1.md):

- Verify bearer/HMAC authentication as configured, identity headers, raw metadata/audio hashes, and metadata consistency. Preserve original bytes before decoding JSON; signed requests use the reference five-minute tolerance.
- Atomically accept only the first payload for each Note ID, including simultaneous iPhone/Watch Attempts and retries after restart.
- Return `200`, the `X-Whim-Note-ID` header, and `{ "note_id": "...", "duplicate": false }` after durable acceptance. Duplicates return `duplicate: true` without new work, including after content cleanup.
- Validate and acknowledge `configuration.test` without processing or saving it as a user Note. Its zero duration is valid.
- Reject invalid requests with non-success responses. Whim permanently considers any `2xx` delivered, so subsequent processing failures belong to this server.

Cap incoming requests at 32 MiB. Check OpenAI's documented 25 MB transcription file limit; an accepted recording beyond it remains a recoverable failure. No audio conversion/chunking in v1.

## Pipes and live settings

There are two pipe types:

- **Webhook:** a provisioned destination defines its URL/method, credential references, argument schema, and request mappings. Support JSON, text, URL-encoded fields, multipart, and original audio as configured. OpenAI supplies arguments; the server builds and sends the request. The default destination accepts a generic Note without extra extracted fields.
- **Configure:** apply a validated change to routing instructions, model choices, prompts, or explicitly mutable pipe options. Voice cannot add destinations, change credentials/authentication references, or expand its own permissions.

Settings live in versioned SQLite records. Validate an update and atomically append/activate its revision; stale updates are rejected. The next unstarted Note uses it immediately. Running Notes and retries keep their original revision.

Rollback appends a new revision containing an earlier revision's settings. Record a configuration action and its result in the same transaction so it cannot apply twice. Rollback changes future processing; it does not undo external webhook effects.

A small admin API and CLI provide settings import/export, revision history, rollback, Note status, failed-work retry, and uncertain-action resolution. Their credential is separate from Whim credentials and the OpenAI key. Credentials remain separately provisioned and are excluded from model context, configuration exports as values, and logs.

## Failure handling

Save the transcript and chosen actions before effects. Resume saved work after restart and skip completed actions.

Retry transient OpenAI failures up to three total calls, with 30-second and two-minute delays, honoring a later valid `Retry-After`. Permanent errors or exhausted retries retain the Note as failed. Other eligible Notes continue while retries or owner decisions wait.

Record an external action as in flight before sending it. If its response is lost, or the process stops during it, mark it uncertain and preserve its content. Arbitrary webhooks cannot be assumed idempotent: the owner explicitly marks the action delivered or requests a retry. Explicit non-success webhook responses are also inspectable failures rather than automatically repeated effects.

Successful content deletion is immediate removal from the active application store; it does not erase owner backups or vendor copies. Configuration history retains deliberately changed settings. Never log Note content, payloads, or secrets.

## Delivery and verification

Ship the server/CLI image, Fly.io configuration, and concise setup, rollback, retry, and backup instructions. Keep the process alive for background work; stop new processing on shutdown and preserve interrupted-action uncertainty.

Verify signed uploads and configuration tests, concurrent deduplication, both OpenAI request/response contracts, default routing, all supported webhook formats, hot settings and rollback, restart recovery, uncertain outcomes, cleanup, and the actual container. Use deterministic local fixtures; report live OpenAI checks separately when credentials are supplied.

The previous multi-provider design is superseded. Approval of this shorter specification permits writing a correspondingly small implementation plan.
