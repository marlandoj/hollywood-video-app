# Provider capability routing (HV-019)

This increment replaces model-name selection in new job execution with an admitted provider plan. It implements routing for the existing video and rich-animatic adapters. HV-019 and the wider P5 scope remain in progress: additional modalities, quality presets, calibrated visual evaluation, production canaries, self-hosted inference, and a complete reproducible film package are separate work.

## Admission and execution

The API saves a versioned, SHA-256-addressed plan in the job body: stage, strategy, per-shot cap, render requirements, normalized operator-approved pool, and each adapter's capability and configured price snapshot. Metadata construction requires no inference key. Only the worker receives FAL_KEY.

At claim time, the worker verifies the saved plan against the current allowed pool and adapter definitions. Removing an admitted provider or changing its model, price or capability definition prevents execution and asks for a new render. Reordering or adding current pool entries cannot silently change the admitted pool. Environment settings shared by API and workers must match.

Before every dispatch, the router matches requested dimensions, frame rate, duration, reference/identity counts, camera move, audio, native resolution, deterministic output, region and synthetic-output policy. Unknown or unsupported features are explicit rejections. Retired endpoints cannot be selected. Capability definitions describe the actual adapter path, including post-processing; an endpoint supporting a feature does not imply this adapter implements it.

The lease holder saves a routing decision before inference. Decisions contain eligibility/rejection reasons, configured quotes, capability and price revisions, and bounded worker-local health observations. They contain no prompt, reference URL, credential or provider response body. PostgreSQL persists these through the existing job row lock, lease fence and RLS scope; no database migration is required.

New jobs always enforce their saved plan. Older jobs use registered built-in adapters when available. The legacy injected-adapter contract is retained only for pre-plan jobs whose custom adapters have no capability snapshot.

## Configuration

Set these on both the API and workers. Existing primary/secondary selectors remain the defaults.

| Setting | Behavior |
| --- | --- |
| HV_PROVIDER_POOL | Optional JSON array of 1–8 final adapter specs; overrides primary/secondary. Duplicates normalize to one entry. |
| HV_ANIMATIC_PROVIDER_POOL | Optional JSON array of 1–8 animatic adapter specs; overrides HV_ANIMATIC_PROVIDER. |
| HV_CHARACTER_SHEET_PROVIDER_POOL | Optional JSON array of 1–8 character-sheet adapter specs; defaults to `["mock"]`. Narration and captions are forced off on this stage. |
| HV_ROUTING_STRATEGY | configured (default), cost, or latency. |
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
- Admission also enforces a per-film limit, `HV_FILM_SPEND_CAP_USD` ($40 default, never above the monthly cap). In PostgreSQL it is checked inside `admit`'s lock, from `hv_cost_events` and `hv_reservations` by `project_id`.

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

Cost strategy ranks eligible configured quotes; video quotes round up to supported billed durations and image quotes use the adapter's configured megapixel ceiling or per-image rate. Latency strategy uses observed successful durations only after three samples; unknown providers keep configured order behind observed providers. Neither strategy fabricates quality scores or live vendor health.

## Accounting and failure behavior

The router re-reads remaining shot/job capacity before each candidate. PostgreSQL atomically checks the saved route's model, capability revision and quote, rejects reuse of a route for another dispatch, and reserves the attempt under the existing budget lock. Known shot spending plus outstanding running/unknown liabilities must fit the shot cap. Other shots retain their own limits within the shared job reservation.

Each bill carries the attempt and route IDs. Paid failures, discarded repairs and cancellations retain their costs. An invoice above the quote is still recorded; exceeding a shot cap cancels further job work even when the overall job cap has room. A failed route write, lease loss, budget error or safety refusal stops inference. Unknown liabilities remain held through the existing reconciliation path.

The JSON ledger supports the local single-worker path and checks known per-shot spending. PostgreSQL remains the supported shared-worker accounting path with atomic concurrent attempt holds.

Three provider failures open that worker process's circuit for 30 seconds. One recovery probe may run after the interval; successful generation closes the circuit. Observations expire after ten minutes of inactivity, while an active recovery probe stays exclusive. This is process-local operational evidence, not a fleet-wide health service or a quality evaluation.

Completed clip checkpoints and the protected provenance download include the selected capability snapshot, requirements, adaptation notes and route decision IDs. Existing model/seed/fingerprint fields remain. The manifest still uses the existing c2pa-style claim; this work does not create signed C2PA credentials.

## Provider facts checked

- [Kling v2.5 Turbo Pro text-to-video API](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video/api): this adapter uses the text-only endpoint, supported billed durations and aspect ratios; no reference conditioning is implemented.
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
| Upscaling, frame interpolation, extension, inpainting/outpainting, relighting, 3D, depth, segmentation | HV-019-03/-04 | `GenerationModality` is the closed union `"image" \| "video"`. None of these modalities exists in any package. |
| Quality presets (draft, preview, standard, hero, archival) and the hero-render chain | HV-019-04/-05 | Absent. The only tiering today is a two-value job priority in the queue, which is unrelated to quality. |
| Routing on policy and on evaluation scores, and provider canaries | HV-019-06 (G1 for honest scores) | The ranking function has exactly three branches: configured, cost, latency. `policy` is stored but never an eligibility or ranking input. Honest quality scores need live paid dispatch and a real benchmark; `packages/benchmarks/baseline.json` is mock-only with `visualQualityProxy: 1`. |
| Self-hosted model lane behind the same adapter contract | G3 | Absent. Needs operator GPUs, which is a provisioning decision, not a code change. |
| End-to-end deterministic mode and the Reproducible Film Manifest | HV-019-07 | Seeds, fixed model versions and a `determinism` field exist, and the local adapters are genuinely bit-exact. There is no regenerate-from-manifest path and no cross-generation diff report. The manifest still uses the existing c2pa-style claim; no signed C2PA credentials are created. |
| Telemetry labels that distinguish one paid model from another | not scheduled | **Delivered in HV-019-02 for the lane**: `rich-animatic-paid` and `anchor-storyboard` are now their own labels and no registered adapter reaches `other`. What remains is per-model resolution — two different paid image models still share one label — and it is deliberately not proposed, because a per-model label is unbounded cardinality, which ADR-0018 and the metric allow-list refuse. |
| Invoice reconciliation of recorded provider cost | G1/G3 | Every `price.basis` is `configured` and every `price.invoiceReconciled` is `false`. `docs/PROVIDER-RECEIPTS.md` records that a read-only fal Billing Events probe returned HTTP 403. |
