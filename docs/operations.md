# Running Whim server

Start with the [README](../README.md) for browser setup and Docker. This guide covers configuration files, request recipes, recovery, and deployment.

## Other setup methods

Both the browser and terminal wizards configure an empty server. They refuse to overwrite existing settings. For later changes, use `config import` or the admin API. Competing setup sessions receive HTTP 409.

For terminal setup, set `WHIM_ADMIN_TOKEN` and, for a remote server, `WHIM_SERVER_URL` in the client environment:

```sh
npm run cli -- config setup
```

The command shows the settings and asks you to type `yes` before saving. In Docker, run `docker exec -it whim-server node dist/cli.js config setup`.

To start from a file:

```sh
cp config.example.json config.local.json
# Edit the destination URL and request recipe before starting.
export WHIM_BOOTSTRAP_FILE="$PWD/config.local.json"
npm start
```

Bootstrap reads the file only when the database has no configuration revisions. Editing it afterward does not update the server. To import a file into an empty or configured server, run `npm run cli -- config import config.local.json`.

For Docker bootstrap, add these options to the README's `docker run` command:

```sh
--mount type=bind,source="$PWD/config.local.json",target=/bootstrap.json,readonly \
-e WHIM_BOOTSTRAP_FILE=/bootstrap.json
```

The browser keeps the admin token in memory for the session. Its review step lets you edit the settings JSON to add pipes, mappings, and headers. The server includes the wizard in its Docker image, so you don't need a separate frontend service.

## Request recipes and credentials

Each pipe defines a destination URL, HTTP method, public `headers`, credential references in `authHeaders`, an `argsSchema`, and a `body` with `format` and `mapping`. Requests do not follow redirects.

| Body format | Sends |
| --- | --- |
| `json` | A mapped JSON value |
| `text` | Plain text |
| `form` | URL-encoded fields |
| `multipart` | Fields and optional audio, named `note.m4a` with type `audio/mp4` |
| `audio` | Raw audio, requires an audio mapping |

GET requests are fixed triggers without a body. Use `"body": {"format": "json", "mapping": {}}`. The server rejects content mappings for GET.

Mappings select data with these objects:

```json
{"source": "note", "path": "note_id"}
{"source": "args", "path": "nested.field"}
{"source": "options", "path": "folder"}
{"source": "transcript"}
{"source": "audio"}
{"source": "literal", "value": "fixed value"}
```

Each line above is a separate mapping example. Use an empty path to select the whole `note`, `args`, or `options` object. Nest mappings to build JSON objects and arrays. Form and multipart bodies use a field object.

Argument schemas support objects, arrays, primitive types, nullable types, enums, and descriptions. Objects reject undeclared properties, and every declared property becomes required. Use nullable fields for optional values. The server rejects missing required arguments before executing any action.

The default pipe must accept an empty argument object. It handles unclear routing without invented fields.

For an authenticated destination, add `"authHeaders": {"Authorization": "inboxAuth"}` to the pipe. Provision the whole header value in the server environment:

```sh
export WHIM_CREDENTIALS_JSON='{"inboxAuth":"Bearer your-token"}'
```

Keep secrets out of URLs and public headers. Settings exports contain references, not credential values. OpenAI receives pipe descriptions, argument schemas, and options. It does not receive destination URLs or credential references.

Voice commands can change instructions, model names, the default among registered pipes, and scalar options listed in a pipe's `mutableOptions`. They cannot change destinations, recipes, credentials, schemas, or permissions. A voice configuration action checks its saved revision and fails if a newer edit has replaced it.

## Admin commands and API

Set `WHIM_SERVER_URL` and `WHIM_ADMIN_TOKEN` in the CLI environment. The default URL is `http://127.0.0.1:8788`.

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

Import accepts an optional expected revision number after the filename. In Docker, replace `npm run cli --` with `docker exec whim-server node dist/cli.js`.

The admin API requires `Authorization: Bearer <admin token>`.

| Method and path | Request or result |
| --- | --- |
| GET `/admin/config` | Current revision and settings |
| GET `/admin/config/template` | Initial settings and body-format presets, without secrets |
| PUT `/admin/config` | `{settings, expectedRevisionId}` |
| GET `/admin/config/revisions` | Immutable revision history |
| POST `/admin/config/rollback` | `{targetRevisionId, expectedRevisionId}` |
| GET `/admin/notes` | Operational statuses |
| GET `/admin/notes/:id` | One Note's operational status |
| POST `/admin/notes/:id/retry` | Explicit retry of failed work |
| POST `/admin/notes/:id/actions/:index/resolve` | `{resolution: "delivered" \| "retry"}` |

Before setup, `GET /admin/config` returns `{"id": 0, "settings": null}`. The template endpoint returns `{settings, bodyFormats}` without activating them. To configure an empty server through the API:

```sh
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({settings: JSON.parse(fs.readFileSync("config.local.json", "utf8")), expectedRevisionId: 0}))' > setup-request.json
curl --fail-with-body "$WHIM_SERVER_URL/admin/config" \
  -X PUT -H "Authorization: Bearer $WHIM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @setup-request.json
```

## Recovery and data retention

Retryable OpenAI failures get at most three calls per stage. The server waits 30 seconds before the second call and two minutes before the third. A later `Retry-After` takes precedence. Waiting or failed Notes don't block other eligible work.

Webhook errors have no automatic retries. Retrying a failed Note reuses its saved transcript and plan, and skips successful actions.

A lost response or interrupted webhook send leaves the action `uncertain`. Check the destination before resolving it. Mark it `delivered` if the request took effect, or choose `retry` to send it again. A retry can duplicate an external effect.

Settings rollback creates a new revision from earlier settings. It affects Notes that haven't started processing and never reverses webhook effects. Running Notes and their retries keep their saved revision. A stale voice command stays failed. Apply the intended settings change through the CLI or admin API.

After a Note succeeds, the server deletes its audio, metadata, transcript, and payloads from the active database. Operational IDs and statuses remain. Failed and uncertain Notes keep their content. Deletion from the active database does not remove copies in backups, OpenAI, or webhook destinations.

Before upgrading, stop the server and copy the whole data directory, including SQLite WAL and SHM files. Start the new image with the same volume to resume work. Restore backups only while the server is stopped.

A restored backup can forget deliveries made since the backup. Reconcile those deliveries with destinations before retrying. Protect backups and credentials separately. Rolling back an image and rolling back settings are separate operations.

## Deploy to Fly.io

Use one machine and one persistent volume. Run `fly launch --no-deploy` to set the app name in `fly.toml`, and keep the supplied service and mount settings.

```sh
fly volumes create whim_data --region mad --size 1
fly secrets import < .env
fly deploy --ha=false
fly scale count 1
```

Your `.env` file should contain the server credentials. Keep it out of version control. After deployment, open your public HTTPS `/setup` URL to configure the empty database.

For file bootstrap, customize the non-secret `config.example.json` before building and set `WHIM_BOOTSTRAP_FILE=/app/config.example.json`. You can also configure through the admin API with `expectedRevisionId: 0`.

Keep autostop off so queued work runs without more incoming traffic. Fly deployment requires your own account and is separate from local tests. See the [Fly configuration reference](https://docs.fly.io/reference/configuration).

## Environment and limits

| Variable | Default or purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI credential |
| `WHIM_ADMIN_TOKEN` | Required, distinct admin credential |
| `WHIM_BEARER_TOKEN` | Receiver bearer credential |
| `WHIM_HMAC_SECRET` | Receiver signing secret |
| `WHIM_CREDENTIALS_JSON` | Destination credential values, defaults to `{}` |
| `WHIM_DATABASE` | `./data/whim.sqlite`, or `/data/whim.sqlite` in Docker |
| `WHIM_HOST` | `0.0.0.0` |
| `WHIM_PORT` | `8788` |
| `WHIM_BOOTSTRAP_FILE` | Optional initial settings file |
| `WHIM_POLL_MS` | `1000` |
| `WHIM_SHUTDOWN_MS` | `10000` |
| `OPENAI_BASE_URL` | Official OpenAI `/v1` endpoint, override for local fixtures |
| `WHIM_SERVER_URL` | CLI only, defaults to `http://127.0.0.1:8788` |

Signed requests allow five minutes of timestamp difference. Uploads cap at 32 MiB. The server's transcription limit is 25 MB. It retains larger accepted recordings as failed without converting them.

For bind-mounted data directories, give the container's `node` user, UID 1000, write access. Named volumes work with the image's permissions.

## Container releases

[ci.yml](../.github/workflows/ci.yml) runs tests and type checks, builds the Docker image, and runs the container smoke test against local provider and webhook fixtures. CI needs no OpenAI or destination credentials.

[images.yml](../.github/workflows/images.yml) runs on pushes to `feat/openai-server-v1`, tags matching `v[0-9]*`, and manual dispatch. It reuses the checks before publishing `linux/amd64` and `linux/arm64` images to `ghcr.io/kumibrr/whim-server-public`. Publication permits only the repository's default branch or a `v` tag. Update the push filter if you rename the default branch.

| Build | Published tags |
| --- | --- |
| Default branch | `latest`, `sha-<full commit SHA>` |
| Stable `v1.2.3` release | `v1.2.3`, `1.2.3`, `1.2`, `1`, `latest`, commit tag |
| Prerelease | Full version and commit tags, without changing `latest` or major/minor aliases |

The publish job summary lists tags and the digest. Publishing uses `GITHUB_TOKEN` with `packages: write`. Actions use pinned commit SHAs. Pull request checks have read-only repository permissions and never publish images.

Check the package visibility after the first publication and set it to public if you want anonymous pulls. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

```sh
docker pull ghcr.io/kumibrr/whim-server-public:latest
# Pin a release when you want upgrades to be an explicit choice.
docker pull ghcr.io/kumibrr/whim-server-public:1.2.3
```

Use the chosen tag in the README's Docker command, with the same volume and environment variables. The workflows publish images. They don't deploy the server.
