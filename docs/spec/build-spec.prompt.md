# Hollywood Video Build Specification

Version: 1.0.1  
Date: 2026-08-29  
Owner: Marlandoj (operator); Alaric (Chief of Staff) - spec author  
Execution mode: swarm

## Source Provenance

- Label: Hollywood Video PRD v1.0 (2026-08-29, 338 lines)
- Path: `/home/workspace/Projects/hollywood-video/PRD.md`
- SHA-256: `612c3811b9bbffceb4b1e453681bd1f3719031d32126e09367a3dadddc28f3d5`


## Mission

Build Hollywood Video: a free, anonymous, script-first AI filmmaking studio in which any visitor pastes a Fountain screenplay and, without an account, an upload, or a payment, receives a watchable H.264 MP4 assembled from AI-generated shots. The operator funds all inference and rendering; the product earns goodwill, a public benchmark, and a distribution moat, not subscription revenue.

First experience: A new visitor pastes a 5-page Fountain script, sees a parsed preview, approves the animatic at the single human-in-the-loop gate, and - with no signup, no card, and no watermark - downloads a watchable H.264 MP4 within the published time-to-MP4 target.

Qualities: zero-friction anonymous access (no account, no card, no watermark), operator-funded (no user billing of any kind), evidence-governed (24-shot benchmark with regression gates in CI), reproducible (deterministic hashes; byte-identical output for identical inputs), fail-closed safety (any missing safety gate blocks generation), self-hostable (single docker compose on one 4xA100 machine)

Release tier: v1.0 public alpha -> free public beta -> GA (free, anonymous, operator-funded); excluded tier: paid tiers, freemium, subscriptions, pass-through provider charges, required accounts or free accounts (rejected by ADR-0018)

## Constraints

- **C-001** [source]: All inference and rendering is operator-funded; no user billing, subscription, credit ledger, or payment of any kind exists in the product.
- **C-002** [source]: No account, no email, no cookie: anonymous project access is via a signed, expiring (72 h) token embedded in a URL.
- **C-003** [source]: Fail-closed safety: any missing safety gate blocks generation rather than warning.
- **C-004** [source]: Self-hostable: a single docker compose up runs the full stack with no cloud-specific dependencies.
- **C-005** [source]: Reproducible: the same script, model, seed, and parameters produce a byte-identical MP4; the 24-shot benchmark is a CI artifact with deterministic hashes.
- **C-006** [source]: Hard monthly cost cap below $5,000 with auto-throttle at 80% of budget, rejection at 100%, and a per-job cost cap (default $5/shot).
- **C-007** [source]: The animatic approval is the only human-in-the-loop gate in v1.
- **C-008** [source]: Security and privacy baseline: mTLS between internal services, signed URLs for artifact access, no secrets in images, no cookies, no tracking pixels; IP addresses logged for rate limiting only and deleted after 30 days.
- **C-009** [source]: Evidence-gated changes: the 24-shot benchmark runs in CI on every model/provider change and a regression greater than 5% on any metric blocks merge.

## Anti-Goals

- **AG-001** [source]: No user accounts, authentication, or payment - signup itself is an access barrier (ADR-0018).
- **AG-002** [source]: No feature that requires a user to spend money; no freemium, subscriptions, or pass-through provider charges.
- **AG-003** [source]: No real-time collaborative editing in v1.
- **AG-004** [source]: No full non-linear editing timeline in v1; v1 is linear assembly only.
- **AG-005** [source]: No 4K or HDR output in v1; v1 targets 1080p H.264.
- **AG-006** [source]: No mobile-native app in v1; responsive web only.
- **AG-007** [source]: No public API in v1; an internal API exists and a public API is a post-alpha consideration.
- **AG-008** [source]: No audio mixing, music licensing, or localization in v1.

## Protected Capabilities

- **PC-001** [source]: Anonymous zero-charge access: the complete core journey completes without identity or payment.
- **PC-002** [source]: Fail-closed content safety: every prompt passes the moderation layer before reaching any provider; blocked prompts return a polite refusal.
- **PC-003** [source]: Provenance: every generated frame carries a C2PA-style content credential and a downloadable reproducibility manifest ships with the MP4.
- **PC-004** [source]: Hard operator budget: auto-throttle at 80% of budget and rejection at 100% keep monthly spend under cap.
- **PC-005** [source]: Deterministic reproducibility of pipeline output and benchmark runs.
- **PC-006** [source]: Data minimization: no personal data collected and anonymous projects auto-delete after 30 days.

## Scope Cut Order

- Elevated capacity tier (FR-030) - operator-granted only; the free tier is the product
- TTS voiceover (FR-041) - fall back to silent cuts with burned-in subtitles
- Extended export formats (ProRes, DNxHR) and 4K (FR-11.3 deferred item; v1.1)
- Proxy editing / drag-to-reorder timeline (FR-9.4 deferred item; v1.1)
- Localization and multi-language dubbing (FR-10.3 deferred item; v2)
- Real-time collaborative editing (never in v1 scope)

## Shared Contracts

- **SC-001 Anonymous project token**: `packages/api (auth layer, per FR-2.1 monorepo layout)`; owner api service; consumers api-gateway, generator, assembler, review-links; invariants Signed and expiring at 72 h (FR-007); No email, cookie, or account state (FR-007); Revocable via the operator kill switch (FR-049)
- **SC-002 Job record and cost accounting**: `packages/queue (job system, per FR-2.1 and FR-2.5)`; owner queue service; consumers generator, queue-capacity, cost-dashboard, benchmarks; invariants Persistent idempotent jobs with retry policy, timeout, and cost tracker (FR-009); Every job records {provider, model, prompt_tokens, output_frames, gpu_seconds, total_cost_usd} (FR-033)
- **SC-003 Safety and moderation gate**: `packages/safety (per FR-2.1)`; owner safety service; consumers generator, parser-editor, operator-console; invariants All prompts pass the gate before any provider call (FR-026); Fail-closed: a missing gate blocks generation (C-003); Blocked prompts return a polite refusal, not an error (FR-026)
- **SC-004 Continuity packet**: `packages/planner (creative bible, per FR-4.1 and FR-8.1)`; owner planner service; consumers shot-planner, generator-prompt-builder, continuity-checker; invariants Per character: reference image set plus text description (FR-034); Injected into every shot prompt that features the character (FR-034)
- **SC-005 Provider adapter interface**: `packages/generator (adapter interface, per FR-6.1)`; owner generator service; consumers generator, benchmarks, provider-failover; invariants generate(prompt, seed, params) -> video_clip is stable across implementations (FR-024); At least 2 providers run in production (risk R3)
- **SC-006 Benchmark fixture (24-shot Fountain)**: `packages/benchmarks (per FR-1.1 and FR-2.1)`; owner benchmarks package; consumers ci, generator, success-metrics; invariants Fixed Fountain file versioned in git (FR-001); Byte-identical hashes for a given model + seed (C-005); Regression greater than 5% on any metric blocks merge (FR-003)

## Requirements

| ID | Type | Origin | Requirement | Verification |
|---|---|---|---|---|
| FR-001 | functional | source | Define a 24-shot benchmark script as a fixed Fountain file versioned in git. | V-007 |
| FR-002 | functional | source | Benchmark measures per-shot generation latency, total pipeline time, visual quality (CLIP/FID or equivalent), continuity (face/scene consistency), and cost per shot. | V-007 |
| FR-003 | functional | source | Benchmark runs in CI on every model/provider change; a regression greater than 5% on any metric blocks merge. | V-001, V-007 |
| FR-004 | functional | source | Product name clearance: verify the chosen name is not trademarked in relevant classes and document the result in an ADR. | V-024 |
| FR-005 | functional | source | Monorepo with separate packages: frontend, api, parser, planner, generator, assembler, safety, queue, benchmarks. | V-001, V-025 |
| FR-006 | functional | source | CI pipeline: lint, typecheck, unit tests, integration tests, benchmark (GPU runner), build, deploy. | V-001 |
| FR-007 | functional | source | Anonymous access: project creation returns a signed, expiring (72 h) token embedded in a URL; no email, no cookie, no account. | V-009 |
| FR-008 | functional | source | All artifacts (shots, renders, MP4s) go to S3-compatible object storage with a 30-day auto-delete lifecycle for anonymous projects. | V-023 |
| FR-009 | functional | source | Job system: persistent, idempotent jobs (Redis + worker pool); every job has a retry policy, timeout, and cost tracker. | V-012 |
| FR-010 | functional | source | Telemetry: structured JSON logs, Prometheus metrics, Grafana dashboards; every generation job emits cost, latency, model, and quality metadata. | V-014, V-018 |
| FR-011 | functional | source | Parse standard Fountain format: scene headings, action, dialogue, transitions, parentheticals. | V-003 |
| FR-012 | functional | source | Editor: paste or upload .fountain with live preview of parsed structure (scenes, shots, characters). | V-002 |
| FR-013 | functional | source | Protected text: users can mark lines as locked (e.g., brand names, legal text) that the generator must not alter. | V-003 |
| FR-014 | functional | source | Revision history: each edit creates a version; regeneration can target any prior version. | V-002 |
| FR-015 | functional | source | Validation: reject scripts over 30 pages (v1 cap), warn above 20 scenes, flag unparseable constructs. | V-003 |
| FR-016 | functional | source | Auto-generate a creative bible per project: character descriptions, setting palette, tone keywords, style references. | V-002, V-004 |
| FR-017 | functional | source | Rights and consent: require user attestation (checkbox) that they hold rights to all referenced IP, characters, and locations. | V-009 |
| FR-018 | functional | source | Provenance: every generated frame carries a C2PA-style content credential (model, prompt hash, timestamp, seed). | V-010 |
| FR-019 | functional | source | Provenance manifest: downloadable JSON alongside the MP4 listing all models, prompts, seeds, and parameter hashes for full reproducibility. | V-010 |
| FR-020 | functional | source | LLM-driven shot planner converts the parsed script into a shot list (shot type, duration, camera angle, motion, dialogue overlay). | V-002, V-004 |
| FR-021 | functional | source | Storyboard: per-shot thumbnail image (text-to-image) showing composition, character placement, and setting. | V-004 |
| FR-022 | functional | source | Animatic: auto-assemble storyboard stills with timing and dialogue audio (TTS) into a rough-cut video for review before expensive video generation. | V-004 |
| FR-023 | functional | source | User review gate: the user must approve the animatic (or request edits) before video generation begins; this is the only human-in-the-loop gate in v1. | V-009, V-016 |
| FR-024 | functional | source | Provider adapter interface generate(prompt, seed, params) -> video_clip with implementations for Runway, Pika, Kling, local ComfyUI, and at least one open-weight model. | V-005 |
| FR-025 | functional | source | Durable generation jobs survive worker restarts, checkpoint at frame boundaries, and resume on retry. | V-012 |
| FR-026 | functional | source | Safe submission: all prompts pass the safety/moderation layer before reaching any provider; blocked prompts return a polite refusal, not an error. | V-006 |
| FR-027 | functional | source | Provider failover: if the primary provider times out or errors, retry on the configured secondary before failing the job. | V-005 |
| FR-028 | functional | source | Cost guardrails: per-job cost cap (configurable, default $5/shot); if exceeded, the job is cancelled and the user is notified. | V-015 |
| FR-029 | functional | source | Fair queue: each anonymous project gets a weighted fair share of GPU time; no project can starve another. | V-013 |
| FR-030 | functional | source | Capacity tiers: free (default) = 1 concurrent project, max 24 shots, 720p, standard queue; elevated (operator-granted) = 3 concurrent, 60 shots, 1080p, priority queue. | V-015 |
| FR-031 | functional | source | Operator cost dashboard: real-time spend per day/week/month, per project, per provider, per shot type. | V-014 |
| FR-032 | functional | source | Auto-throttle: at 80% of monthly budget, new free-tier projects queue behind existing jobs; at 100%, new projects are rejected with a capacity-full message. | V-015 |
| FR-033 | functional | source | Cost accounting: every job records {provider, model, prompt_tokens, output_frames, gpu_seconds, total_cost_usd}, aggregated to daily/weekly/monthly rollups. | V-014 |
| FR-034 | functional | source | Continuity packet: per character, a reference image set plus text description, injected into every shot prompt that features the character. | V-002, V-004 |
| FR-035 | functional | source | Shot-to-shot continuity check compares adjacent shots for character consistency (face embedding distance), lighting, and palette; shots below threshold are flagged. | V-008 |
| FR-036 | functional | source | Human review queue: flagged shots appear in an operator review panel where the operator approves, regenerates, or manually adjusts. | V-008 |
| FR-037 | functional | source | Repair loop: a shot failing continuity after regeneration (max 2 retries) is marked 'degraded' and the final MP4 carries a metadata note. | V-008 |
| FR-038 | functional | source | Auto-assembly: concatenate approved shots in script order, apply crossfades (0.5 s default), burn in dialogue subtitles (optional toggle). | V-004, V-011 |
| FR-039 | functional | source | Inline viewer: stream the assembled video in-browser (HLS) with per-shot timestamps, thumbnails, and regeneration buttons. | V-004 |
| FR-040 | functional | source | Export: H.264 MP4, 1080p, 30 fps, AAC audio; download link valid for 30 days. | V-011 |
| FR-041 | functional | source | Alpha: auto-generate voiceover from dialogue lines using TTS (ElevenLabs or an open-source alternative). | V-011 |
| FR-042 | functional | source | Alpha: SRT/VTT captions burned in or provided as a sidecar file. | V-011, V-020 |
| FR-043 | functional | source | Export pipeline is ffmpeg-based and deterministic: same inputs produce the same output hash. | V-011 |
| FR-044 | functional | source | Every exported MP4 passes ffprobe checks (codec, resolution, duration, bitrate) before the download link is issued. | V-011 |
| FR-045 | functional | source | Signed review links: any project can be shared via a URL with read-only or approve/deny permission; no account required. | V-021 |
| FR-046 | functional | source | Approval workflow: creator submits, reviewer views, reviewer approves or requests changes (free-text note), creator regenerates or finalizes. | V-021 |
| FR-047 | functional | source | Link hygiene: review links expire after 7 days or 3 views (configurable) and are revocable by the creator. | V-021 |
| FR-048 | functional | source | Public status page: current queue depth, estimated wait time, system health; no PII. | V-018 |
| FR-049 | functional | source | Operator console (authenticated, internal): job monitoring, queue management, project kill-switch, cost alerts, provider health. | V-017, V-018 |
| FR-050 | functional | source | Support: in-app 'Report an issue' form (no account; attaches project ID + anonymized logs), routed to the operator inbox. | V-016, V-018 |
| FR-051 | functional | source | Analytics: anonymized, aggregated usage metrics (projects created, shots generated, completion rate, avg time-to-MP4); no individual tracking. | V-018 |
| FR-052 | functional | source | Terms of Service: clear, plain language - free use, operator-funded, no SLA, content is the user's responsibility, operator can delete any project. | V-019 |
| FR-053 | functional | source | Privacy: no personal data collected; IP address logged for rate limiting only and deleted after 30 days; no cookies; no tracking pixels. | V-018, V-023 |
| FR-054 | functional | source | Content policy prohibits: (a) identifiable real persons without consent, (b) CSAM or sexual content involving minors, (c) deepfake political content, (d) trademark-infringing brand content. | V-006 |
| FR-055 | functional | source | Takedown: DMCA-style form; the operator can takedown any project within 24 h of a verified request; takedown is logged and irreversible. | V-022 |
| FR-056 | functional | source | Legal review: ToS, privacy policy, and content policy reviewed by counsel before public launch. | V-019 |
| FR-057 | functional | source | Data retention: anonymous project data auto-deletes after 30 days; the operator can manually extend for benchmark purposes (logged). | V-023 |
| FR-058 | functional | source | Load test: sustain 50 concurrent projects and 500 shots in queue with p99 shot latency under 120 s. | V-013 |
| FR-059 | functional | source | Security pen test on auth tokens, rate limiting, file upload, and API; fix all critical/high findings before launch. | V-017 |
| FR-060 | functional | source | Free public beta: soft launch to 100 invited users for 2 weeks; monitor cost, quality, and failure rates. | V-016 |
| FR-061 | functional | source | GA launch: public URL, status page live, social announcement, benchmark results published. | V-016 |
| FR-062 | functional | source | Post-launch cadence: weekly cost review, monthly benchmark re-run, quarterly capacity planning. | V-007, V-014 |
| NFR-001 | nonfunctional | source | Performance: p99 shot generation under 90 s (720p, 5 s clip); end-to-end script-to-MP4 under 15 min for a 12-shot short. | V-013, V-016 |
| NFR-002 | nonfunctional | source | Availability: 99% monthly uptime for the public site; GPU-maintenance downtime acceptable with under 4 h notice. | V-016 |
| NFR-003 | nonfunctional | source | Scalability: horizontal GPU worker scaling; queue depth over 1,000 jobs without degradation. | V-013 |
| NFR-004 | nonfunctional | source | Security: all internal service traffic over mTLS; signed URLs for artifact access; no secrets in images. | V-018 |
| NFR-005 | nonfunctional | source | Observability: 100% of jobs produce structured logs; dashboards for queue depth, cost/hour, error rate, and p50/p95/p99 latency. | V-014, V-018 |
| NFR-006 | nonfunctional | source | Portability: docker compose up on a single 4xA100 machine runs the full stack; no cloud-specific dependencies. | V-025 |
| NFR-007 | nonfunctional | source | Reproducibility: given the same script, model, seed, and parameters, the output MP4 is byte-identical. | V-011 |
| NFR-008 | nonfunctional | source | Accessibility: WCAG 2.1 AA; all interactive elements keyboard-navigable; captions on all exported video. | V-020 |

## Verification

- **V-001** (static, automated): CI lint + typecheck across all monorepo packages. Threshold: Zero errors; every commit must pass
- **V-002** (unit, automated): Unit tests for parser, planner, queue, cost accounting, editor state, and creative-bible generation. Threshold: 100% pass; line coverage >= 90% on parser, planner, and queue
- **V-003** (contract, automated): Fountain parser conformance suite: scene headings, action, dialogue, transitions, parentheticals, protected text, 30-page cap, 20-scene warning, and unparseable-construct fixtures. Threshold: All fixtures parse to the expected AST; cap/warn/flag behaviors match FR-015
- **V-004** (integration, automated): Full-pipeline integration on the compose stack with a stubbed provider: script -> shot plan -> storyboard -> animatic -> generation -> assembly -> export. Threshold: A 12-shot short completes end-to-end deterministically
- **V-005** (contract, automated): Provider adapter contract tests per implementation (generate(prompt, seed, params) -> clip) including the failover path. Threshold: All adapters return clips with expected metadata; primary timeout routes to the secondary, which completes the job
- **V-006** (integration, automated): Safety gate battery of prohibited prompts: identifiable real persons, minors, political deepfakes, trademarked brands. Threshold: 100% blocked before any provider call; polite refusal returned; zero provider submissions
- **V-007** (performance, automated): Run the 24-shot benchmark (fixed versioned Fountain, pinned model + seed). Threshold: Baseline recorded; regression > 5% on any metric blocks merge; per-shot latency, cost, quality, and continuity recorded
- **V-008** (visual, agent): Continuity evaluation: face-embedding distance between adjacent shots featuring the same character, plus lighting and palette comparison. Threshold: Flagged shots surface in the operator review queue; >= 80% of shot pairs pass at the post-GA target
- **V-009** (integration, automated): Anonymous journey test: fresh visitor pastes a script, receives a tokenized URL, completes rights attestation, approves the animatic, and downloads the MP4. Threshold: Zero account/email/card prompts; token expires at 72 h; generation is blocked until animatic approval
- **V-010** (contract, automated): Provenance check on export: C2PA-style per-frame credentials plus the downloadable manifest. Threshold: Every frame carries model, prompt hash, timestamp, and seed; the manifest lists all models, prompts, seeds, and parameter hashes
- **V-011** (integration, automated): Export validation: ffprobe (codec, resolution, duration, bitrate, audio) plus deterministic re-export hash comparison. Threshold: 100% of exports pass ffprobe; identical inputs produce identical MP4 hashes
- **V-012** (temporal, automated): Durability test: kill the generation worker mid-job, then restart it. Threshold: Job resumes from the last frame-boundary checkpoint with no duplicate or lost shots; idempotent
- **V-013** (performance, automated): Load test: 50 concurrent projects, 500 shots in queue. Threshold: p99 shot latency < 120 s; no degradation at queue depth > 1,000 jobs
- **V-014** (temporal, agent): Cost accounting audit: compare job cost records against provider invoices over a 2-week window. Threshold: Daily/weekly/monthly rollups match provider invoices within 5%
- **V-015** (temporal, automated): Budget enforcement simulation: drive monthly spend to 80% and 100% of budget. Threshold: At 80% new free-tier projects queue behind existing jobs; at 100% new projects are rejected with the capacity message; per-job cap (default $5/shot) cancels and notifies
- **V-016** (human, user): Free public beta: 100 invited users for 2 weeks. Threshold: Completion rate >= 70%; median time-to-MP4 < 12 min; monthly cost < $5,000; uptime >= 99%
- **V-017** (human, user): Penetration test: auth tokens, rate limiting, file upload, API. Threshold: No open critical or high findings at launch
- **V-018** (static, automated): Security static audit: secret scan of images and repo, mTLS configuration, signed-URL enforcement, cookie/tracking-pixel scan. Threshold: Zero secrets in images; internal traffic mTLS; artifact access via signed URLs only; no cookies or tracking pixels
- **V-019** (human, user): Counsel review of ToS, privacy policy, and content policy. Threshold: Documented sign-off before public launch
- **V-020** (human, user): WCAG 2.1 AA audit of the public UI (keyboard navigation, contrast) plus caption check on all exported video. Threshold: Passes the automated and manual AA checklist; captions present on every export
- **V-021** (contract, automated): Review link contract tests: permission levels, 7-day/3-view expiry, creator revocation. Threshold: Read-only links cannot approve; expired or revoked links are rejected; revocation is immediate
- **V-022** (integration, automated): Takedown flow test: verified request -> project removal. Threshold: Takedown completes, is logged, and is irreversible; artifacts inaccessible afterward
- **V-023** (temporal, automated): Retention test: age anonymous projects past 30 days. Threshold: Projects and artifacts auto-delete at 30 days; operator extensions logged; IPs deleted after 30 days
- **V-024** (human, user): Trademark clearance search for the product name in relevant classes. Threshold: Clearance documented in an ADR; fallback name pre-cleared if blocked
- **V-025** (integration, automated): Fresh docker compose up deployment on a single 4xA100 host, followed by the end-to-end pipeline run. Threshold: Full stack healthy; the 12-shot e2e completes; no cloud-specific dependencies
- **V-026** (human, user): Five-user pilot: external users each produce a 60-second MP4. Threshold: 5/5 complete with zero operator intervention

## Canonical Scenarios

- **CS-001 Screenwriter proof-of-concept**: Fresh visitor, 5-page Fountain script, no account; Paste script, review parsed preview, approve animatic, await generation, download MP4. Evidence: Downloaded MP4, provenance manifest, and job cost records
- **CS-002 Marketer product short**: 1-page outline for a product short, 1080p export for same-day social posting; Upload outline, approve animatic, export H.264. Evidence: Exported MP4 and ffprobe report
- **CS-003 Evaluator provider comparison**: 24-shot benchmark suite, provider A vs provider B, pinned seeds; Run the benchmark suite in CI. Evidence: Benchmark report artifact retained in CI
- **CS-004 Abuse attempt**: Anonymous project submitting prohibited content (e.g., identifiable real person); Prompt passes through the safety gate before any provider. Evidence: Moderation log and absence of provider submission
- **CS-005 Capacity exhaustion**: Monthly spend at 100% of budget; New free-tier project request arrives. Evidence: Queue state, cost rollup, and rejection message
- **CS-006 Worker failure mid-generation**: Durable job in flight; worker killed at a random frame; Worker restarts. Evidence: Job logs before/after and final shot-set integrity
- **CS-007 Continuity failure**: A character appears in 10 consecutive shots; the model drifts; Continuity check flags low-similarity shots. Evidence: Flag logs, review decisions, and final MP4 metadata note
- **CS-008 Accountless review**: Creator shares a signed approve/deny review link with a reviewer; Reviewer views the cut and approves or requests changes. Evidence: Approval record and link expiry behavior

## Acceptance Matrix

| ID | Criterion | Requirements | Verification | Authority |
|---|---|---|---|---|
| AC-001 | The 24-shot benchmark is defined (fixed, versioned Fountain file) and runs end-to-end with baseline metrics recorded: per-shot latency, total pipeline time, visual quality (CLIP/FID or equivalent), continuity, and cost per shot. | FR-001, FR-002 | V-007 | automated |
| AC-002 | CI runs the benchmark on every model/provider change and blocks merge on a regression greater than 5% on any metric. | FR-003, FR-006 | V-001, V-007 | automated |
| AC-003 | Name clearance for 'Hollywood Video' (or the pre-cleared fallback) is documented in an ADR. | FR-004 | V-024 | user |
| AC-004 | Anonymous project creation returns a signed 72 h URL token, and the complete core journey finishes with no account, email, or card. | FR-007 | V-009 | automated |
| AC-005 | The 9-package monorepo exists and CI is green through lint, typecheck, unit, integration, and build stages. | FR-005, FR-006 | V-001, V-002 | automated |
| AC-006 | The Fountain editor and parser pass the conformance suite, including protected text, 30-page rejection, 20-scene warning, and unparseable-construct flagging, with per-edit version history. | FR-011, FR-012, FR-013, FR-014, FR-015 | V-002, V-003 | automated |
| AC-007 | The creative bible auto-generates per project, rights attestation is captured, and every export carries C2PA-style credentials plus the downloadable provenance manifest. | FR-016, FR-017, FR-018, FR-019 | V-009, V-010 | automated |
| AC-008 | A 12-shot short is produced end-to-end (script to MP4) with fewer than 2 continuity failures. | FR-020, FR-021, FR-022, FR-023, FR-024, FR-034, FR-035, FR-037 | V-004, V-008 | automated |
| AC-009 | All provider submissions pass the safety gate; the prohibited-prompt battery is 100% blocked with a polite refusal and zero provider calls. | FR-026, FR-054 | V-006 | automated |
| AC-010 | The per-job cost cap (default $5/shot) cancels over-cap jobs and notifies the user; every job records provider, model, prompt_tokens, output_frames, gpu_seconds, and total_cost_usd with rollups. | FR-028, FR-033 | V-014, V-015 | automated |
| AC-011 | Capacity tiers are enforced (free: 1 concurrent / 24 shots / 720p; elevated: 3 / 60 / 1080p) and auto-throttle is verified at 80% (queue behind) and 100% (reject with capacity message). | FR-030, FR-032 | V-015 | automated |
| AC-012 | The continuity check flags below-threshold shots to the operator review queue; the repair loop retries at most twice, then marks the shot 'degraded' with a metadata note in the final MP4. | FR-035, FR-036, FR-037 | V-008 | agent |
| AC-013 | Auto-assembly (script order, 0.5 s crossfades, optional subtitles), the HLS viewer, and export (H.264 1080p 30 fps AAC, 30-day link) work; every export passes ffprobe and re-export is byte-identical. | FR-038, FR-039, FR-040, FR-043, FR-044, NFR-007 | V-004, V-011 | automated |
| AC-014 | Alpha TTS voiceover from dialogue lines and SRT/VTT captions (burned in or sidecar) are present on exports. | FR-041, FR-042 | V-011, V-020 | automated |
| AC-015 | Accountless review links support read-only and approve/deny permissions, expire after 7 days or 3 views, and are revocable by the creator. | FR-045, FR-046, FR-047 | V-021 | automated |
| AC-016 | The public status page, operator console, support form, and anonymized analytics are live; no PII on any public surface; IPs delete after 30 days; no cookies or tracking pixels. | FR-048, FR-049, FR-050, FR-051, FR-053 | V-018, V-023 | automated |
| AC-017 | ToS and the content policy (four prohibitions) are live and counsel-reviewed; takedown completes within 24 h of a verified request and is logged and irreversible. | FR-052, FR-054, FR-055, FR-056 | V-006, V-019, V-022 | user |
| AC-018 | Free public beta completes: 100 invited users over 2 weeks with completion rate >= 70%, median time-to-MP4 < 12 min, monthly cost < $5,000, and uptime >= 99%. | FR-060, NFR-001, NFR-002 | V-016 | user |
| AC-019 | The load test passes (50 concurrent projects, 500 queued shots, p99 < 120 s), the pen test has no open critical or high findings, and the GA launch is live (public URL, status page, announcement, published benchmark results). | FR-058, FR-059, FR-061 | V-013, V-017 | user |
| AC-020 | Post-launch cadence is operational: weekly cost review, monthly benchmark re-run, quarterly capacity planning. | FR-062 | V-007, V-014 | agent |
| AC-021 | The public site sustains >= 99% monthly uptime during the beta window. | NFR-002 | V-016 | user |
| AC-022 | The public UI meets WCAG 2.1 AA (all interactive elements keyboard-navigable) and every exported video carries captions. | NFR-008 | V-020 | user |
| AC-023 | The full stack runs via a single docker compose up on a 4xA100 machine with no cloud-specific dependencies. | FR-005, NFR-006 | V-004, V-025 | automated |
| AC-024 | Durable, idempotent jobs survive worker restart via frame-boundary checkpoints; every job carries a retry policy, timeout, and cost tracker. | FR-009, FR-025 | V-012 | automated |
| AC-025 | Under mixed load, no anonymous project starves another (weighted fair share of GPU time). | FR-029 | V-013 | automated |
| AC-026 | Provider failover: a primary provider timeout or error retries on the configured secondary before the job fails. | FR-027 | V-005 | automated |
| AC-027 | Revision history: each edit creates a version and regeneration can target any prior version. | FR-014 | V-002 | automated |
| AC-028 | Anonymous projects and artifacts auto-delete after 30 days (S3 lifecycle); operator extensions are logged. | FR-008, FR-057 | V-023 | automated |
| AC-029 | Five external users each produce a 60-second MP4 without operator intervention (M3 gate). | FR-038, FR-039, FR-040, FR-045 | V-026 | user |

## Milestones

| ID | Increment | Dependencies | Owned Paths | Exit Criteria | Approval |
|---|---|---|---|---|---|
| M0 | Validation and benchmark (HV-001) | None | packages/benchmarks/, scripts/benchmark/ | AC-001, AC-003 | agent |
| M1 | Modular foundation (HV-002 to HV-004) | M0 | packages/api/, packages/parser/, packages/safety/, packages/queue/, infra/ | AC-002, AC-004, AC-005, AC-006, AC-007, AC-009, AC-023, AC-027, AC-028 | automated |
| M2 | Generation and continuity (HV-005 to HV-008) | M1 | packages/planner/, packages/generator/, packages/frontend/src/animatic/ | AC-008, AC-010, AC-011, AC-012, AC-024, AC-025, AC-026 | agent |
| M3 | Assembly, export, and accountless review (HV-009 to HV-012) | M2 | packages/assembler/, packages/frontend/src/player/, packages/frontend/src/review/ | AC-013, AC-014, AC-015, AC-029 | user |
| M4 | Hardening, free public beta, and GA (HV-013 to HV-015) | M3 | packages/operator/, packages/frontend/src/status/, docs/legal/ | AC-016, AC-017, AC-018, AC-019, AC-020, AC-021, AC-022, AC-028 | user |

## Human Review

- **HC-001** (operator): Do the animatic and continuity results from the CS-001 and CS-007 runs meet the narrative bar for a free public release? Scenarios: CS-001, CS-007
- **HC-002** (operator): Are the beta economics (cost per completed MP4, failure rate) sustainable under the < $5,000/month cap? Scenarios: CS-005
- **HC-003** (operator): Does the refusal UX in CS-004 protect the free/anonymous promise without leaking moderation internals? Scenarios: CS-004

## Deliverables

- Docker-compose deployable monorepo (9 packages) running on a single 4xA100 host
- Public web app: Fountain editor -> preview -> animatic gate -> progress -> HLS player -> MP4 export
- 24-shot benchmark suite with CI regression gates (versioned fixture, deterministic hashes)
- Operator console: job, queue, cost, and health monitoring with project kill-switch
- Public status page, provenance manifest, and counsel-reviewed ToS/privacy/content policy
- Free public beta evidence pack (100 users, 2 weeks) and GA launch artifacts

## Out of Scope

- User accounts, authentication, or payment of any kind (source L67, L74)
- Real-time collaborative editing (source L68)
- Full non-linear editing timeline - v1 is linear assembly only (source L69)
- Audio mixing, music licensing, and localization/dubbing (source L70; FR-10.3 targets v2)
- 4K or HDR output - v1 targets 1080p H.264 (source L71)
- Mobile-native app - responsive web only (source L72)
- Public API - post-alpha consideration (source L73)
- Proxy editing / drag-to-reorder timeline - targeted v1.1 (FR-9.4)
- Extended export formats (ProRes, DNxHR) - targeted v1.1 (FR-11.3)
- Cold-storage archive for operator-approved projects (FR-11.4)
- Paid tiers, freemium, and subscriptions - excluded by ADR-0018

## Unresolved

- None
