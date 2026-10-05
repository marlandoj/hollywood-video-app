# Provider capability routing (HV-019)

This increment replaces model-name selection in new job execution with an admitted provider plan. It implements routing for the existing video and rich-animatic adapters. HV-019 and the wider P5 scope remain in progress: additional modalities, quality presets, calibrated visual evaluation, production canaries, self-hosted inference, and a complete reproducible film package are separate work.

## Admission and execution

The API saves a versioned, SHA-256-addressed plan in the job body: stage, strategy, per-shot cap, render requirements, normalized operator-approved pool, and each adapter's capability and configured price snapshot. Metadata construction requires no inference key. Only the worker receives FAL_KEY.

At claim time, the worker verifies the saved plan against the current allowed pool and adapter definitions. Removing an admitted provider or changing its model, price or capability definition prevents execution and asks for a new render. Reordering or adding current pool entries cannot silently change the admitted pool. Environment settings shared by API and workers must match.

Before every dispatch, the router matches requested dimensions, frame rate, duration, reference/identity counts, camera move, audio, native resolution, deterministic output, region and synthetic-output policy. Unknown or unsupported features are explicit rejections. Retired endpoints cannot be selected. Capability definitions describe the actual adapter path, including post-processing; an endpoint supporting a feature does not imply this adapter implements it. A capability's `nativeCamera` moves (HV-020-01, [CAMERA-PATHS.md](CAMERA-PATHS.md)) decide whether a camera path is sent as the provider's own control or cropped locally; they never change eligibility, price or routing order. A capability's `referenceUse: "recorded-not-rendered"` (HV-019-16, only on the mock adapters) says that the reference images it accepts are recorded by digest and not rendered from; a match of a shot with references names that as an adaptation, and the shot's provenance carries the `referenceRecord`. See [REFERENCE-PROVIDERS.md](REFERENCE-PROVIDERS.md).

The lease holder saves a routing decision before inference. Decisions contain eligibility/rejection reasons, configured quotes, capability and price revisions, and bounded worker-local health observations. They contain no prompt, reference URL, credential or provider response body. PostgreSQL persists these through the existing job row lock, lease fence and RLS scope; no database migration is required.

New jobs always enforce their saved plan. Older jobs use registered built-in adapters when available. The legacy injected-adapter contract is retained only for pre-plan jobs whose custom adapters have no capability snapshot.

## Configuration

Set these on both the API and workers. Existing primary/secondary selectors remain the defaults.

| Setting | Behavior |
| --- | --- |
| HV_PROVIDER_POOL | Optional JSON array of 1–8 final adapter specs; overrides primary/secondary. Duplicates normalize to one entry. |
| HV_ANIMATIC_PROVIDER_POOL | Optional JSON array of 1–8 animatic adapter specs; overrides HV_ANIMATIC_PROVIDER. |
| HV_CHARACTER_SHEET_PROVIDER_POOL | Optional JSON array of 1–8 character-sheet adapter specs; defaults to `["mock"]`. Narration and captions are forced off on this stage. |
| HV_ROUTING_STRATEGY | configured (default), cost, latency, or quality (HV-019-14; see "Routing on measured quality" below). No profile defaults to quality. |
| HV_ROUTING_QUALITY_RESULTS_PATH | API only, read at admission when the strategy is quality. One committed benchmark results file; a relative path is read from the repository root. Unset, unreadable or refused, the quality strategy keeps the configured order and says why. |
| HV_COST_CAP_PER_SHOT_USD | Final per-shot cap, default $5. Admission reserves the aggregate job cap for pools containing paid providers. |
| HV_ANIMATIC_COST_CAP_USD | Whole-animatic cap, default $5; also the maximum for an individual animatic shot. |
| HV_FAL_USD_PER_BILLED_SECOND | Optional positive configured video rate override, applied on both roles. |
| HV_FAL_IMAGE_USD_PER_IMAGE | Optional positive configured per-image override, applied on both roles. |

Every admissible `(stage, spec)` pair is enumerated in `packages/generator/src/registry.ts`. The table below restates that registry; the conformance suite asserts the two agree, so a spec missing here is a documentation bug that a test catches.

| Stage | Canonical spec | Also accepted | Adapter | Bills |
| --- | --- | --- | --- | --- |
| final | mock | (empty string) | mock | no |
| final | anchor-storyboard | | anchor-storyboard | no |
| final | fal:kling-v2.5-turbo-pro | fal | fal | yes |
| final | fal:kling-o3-standard-reference | | fal | yes |
| final | fal:kling-o3-standard-keyframes | | fal | yes |
| final | fal:veo3-fast | | fal | yes (retired; never eligible) |
| final | image:mock | | rich-animatic | no |
| final | image:fal:flux-schnell | image:fal | rich-animatic | yes |
| final | image:fal:flux-2-edit | | rich-animatic | yes |
| animatic | mock | (empty string), image:mock | rich-animatic | no |
| animatic | legacy-mock | | mock | no |
| animatic | anchor-storyboard | | anchor-storyboard | no |
| animatic | image:fal:flux-schnell | image:fal | rich-animatic | yes |
| animatic | image:fal:flux-2-edit | | rich-animatic | yes |
| character-sheet | mock | (empty string), image:mock | rich-animatic | no |
| character-sheet | image:fal:flux-schnell | image:fal | rich-animatic | yes |
| character-sheet | image:fal:flux-2-edit | | rich-animatic | yes |

The fal rows are derived from `FAL_MODELS` and `FAL_IMAGE_MODELS` rather than transcribed, so a new model key appears in the registry automatically and the conformance suite immediately demands a matching adapter for it. `anchor-storyboard` is admitted only for jobs that ask for frame anchors, as a ninth pool slot; see FRAME-ANCHORS.md. See REFERENCE-PROVIDERS.md for the opt-in image/video reference paths and their limits.

## Quality presets and the film limit (HV-019-04)

- **Draft** is the `animatic` stage (storyboard and rough cut), routed by `HV_ANIMATIC_PROVIDER_POOL`.
- **Final** is the `final` stage, routed by `HV_PROVIDER_POOL`.
- The studio's creator never picks a provider; the operator's pools do.
- Admission also enforces a per-film limit, `HV_FILM_SPEND_CAP_USD` ($40 default, never above the monthly cap; plain dollars such as `40` or `12.50`, read at startup, HV-024-13). In PostgreSQL it is checked inside `admit`'s lock, from `hv_cost_events` and `hv_reservations` by `project_id`.
- A film planned as a `feature` is held to its own limit instead, `HV_FEATURE_FILM_SPEND_CAP_USD` ($150 default, G20-202610031349; HV-030-28). `filmCapFor` in `packages/operator/src/film-budget.ts` picks the limit from the project's format at every admission.

## Spec normalization

`normalizeSpec(spec, stage)` is the single answer to "what is this spec called". It is a fixed point: normalizing a canonical spec returns it unchanged, and `describeProvider` returns that same canonical spelling, so a pool cannot hold one adapter twice under two names.

A final-stage `image:` spec is the animatic adapter under a stage-qualified spelling. What follows the prefix is normalized and the prefix is then restored — never the caller's spelling. Before HV-019-01 the caller's spelling was restored verbatim, so `image:fal` and `image:fal:flux-schnell` survived pool de-duplication as two entries carrying byte-identical capability snapshots. `RoutedGenerator` and the worker both key the circuit breaker on `snapshot.revision`, so those two nominal providers shared one circuit and one half-open probe: a single failure counted twice, and opening the circuit removed both.

The prefix itself is kept. `image:mock` does **not** collapse to `mock`, because the final-stage adapter for `mock` is the plain deterministic video renderer while `image:mock` is the rich animatic over the deterministic image renderer — two different adapters with different capability revisions.

A plan admitted under the old spelling does not execute under the new one. `instantiateProviderPlan` finds no current pool entry named `image:fal`, and fails closed with "Provider configuration changed after this job was queued. Start a new render to use the current configuration." That is the designed path for any pool change, not a special case.

## Adapter conformance

FULL-SCOPE §7 and §8 require an adapter conformance suite before a provider is promoted. `packages/generator/test/conformance.test.ts` is that suite. It is table-driven over the registry, so every registered pair is checked and a new entry cannot be quietly half-wired. Sixteen check families run offline, with no PostgreSQL, no object store and no network:

- **registry-derivation** — the fal families match the model records in both directions; no spec or alias is registered twice on a stage; the paid family prefixes are derived, not transcribed.
- **switch-totality** — for every registered pair, `describeProvider`, the stage resolver and `specIsPaid` agree, and the resolved adapter's live capability revision equals the admitted snapshot's.
- **unregistered-refused** — every unregistered pair is refused at admission. The two places where the resolvers are laxer than admission (`anchor-storyboard` and `legacy-mock` on `character-sheet`, neither reachable because admission runs first) are pinned so that widening the set has to be a decision.
- **paid-family** — `providerUsesPaidInference` answers for the vendor family, including a model key this build does not know: "unknown model" is not a reason to dispatch without a budget reservation.
- **normalization-fixed-point**, **image-spec-dedup**, **stale-spelling-fails-closed** — the normalization rules above.
- **snapshot-integrity** — every snapshot round-trips through `validateCapability`, is revision-stable across calls, is deeply frozen, and is built in an environment holding no inference key. Execution, unlike metadata, does need the key and says so rather than dispatching without one.
- **declared-price-region-synthetic**, **bit-exactness**, **anchor-bit-exactness**, **cancellation** — declared behaviour checked against actual behaviour: a `local-bitexact` claim is verified by rendering twice and comparing bytes; a `local` cancellation claim is verified with an already-aborted signal; free ⟺ a zero estimate; `region: "local"` ⟺ a free local adapter. A `cancellation: "none"` claim is not asserted to cancel — the plain video mock renders synchronously and there is nothing to interrupt.
- **eligible-vector**, **boundary-rejections** — a requirements vector derived from each adapter's own snapshot is accepted, and each ineligible dimension yields its own named `RejectionReason`. Fourteen of the seventeen reasons are reachable from a requirements vector alone and all fourteen are asserted to have been reached; the other three are not requirements at all — `circuit-open` and `capability-changed` are router state (`router.test.ts`) and `frame-anchors` is anchor state (`frame-anchor-provider.test.ts`).
- **no-paid-dispatch** — `globalThis.fetch` is replaced by a stub that throws, and asserted never to have been called. Paid adapters are constructed with a literal fixture key, described and matched; none is ever asked to generate.
- **telemetry-labels** — `providerKind` returns a member of the exported `PROVIDER_KINDS` tuple for every registered adapter; the set of adapters collapsing to `other` is pinned (empty since HV-019-02); the paid and free rich-animatic lanes produce distinct labels; and two different paid image models are pinned as still sharing one label, which is deliberate.
- **evidence** — the record below.

The bit-exactness and cancellation families need `ffmpeg`. When `ffmpeg` is absent they **skip with a recorded reason** rather than pass; the reason lands in the evidence file, so a silently-green conformance run is not possible.

The suite writes `docs/evidence/hv019-router/adapter-conformance.json` (schema `hv-adapter-conformance/1`) when `HV_ADAPTER_CONFORMANCE_EVIDENCE` names a path, and always re-validates the committed file: schema, the registry entry set, every recorded capability revision against the revision this build produces, the check-family set, and the honesty fields. The recorded revisions are therefore a tripwire — a capability edit that would invalidate already-admitted plans breaks this test before it reaches staging.

What the record does **not** establish is stated in the file itself: `provesVendorAvailability`, `provesVisualQuality`, `provesLivePricing` and `provesRegionalExecution` are all `false`. No live provider was reached, no price was confirmed against an invoice, no region was observed, and no visual quality was evaluated. `newProviderSpendUsd` and `liveProviderDispatches` are both `0`.

The API's jobs POST accepts optional renderRequirements with audio (any, temporary-dialogue, native-dialogue), deterministic, nativeResolution, allowSynthetic and region (any, local). Unsupported keys are refused; callers cannot add an endpoint, model or price. Defaults preserve the existing silent/synthetic-compatible flow. Native dialogue is currently unsupported. Temporary dialogue requires the rich animatic narration option.

Cost strategy ranks eligible configured quotes; video quotes round up to supported billed durations and image quotes use the adapter's configured megapixel ceiling or per-image rate. Latency strategy uses observed successful durations only after three samples; unknown providers keep configured order behind observed providers. Neither strategy fabricates quality scores or live vendor health. The quality strategy ranks on measured benchmark scores only, as the next section describes.

## Routing on measured quality (HV-019-14)

Release 3 step 10. `HV_ROUTING_STRATEGY=quality` ranks the plan's providers by the benchmark's measured score, and never by an invented one. Like every strategy it only orders candidates. Eligibility (capability, retirement, price against the per-shot cap and the remaining budget, circuit state, capability drift), every spend limit and failover are exactly what they are under `configured`, and a tested decision's eligibility matches the configured decision's candidate for candidate. No profile and no default selects it. Choosing it is the operator's call.

**The results file.** `HV_ROUTING_QUALITY_RESULTS_PATH` names one committed file of `hv-benchmark-measured/1` records (HV-037-02; `packages/benchmarks/src/measured.ts`): a single record, or a JSON array with one record per provider spec. `packages/benchmarks/src/routing-results.ts` reads it at admission. The file is used only if all of these hold, and it is refused as a whole otherwise:

- every record passes `readMeasuredRecord`: each shot score is recomputed from its frame and reference fingerprints, the aggregate is recomputed from the shots, and a synthetic (stand-in) record is refused;
- every record was measured on the frozen corpus this build plans (fixture version and sha256), with one metric, one frame size and one set of reference images, so the scores compare like with like;
- no provider spec appears twice, there are 1 to 16 records, and the file is at most 4 MiB of JSON.

A provider's score is its record's `aggregate.identityMean`: the `identity-dhash256-midframe/1` mean, a whole-frame structural measure, not face identity (see HV-037-02).

**Pinned at admission.** The result is a `hv-routing-quality/1` block in the job's `hv-provider-plan/1`, which carries `quality` exactly when the strategy is `quality`. The block holds the file's sha256, the metric, the corpus sha256, and per measured spec the provider, model, capability revision, score and scored-shot count. The plan's revision therefore covers the digest, and the worker ranks from the plan and never re-reads the file. Plans under the other strategies have the same seven keys and the same revision as before.

**The ranking.** Measured providers come first, highest score first, with ties kept in configured order. Every other provider follows in configured order with score `null`. A provider is unmeasured when:

- the file has no record for its spec;
- the record was measured under a different capability revision (a price override or capability edit moves the revision, and the record no longer describes this configuration);
- the adapter is synthetic, whatever a record claims for it;
- or the pass scored no shot.

The anchor-storyboard slot an anchored job appends is unmeasured. The frame-anchor native-priority still comes before the score, as it does for every strategy.

**The fallback.** If no file is configured, it cannot be read, or it is refused, the plan's block carries `fallback` with the reason ("no benchmark results file is configured (HV_ROUTING_QUALITY_RESULTS_PATH)", "the configured results file could not be read (ENOENT)", or "the results file was refused: …" with the reader's own reason). It has no digest and no measured entries. Every candidate's score is `null`, and the order is the configured order. Admission still succeeds, because a missing score is not a reason to refuse a film.

**What a decision records.** A `quality` `hv-route-decision/1` carries a `quality` field: `resultsSha256`, `metric`, `fallback`, each candidate's `{id, score, reason}` in ranked order, and `selectedScore`. Reasons read "measured: identity-dhash256-midframe/1 mean over 6 scored shots" or "not measured: …". Decisions under the other strategies carry no such field.

**Custody.** Everything that re-validates a route derives the scores and the order from the plan's pinned block and compares, so an edited score is refused, never stored:

- the job journal (`recordRouteDecision`, which also refuses a `quality` field on a non-quality plan);
- the private execution capture (`shot-execution-capture.ts`);
- the reuse equivalence (`shot-execution-equivalence.ts`). A quality order is fully determined by the plan, so unlike `latency` it can be proved.

Tests: `packages/benchmarks/test/routing-results.test.ts`, `packages/generator/test/quality-routing.test.ts`, `packages/queue/test/routing-custody.test.ts`, `packages/queue/test/quality-routing-worker.test.ts`, and the quality cases in `packages/planner/test/shot-execution-capture.test.ts` and `shot-execution-equivalence.test.ts`.

## Hero-render chain (HV-019-15)

Release 3 step 11. A creator chooses one shot of a finished final render, and it goes through an ordered chain of stages. Each stage writes a new file and its own provenance record. Every stage that ships is local ffmpeg, so a hero render costs $0. Code: `packages/planner/src/hero-chain.ts` (plan, limits, record validation) and `packages/generator/src/hero-chain.ts` (render, seal, verify).

**The stages, in order.**

| # | Stage | Engine | ffmpeg filter | Creator's choice (default) |
|---|---|---|---|---|
| 1 | denoise | `ffmpeg-hqdn3d` | `hqdn3d=2:1.5:3:2.25`, `4:3:6:4.5` or `8:6:12:9` | light, medium or strong (medium) |
| 2 | frame-rate | `ffmpeg-minterpolate` | `minterpolate=fps=N:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` | 24, 25, 30, 48, 50 or 60 fps (60) |
| 3 | upscale | `ffmpeg-lanczos` | `scale=W:H:flags=lanczos` | 720, 1080, 1440 or 2160 lines (2160) |

Noise is removed at the shot's own size, before an upscale could enlarge it. Motion is estimated at the shot's own size, where it costs a quarter of what it would at 4K. The upscale comes last, once. Every stage encodes H.264 yuv420p at CRF 14, `veryfast`, on one thread, with no build version in the file. The picture only: a hero render is the shot's frames, and its sound is the cut's.

**Limits.** A source shot is at most 1920×1080, 60 fps and 10 s. The shot's duration comes from its render record and is checked at admission. Its size and rate come from an ffprobe of the file and are checked before the first stage runs. The output is at most 3840×2160 at 60 fps. An upscale must make the shot larger, and keeps its aspect ratio with an even width. A frame-rate stage that would write the rate the shot already has is refused. A choice outside these lists is refused by name, before anything is queued.

**Each stage's provenance** (`hv-hero-stage/1`):

- the digest and size of the file it read (the first stage reads the shot's own clip; each later stage reads the file the one before it wrote);
- the stage, engine, provider and spend (`local`, $0);
- the exact ffmpeg filter, and the whole command with its paths written as `<input>` and `<output>`;
- the ffmpeg build that ran it: its version string and a digest of its whole `-version` banner;
- the digest and size of the file it wrote, and an ffprobe reading of that file (size, rate, decoded frame count, duration, codec, pixel format).

**The ffprobe gate.** Each stage's file must be what the stage was asked to make, from the file it read. Denoise keeps every frame, the size and the rate. Frame-rate conversion keeps the size, writes the target rate, and keeps the running time to within one source frame and two output frames (interpolation ends on the last source frame's instant). The upscale writes the planned size and keeps every frame and the rate. Every file is h264 yuv420p within the output limits.

**The chain's record** (`hv-hero-chain/1`) links back to the shot: the film's job id, the shot id, the shot's render-record revision, and the digest and probe of its clip. It holds every stage's record and the result's content credentials. The record is written as `hero/provenance.json` beside the stage files. Every validation re-derives it link by link: each stage's input is the previous output, each filter is the one its plan and input derive, each probe passes its gate, and the result is the last stage's file. An edited link is refused by name.

**Content credentials.** The result is signed the way every export is (`exportCredentials`, HV-031-17). With the host's key, a C2PA sidecar `hero/provenance.c2pa` is written. Its `hv.provenance` assertion has `spec: "hv-hero-chain/1"` and a `derivedFrom` block that names the film, the shot, the shot's render record, the clip's digest and the digest of every stage's record. With no key, the record says unsigned, as every export does.

**A deliverable, not an edit.** A hero render is a delivery job beside the film (`DELIVERY-JOBS.md`). It is bound to the film's sealed output revision, the shot's render record and the clip's digest, and it reads the clip through the artifact reader. It reserves and spends nothing. It does not replace the shot in any cut: that would be an editorial operation with its own review, and it is left out. The creator exports the result. Same-key, same-chain and same-shot idempotency, the project's permission, the film's retention and the cast permission of every shot in it are all checked the way they are for every deliverable: at admission, during the render, and wherever the result is listed or served.

**A paid stage must declare itself.** An engine names its stage, its provider and whether it is paid. A paid engine is refused unless the stage declares that provider and a spend above $0 and at most $50 (G1's single-evaluation gate). A local engine declares nothing. A chain with any declared spend is still refused when the job is planned, because a deliverable is admitted only at zero cost: a vendor upscaler needs its vendor approved (G3) and a reservation of its own (G1), and neither exists. No paid engine ships. The refusal is tested with a test-only fake vendor upscaler.

**Routes** (owner-only, `private, no-store`):

| | |
|---|---|
| `GET /api/projects/:id/deliveries/hero/:filmJobId` | every shot of a finished final render, each available or not with the reason; the chain's choices, engines and limits; and the hero renders already made of that film |
| `POST /api/projects/:id/deliveries/hero/:filmJobId` | `{"idempotencyKey": "…", "shotId": "…", "denoise"?, "fps"?, "height"?}`; answers `202` with the job id |

A made hero render is listed in `GET …/deliveries`. The listing shows every stage's record and links to every file it retains: each stage's file, the record, and the sidecar when signed. The artifact route serves those files under the job's own token, and nothing else.

Tests: `packages/planner/test/hero-chain.test.ts`, `packages/generator/test/hero-chain.test.ts`, `packages/api/test/hero-chain-route.test.ts`, `packages/storage/test/hero-chain-recovery.test.ts`.

## Prompt limits (HV-019-19)

Release 3's live run (G23) stopped when fal's Kling refused a final's prompt at result time, after accepting the submit: `422 string_too_long ... "String should have at most 2500 characters"`. A shot's prompt is its heading and action, the cast direction, the reference map, the shot direction and a feature's style bible, and nothing bounded the whole.

- **Declared in the catalogue.** `FalModelSpec.maxPromptChars` is 2,500 on all three Kling entries (`kling-v2.5-turbo-pro`, `kling-o3-standard-keyframes`, `kling-o3-standard-reference`). It counts the numbered image note a reference model appends (`falReferenceNote`): O3 reference takes 2,500 less 30 characters per image from the planner, 2,380 with four. FLUX Schnell and FLUX.2 edit declare none. No limit for them is recorded in this repository, so none is invented and a still's prompt is never cut. `promptCharLimit(stage, spec, images)` in `catalog.ts` reads the declaration for a pool entry.
- **Not in the capability snapshot.** No capability or provider-plan revision moves, so a plan admitted before this change keeps its revision. The limit's effect is the shot's fitted prompt, which the shot's input hash already covers.
- **The mock stands in.** The mock video adapter takes what the strictest live fal video model takes (`mockVideoPromptLimit`), so a $0 rehearsal fits and refuses the same prompts. The stills mock declares none, like FLUX.
- **Fitted before admission.** `fitShotPrompts` (`packages/planner/src/prompt-fit.ts`) runs last in the film chain at admission, in the worker and in shot reuse. A shot's limit is the smallest declared among the pool's providers that take its image count. The order of cuts, the parts never cut and the record are in that module's header. A shot within its limit is unchanged byte for byte. A fitted shot carries `promptFit` (`hv-prompt-fit/1`) into its provenance. One that can't fit is refused at admission (HTTP 400, `PromptFitError`), before anything is queued.
- **Refused locally.** The fal adapter and the mock refuse an over-limit prompt with `PromptLengthError` before any request. The router does not fail it over.
- **Counted in UTF-8 bytes (HV-019-20).** The resumed run's shot 9 was fitted to 2,495 characters and fal refused it: `422 "prompt: size must be between 0 and 2500"`. It was 2,503 UTF-8 bytes, because the live crew's cast direction quotes the script in curly quotes. Every limit, size and cut is now measured with `promptSize` (UTF-8 bytes, never fewer than characters). The cut mark is ASCII "...". The fit record is `hv-prompt-fit/2`, in bytes. The fal guard measures the `prompt` field of the serialized request body it is about to send.

Takes, character sheets, motion studies and current-film renders are not fitted. Their adapters still refuse an over-limit prompt locally, at $0.

## Accounting and failure behavior

The router re-reads remaining shot/job capacity before each candidate. PostgreSQL atomically checks the saved route's model, capability revision and quote, rejects reuse of a route for another dispatch, and reserves the attempt under the existing budget lock. Known shot spending plus outstanding running/unknown liabilities must fit the shot cap. Other shots retain their own limits within the shared job reservation.

Each bill carries the attempt and route IDs. Paid failures, discarded repairs and cancellations retain their costs. An invoice above the quote is still recorded; exceeding a shot cap cancels further job work even when the overall job cap has room. A failed route write, lease loss, budget error or safety refusal stops inference. Unknown liabilities remain held through the existing reconciliation path.

The JSON ledger supports the local single-worker path and checks known per-shot spending. PostgreSQL remains the supported shared-worker accounting path with atomic concurrent attempt holds.

Three provider failures open that worker process's circuit for 30 seconds. One recovery probe may run after the interval; successful generation closes the circuit. Observations expire after ten minutes of inactivity, while an active recovery probe stays exclusive. This is process-local operational evidence, not a fleet-wide health service or a quality evaluation.

Completed clip checkpoints and the protected provenance download include the selected capability snapshot, requirements, adaptation notes and route decision IDs. Existing model/seed/fingerprint fields remain. The manifest still uses the existing c2pa-style claim; this work does not create signed C2PA credentials.

## Provider facts checked

- [Kling v2.5 Turbo Pro text-to-video API](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video/api): this adapter uses the text-only endpoint, supported billed durations and aspect ratios; no reference conditioning is implemented.
- Kling's 2,500-character prompt limit is the vendor's own 422 on Release 3's live run (G23, 2026-10-05), on `fal-ai/kling-video/o3/standard/reference-to-video`; it is applied to all three Kling entries.
- [Veo 3 Fast API](https://fal.ai/models/fal-ai/veo3/fast/api): checked 2026-09-06; the vendor marks the endpoint deprecated and unsupported. The registry retains its historical descriptor but marks it retired. It is not automatically migrated to another paid model.
- [FLUX Schnell API](https://fal.ai/models/fal-ai/flux/schnell/api): single-frame text-to-image path; the current adapter rejects identity/reference conditioning.

Prices are configured estimates with invoiceReconciled=false. Region for hosted adapters is unspecified. Local fixtures do not establish live vendor availability, regional execution, visual quality or current invoices. No paid inference was dispatched for this increment.

## Validation and rollout

Router tests cover metadata without credentials, unsupported requirements, configured prices, plan integrity, ordering, persistence failure, paid failover, cancellation costs, circuit recovery, retired models, and capability drift. Worker/API tests cover admitted-plan execution, provenance and cost correlation, refusal before enqueue, and unexpected per-shot invoices. PostgreSQL tests exercise concurrent shot holds, unknown liability, exact dispatch binding and route replay.

Desktop targeted tests and static checks run on Windows. The complete Linux CI suite additionally supplies PostgreSQL, S3, ffmpeg, espeak-ng and shell tooling. Desktop full-suite limitations include existing Unix path/script assumptions and absent espeak-ng; these do not substitute for the Linux checks.

Deploy only after CI passes. Existing active jobs with no plan remain readable. Keep shared nonsecret provider configuration consistent across roles, retain worker-only inference keys, and perform a private mock animatic/final smoke after rollout. Live Zo deployment and provider evaluation remain pending while Zo is unavailable.

## Capability revision changes and in-flight plans

`revision` is `contentHash(definition)` and `priceVersion` is `contentHash(definition.price)`. Those hashes are pinned in saved `hv-provider-plan/1` job bodies, in `hv-route-decision/1` candidates, in the circuit-breaker key, in the worker's heartbeat rows and in the committed conformance evidence. Any change to what an adapter publishes therefore moves a hash, and this section states exactly what happens when one does — because the shape of the change decides whether the consequence is a clean refusal or an unrecoverable one.

**An enqueued plan.** Both staging deploy paths drain first: `deploy-storage-staging.py` counts queued and running jobs and raises "jobs did not drain; admission remains closed", and `deploy-private-staging.py` raises "staging still has active jobs; drain it before deployment". If a stale plan is claimed anyway, `instantiateProviderPlan` finds the spec in the current pool, sees that the hashes differ, and throws "Provider configuration changed after this job was queued. Start a new render to use the current configuration." Nothing dispatches and nothing is spent.

**A leased job.** The plan-versus-live comparison happens before the router sees the job, in `instantiateProviderPlan`. Inside `RoutedGenerator` a drifted revision is caught twice more: once while it builds each route decision's candidate list, where the candidate is marked ineligible with reason `capability-changed`, and again immediately before dispatch, where it re-validates the live capability and raises `RoutingError(["capability-changed"])`. (The constructor's own check compares the adapter's name and model against the capability it publishes — "Registered providers must publish matching capabilities" — which is a different invariant: it pins the snapshot it was handed, so it cannot detect a revision change.) That error is terminal rather than a failover trigger, so the job fails with its accounting closed rather than rendering against a provider it was not admitted for.

**A retained record.** Provenance re-verification is rebuilt entirely from saved data — `shot-execution-capture.ts` and `shot-execution-equivalence.ts` read `plan.pool[…].snapshot.revision` and never consult the live registry — so a retained record survives a revision bump **provided `capability()` still accepts the stored definition**.

**The one forbidden move.** Adding a *required* field, or otherwise tightening `capability()`'s validator, makes it throw on definitions that are already stored. That propagates through `validateCapability` → `validateProviderPlan` into `renderInputHash`, `validateShotRenderRecipe` and the whole equivalence chain: every retained plan becomes permanently unreadable and shot reuse permanently dead, on records that are content-addressed and so cannot be rewritten without breaking their own seals. A field added to `CapabilityDefinition` must therefore be optional, and a widening must keep every currently-emitted value legal. The conformance suite's `snapshot-integrity` family asserts all of this: that an additive field moves the revision and the old plan fails closed with the documented message; that a definition carrying the new field and one lacking it both round-trip, so a rollback is safe; that removing a required field throws; and that an explicit `undefined` does not hash the same as an absent key, so an optional field must be spread conditionally or "optional" silently becomes "always present".

**What does *not* move a hash.** `contentHash` hashes runtime values through `canonical()`, which enumerates `Object.keys` — not TypeScript types. Widening the declared union of a field while every adapter keeps emitting the same value produces a byte-identical canonical string and changes no revision at all.

**The audio and lip-sync lanes are not governed by this section.** Their hashes include their own `schema` string and their validators re-derive rather than compare, so the rules above do not transfer. See "Audio and lip-sync revisions are immovable" below.

## Audio and lip-sync revisions are immovable, and why the unification is not additive

The roadmap asked for the audio and lip-sync capabilities to be re-expressed as `hv-capability/2` snapshots behind an additive compatibility shim. That is not possible, and this section states why with reproductions rather than assertions, so the later work is designed against the real constraint.

**`schema` is inside every performance hash and outside the video hash.** `capability()` hashes a definition that has no `schema` key and adds the literal afterwards, so the video schema string is in no video revision — renaming it would move nothing. Every performance capability does the opposite: it builds its definition *with* the schema string inside it and hashes that. So a schema rename alone moves all five performance revisions, before any field is touched. Both facts are reproduced in `packages/generator/test/performance-conformance.test.ts` (`hash-shape`), including the specific case of renaming a performance schema to `hv-capability/2`.

**A lookup shim does not sit on the path that breaks.** `audioCapability(revision)` is a lookup, and `audio-jobs.ts` does fail a line when it misses — but the paths that matter are live *re-derivations*, which a lookup cannot help: `validateAudioLinePlan` recompiles the stored plan from the live capability constants and hash-compares it; `validateLipSyncPolicy` strips `capabilityRevision` and re-derives it from the live constant; `createLipSyncPlan` / `validateLipSyncPlan` do the same; and `validateLipSyncDelivery` does a bare live equality on an already-delivered record. A shim that keeps old revisions *resolvable* changes none of those outcomes. Two long-committed tests already demonstrate the failure — `packages/planner/test/audio-phrases.test.ts` and `azure-performance.test.ts` both assert that a line plan whose `capabilityRevision` differs from the derived one throws. A genuine shim would have to make the *compiler* reproduce historical revisions, keeping every retired definition object verbatim and selecting it by the stored record's discriminant. That is a revision-parameterized compiler, not a shim, and the archive of retired definitions is exactly the thing that rots — nothing exercises it unless golden records are committed and re-validated, which is what HV-019-03 built.

**What a moved revision costs, by record.** Seven record shapes pin a performance revision: `hv-audio-line/1..5` (written from the live constant in `audio-performances.ts`, stored on the job's audio take, in audio outputs, checkpoints, retained auditions, dialogue reports and editorial bindings); `hv-audio-line-delivery/1..2`; `hv-audio-dispatch/1..2` (in the ledger's audio attempts, in PostgreSQL and in portable archives); `hv-audio-policy/1..3` (which pins a *model*, coupled to the capability through a model comparison); `hv-lipsync-policy/1`; `hv-lipsync-plan/1`; and `hv-lipsync-delivery/1`. Every one of them is refused rather than misread — there is no silent-wrong-answer case anywhere in this lane. But the refusals split into two classes, and only one is acceptable:

- **A clean refusal on new work.** A queued or leased job fails closed and the operator starts a new render. This is the same shape as the video lane and it is fine.
- **An unrecoverable refusal on finished work.** `validateSnapshot` reaches `validateAudioTake` on every job and `validateAudioIntent` on every attempt, and it is called from all four snapshot entry points — read, write, import and export. So one moved revision makes every portable archive and every backup restore that contains a single audio take permanently un-importable. The records are content-addressed, so they cannot be rewritten to the new revision without breaking their own seals.

**The additive discipline this lane already uses** is the one to keep, and `docs/NATIVE-VOICE-PERFORMANCE.md` states it: a new capability constant, a new line schema, routed by the shape of the input, with *older discriminants and hashes unchanged*. A `hv-capability/2` projection is safe only as a new, additional object that no existing record references.

**One trap for whoever does attempt it.** `validateProviderPlan` and `validateCapability` both hard-code the literal `hv-capability/1`. Introducing `hv-capability/2` means loosening both — and *not* changing the `/1` literal, which would be the forbidden move described in "Capability revision changes and in-flight plans" above, on every stored video plan.

## P5 gap register

FULL-SCOPE §3 P5 is larger than what HV-019 delivers today. Each item below states what is not delivered and who owns it, so the epic's eventual G6 acknowledgement is of a bounded scope rather than a vague one. Nothing here is a claim that the item is partially working.

| Not delivered | Owner | Current truthful state |
| --- | --- | --- |
| Performance capability revision pins and a conformance suite | HV-019-03 | **Delivered.** Five revisions pinned in `docs/evidence/hv019-performance/capability-revision-pins.json` and re-derived on every test run; ten golden delivered records committed in `packages/generator/test/fixtures/performance-records.json` and re-validated by the validators that read them in production. Before this, nothing anywhere guarded those revisions — a one-character capability edit left every audio suite green. The adapters are still selected by voice id through `hv-audio-policy/N`; there is no pool, plan, matcher, failover or circuit, and none is claimed. |
| `hv-capability/2` unification of the performance schemas, and a third `modality` value | HV-019-04 / HV-019-09 | Two blockers, both stated with reproductions in "Audio and lip-sync revisions are immovable" above. `capability()` cannot express a non-raster contract without fabricating `output.minWidth/minHeight/maxWidth/maxHeight` into a content-addressed record, which CLAUDE.md forbids. And every performance hash includes its own `schema` string, so no re-expression is additive under any lookup shim — a genuine one needs a revision-parameterized compiler, which is only safe now that golden records exist to exercise it. |
| Voice and lip-sync selection as a pool and an admitted plan, and automatic lip-sync quality scoring | **HV-022** (FULL-SCOPE §P7) | §P5 owns the registry mechanism; §P7 owns voice selection, and this is §P7's. A pool is a failover set, which this lane forbids in code: "No automatic retry, alternate voice, or fallback provider may consume a second reservation." Admitting one would also break the three single-`heldUsd` reservation invariants, and would need three provider labels the closed telemetry set does not have plus a widened router `Stage`. Automatic scoring is refused by the capability itself — `quality.automaticScore: false`, owner rubric only — and honest scoring would need authorized footage (G1/G7). |
| `health` in the capability snapshot | HV-019-08, gated on a second reachable value (G3) | §P5 names health as a snapshot field. It is not one: live health is per-worker-process circuit state in `router.ts`, which is correctly outside a content-addressed snapshot. The honest form is a *declared* enum saying what health signal an adapter offers — but every adapter would declare the same constant until there is a vendor status endpoint or a self-hosted lane, so seventeen revisions would move for no information. HV-019-01's claim that adding it would invalidate every admitted plan in flight is correct, and this increment's own test demonstrates it: a plan admitted before the addition fails closed with "Start a new render", and both staging deploy paths drain queued and running jobs first. What "Capability revision changes and in-flight plans" above adds is the part that was missing rather than wrong — a *retained* record is re-verified from saved data and survives the bump as long as the field is optional, while a *required* field would make every retained plan permanently unreadable. |
| `extension` as a real tri-state | HV-019-03/-04, with the extension modality | `extension` is hard-coded `false` and `capability()` rejects any other value. Widening the union today produces a type with one reachable value and no test that can assert anything, because no adapter can emit a second one until the extension modality exists. Widening the *type* alone changes no revision — `contentHash` hashes values, not types. |
| `policy.vendorPolicyVersion` populated | operator check; no gate blocks it | Hard-coded `null`. This repository cites model schema and list pricing for fal.ai and nothing else — there is no terms-of-service, acceptable-use or content-policy document referenced anywhere, and no version identifier for one. Writing a value would be inventing provider evidence, which CLAUDE.md forbids. It needs a human to read and cite fal's policy document. |
| Upscaling, frame interpolation, extension, inpainting/outpainting, relighting, 3D, depth, segmentation | HV-019-03/-04; HV-019-15 (upscaling and interpolation, locally) | `GenerationModality` is still the closed union `"image" \| "video"`, and no provider modality exists for any of these. HV-019-15 upscales and interpolates a chosen shot with local ffmpeg in the hero-render chain, outside the router. That is not a generation modality, and no model-based upscaler or interpolator (Real-ESRGAN, RIFE, FILM) runs anywhere. |
| Quality presets (draft, preview, standard, hero, archival) and the hero-render chain | HV-019-04/-05; HV-019-15 (the chain) | **The hero-render chain is delivered in HV-019-15** (see "Hero-render chain" above): denoise, frame-rate conversion and upscale on a chosen shot of a final render, with local ffmpeg at $0. Each stage has its own provenance, and a paid stage must declare itself. FULL-SCOPE's chain also ends in a colour-managed output, which this chain does not make: it writes H.264 yuv420p and adds no colour management of its own. The five quality presets are still absent. The only tiering is a two-value job priority in the queue, which is unrelated to quality. |
| Routing on policy and on evaluation scores, and provider canaries | HV-019-14 (scores); policy and canaries not scheduled | **Routing on measured scores is delivered in HV-019-14**: the `quality` strategy reads a committed, validated `hv-benchmark-measured/1` results file. No such file is committed yet. The paid pass that produces one is HV-037's next increment (about $11, declared there), so today every `quality` plan falls back to the configured order and says so. `policy` is stored but is still never an eligibility or ranking input, and there are no provider canaries. `packages/benchmarks/baseline.json` stays mock-only with `visualQualityProxy: 1` and is not a routing input. |
| Self-hosted model lane behind the same adapter contract | G3 | Absent. Needs operator GPUs, which is a provisioning decision, not a code change. |
| End-to-end deterministic mode and the Reproducible Film Manifest | HV-019-07 | Seeds, fixed model versions and a `determinism` field exist, and the local adapters are genuinely bit-exact. There is no regenerate-from-manifest path and no cross-generation diff report. The manifest still uses the existing c2pa-style claim; no signed C2PA credentials are created. |
| Telemetry labels that distinguish one paid model from another | not scheduled | **Delivered in HV-019-02 for the lane**: `rich-animatic-paid` and `anchor-storyboard` are now their own labels and no registered adapter reaches `other`. What remains is per-model resolution — two different paid image models still share one label — and it is deliberately not proposed, because a per-model label is unbounded cardinality, which ADR-0018 and the metric allow-list refuse. |
| Invoice reconciliation of recorded provider cost | G1/G3 | Every `price.basis` is `configured` and every `price.invoiceReconciled` is `false`. `docs/PROVIDER-RECEIPTS.md` records that a read-only fal Billing Events probe returned HTTP 403. |
