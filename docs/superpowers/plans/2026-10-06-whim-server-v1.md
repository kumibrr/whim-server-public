# Whim Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a small, self-managed Whim server using OpenAI transcription and Responses, configurable webhooks, and recoverable voice configuration.

**Architecture:** One HTTP receiver and one serial background worker share SQLite. Save each stage before continuing; configuration revisions and action outcomes survive restarts. Use ordinary functions and modules, without provider abstractions.

**Tech Stack:** Node 24, TypeScript, built-in HTTP/crypto/fetch/SQLite/test runner, Ajv 8 for JSON Schema validation, Docker, Fly.io.

**Spec:** [Approved OpenAI-only specification](../specs/2026-10-06-whim-server-v1-design.md).

## Global Constraints

- One owner, one process, one persistent SQLite volume; Docker/Fly.io first.
- Durable acceptance before `200`; one active Note; queued Notes use current settings, started Notes and retries stay pinned.
- Whim requests: 32 MiB cap, five-minute signed timestamp tolerance, Note-ID deduplication after cleanup.
- Original M4A transcription: 25 MB file limit; no conversion or chunking.
- One transcription stage and one Responses stage; no separate extraction, provider registry, plugins, or Workers implementation.
- OpenAI transient failures: three total calls per stage, delays of 30 seconds and two minutes, honoring a later valid `Retry-After`.
- No automatic webhook replay; uncertain actions require explicit owner resolution.
- Immediately delete successful Note content; retain operational records and configuration history. Never log content or secrets.
- Whim, admin, and OpenAI credentials are separate; voice cannot register destinations or change credential references.

## Review Focus

- Signed metadata with different JSON whitespace must verify against original bytes (Task 1).
- A duplicate arriving after successful cleanup must never create work again (Tasks 1 and 5).
- Responses refusal, incomplete output, or unsupported argument schemas must fail before effects (Tasks 2 and 3).
- A pinned voice change competing with a newer admin update must reject stale mutation (Tasks 2 and 5).
- A crash after webhook delivery but before checkpoint must become uncertain, never replay automatically (Task 5).

---

## Files and shared data

Create `src/types.ts` for shared records; `store.ts` for SQLite; `receiver.ts` for Whim HTTP; `config.ts` for validated revisions; `openai.ts` for the two API calls; `pipes.ts` for request construction; `process-note.ts` for background processing; `admin.ts`, `cli.ts`, and `server.ts` for administration and composition. Put companion `*.test.ts` beside each module, with fixture builders/local HTTP servers in `src/test-fixtures.ts`.

Define shared records once: `IncomingNote` contains Note/Attempt IDs, original metadata bytes, parsed metadata, and audio bytes; `Settings` contains transcription/Responses model names, instructions, default pipe ID, and provisioned webhook recipes; `Revision` contains ID and settings; `Plan` contains ordered `Action` records; `Job` contains saved stage content, pinned revision ID, next eligible time, and per-stage attempt counts. Actions distinguish webhook arguments from configuration patches; stored action outcomes use their ordered index as identity. `Secrets` resolves provisioned credential references and holds ingest/admin/OpenAI credentials. Secrets never enter Settings or model context.

Request mappings reference literals, arguments, Note metadata, transcript, or original audio. Recipes specify URL, method, headers/credential references, argument schema, body format, and explicitly voice-mutable options. Reserve `configure` as the configuration pipe ID. Use a default recipe requiring no extracted arguments.

### Task 1: Durable Whim acceptance

**Files:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`, `src/store.ts`, `src/receiver.ts`, `src/receiver.test.ts`, `src/test-fixtures.ts`.

**Interfaces:** `openStore(path: string): Store`; `Store.accept(note: IncomingNote): {duplicate: boolean}`; `createReceiver(store: Store, secrets: Secrets): import('node:http').RequestListener`.

- [ ] Write companion tests using real HTTP multipart fixtures and temporary SQLite files:

```ts
// signed_raw_bytes_and_durable_deduplication
assert.equal(first.status, 200);
assert.equal(first.headers.get('X-Whim-Note-ID'), noteId);
assert.deepEqual(await duplicate.json(), {note_id: noteId, duplicate: true});
// configuration_test_is_not_queued
assert.equal(queuedNotes.length, 0);
```

  Include concurrent Attempts, receiver restart, modified raw JSON whitespace, tampered hashes/signatures, identity mismatches, configured bearer auth, expired timestamps, malformed multipart, and the size cap. Use the adjacent Whim contract/reference fixtures; preserve MIT attribution if copying reference code.
- [ ] Run `npm run test -- src/receiver.test.ts`; expect failing acceptance assertions after creating the minimal runnable test harness.
- [ ] Implement the interfaces and atomic SQLite acceptance transaction, storing audio in SQLite with metadata/work records. Validate `configuration.test` with zero duration and acknowledge without queuing. Add scripts: `test` → `node --test`, `check` → `tsc --noEmit`, `build` → `tsc`; use explicit `.ts` imports with emitted extension rewriting. Ignore generated output/database files.
- [ ] Run `npm run test -- src/receiver.test.ts` and `npm run check`; expect all pass.
- [ ] Commit: `git add package.json package-lock.json tsconfig.json .gitignore src && git commit -m "feat: durably accept signed Whim notes"`.

### Task 2: Versioned live configuration

**Files:** Create `src/config.ts`, `src/config.test.ts`; extend `src/types.ts`, `src/store.ts`.

**Interfaces:** `validateSettings(value: unknown): Settings`; `Store.currentRevision(): Revision`; `Store.activate(settings: Settings, expectedRevisionId: number, source: 'admin' | 'voice' | 'rollback'): Revision`; `Store.rollback(targetRevisionId: number, expectedRevisionId: number): Revision`; `Store.claim(now: number): Job | null`.

- [ ] Write revision/permission/schema tests:

```ts
assert.equal(store.claim(now)!.revisionId, active.id);
assert.throws(() => store.activate(next, staleId, 'voice'));
assert.deepEqual(rolledBack.settings, original.settings);
assert.notEqual(rolledBack.id, original.id);
```

  Also reject missing default destinations, credential values, unsupported Responses schema shapes, and voice changes to URL/auth refs/permissions. Verify invalid changes preserve the active revision.
- [ ] Run `npm run test -- src/config.test.ts`; expect missing revision functionality failures.
- [ ] Implement immutable revision records, atomic compare-and-activate, rollback-as-new-revision, and claim-time pinning. Admin provisioning defines recipes and credential references; voice patches use an explicit allowlist. Restrict argument schemas to the supported Structured Outputs subset and normalize them for strict mode.
- [ ] Run `npm run test -- src/config.test.ts` and `npm run check`; expect pass.
- [ ] Commit: `git add src && git commit -m "feat: version and hot-load server settings"`.

### Task 3: Transcribe and choose actions with OpenAI

**Files:** Create `src/openai.ts`, `src/openai.test.ts`; extend shared types/fixtures.

**Interfaces:** `transcribe(audio: Uint8Array, settings: Settings, key: string): Promise<string>`; `decide(transcript: string, settings: Settings, key: string): Promise<Plan>`; `validatePlan(value: unknown, settings: Settings): Plan`. Typed API failures carry retry eligibility and optional retry-after time.

- [ ] Write tests against a local HTTP mock using a configurable API base URL:

```ts
assert.equal(transcriptionRequest.fileType, 'audio/mp4');
assert.equal(responsesRequests.length, 1);
assert.equal(defaultPlan.actions[0].pipeId, settings.defaultPipeId);
assert.equal(recordedRequests.includes(secretValue), false); // context/body only
```

  Check exact endpoint/body/model/schema contracts, typed multi-action arguments, unambiguous configuration proposals, default routing, missing fields, refusals, incomplete responses, oversized audio, and permanent/transient errors. No live vendor calls in the suite.
- [ ] Run `npm run test -- src/openai.test.ts`; expect missing API behavior failures.
- [ ] Implement file transcription and Responses strict structured output using fetch and current official API contracts. Generate the action schema from provisioned recipes; combine routing and argument generation in this call. Parse and validate every action before returning a plan. Extract retry metadata; do not perform hidden retries inside these functions.
- [ ] Run `npm run test -- src/openai.test.ts` and `npm run check`; expect pass.
- [ ] Commit: `git add src && git commit -m "feat: transcribe and plan notes with OpenAI"`.

### Task 4: Execute provisioned webhook recipes

**Files:** Create `src/pipes.ts`, `src/pipes.test.ts`; extend shared types/fixtures.

**Interfaces:** `buildWebhookRequest(action: Action, job: Job, settings: Settings, secrets: Secrets): {url: string; init: RequestInit}`; `sendWebhook(request: {url: string; init: RequestInit}): Promise<void>`.

- [ ] Write local destination tests:

```ts
assert.deepEqual(receivedJson, expectedMappedPayload);
assert.deepEqual(receivedAudio, originalAudio);
assert.equal(destinationCallsAfterInvalidPlan, 0);
```

  Cover JSON, text, URL-encoded, multipart, raw audio, credential resolution, required arguments, and explicit HTTP failure versus lost response. Check secret references remain absent from model context.
- [ ] Run `npm run test -- src/pipes.test.ts`; expect missing serialization/delivery failures.
- [ ] Implement mappings and bounded requests with redirects disabled. Preserve arbitrary destination requirements through provisioned recipes; the model cannot supply arbitrary URLs/headers. Return failures to the processor without automatic replay. Configuration effects remain local transactions in Task 5.
- [ ] Run `npm run test -- src/pipes.test.ts` and `npm run check`; expect pass.
- [ ] Commit: `git add src && git commit -m "feat: deliver configured webhook request formats"`.

### Task 5: Serial processing, recovery, and cleanup

**Files:** Create `src/process-note.ts`, `src/process-note.test.ts`; extend `src/store.ts` and shared records.

**Interfaces:** `processNext(store: Store, secrets: Secrets, now: number): Promise<boolean>` returns whether work ran. Store gains `saveTranscript(noteId: string, transcript: string): void`, `savePlan(noteId: string, plan: Plan): void`, `recoverInterrupted(): void`, and transactional state transitions owned by this module. Persist stage attempts, deadlines, action outcomes, and failure reasons.

- [ ] Write restart tests with fake time and local services:

```ts
assert.equal(recoveredAction.status, 'uncertain');
assert.equal(webhookCallsAfterRestart, webhookCallsBeforeRestart);
assert.equal(openAiCallsAtExhaustion, 3);
assert.equal(successfulNote.audio, null);
assert.equal(duplicateAfterCleanup.duplicate, true);
```

  Verify sequential actions, saved-stage resume, completed-action skipping, 30/120-second retry scheduling, later Retry-After, other eligible work during waits, pinned revisions, stale voice edits, atomic configure/outcome commit, and full content purge.
- [ ] Run `npm run test -- src/process-note.test.ts`; expect missing processing/recovery failures.
- [ ] Implement claim → transcription → saved plan → sequential effects. Persist in-flight before external sends; startup converts interrupted sends to uncertain. Explicit non-success responses become failed. Apply configure actions and outcomes together with revision comparison. Retry OpenAI stages only; retain failed/uncertain content. Full success removes all Note/generated content while keeping operational tombstones.
- [ ] Run `npm run test -- src/process-note.test.ts` and `npm run check`; expect pass.
- [ ] Commit: `git add src && git commit -m "feat: recover queued processing and purge successful content"`.

### Task 6: Owner controls and deployable image

**Files:** Create `src/admin.ts`, `src/admin.test.ts`, `src/cli.ts`, `src/cli.test.ts`, `src/server.ts`, `Dockerfile`, `.dockerignore`, `fly.toml`, `README.md`, `config.example.json`; extend `src/store.ts` and package scripts.

**Interfaces:** `createAdminHandler(store: Store, adminToken: string): import('node:http').RequestListener`; `runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number>`; server composes receiver/admin routes and the serial polling loop.

- [ ] Write HTTP/CLI tests:

```ts
assert.equal(adminWithIngestToken.status, 401);
assert.equal(await runCli(historyArgs, testEnv), 0);
assert.equal(resolvedAction.status, 'delivered');
assert.equal(exportedConfig.includes(openAiKey), false);
```

  Cover import/export/history/rollback, failed retry, uncertain delivered/retry decisions, invalid transitions, and shutdown with work in flight.
- [ ] Run `npm run test -- src/admin.test.ts src/cli.test.ts`; expect missing owner-control failures.
- [ ] Implement bearer-authenticated `/admin/config`, revision history/rollback, Note list/detail/retry, and action-resolution routes with matching CLI commands. Return operational status, excluding retained content. Bootstrap from the example file only for an empty database. Add `/healthz`, graceful shutdown, Node 24 image, persistent `/data`, and Fly configuration keeping one machine alive. Document provisioning, upgrade/backup, rollback, retries, and potential duplicate effects after owner-requested webhook replay.
- [ ] Run `npm run test -- src/*.test.ts`, `npm run check`, `npm run build`, and `docker build -t whim-server:v1 .`; expect all pass. Run the actual image with a temporary volume/local OpenAI mocks, submit signed Notes, restart it, exercise CLI rollback, and verify dedupe/cleanup. Report live OpenAI verification separately if credentials are supplied; do not deploy remotely without instruction.
- [ ] Commit: `git add src package.json package-lock.json Dockerfile .dockerignore fly.toml README.md config.example.json && git commit -m "feat: ship owner controls and Docker deployment"`.

## Handoff

Self-review covers every approved requirement, shared signatures, the five review-focus cases, and the actual container check. Recommend native execution: these six tasks share the same small persistence model, and one final independent review keeps the workflow compact. Implementation starts after plan review and execution-method selection.
