# OpenAI decision-provider research

Checked 2026-10-05 using the OpenAI Docs skill. Documentation research only; no API requests were made.

## Requested API identity

I **could not verify from official documentation** the requested “Decisions API (from ChatGPT)”. Exact-name searches across developers.openai.com, platform.openai.com, and learn.chatgpt.com, followed by inspection of the [API overview](https://developers.openai.com/api/reference/overview), [documentation index](https://developers.openai.com/llms.txt), and [changelog](https://developers.openai.com/api/docs/changelog), did not establish a separately named Decisions API, endpoint, decision model, schema, or account-access requirements. This is an unresolved identity, not proof that such a service cannot exist. Do not invent `/decisions`, treat ChatGPT access as API access, or silently map this request to Responses.

Recommended explicit user decision: provide the exact product link/model/endpoint for Decisions API, or authorize a separately named OpenAI Responses adapter as the initial OpenAI decision provider. Keep the requested Decisions API provider recorded as unresolved until its identity is supplied.

Design decision recorded 2026-10-06: the owner approved an explicitly named OpenAI Responses decision adapter, plus independently replaceable OpenAI transcription and structured-extraction starter adapters. This resolves the server's v1 integration choice; it does not establish the existence or identity of a separate Decisions API. No live inference compatibility or account-access checks have been performed.

Scope correction later on 2026-10-06: the owner simplified v1 to OpenAI only. Use transcription followed by a single Responses call for decisions and arguments; the earlier independent-adapter proposal is superseded. The remaining discussion below records research history, not additional v1 architecture requirements.

## Verified alternatives, subject to that decision

OpenAI documents the [Responses API](https://developers.openai.com/api/reference/python/resources/responses), including `POST /responses`. Its [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) documents JSON Schema output through `text.format`, using a supported schema subset. An adapter could ask for a provider-neutral decision object, then validate it locally and handle refusal/incomplete/error outcomes. Schema conformance does not establish that an action is correct or authorized; that last sentence is an application-design inference.

[Function calling](https://developers.openai.com/api/docs/guides/function-calling) is a documented alternative when the model selects application functions. The model produces a proposed call; the application executes it and supplies the result. For Whim, a single decision object may provide a simpler adapter boundary than provider-native tool execution. This is a design recommendation, not a documented Decisions API.

## Replaceable transcription boundary

The [file-transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) documents `POST /v1/audio/transcriptions`, accepts completed `.m4a` recordings, and limits files to 25 MB. It currently recommends `gpt-transcribe` for recorded speech in its original language. This establishes an OpenAI route for the requested Whim AAC-in-M4A input; no representative Whim recording was submitted or codec behavior tested.

The [transcription endpoint reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) requires an uploaded file object and sufficient format metadata; it recommends a filename with an extension and appropriate content type. Preserve `.m4a` and its content metadata instead of sending a bare file path or treating the recording as text. Larger recordings require compression/chunking or a different provider; chunk boundaries can affect accuracy.

Suggested architecture, explicitly an inference: keep transcription separate from decisions. A replaceable transcription adapter returns normalized transcript text (plus provider metadata/error information); a replaceable decision adapter consumes that text plus application context and returns a normalized decision. This permits an M4A-capable transcriber to feed Jev, Cloudflare Clef, or an eventual verified OpenAI provider without requiring every decision model to accept audio.

## Audio and schema support are model-specific

The [GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) lists Structured Outputs and function calling as supported, while audio is unsupported. It is evidence for a transcript-to-structured-decision route, not a recommendation to replace the requested API/model.

The [GPT-Audio model page](https://developers.openai.com/api/docs/models/gpt-audio) lists audio input/output and function calling, but says Structured Outputs are unsupported and marks the model deprecated. Native audio therefore must not be equated with strict JSON Schema support. Select and verify an actual model before implementation; do not infer capabilities solely from an API family name or a model-page endpoint navigation list.

## Remaining uncertainties

- Exact identity and public/private availability of the requested Decisions API.
- Desired OpenAI model, account eligibility, pricing/latency budget, and retention requirements.
- Compatibility of real Whim AAC-in-M4A samples; this note verifies documented M4A acceptance only.
- Jev and Cloudflare Clef identities/capabilities are outside this OpenAI-only research note and need their own primary-source verification.
