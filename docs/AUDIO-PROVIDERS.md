# Expressive dialogue provider qualification

A separate native Azure adapter now submits reviewed word emphasis and style intensity, with provider-specific policies, actual SDK word boundaries and durable audition integration. See [NATIVE-VOICE-PERFORMANCE.md](NATIVE-VOICE-PERFORMANCE.md). The Cartesia contract below remains unchanged.

Source-bound phrase speed, volume and requested pauses now compile to supported inline controls under an additive capability revision. Native emphasis remains unsupported; raw owner markup remains refused. See [PHRASE-PERFORMANCE.md](PHRASE-PERFORMANCE.md) for the exact scope, legacy preservation and timing limitations.

The independent Cartesia audio adapter compiles character defaults and line overrides into source-bound requests, streams PCM, and retains provider word/phoneme timings. Its acoustic qualification is **transport fixtures only**. Isolated audio audition jobs now have PostgreSQL admission/accounting and owned media recovery; see [AUDIO-AUDITIONS.md](AUDIO-AUDITIONS.md). No active catalogue policy ships with the application. Existing eSpeak voices, auditions, versions, rollback and `hv-speech/1` records retain their existing behavior.

No paid request, production voice quality evaluation, licensed voice admission, dubbing, lip-sync or Zo deployment is evidenced by this milestone. The fixture PCM is a generated test signal, not an actor performance. P7 / HV-022 remains open.

## A second production vendor: ElevenLabs (HV-022-05)

The operator approved ElevenLabs as a second voice vendor (G14) and provisioned its key on the staging host. `hv-audio-capability/4` pins `eleven_multilingual_v2` and the timestamped endpoint, and records two facts about the service rather than hiding them: it returns at most 44.1 kHz PCM, so the adapter resamples to this application's 48 kHz mono with the one fixed ffmpeg recipe already used for retained editorial audio; and it aligns **characters**, so word timings are derived (`derived-from-provider-character-alignment`) and a read whose alignment is out of order, past the audio or wordless is refused rather than approximated.

The line controls are the service's own and nothing else: `speed` 0.7–1.2, `stability`, `similarity` and `exaggeration`, each in steps of 0.01. There is no loudness control and no emotion enum, so a line that asks for either is refused before any reservation; level belongs to the mix. Phrase direction, word emphasis and phoneme alignment are unsupported here. `hv-audio-voice/4` and `hv-audio-line/6` are the vendor's own schemas, with the service's twenty-character voice IDs, so no older record can be read as an ElevenLabs one.

Billing is prepaid characters against a monthly allowance, not dollars per call, so the operator's catalogue carries the plan's rate and its evidence, and the hold per take is that rate applied to the line. No voice ships authorized with the code: a voice becomes castable only through catalogue evidence captured on the host.

## Provider contract

The adapter pins `sonic-3.6-2026-08-27` and API version `2026-08-14`. It submits one English line per `POST https://api.cartesia.ai/tts/sse`, with a string voice ID, mono raw signed 16-bit PCM at 48000 Hz, normalized word timestamps, and optional phoneme timestamps. Provider audio retains 48 kHz through the WAV and report; legacy temporary speech remains 22050 Hz. A dated model is retained as an immutable capability entry; a future model must get a separate entry and preserve validation of old deliveries. [Model snapshots](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest), [SSE API](https://docs.cartesia.ai/api-reference/tts/sse), [output formats](https://docs.cartesia.ai/build-with-cartesia/capability-guides/tts-output-audio-format), [SDK output and event types](https://github.com/cartesia-ai/cartesia-js/blob/v4.0.1/src/resources/tts.ts).

The initial adapter accepts speed 0.6–1.5, volume 0.5–2.0, and six primary English emotion directions: neutral, calm, angry, content, sad and scared. These are submitted guidance, not verified acoustic outcomes; emotion is experimental. The service supports additional languages and emotions, but this qualification covers English and these six directions. Pitch, word emphasis, raw speech tags and unknown fields are rejected before reservation or dispatch. Acting notes and screenplay parentheticals remain direction metadata. [Control semantics](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion), [supported speech tags](https://docs.cartesia.ai/build-with-cartesia/capability-guides/ssml-tags).

`hv-audio-voice/1` carries the selected voice ID, catalogue revision and permission revision. These hashes bind an authorization decision; they do not themselves establish a licence or consent. The journal must verify current project/cast permission and current authorized catalogue metadata before dispatch and attachment. No catalogue grants ship in this change, and no cloning endpoint is implemented. [Voice metadata API](https://docs.cartesia.ai/api-reference/voices/get).

`hv-audio-line/1` retains the screenplay source, effective character/line controls, pronunciation substitutions, exact local pauses, direction notes and alignment requirement. Its revision includes the capability and voice authorization bindings. No character name, parenthetical or direction note is sent as spoken dialogue. Existing plain pronunciation replacements and safety checks run before request creation; tags introduced by a replacement are refused.

## Audio and timing evidence

`hv-audio-line-delivery/1` records the compiled plan, original attempt, PCM format and checksums, exact speech/pause sample positions, provider tokens and their original timing seconds. Alignment has an explicit origin at speech start, after the leading local silence. Tokens describe the provider's normalized spoken transcript: “12” may become “twelve”, and a pronunciation replacement may differ from the screenplay. No word-to-screenplay or phoneme-to-picture mapping is invented. [Word timing](https://docs.cartesia.ai/examples/tts-sse-with-timestamps), [phoneme timing](https://docs.cartesia.ai/examples/tts-sse-with-phoneme-timestamps).

The stream reader handles UTF-8, LF/CRLF/CR delimiters, comments, multiline data and arbitrary chunk boundaries. It bounds event size, stream bytes, event count, audio duration and timing counts. Completion is required; missing/malformed requested timings, out-of-range or unordered times, a wrong echoed context, invalid base64, partial samples and truncated streams withhold delivery. Adjacent timing tokens may overlap due to coarticulation, but starts and ends must remain ordered. Checksums and exact inserted silence are validated against owned PCM. The report states that guidance was submitted and quality has not been evaluated.

## Dispatch and accounting boundary

`CartesiaAudioProvider.synthesize` requires an `AudioAttemptJournal`; there is no environment-enabled resolver or default journal. A production implementation must provide these operations:

1. Atomically check current project/cast/catalogue permission and worker lease, reserve a positive USD hold against verified pricing evidence, and persist a unique `hv-audio-dispatch/1` intent before network activity. Recovery must not redispatch an uncertain intent.
2. Check current permission and lease immediately before dispatch and after audio validation. Publication must also use the durable worker's current ownership/permission checks and artifact checkpoint rules.
3. Persist `hv-audio-attempt-outcome/1` by its original attempt ID, including after cancellation, permission loss, or lease loss. Keep dispatched attempts held until billing is reconciled. Outcome persistence failure prevents media return and carries the original receipt in `AudioProviderError` for recovery.

The intent records a canonical request hash and a client-generated context ID. That context is not a provider-issued request ID. Only a documented SSE error's `request_id` is recorded as a provider ID. Redirects are refused; response error text and credentials are not copied into receipts or exceptions. Timeouts/disconnects do not automatically retry, fail over or establish a remote cancellation. A recorded `deliveryState: ready` means bytes passed validation before outcome persistence, not that they were published; the caller must receive a successful return and perform current attachment checks.

Cartesia describes TTS usage as approximately one credit per character, with preprocessing affecting exact usage. Its credit API returns aggregates over time and dimensions, not a per-request invoice. The adapter therefore records `actualUsd: null` for every dispatched outcome, even successful or provider-rejected requests. It does not convert a credit estimate, completion event or aggregate usage difference into an actual USD charge. A pre-dispatch failure alone records no incurred cost. [Pricing](https://docs.cartesia.ai/pricing), [credit usage API](https://docs.cartesia.ai/api-reference/usage/credits).

These outcome records are deliberately distinct from `fal-request/1` and `CostRecord`. They cannot settle an image/video attempt. The separate PostgreSQL audio journal records dispatch and retains unresolved holds. Operator invoice allocation is distinct from provider-measured per-request billing. Zero-cost ADR never dispatches this provider.

## Verification and remaining integration

The dedicated contract suite uses a loopback HTTP server and a dummy credential, plus a byte-at-a-time parser probe. It verifies exact request controls, separate holds/receipts, source and grant invalidation, unsupported controls, actual returned PCM bytes, exact pauses, normalized timing provenance, cancellation before/during/after streaming, timeouts, refused redirects, error sanitization, malformed/oversized responses, permission loss and outcome persistence failure. Run `bun test packages/generator/test/cartesia-audio.test.ts`; no provider credentials or inference are needed.

Before production selection, verify account pricing and licence/catalogue evidence; integrate persistent character profiles and audition selection through the UI and film/ADR timeline; then evaluate actual generated dialogue with blinded listening and alignment checks. Only this evidence can qualify emotion, voice quality and pronunciation. Word emphasis requires a verified supporting engine. Lip-sync changes picture and cannot inherit the locked-picture ADR guarantee.
