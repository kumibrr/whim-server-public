# Whim server

Receive Whim audio, transcribe it with OpenAI, make one Responses call to select webhook actions and arguments, then execute them sequentially. One owner, one Node 24 process, and SQLite on a persistent volume. Spoken configuration takes effect for the next unstarted Note; settings history supports rollback.

## Run

```sh
npm ci
cp config.example.json config.local.json
```

Edit the webhook URL and request recipe in `config.local.json`. The default pipe must accept an empty argument object; it receives unclear requests without invented fields. Choose transcription and Responses model names available to your OpenAI account. This server uses an OpenAI API key; a ChatGPT subscription alone is not an API credential.

Provision `OPENAI_API_KEY`, a distinct `WHIM_ADMIN_TOKEN`, and Whim's `WHIM_BEARER_TOKEN` and/or `WHIM_HMAC_SECRET` through your environment. Generate random tokens with `openssl rand -hex 32`. Do not commit secrets. Then:

```sh
export WHIM_BOOTSTRAP_FILE="$PWD/config.local.json"
npm run build
npm start
```

Set Whim's endpoint to `https://your-server/receive` and enter the matching bearer/HMAC credentials. Terminate HTTPS at your proxy. Whim's configuration test verifies the contract without creating work. Its Sent status means audio and work were durably accepted; inspect processing through the admin API/CLI.

```sh
docker build -t whim-server:v1 .
docker volume create whim_data
docker run --name whim-server -p 8788:8788 \
  --mount source=whim_data,target=/data \
  --mount type=bind,source="$PWD/config.local.json",target=/bootstrap.json,readonly \
  -e WHIM_BOOTSTRAP_FILE=/bootstrap.json \
  -e OPENAI_API_KEY -e WHIM_ADMIN_TOKEN -e WHIM_BEARER_TOKEN -e WHIM_HMAC_SECRET \
  -e WHIM_CREDENTIALS_JSON whim-server:v1
```

Bootstrap is read only when the database has no revisions. Editing that file later does not update the server. Use the CLI/admin API for validated live changes. For bind-mounted data directories, give the container's `node` user (UID 1000) write access; named volumes work with the image's permissions.

## Recipes and credentials

Recipes supply `url`, HTTP `method`, public `headers`, credential references in `authHeaders`, an `argsSchema`, and `body: {format, mapping}`. Formats: `json`, `text`, `form` (URL-encoded), `multipart`, and `audio`. Multipart audio fields use `audio/mp4` and `note.m4a`; raw audio requires an audio mapping. GET sends no body. Requests do not follow redirects.

Mapping objects use `{ "source": "args" | "note" | "options", "path": "nested.field" }`, `{ "source": "transcript" }`, `{ "source": "audio" }`, or `{ "source": "literal", "value": ... }`. Nest mappings to build JSON objects/arrays, or a field object for form/multipart. An empty path selects the whole source. Argument schemas support objects, arrays, primitive/nullable types, enums, and descriptions. Objects are closed and all declared properties become required; use nullable fields for optional values. Missing required values fail before any effects.

For authenticated destinations, use an entire header value reference, for example `"authHeaders": {"Authorization": "inboxAuth"}`, and separately provision `WHIM_CREDENTIALS_JSON` as `{"inboxAuth":"Bearer your-token"}`. Credential values stay outside settings, model context, and exports. Keep URL and public header fields free of secrets. OpenAI sees pipe descriptions, argument schemas, and options; it does not see destination URLs or credential references.

Voice may change instructions, model names, the default among registered pipes, and scalar `options` keys listed in that pipe's `mutableOptions`. It cannot change destinations, request recipes, credentials, schemas, or its own permissions. Configuration actions check the pinned revision and reject competing newer edits.

## Admin and recovery

Set `WHIM_SERVER_URL` (default `http://127.0.0.1:8788`) and `WHIM_ADMIN_TOKEN` for the CLI. In Docker use `docker exec whim-server node dist/cli.js ...`.

```sh
npm run cli -- config show
npm run cli -- config export config.local.json
npm run cli -- config import config.local.json
npm run cli -- config history
npm run cli -- config rollback 1
npm run cli -- notes list
npm run cli -- notes show NOTE_UUID
npm run cli -- notes retry NOTE_UUID
npm run cli -- notes resolve NOTE_UUID ACTION_INDEX delivered
npm run cli -- notes resolve NOTE_UUID ACTION_INDEX retry
```

Import accepts an optional expected revision number after the filename. Rollback creates a new revision with earlier settings; it affects unstarted Notes and never undoes webhook effects. Running Notes and their retries keep their saved revision. A stale voice command remains failed; apply the intended change administratively.

Provider failures get at most three calls per stage with 30-second and two-minute delays (a later Retry-After wins). Waiting/failed Notes allow other eligible work to continue. Failed retries resume saved transcript/plan and skip successful actions. Webhook errors are not automatically retried. A lost response or interrupted send becomes `uncertain`; inspect the destination before marking delivered. Explicit retry can duplicate a side effect. Successful Notes immediately lose audio, metadata, transcript, and payloads; operational IDs/statuses remain. Failed/uncertain content stays in the database. Active-store deletion does not erase backups or OpenAI/destination copies.

The admin API uses `Authorization: Bearer <admin token>`:

| Method/path | Request or result |
| --- | --- |
| GET `/admin/config` | Current revision/settings |
| PUT `/admin/config` | `{settings, expectedRevisionId}` |
| GET `/admin/config/revisions` | Immutable revision history |
| POST `/admin/config/rollback` | `{targetRevisionId, expectedRevisionId}` |
| GET `/admin/notes`, GET `/admin/notes/:id` | Operational status only |
| POST `/admin/notes/:id/retry` | Explicit failed-work retry |
| POST `/admin/notes/:id/actions/:index/resolve` | `{resolution: "delivered" | "retry"}` for uncertainty |

## Fly.io, upgrades, and backups

Keep one machine and one volume. Set the app name in `fly.toml` through `fly launch --no-deploy`, retain the provided service/mount settings, and provision:

```sh
fly volumes create whim_data --region mad --size 1
fly secrets import < .env
fly deploy --ha=false
fly scale count 1
```

Your secret file should contain the required environment variables. For first bootstrap on Fly, provide `WHIM_BOOTSTRAP_FILE=/app/config.example.json` plus a customized non-secret `config.example.json` before building, or start with an empty database and use the admin API's first PUT with `expectedRevisionId: 0`. Keep autostop off so accepted work runs without further traffic. Fly setup/deployment requires your account and is not part of local tests. See [Fly configuration](https://docs.fly.io/reference/configuration).

Before an upgrade, stop the server and copy the whole data directory, including any SQLite WAL/SHM files; restart the same image/volume to resume work. Restore backups only while stopped. Restoring a backup can forget deliveries made since that backup; reconcile those with destinations to avoid duplicates. Protect backups and credential provisioning separately. Image rollback and settings rollback are separate operations.

Environment controls: `WHIM_DATABASE`, `WHIM_HOST`, `WHIM_PORT`, `WHIM_BOOTSTRAP_FILE`, `WHIM_POLL_MS` (1000), `WHIM_SHUTDOWN_MS` (10000), and `OPENAI_BASE_URL` (normally the official `/v1` endpoint; override for local fixtures). Signed timestamps allow five minutes; uploads cap at 32 MiB. OpenAI transcription caps at 25 MB; larger accepted recordings are retained as failed without conversion.

## Verify

```sh
npm run test -- src/*.test.ts
npm run check
npm run build
docker build -t whim-server:v1 .
```

Tests use local HTTP fixtures, no paid calls. On a Linux Docker host, run `npm run test:container` after building for actual image acceptance, processing, cleanup, restart, CLI rollback, and dedupe. Live OpenAI verification requires provisioned credentials and is separate. Contracts and scope: [approved design](docs/superpowers/specs/2026-10-06-whim-server-v1-design.md), [OpenAI transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). Whim receiver attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
