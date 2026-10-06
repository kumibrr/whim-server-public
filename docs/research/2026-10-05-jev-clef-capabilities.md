# Jev and Clef capabilities for Whim

Checked 2026-10-05 against official documentation, published schemas, and Cloudflare's own model release. No inference calls, dependency installation, or credentials were used. No applicable `AGENTS.md` existed in the workspace or its ancestors when checked. These are research notes, not an implementation specification.

## Conclusions supported by sources

**Neither documented decision API accepts native AAC `.m4a` audio.** Jev explicitly supports text only and excludes audio, images, and video. Its documentation directs callers to convert other modalities into text or structured fields. [TypeSafe State](https://docs.typesafe.ai/concepts/state), [TypeSafe Models](https://docs.typesafe.ai/models)

Clef is multimodal, but its hosted API documents text/JSON state plus embedded images; there is no documented audio input. Cloudflare's local model release additionally supports video frame arrays. Local video support does not establish hosted video or audio support. [Hosted Clef](https://developers.cloudflare.com/workers-ai/models/clef/), [Cloudflare model card](https://huggingface.co/Cloudflare/clef)

**These APIs make typed decisions, not arbitrary content.** Jev's introduction explicitly describes an API without text generation. Cloudflare's model card likewise excludes free-form generation. Neither documented API returns invented destination JSON, arbitrary configuration patches, or a transcript. [TypeSafe Introduction](https://docs.typesafe.ai/introduction), [Cloudflare model card](https://huggingface.co/Cloudflare/clef)

## HTTP transport and SDK optionality

| Provider | Documented inference request | Authentication |
| --- | --- | --- |
| Jev | `POST https://api.typesafe.ai/v1/systemone`, JSON body | `Authorization: Bearer <API_KEY>` |
| Hosted Clef | `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`, model-specific JSON body | `Authorization: Bearer <API_TOKEN>` |

Set `Content-Type: application/json`. Jev requires `model`, `state`, and `questions`; `jev-latest` is the documented alias. Cloudflare's Clef examples include `model: "clef"` inside the body as well as the namespaced model in the URL. Both expose ordinary HTTP, so SDKs are optional. [TypeSafe API](https://docs.typesafe.ai/api), [Clef examples](https://developers.cloudflare.com/workers-ai/models/clef/)

Cloudflare requires an account ID. Its REST tutorial recommends the Workers AI API token template; for a custom token it specifies both Workers AI Read and Edit. The generic API reference lists Read or Write as accepted permissions, a documentation discrepancy worth retaining during provisioning. [REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/), [Run API reference](https://developers.cloudflare.com/api/resources/ai/methods/run/)

Cloudflare REST documentation shows a transport envelope with `result`, `success`, `errors`, and `messages`; the model output schema describes the contents of `result`. The Workers binding example returns the model output directly. The exact live Clef REST envelope has not been tested. [REST example](https://developers.cloudflare.com/workers-ai/get-started/rest-api/), [Clef output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json)

## Questions and answers

All questions share a state and return answers under the request's question IDs. Instructions can be text or structured JSON. The common primitives are:

| Primitive | Request criteria | Model answer |
| --- | --- | --- |
| Choice | Map of named candidate IDs to descriptions; descriptions may be structured or null | `type: "choice"`, `choice` (highest probability candidate), `probabilities` for every candidate, `confidence` |
| Score | Ordered rubric descriptions, 2–10 levels indexed from zero | `type: "score"`, `score`, `legend`, `probabilities`, `confidence` |
| Noul | Optional descriptions under `true` and `false` | `type: "noul"`, `noul` (probability of yes, 0–1); no separate confidence |

Choice is closed-set selection, up to 255 candidates. Score is the expected level index, `sum(index * probability)`, and may fall between levels; it is not arbitrary numeric extraction. HTTP Score probability and legend keys are strings. Distributions sum to one. [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul)

The model output has `model`, `answers`, and `usage: {input_tokens, output_tokens}`. Hosted Clef's answer fields match the table and its confidence/probability values are constrained to 0–1. [TypeSafe API](https://docs.typesafe.ai/api), [Clef output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json)

Hosted Clef requires explicit instructions. It permits 1–64 questions, IDs up to 100 characters using letters, digits, `_`, `.`, `-`; Choice descriptions specify 2–255 candidates and Score 2–10 levels. Its optional images accept base64 data URLs or `{content_type, base64}` objects for PNG/JPEG/WebP. Limits: four images, 4 MiB/16 megapixels each, 8 MiB total decoded, 13 MiB request body. Remote image URLs are excluded. Long state is truncated. Some constraints appear in descriptions rather than executable JSON Schema keywords; do not assume a generic schema validator enforces all of them. [Clef input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json)

## Compatibility and confidence caveats

Cloudflare claims Jev/SystemOne compatibility for Clef and supplies a local `systemone` function accepting the corresponding body and producing the corresponding answer fields. Hosted transport/authentication differ. The local release permits omitted instructions and video inputs, unlike the hosted schema. [Cloudflare model card](https://huggingface.co/Cloudflare/clef)

Jev Choice confidence is `(p_max - 1/n) / (1 - 1/n)`. Jev Score confidence compares probability-weighted distance from the most likely level against uniform mean absolute deviation, floored at zero. Noul has no supplied confidence; the docs suggest `abs(2*p - 1)` if needed. [TypeSafe Confidence](https://docs.typesafe.ai/confidence)

Cloudflare's published local `systemone_answer` instead sets Choice confidence to the selected probability and Score confidence to the maximum level probability, rounding results to four decimals. Hosted Clef's schema does not publish its exact formula. **Shape compatibility does not establish confidence equivalence.** [Cloudflare release source](https://huggingface.co/Cloudflare/clef/blob/main/joint_schema_model.py), [Hosted output schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-output.json)

## Errors and retry evidence

Jev documents 401 for authentication, 422 for validation, 429 for rate limiting, and 529 for overload; it prescribes exponential backoff for 429/529. [TypeSafe API](https://docs.typesafe.ai/api)

Its Python SDK defaults to two retries, 0.5-second initial exponential backoff, five-second cap, jitter, and honoring `Retry-After`/`retry-after-ms`; retryable statuses include 408, 429, and 5xx. A 30-second total retry budget is documented. These are SDK defaults, not a server SLA. [SDK retry policy](https://docs.typesafe.ai/sdk/python/api/retries)

Cloudflare documents 400 invalid inputs, 403 access/account restrictions, 404 invalid model, 413 oversized request, 408 timeout/abort, and distinct 429 internal codes: 3036 for daily allocation exhaustion and 3040 for temporary capacity exhaustion. Only the latter is described as temporarily retryable. No Clef-specific retry schedule was found. [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/)

## Inferred consequences for Whim, not vendor capabilities

- Put an audio-to-text stage before either interchangeable decision provider. AAC/container support belongs to the chosen transcription service, not these models.
- Compile the current pipe registry into Choice candidates per request; resolve the returned candidate ID to the configured destination in server code. User-configurable pipes remain possible, but candidates must exist before the decision call.
- New arbitrary URLs, names, numbers, or instruction text in configuration changes require deterministic extraction, pre-parsed candidates, or a separate generative parser. TypeSafe's function-calling cookbook explicitly leaves open-ended arguments at their defaults. [Function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling)
- Validate and apply configuration changes in server code. Request-scoped state/questions allow changing candidates on the next call; neither provider documents persistent hot configuration management for Whim.
- Keep provider confidence and full distributions; validate thresholds per provider/model or compute a common statistic explicitly. Pin versions when reproducing routing behavior matters.

## Unresolved without vendor confirmation or authorized integration checks

Hosted Clef's confidence formula, exact live REST envelope/error-body shapes, treatment of undocumented extra fields, hosted video availability, transcription provider/codec support, and workload-specific non-English routing accuracy remain unverified. No source establishes native audio support for hosted Clef; no source establishes arbitrary generated configuration values for either decision API.
