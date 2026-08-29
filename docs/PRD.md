# Hollywood Video — Product Requirements Document

**Version:** 1.0
**Status:** Draft for approval
**Last updated:** 2026-08-29
**Owner:** Marlandoj / Alaric (Chief of Staff)
**Team:** ZOU (Zouroboros)
**Linear Project:** Hollywood Video
**ADR:** [ADR-0018 — Free anonymous access](../../decisions/ADR-0018-hollywood-video-free-anonymous-access.md)

---

## 1. Vision

Hollywood Video is a **free, anonymous, script-first AI filmmaking studio**. A user pastes a Fountain screenplay (or short outline) and, without creating an account, uploads a file, or paying a cent, receives a watchable H.264 MP4 assembled from AI-generated shots. The operator funds all inference and rendering; the product earns goodwill, a public benchmark, and a distribution moat — not subscription revenue.

**One-liner:** "Paste a screenplay, get a movie. No account. No card. No watermark."

---

## 2. Problem Statement

| Pain | Current market gap |
|---|---|
| Every AI video tool requires signup, API keys, or payment | No zero-friction path from script to film |
| Short-form tools (Runway, Pika) don't handle multi-shot narrative coherence | No shot-to-shot character/scene continuity at narrative scale |
| Open-source pipelines (e.g., ComfyUI) require local GPU + expertise | No hosted, fair-queued, anonymous alternative |
| No public, reproducible benchmark for script-to-video quality | No way to compare providers or track improvement over time |

---

## 3. Product Vision & Positioning

- **Positioning:** Free, open-source, self-hostable AI film studio. The open-source model is a *distribution and trust* feature (transparent cost model, auditable safety), not a revenue feature.
- **Differentiation:**
  - Zero-friction: no account, no API key, no payment. Paste script → download MP4.
  - Operator-funded: the product is a public demo / benchmark, not a SaaS.
  - Evidence-governed: every pipeline change ships behind a 24-shot benchmark with regression gates.
  - Reproducible: all runs produce deterministic hashes; the benchmark is a CI artifact.

---

## 4. Target Users & Primary Scenarios

| Persona | Scenario | Success signal |
|---|---|---|
| **Screenwriter / indie filmmaker** | Pastes a 5-page Fountain spec, gets a 60-second proof-of-concept cut | Shares the MP4 with a producer within 24 h |
| **Marketer / creator** | Uploads a 1-page outline for a product short | Exports H.264, posts to social same day |
| **Evaluator / researcher** | Runs the 24-shot benchmark suite, compares provider A vs B | Produces a reproducible quality delta report |
| **Operator (Marlandoj)** | Monitors cost, queues, capacity; approves/denies borderline projects | Keeps monthly inference spend < $5,000 without manual intervention |

---

## 5. Scope

### In scope (v1.0 / public alpha)
- Fountain screenplay parsing → shot plan → storyboard → per-shot video generation → assembly → H.264 MP4
- Anonymous, accountless usage with signed review links
- Fair, prioritized, cost-aware job queues
- Operator-funded inference (no user billing)
- 24-shot public benchmark with regression gates in CI
- Creative bible / character continuity packets
- Content safety: text moderation, generation refusals, takedown, provenance
- Modular, self-hostable architecture (single Docker compose)

### Out of scope (explicitly deferred)
- User accounts, authentication, or payment
- Real-time collaborative editing
- Full non-linear editing timeline (v1 is linear assembly only)
- Audio mixing, music licensing, or localization
- 4K / HDR output (v1 targets 1080p H.264)
- Mobile-native app (responsive web is v1)
- Public API (internal API exists; public API is a post-alpha consideration)
- Any feature that requires a user to spend money

---

## 6. Core Architecture (High-Level)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (SvelteKit)                         │
│  Script paste → Preview → Review link → Progress → Player → Export  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  (signed links, no auth)
┌──────────────────────────────▼──────────────────────────────────────┐
│                     API Gateway / Auth Layer                         │
│  • Anonymous project tokens (signed, expiring)                       │
│  • Rate limiting per IP + per project                                │
│  • Bearer auth for internal services                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                         Core Services                                │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Script     │  │ Shot Plan  │  │ Generation │  │ Assembly &   │  │
│  │ Parser     │→ │ & Board    │→ │ Orchestr.  │→ │ Export       │  │
│  │ (Fountain) │  │ (LLM)      │  │ (Jobs)     │  │ (ffmpeg)     │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────┘  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ Safety /   │  │ Continuity │  │ Queue &    │  │ Cost &       │  │
│  │ Moderation │  │ Packets    │  │ Capacity   │  │ Accounting   │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                    Infrastructure / Data Layer                       │
│  PostgreSQL  │  Redis (queues)  │  S3-compatible (artifacts)         │
│  GPU Workers (inference)  │  Prometheus + Grafana (observability)   │
└─────────────────────────────────────────────────────────────────────┘
```

**Design principles:**
- **Modular:** Each service is independently deployable and testable.
- **Self-hostable:** A single `docker compose up` runs the full stack.
- **Fail-closed:** Any missing safety gate blocks generation, not just warns.
- **Deterministic benchmark:** The 24-shot suite produces byte-identical hashes for a given model + seed.

---

## 7. Functional Requirements

### 7.1 Product Validation & Benchmark (HV-001)
- **FR-1.1:** Define a 24-shot benchmark script (fixed Fountain file, versioned in git).
- **FR-1.2:** Benchmark measures: generation latency per shot, total pipeline time, visual quality score (CLIP / FID or equivalent), continuity score (face/scene consistency), and cost per shot.
- **FR-1.3:** Benchmark runs in CI on every model/provider change; regression > 5% on any metric blocks merge.
- **FR-1.4:** Product name clearance: verify "Hollywood Video" (or chosen name) is not trademarked in relevant classes; document in ADR.

### 7.2 Modular Foundation (HV-002)
- **FR-2.1:** Monorepo with separate packages: `frontend`, `api`, `parser`, `planner`, `generator`, `assembler`, `safety`, `queue`, `benchmarks`.
- **FR-2.2:** CI pipeline: lint → typecheck → unit tests → integration tests → benchmark (on GPU runner) → build → deploy.
- **FR-2.3:** Anonymous access: project creation returns a signed, expiring (72 h) token embedded in a URL. No email, no cookie, no account.
- **FR-2.4:** Storage: all artifacts (shots, renders, MP4s) go to S3-compatible object storage with lifecycle policies (30-day auto-delete for anonymous projects).
- **FR-2.5:** Job system: persistent, idempotent jobs (Redis + worker pool). Every job has a retry policy, timeout, and cost tracker.
- **FR-2.6:** Telemetry: structured JSON logs, Prometheus metrics, Grafana dashboards. Every generation job emits cost, latency, model, and quality metadata.

### 7.3 Fountain Editor, Parser, and Revisions (HV-003)
- **FR-3.1:** Parse standard Fountain format (scene headings, action, dialogue, transitions, parentheticals).
- **FR-3.2:** Editor: paste or upload `.fountain`; live preview of parsed structure (scenes, shots, characters).
- **FR-3.3:** Protected text: user can mark lines as "locked" (e.g., brand names, legal text) that the generator must not alter.
- **FR-3.4:** Revision history: each edit creates a version; regeneration can target any prior version.
- **FR-3.5:** Validation: reject scripts > 30 pages (v1 cap), warn on > 20 scenes, flag unparseable constructs.

### 7.4 Creative Bible, Rights, Consent, and Provenance (HV-004)
- **FR-4.1:** Auto-generate a "creative bible" per project: character descriptions, setting palette, tone keywords, style references.
- **FR-4.2:** Rights & consent: require user attestation (checkbox) that they hold rights to all referenced IP, characters, and locations.
- **FR-4.3:** Provenance: every generated frame carries a C2PA-style content credential (model, prompt hash, timestamp, seed).
- **FR-4.4:** Provenance manifest: downloadable JSON alongside the MP4 listing all models, prompts, seeds, and parameter hashes for full reproducibility.

### 7.5 Shot Planning, Storyboards, and Animatic (HV-005)
- **FR-5.1:** LLM-driven shot planner: converts parsed script into a shot list (shot type, duration, camera angle, motion, dialogue overlay).
- **FR-5.2:** Storyboard: per-shot thumbnail image (text-to-image) showing composition, character placement, and setting.
- **FR-5.3:** Animatic: auto-assemble storyboard stills with timing and dialogue audio (TTS) into a rough-cut video for user review *before* expensive video generation.
- **FR-5.4:** User review gate: user must approve the animatic (or request edits) before video generation begins. This is the **only** human-in-the-loop gate in v1.

### 7.6 Provider Adapters, Durable Jobs, and Safe Submission (HV-006)
- **FR-6.1:** Provider adapter interface: `generate(prompt, seed, params) → video_clip`. Implementations: Runway, Pika, Kling, local (ComfyUI), and at least one open-weight model.
- **FR-6.2:** Durable generation jobs: survive worker restarts; checkpoint at frame boundaries; resume on retry.
- **FR-6.3:** Safe submission: all prompts pass through the safety/moderation layer before reaching any provider. Blocked prompts return a polite refusal, not an error.
- **FR-6.4:** Provider failover: if primary provider times out or errors, retry on secondary (if configured) before failing the job.
- **FR-6.5:** Cost guardrails: per-job cost cap (configurable, default $5/shot). If exceeded, job is cancelled and user is notified.

### 7.7 Free Capacity, Fair Queues, and Cost Accounting (HV-007)
- **FR-7.1:** Fair queue: each anonymous project gets a weighted fair share of GPU time. No project can starve another.
- **FR-7.2:** Capacity tiers (internal):
  - **Free tier** (default): 1 concurrent project, max 24 shots, 720p, standard queue.
  - **Elevated tier** (operator-granted): 3 concurrent, 60 shots, 1080p, priority queue. For partners, press, benchmark.
- **FR-7.3:** Operator cost dashboard: real-time spend per day/week/month, per project, per provider, per shot type.
- **FR-7.4:** Auto-throttle: if monthly spend exceeds 80% of budget, new free-tier projects queue behind existing jobs. At 100%, new projects are rejected with a "capacity full, try again tomorrow" message.
- **FR-7.5:** Cost accounting: every job records `{provider, model, prompt_tokens, output_frames, gpu_seconds, total_cost_usd}`. Aggregated to daily/weekly/monthly rollups.

### 7.8 Continuity Packets, Human Review, and Repair (HV-008)
- **FR-8.1:** Continuity packet: for each character, maintain a reference image set + text description. Injected into every shot prompt that features the character.
- **FR-8.2:** Shot-to-shot continuity check: compare adjacent shots for character consistency (face embedding distance), lighting, and palette. Flag shots with similarity < threshold.
- **FR-8.3:** Human review queue: flagged shots appear in an operator review panel. Operator can approve, regenerate, or manually adjust.
- **FR-8.4:** Repair loop: if a shot fails continuity check after regeneration (max 2 retries), it is marked "degraded" and the final MP4 includes a metadata note.

### 7.9 Assembly Timeline and Viewer (HV-009)
- **FR-9.1:** Auto-assembly: concatenate approved shots in script order, apply crossfades (0.5 s default), burn in dialogue subtitles (optional toggle).
- **FR-9.2:** Inline viewer: stream the assembled video in-browser (HLS). Show per-shot timestamps, thumbnails, and regeneration buttons.
- **FR-9.3:** Export: H.264 MP4, 1080p, 30 fps, AAC audio. Download link valid for 30 days.
- **FR-9.4:** (Deferred) Proxy editing: rough-cut timeline with drag-to-reorder. Target v1.1.

### 7.10 Audio, Captions, and Localization (HV-010)
- **FR-10.1:** (Alpha) Auto-generate voiceover from dialogue lines using TTS (e.g., ElevenLabs or open-source alternative).
- **FR-10.2:** (Alpha) SRT/VTT captions burned in or as sidecar file.
- **FR-10.3:** (Deferred) Multi-language dubbing and subtitle translation. Target v2.

### 7.11 H.264 Export and Validation (HV-011)
- **FR-11.1:** Export pipeline: ffmpeg-based, deterministic (same inputs → same output hash).
- **FR-11.2:** Validation: every exported MP4 passes ffprobe checks (codec, resolution, duration, bitrate) before the download link is issued.
- **FR-11.3:** (Deferred) Extended formats: ProRes, DNxHR, 4K. Target v1.1.
- **FR-11.4:** (Deferred) Archive: long-term cold storage for operator-approved projects.

### 7.12 Accountless Review, Approvals, and Collaboration (HV-012)
- **FR-12.1:** Signed review links: any project can be shared via a URL with a read-only or approve/deny permission. No account required.
- **FR-12.2:** Approval workflow: creator submits → reviewer views → reviewer approves or requests changes (free-text note) → creator regenerates or finalizes.
- **FR-12.3:** Link hygiene: review links expire after 7 days or 3 views (configurable). Revocable by creator.

### 7.13 Public Capacity, Operator, and Support Tools (HV-013)
- **FR-13.1:** Public status page: current queue depth, estimated wait time, system health. No PII.
- **FR-13.2:** Operator console (authenticated, internal): job monitoring, queue management, project kill-switch, cost alerts, provider health.
- **FR-13.3:** Support: in-app "Report an issue" form (no account needed; attaches project ID + anonymized logs). Routed to operator inbox.
- **FR-13.4:** Analytics: anonymized, aggregated usage metrics (projects created, shots generated, completion rate, avg time-to-MP4). No individual tracking.

### 7.14 Policy, Privacy, Takedown, and Legal (HV-014)
- **FR-14.1:** Terms of Service: clear, plain-language. Key points: free use, operator-funded, no SLA, content is user's responsibility, operator can delete any project.
- **FR-14.2:** Privacy: no personal data collected. IP address logged for rate-limiting only, deleted after 30 days. No cookies. No tracking pixels.
- **FR-14.3:** Content policy: prohibit generation of (a) identifiable real persons without consent, (b) CSAM or sexual content involving minors, (c) deepfake political content, (d) trademark-infringing brand content.
- **FR-14.4:** Takedown: DMCA-style form. Operator can takedown any project within 24 h of verified request. Takedown is logged and irreversible.
- **FR-14.5:** Legal review: ToS, privacy policy, and content policy reviewed by counsel before public launch.
- **FR-14.6:** Data retention: anonymous project data auto-deleted after 30 days. Operator can manually extend for benchmark purposes (logged).

### 7.15 Production Hardening, Free Public Beta, and GA (HV-015)
- **FR-15.1:** Load test: sustain 50 concurrent projects, 500 shots in queue, p99 shot latency < 120 s.
- **FR-15.2:** Security: pen test on auth tokens, rate limiting, file upload, and API. Fix all critical/high before launch.
- **FR-15.3:** Free public beta: soft launch to 100 invited users for 2 weeks. Monitor cost, quality, and failure rates.
- **FR-15.4:** GA launch: public URL, status page live, social announcement, benchmark results published.
- **FR-15.5:** Post-launch: weekly cost review, monthly benchmark re-run, quarterly capacity planning.

---

## 8. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Performance** | P99 shot generation < 90 s (720p, 5 s clip). End-to-end (script → MP4) < 15 min for a 12-shot short. |
| **Availability** | 99% monthly uptime for the public site. Downtime for GPU maintenance is acceptable with < 4 h notice. |
| **Scalability** | Horizontal GPU worker scaling. Queue depth > 1,000 jobs without degradation. |
| **Security** | All internal service traffic over mTLS. Signed URLs for artifact access. No secrets in images. |
| **Observability** | 100% of jobs produce structured logs. Dashboards for: queue depth, cost/hour, error rate, p50/p95/p99 latency. |
| **Portability** | `docker compose up` on a single 4×A100 machine runs the full stack. No cloud-specific dependencies. |
| **Reproducibility** | Given the same script, model, seed, and parameters, the output MP4 is byte-identical. |
| **Accessibility** | WCAG 2.1 AA. All interactive elements keyboard-navigable. Captions on all exported video. |

---

## 9. Cost Model

| Item | Estimate (monthly) | Notes |
|---|---|---|
| GPU inference (Runway/Kling API) | $2,000 – $4,000 | ~500 shots/month at free tier |
| TTS (voiceover) | $100 – $300 | ~200 min of audio |
| Object storage (S3) | $20 – $50 | 30-day lifecycle, ~200 GB |
| Postgres + Redis (managed) | $50 – $100 | Single region, small instance |
| CDN / bandwidth | $50 – $150 | MP4 delivery |
| Monitoring (Grafana Cloud free tier) | $0 | |
| **Total (target)** | **< $5,000/mo** | Hard cap; auto-throttle at 80% |

The operator (Marlandoj) funds all costs. There is **no** user-facing billing, subscription, or payment of any kind.

---

## 10. Milestones & Phasing

| Phase | Scope | Target | Gate to next |
|---|---|---|---|
| **M0 — Validation** | HV-001: Benchmark defined, prototype runs end-to-end, name cleared | 2 weeks | 24-shot benchmark passes baseline; name clearance documented |
| **M1 — Foundation** | HV-002 through HV-004: infra, parser, safety, provenance | 4 weeks | CI green; anonymous project creation works; safety blocks 100% of test-bad prompts |
| **M2 — Generation** | HV-005 through HV-008: shot plan, providers, queue, continuity | 6 weeks | 12-shot short produced end-to-end with < 2 continuity failures |
| **M3 — Assembly & Review** | HV-009 through HV-012: assembly, export, audio, collaboration | 3 weeks | 5 external users produce a 60-s MP4 without operator intervention |
| **M4 — Hardening & Launch** | HV-013 through HV-015: tools, legal, load test, beta, GA | 3 weeks | Pen test clean; 100-user beta at < $5k cost; ToS signed |

**Total target: ~18 weeks from M0 start to GA.**

---

## 11. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | GPU cost exceeds $5k/mo | Medium | High | Auto-throttle at 80%; per-job cost cap; provider failover to cheaper model |
| R2 | Continuity quality too low for narrative coherence | High | High | Continuity packets + reference images; human review gate; accept "degraded" shots in v1 |
| R3 | Provider API changes / price hike | Medium | Medium | Adapter interface isolates providers; at least 2 providers in production |
| R4 | Abuse: users generate disallowed content at scale | Medium | High | Text moderation pre-generation; IP rate limiting; takedown within 24 h; C2PA provenance |
| R5 | Name "Hollywood Video" is trademarked | Low | Medium | Parallel name clearance in HV-001; fallback names pre-cleared |
| R6 | Single-operator dependency (only Marlandoj can operate) | Medium | Medium | Documented runbooks; operator console; automation for routine tasks |
| R7 | No revenue → project abandoned if cost is unsustainable | Medium | High | Hard cost cap; monthly review; kill-switch to pause new projects; benchmark value as standalone asset |

---

## 12. Success Metrics (post-GA, 90-day window)

| Metric | Target |
|---|---|
| Projects created | ≥ 500 |
| Completion rate (script → MP4) | ≥ 70% |
| Median time-to-MP4 | < 12 min |
| Continuity pass rate (no "degraded" shots) | ≥ 80% |
| Monthly inference cost | < $5,000 |
| Uptime | ≥ 99% |
| Takedown requests | < 5/month |
| Benchmark regression (vs. GA baseline) | < 5% on all metrics |

---

## 13. Open Questions

1. **Name:** Is "Hollywood Video" the final name, or do we go with a cleared alternative? (HV-001 must resolve this.)
2. **Primary provider:** Runway Gen-4 vs. Kling v2.1 vs. local ComfyUI + open-weight — which is the default for v1? (Benchmark in HV-001 will inform this.)
3. **TTS provider:** ElevenLabs (quality, cost) vs. Coqui/Piper (free, self-hosted)?
4. **Object storage:** Self-hosted MinIO vs. Cloudflare R2 (free tier, no egress fees)?
5. **Legal entity:** Does the free service need a separate legal entity / liability shield, or does it operate under the existing Zouroboros umbrella?

---

## 14. Related Linear Issues

| ID | Title |
|---|---|
| ZOU-1480 | [HV-001] Product validation, benchmark, prototype, and parallel name clearance |
| ZOU-1481 | [HV-002] Modular foundation, CI, anonymous access, storage, jobs, and telemetry |
| ZOU-1482 | [HV-003] Fountain editor, parser, protected text, and revisions |
| ZOU-1483 | [HV-004] Creative bible, rights, consent, and asset provenance |
| ZOU-1484 | [HV-005] Shot planning, storyboards, and animatic |
| ZOU-1485 | [HV-006] Provider adapters, durable generation jobs, and safe submission |
| ZOU-1486 | [HV-007] Free capacity, fair queues, and operator cost accounting |
| ZOU-1487 | [HV-008] Continuity packets, human review, and repair loop |
| ZOU-1488 | [HV-009] Assembly timeline and viewer; proxy editing later |
| ZOU-1489 | [HV-010] Alpha audio and captions; localization later |
| ZOU-1490 | [HV-011] H.264 export and validation; expanded archive later |
| ZOU-1491 | [HV-012] Accountless review, approvals, and collaboration |
| ZOU-1492 | [HV-013] Public capacity, operator, and support tools |
| ZOU-1493 | [HV-014] Policy administration, privacy, takedown, and legal hardening |
| ZOU-1494 | [HV-015] Production hardening, free public beta evidence, and GA launch |

---

## 15. Approval

This PRD is a living document. Changes require:
- Update this issue (or create a linked ADR for consequential decisions).
- Note the change in the version history below.
- Sync affected workstream issues if scope shifts.

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-08-29 | Alaric (Chief of Staff) | Initial PRD drafted from PROJECT.md, ADR-0018, and post-flight evaluation |