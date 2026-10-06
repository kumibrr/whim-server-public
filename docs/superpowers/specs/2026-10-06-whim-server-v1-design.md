# Whim server v1 design

Date: 2026-10-06

Status: The conversational design was approved in three sections. This written specification is awaiting owner review before implementation planning.

## 1. Intended outcome

Each individual Whim user runs and manages their own small server instance. It accepts Notes through the existing Whim v1 webhook, interprets recordings through replaceable providers, and executes configured Pipes. A configuration Pipe lets spoken instructions change permitted settings without a restart. Owners can inspect history and roll back configuration even when provider processing is unavailable.

Success means a deployable Docker image, a Fly.io deployment configuration, and a working end-to-end Note flow with durable acceptance, recoverable processing, all three decision-provider adapters, destination-specific HTTP requests, hot configuration, rollback, and immediate cleanup of successful Note content.

The initial deployment is one Node 24+/TypeScript process and SQLite on a persistent volume. Cloudflare Workers is a later runtime adapter; v1 does not include a Workers deployment, multi-user hosting, a browser dashboard, or an external queue service.

## 2. Agreed decisions

| Concern | v1 decision |
| --- | --- |
| Ownership | One individual owner per deployment |
| Runtime | One receiver/background-processor process; Docker and Fly.io first |
| Acceptance | Save audio, metadata, and processing work durably before returning success |
| Processing | One active Note; other eligible Notes continue while retries or owner resolutions wait |
| Transcription | OpenAI file transcription initially; independently replaceable |
| Decisions | Jev, Cloudflare Clef, and OpenAI Responses adapters; one selected provider per Note |
| Extraction | OpenAI Responses structured extraction initially; independent of decisions and used when needed |
| Routing ambiguity | Use the configured Default Destination |
| Pipe execution | Multiple Actions in a validated, persisted, sequential plan |
| Destinations | Provisioned request recipes plus an extension interface for custom adapters |
| Configuration | Database-owned immutable revisions; admin API/CLI and file import/export |
| Voice authority | Allowed settings among provisioned integrations; no credential or destination registration changes |
| Cutover | Pin the latest revision at first processing start; preserve it on retries |
| Rollback | Activate a new revision containing earlier settings |
| Provider failures | Bounded retries against the same selected backend; no automatic provider fallback |
| Unknown external effects | Pause for explicit Owner Resolution |
| Successful content | Delete audio, Note content, transcript, and generated payloads after all Actions succeed |
| Surviving records | Minimal operational records, deduplication identities, and configuration history |

Terms are defined in [CONTEXT.md](../../../CONTEXT.md).

## 3. Whim interoperability

The authoritative incoming protocol is the [Whim webhook contract](../../../../whim/docs/webhook-contract-v1.md). This server chooses `POST /receive`; Whim permits any exact configured endpoint URL.

The request is `multipart/form-data` with `metadata` containing exact UTF-8 JSON bytes and `audio` containing AAC `.m4a` bytes with media type `audio/mp4`. Metadata includes schema version, event, immutable Note ID, Attempt ID, capture time/duration, source device, title and its source, capture outcome, Workflow ID, audio size/hash, and app version/build.

Validate the required identity, timestamp, and SHA-256 headers; verify hashes over the original part bytes before decoding JSON. Validate header/metadata identities and audio length/hash consistently. Reject malformed UTF-8 rather than replacing bytes before verification. Verify configured bearer authentication and HMAC signatures with constant-time comparisons. The canonical HMAC input is `v1`, timestamp, Note ID, Attempt ID, metadata digest, and audio digest joined by newlines without a final newline. Signed requests use a five-minute timestamp tolerance.

Store the first accepted audio/metadata and one processing record atomically, keyed by normalized Note UUID. Different devices, titles, or Attempt IDs do not create a second Note. Validate authentication and payload integrity even for duplicate requests.

Return `200` with `X-Whim-Note-ID` and JSON `{ "note_id": "...", "duplicate": false }` after durable acceptance; valid duplicates return the same acknowledgement with `duplicate: true`. A duplicate of a previously completed, content-purged Note remains successful and does not recreate its content or work. Any `2xx` permanently creates a Whim Receipt, so the response never claims downstream completion.

For `event: "configuration.test"`, use the same verification and acknowledgement but do not create Note work or invoke any Provider or Pipe. Zero duration is valid for the app's test recording. A test ID is not reserved as a delivered user Note.

Use meaningful non-success statuses: malformed requests `400`, failed authentication `401`, absent route `404`, wrong method `405`, oversized requests `413`, and durable-store failure `500`/`503`. Overload may return `429` with `Retry-After`. Do not redirect the receiver. Public deployments provide HTTPS through the deployment platform or reverse proxy.

An incoming request cap of 32 MiB matches the reference receiver but is a server limit, not a universal Whim protocol rule. Provider-specific limits are checked before their requests. OpenAI's documented transcription limit is 25 MB; larger accepted recordings become recoverable processing failures rather than being silently discarded. Automatic chunking/transcoding is outside v1.

## 4. Modules and interfaces

The process composes these modules through small interfaces; tests exercise the same interfaces as callers:

- **Receiver:** validates the Whim request and durably accepts or acknowledges a Note.
- **Durable processing store:** owns Note identities, content, stage checkpoints, eligibility times, Action outcomes, and the single active-processing claim.
- **Workflow processor:** pins configuration, runs stages, validates and records a plan, executes Actions, and finalizes content cleanup.
- **Transcription adapter:** accepts original audio and returns transcript text or a classified failure.
- **Decision adapter:** accepts transcript/context and declared candidate questions, returning normalized decisions with optional provider-specific evidence.
- **Extraction adapter:** produces schema-constrained arguments when recipe mappings or configuration changes need free-form values.
- **Pipe registry/executor:** resolves stable provisioned Pipe IDs and executes validated Actions.
- **Configuration module:** validates revisions, enforces authority, activates changes, exports/imports definitions, and restores earlier settings.
- **Admin interface and CLI:** expose inspection and explicit recovery without depending on Providers.

Storage, scheduling, HTTP transport, and secret resolution have explicit interfaces. The v1 implementations use SQLite, the Node process, HTTP, and separately provisioned secrets. A future Workers implementation can replace these adapters without changing the incoming Whim contract or Provider roles. No speculative Workers code is included.

## 5. Durable processing and ordering

Logical flow:

`receive → durable acceptance → pin revision → transcribe → decide → extract if needed → validate/persist plan → execute Actions → purge successful content`

Processing states are `queued`, `processing`, `retry_wait`, `failed`, `uncertain`, and `succeeded`. The store also records the current stage and due time. `failed` and `uncertain` retain recovery content. No active processing claim is required while a Note waits for a retry or owner decision.

Claim the earliest accepted eligible Note. Acceptance order is the server's order, not a promise about capture timestamps across disconnected devices. Only one Note is active. Notes whose retries are not due, or that need Owner Resolution, do not block later eligible Notes.

At first claim, record the active Server Configuration Revision and the selected stage integrations. Resume with those identities and that revision after a crash or retry. Completed transcription, extraction, and planning stages are checkpointed so recovery does not regenerate a plan after effects have started.

Every Action has a stable ID derived from its Note and persisted plan position. Persist the entire plan, including arguments, before executing any Action. All selected Pipe IDs, required fields, mappings, and configuration proposals must validate before the first effect. No valid prefix is executed from an invalid plan.

Execute the plan in its recorded order and checkpoint each result. A v1 plan invokes each selected Pipe at most once; multiple different Pipes are supported. Request recipe order is explicit in configuration and is used when assembling several selected Pipes. Owners can change that order administratively.

When all Actions have known successful outcomes, transition to `succeeded` and purge Note content atomically. Empty or unusable routing results select the configured Default Destination rather than pretending an empty plan succeeded.

## 6. Provider integration

Jev and Clef are typed decision models. Jev is text-only; Clef's hosted schema has no audio input. Neither supplies arbitrary transcription or generated payload fields. This is why transcription, decisions, and extraction are separate roles. See the [Jev/Clef research](../../research/2026-10-05-jev-clef-capabilities.md).

The decision registry ships adapters for:

- Jev: `POST https://api.typesafe.ai/v1/systemone`, bearer authentication, configured model, state, and typed questions.
- Clef: the Cloudflare Workers AI REST endpoint for `@cf/cloudflare/clef`, account/token configuration, and the documented model-specific state/questions body.
- OpenAI Responses: structured decision output with a configured compatible model and local validation.

The owner expressly approved Responses as the OpenAI integration after research could not verify a separately named Decisions API. Do not label the adapter as a verified Decisions API. See the [OpenAI research](../../research/2026-10-05-openai-decisions-api.md).

All adapters use the same server-facing decision intent: choose provisioned Pipes or the Default Destination, and identify an explicit configuration command when present. Questions and state are compiled from the pinned revision and Note transcript. Multiple selected Pipes must remain possible with Jev/Clef's finite-choice primitives. Reject out-of-registry answers, invalid distributions, invalid structured output, and incomplete/refused responses.

Probability distributions and confidence values are optional evidence with identified provider semantics. Do not invent OpenAI probability distributions or apply a single uncalibrated threshold across Jev/Clef/OpenAI. A configured certainty policy is provider-specific; absent adequate routing evidence, select the Default Destination.

Provider availability/authentication failures are not routing ambiguity and do not send a Note to the Default Destination. They follow failure/retry rules. An unavailable selected provider is never silently replaced with another vendor.

OpenAI transcription sends the original `.m4a` file with appropriate filename/media metadata. Extraction receives the transcript, required argument schema, and necessary non-secret context. Recipes that can map transcript/metadata/audio directly skip extraction. Model IDs, endpoint settings, language hints, and prompts belong to configuration rather than processor code. Users initially need OpenAI for transcription and any extraction even when their decision provider is Jev or Clef.

## 7. Destination recipes and configuration Pipe

A provisioned HTTP recipe declares a base destination URL, method, encoded path/query mappings, credential/header mappings, argument schema, body format, explicit execution order, and successful response statuses (default `2xx`). It also declares any voice-mutable non-secret options. Redirects are not followed automatically; a destination's final URL is provisioned directly.

Body formats include nested JSON, text, URL-encoded fields, multipart fields/files, and original audio. Mappings construct values from literals or declared references to Note metadata, transcript, extracted arguments, and decision results. Original audio is available as bytes/file content until completion. Structured mappings and encoding rules must preserve JSON types and correctly escape text/path/query/form values. Recipes do not execute arbitrary scripts.

The agent supplies schema-validated arguments, not credentials or a new authority/host. Required values are not invented to satisfy a schema. Missing or invalid arguments produce a recoverable failed Note before any effects. The configured Default Destination must accept a generic Note mapping without requiring additional extracted fields; configuration validation enforces that property.

Bearer/basic/custom header or query authentication references separately provisioned secrets. Secret references can be resolved for transport but are not exposed in model context, exports as values, or logs. Complex protocols, token refresh, or multi-request integrations use the custom Pipe adapter interface; v1 does not implement every third-party protocol.

The built-in configuration Pipe proposes typed changes through the same extraction/validation process. It may select among registered Providers, adjust routing descriptions and processing prompts, and change explicitly allowed non-secret Pipe options. It cannot register destinations/Providers, replace URLs or authentication references, change credentials, expand its own authority, or submit arbitrary code.

An ambiguous configuration instruction never mutates settings. Route that Note to the Default Destination using the ordinary fallback behavior. An explicit but invalid/stale configuration proposal fails with an inspectable outcome rather than silently applying a different change.

Configuration mutation and its successful Action checkpoint share one database transaction. A retry cannot apply the same configuration Action twice. A Note with configuration and destination Actions still executes its whole plan under its pinned revision; successful configuration activation affects subsequent unstarted Notes.

## 8. Configuration revisions, activation, and rollback

The database is the authoritative live configuration store. Environment/startup settings locate storage, configure listening, and supply independently provisioned credentials. File import/export is an administrative operation, not a file-watcher override.

Each revision stores immutable settings, integration definitions/secret references, schema version, parent revision, creation time, change source, and optional originating Action ID. Activation validates schemas, integration references, the Default Destination, mappings, and the voice authority rules. Updates provide an expected active revision; stale updates return a conflict and preserve current settings.

Create the revision and switch the active pointer atomically. The processor obtains the current revision on each first processing claim, so hot changes require no restart. An invalid update leaves the active revision intact. Exported files contain definitions and references, never resolved credentials.

Rollback reads an earlier revision, validates it against currently available adapter/secret references, and activates its settings as a new revision with restore provenance. History is preserved. Rollback does not undo already completed external effects, restore rotated secret values, or change a running Note's pinned revision.

The admin API/CLI remains usable when processing Providers fail. Database unavailability is a distinct failure: neither configuration mutation nor durable Note acceptance may claim success without persistence. Bootstrap validates the initial configuration before normal processing starts; setup errors must be actionable without leaking secrets.

## 9. Failure and recovery policy

Stage failures distinguish transient availability/rate-limit/timeout errors from permanent credentials, input, schema, or account errors. Interpret vendor-specific rate-limit reasons where documented instead of assuming every `429` is temporary. Provider retries use the selected integration and saved stage inputs.

Default stage retry policy is three total calls, with delays of 30 seconds and two minutes between retryable failures. Honor a valid later `Retry-After` time without increasing the attempt budget. Default request timeouts are 120 seconds for transcription and 30 seconds for decisions/extraction. These are server defaults, configurable administratively; they are separate from Whim's device Attempt policy. Exhaustion or permanent failure produces `failed` and preserves content.

Before an external request, durably mark its Action `in_flight`. Record a known successful response as `succeeded`, or an explicit non-success response as `failed`. A lost response, transport failure after execution begins, or restart with an `in_flight` external Action becomes `uncertain`. Conservatively treating transport failures as uncertain avoids guessing whether bytes reached the destination.

Send stable Action and Note identities for cooperative downstream deduplication, but do not assume arbitrary webhooks honor them. Do not automatically replay uncertain external effects. Non-success external responses also require owner retry unless a custom adapter has an explicitly defined safe recovery contract. Bounded automatic retries in this design apply to Provider stages, not a blanket retry promise for arbitrary destination webhooks.

The owner may mark an uncertain Action delivered or explicitly retry it, acknowledging possible duplicate effects. Owner-delivered resolution records provenance and counts as a successful outcome. Completed Actions remain completed when later Actions resume. Failed stages can be retried with their pinned revision and inputs.

Changing the revision of a failed Note requires a distinct explicit reprocessing command. Permit that only before any Pipe effects have begun; reset processing stages and pin the explicitly chosen revision. Once effects have begun, resume the existing plan or resolve its outcomes rather than silently replanning it. This preserves recovery when an old Provider configuration is broken without repeating prior effects.

## 10. Admin API and CLI

Use an admin credential distinct from Whim bearer/HMAC credentials and integration secrets. Operational responses do not return Note content, destination request/response bodies, or resolved secrets.

The public interface must support these use cases; the implementation plan will assign concrete route and CLI names:

- Inspect the active configuration and list/read immutable revision definitions.
- Validate/import a revision with expected-current concurrency control; export definitions; activate rollback.
- Inspect/list Note states, pinned revisions, stage failures, and Action outcomes.
- Retry failed work under its pinned revision.
- Explicitly reprocess a failed Note under a chosen revision before effects have begun.
- Resolve an uncertain Action as delivered or request an explicit retry.
- Inspect receiver/process health separately from Provider reachability.

Status inspection for a completed Note remains available after its content is deleted. Record stable sanitized error codes/statuses rather than arbitrary Provider/destination response bodies. Unknown administrative requests must not execute processing or mutate configuration.

## 11. Persistence and content lifecycle

Persist the inbox, processing checkpoints, plans/arguments, Action outcomes, configuration history, and active revision on the volume. Transaction boundaries prevent acknowledgements before persistence, duplicate Note work, duplicate local configuration changes, and partial successful cleanup. A durable processing claim prevents two processors from executing Notes concurrently if a second process accidentally uses the same database.

On successful completion, remove audio, original capture metadata/title, transcript, model context/raw replies, extracted values, plan argument bodies, and retained external payloads. Keep the Note ID, first accepted Attempt ID, acceptance/processing times, operational state, pinned revision ID, stable Action IDs, Pipe IDs, sanitized status/error codes, retry counts, and model identity where useful. Deduplication identities remain even when successful content is removed.

Configuration history intentionally retains settings created by an authorized configuration command, including changed prompt text. Those settings are configuration, not an archive of its originating recording. Failed/uncertain Notes retain the content required for recovery until resolved; no automatic expiry of unresolved work is introduced.

Immediate deletion means removal from the active application store after success. It does not promise forensic erasure from storage media, SQLite journals, owner-created backups, or vendor systems. Deployment documentation must make this distinction clear. The server does not log audio, Note titles/transcripts, request bodies, credential values, or model-generated payloads.

Use SQLite-consistent backup/restore operations. A restore includes configuration history and deduplication records, and documents that restoring an old backup can restore old unresolved work/outcomes. V1 uses one storage-owning Machine, not independently writable replicas of local volumes.

## 12. Packaging and operations

Provide a reproducible Docker build and runnable image with the production server and CLI. Mount one persistent data directory. Document bootstrap provisioning, separate secret roles, receiving a real Note, configuration import/export, voice changes, rollback, failure resolution, backup/restore, and upgrades.

Provide a Fly.io application configuration using the same image/process and a persistent volume. Keep the process running while accepted work exists; HTTP traffic alone must not govern background execution. Include health checks and graceful shutdown: stop new claims, complete/checkpoint active work within the shutdown allowance, and preserve external uncertainty if interrupted.

Do not initialize external accounts, deploy a live instance, send owner audio to vendors, or create billable resources as part of ordinary implementation verification. Provider contract tests use recorded schemas and local deterministic fixtures. Live vendor smoke tests are separate, explicitly configured checks and must not be claimed as completed when unavailable.

Preserve applicable MIT notices if substantial reference receiver code is reused from Whim. The server remains an independent package and does not require the Apple app's build toolchain.

## 13. Acceptance and verification

Behavior is built in vertical slices with public-interface tests. Acceptance requires:

1. Correct signed/unsigned-as-configured multipart validation, raw-byte hash verification, tamper/auth rejection, malformed input handling, and matching Note acknowledgements.
2. Configuration-test acknowledgement without work, including zero duration.
3. Concurrent device Attempts and lost-response retries yielding one first payload/work item, including after restart and successful content deletion.
4. A complete local fixture flow through transcription, each of the three decision adapters, optional extraction, and multiple destination Actions.
5. Default Destination selection for unclear routing, with no automatic fallback on Provider outages and no mutation from ambiguous configuration speech.
6. JSON/text/form/multipart/audio request serialization, credential resolution without model exposure, and rejection of invalid required arguments before any effects.
7. Persisted stage/Action recovery, bounded retries and due-time scheduling, and no replay of completed effects.
8. Lost-response/crash uncertainty with explicit delivered/retry resolution and content retained until resolved.
9. Valid hot activation, invalid/stale edit rejection, immutable rollback history, duplicate configuration Action suppression, and correct queued/running revision cutover.
10. Admin operation with unavailable Providers, credential separation, import/export without secret values, and pre-effect explicit reprocessing.
11. Success cleanup with only operational/deduplication records retained; unresolved work remains recoverable.
12. Building and running the actual container, persistence across replacement/restart, receiver and admin health, and graceful shutdown behavior.

Live model accuracy, hosted Clef confidence formulas, and real account access are not established by deterministic contract tests. Verification reports must distinguish mocked contract coverage, local container evidence, and any optional live checks.

## 14. Design alternatives and scope limits

The selected architecture embeds the processor beside the receiver with a durable local store: it fits one owner, one active Note, and one deployable unit. Separate receiver/processor processes add supervision and lifecycle coordination. An external broker/database adds provisioning and supports independent scaling. Those alternatives remain possible later but are not necessary for the agreed v1.

Additional transcription/extraction vendors, Workers hosting, a dashboard, provider ensembles, arbitrary executable transformations, automatic audio transcoding, generalized workflow graphs, and prebuilt adapters for every destination are deferred. Easy replacement means stable adapter interfaces, configured model/integration identities, and shared behavioral contract tests, not identical model capabilities or guaranteed identical decisions.

## 15. Review handoff

The 25 decision questions and all three conversational design sections have been resolved/approved. This specification consolidates those decisions and makes recovery/default behavior explicit. The next step is owner review of this file. After approval, use the superpowers writing-plans skill to create the implementation plan; review that plan and select execution before product code is written.
