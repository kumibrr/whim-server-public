<p align="center">
  <img src="assets/whim-icon.png" alt="Whim logo" width="128" height="128">
</p>

<h1 align="center">Whim server</h1>

<p align="center">Turn Whim voice Notes into webhook requests.</p>

Whim server receives your recordings, sends them to OpenAI for transcription, and uses Decisions to choose which of your configured webhooks to call. Responses then extracts their arguments. You define the destinations and request formats.

It runs as one Node 24 process with a SQLite database. It's built for one owner. Keep one server instance and put the database on persistent storage.

## How it works

1. [Whim](https://github.com/kumibrr/whim) sends a Note's audio and metadata to `/receive`.
2. The server saves the Note, asks OpenAI to transcribe it, selects pipes with Decisions, and extracts arguments with Responses.
3. The server validates the plan and calls your webhooks in order. If routing is unclear, it uses your default destination.
4. After every action succeeds, the server deletes the Note's audio, metadata, transcript, and payloads. It keeps operational IDs and statuses.

You can also change instructions, models, and permitted options by voice. Those changes apply to Notes that haven't started processing. Destinations and credentials stay under your administrative control.

Whim's "Sent" status means the server saved the Note. Check the server's CLI or admin API to see whether processing finished.

## Start locally

You need Node 24 or newer, an OpenAI API key, and a webhook destination. A ChatGPT subscription does not provide an API key.

```sh
npm ci
npm run build

export OPENAI_API_KEY='your-openai-api-key'
export WHIM_ADMIN_TOKEN="$(openssl rand -hex 32)"
export WHIM_BEARER_TOKEN="$(openssl rand -hex 32)"

npm start
```

Save the generated tokens in your secret manager. Keep the admin token separate from the receiver and OpenAI credentials, and don't commit secrets.

Open [localhost:8788/setup](http://localhost:8788/setup) and sign in with `WHIM_ADMIN_TOKEN`. Enter your destination URL, choose its HTTP method and body format, then review and save the settings. Choose models available to your OpenAI account.

The default request sends the Note ID, title, and transcript as JSON. The wizard also offers plain text, URL-encoded fields, multipart fields with audio, and raw audio. It validates settings when you save, but doesn't test the destination or its credentials.

To receive Notes from Whim, expose the server through an HTTPS proxy. Set Whim's endpoint to `https://your-server/receive` and enter the value of `WHIM_BEARER_TOKEN`. You can use `WHIM_HMAC_SECRET` for signed requests as well, or instead of bearer authentication. Match the credentials on both sides.

Whim's configuration test checks the receiver contract without queuing a Note. Notes received before setup finishes stay queued until you save a configuration.

Prefer a terminal or a settings file? See [other setup methods](docs/operations.md#other-setup-methods).

## Run with Docker

```sh
docker build -t whim-server:v1 .
docker volume create whim_data
docker run -d --name whim-server -p 8788:8788 \
  --mount source=whim_data,target=/data \
  -e OPENAI_API_KEY -e WHIM_ADMIN_TOKEN \
  -e WHIM_BEARER_TOKEN -e WHIM_HMAC_SECRET \
  -e WHIM_CREDENTIALS_JSON \
  whim-server:v1
```

Set the environment variables in your shell before running this command, then open `/setup`. The named volume stores the database across container replacements.

The image workflow publishes to `ghcr.io/kumibrr/whim-server-public`. To use a published build, replace `whim-server:v1` with its image tag. See [container releases](docs/operations.md#container-releases) for tags and publishing details, or [Fly.io deployment](docs/operations.md#deploy-to-flyio) for a hosted setup.

## Configure and inspect

A pipe is a configured destination the server can call. Each pipe has a request recipe, an argument schema, and a description that helps the model decide when to use it. [config.example.json](config.example.json) shows a complete configuration.

Decisions defaults to `gpt-6-luna` with a `0.8` selection threshold. Existing settings remain valid. See [Decisions and argument extraction](docs/operations.md#decisions-and-argument-extraction) for model settings, multiple destinations, and unclear routing.

Keep destination secrets in the server's `WHIM_CREDENTIALS_JSON` environment variable. Settings contain credential reference names. See [request recipes and credentials](docs/operations.md#request-recipes-and-credentials) for mappings, body formats, and voice permissions.

The CLI uses `WHIM_ADMIN_TOKEN` and defaults to `http://127.0.0.1:8788`. Set `WHIM_SERVER_URL` to administer another server.

```sh
npm run cli -- config show
npm run cli -- notes list
npm run cli -- notes show NOTE_UUID
```

OpenAI failures can trigger automatic retries. Webhook failures need your attention. If a request times out or the server stops during a send, the destination may already have acted. Check it before retrying, because another request can duplicate the effect. The [operations guide](docs/operations.md#recovery-and-data-retention) explains recovery, settings rollback, and backups.

## Development

```sh
npm run test -- src/*.test.ts
npm run check
npm run build
```

Tests use local HTTP fixtures and make no paid API calls. To test the Docker image on a Linux Docker host, build `whim-server:v1` and run `npm run test:container`. That check covers acceptance, processing, cleanup, restart, CLI rollback, and duplicate delivery.

See the [server design](docs/superpowers/specs/2026-10-06-whim-server-v1-design.md) for the processing contract and scope, and the official [Decisions guide](https://developers.openai.com/api/docs/guides/decisions) for the API. Live OpenAI verification requires provisioned credentials and is separate from local fixtures. Receiver attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
