# HV-000 Post-Flight Evaluation — 2026-08-30 (assignment asg-ZOU-1566-DIRECT-a1-mtfzfmst)

> Historical executor report for commit `803c969`. Its named reachability, HLS, CI, review-decision, token-secret, and Compose gaps are addressed by the later additive report `evaluations/hv000-remediation-postflight-2026-08-30.md`; use that report and the final GitHub/Factory evidence for promotion decisions.

Seed: adopted repo-canonical docs/spec/factory-seed.yaml (source SHA-256 612c3811… matches ticket).
Seed eval (deterministic): package paths in seed tasks match build-spec.json package list; DAG M0→M4 acyclic; no file conflicts. PASS.

## Stage 1 — Mechanical
- bun test: 38 pass / 0 fail across 10 files (unit + integration + 12-shot E2E), 8.35s
- tsc --noEmit: clean
- Benchmark baseline recorded: packages/benchmarks/baseline.json (24 shots, mock-deterministic-v1)

## Stage 2 — Acceptance criteria evidence
Satisfied with in-repo test evidence (mock provider per ADR-0020):
- AC-001 benchmark fixture v1.0.0 + all 6 metrics (benchmark.test.ts)
- AC-002 compare gate blocks >5% regression; CI wires it on generator/benchmarks changes (ci.yml)
- AC-003 name-clearance ADR written (docs/adr/ADR-HV-001) — documents clearance NOT yet obtained, working-title gate
- AC-004 signed 72h HMAC token, tamper+expiry tested (api.test.ts)
- AC-005 monorepo + CI stages defined (10 packages incl. frontend; spec's "9-package" count excludes frontend static shell) — CI green-on-GitHub unverified (no push allowed)
- AC-006 parser conformance: protected text, 30-page rejection, 20-scene warning, unparseable flagging, version history
- AC-007 bible autogen + rights attestation + c2pa-style credentials + provenance manifest
- AC-008 12-shot E2E script→validated MP4, 0 continuity failures (<2 required)
- AC-009 prohibited battery 100% blocked, polite refusal, zero provider calls (gate precedes adapter)
- AC-010 $5/shot cap cancels + notifies; 5 cost fields + rollups
- AC-011 tiers 1/24/720p and 3/60/1080p; 80% queue-behind, 100% reject verified
- AC-012 repair loop max 2 retries → degraded + metadata note + operator review queue
- AC-013 0.5s crossfade assembly, H.264+AAC ffprobe gate, SRT/VTT, byte-identical re-export, 30-day link (HLS viewer NOT built)
- AC-014 captions on every export; TTS ships as silent+captions degradation path (Piper integration pending)
- AC-015 review links read/approve, 3-view + 7-day expiry, revocable
- AC-024 durable JSON store, frame checkpoints survive restart, idempotency key, retry policy + timeout
- AC-025 fair-share ordering by least gpu_seconds
- AC-026 primary failure retries on secondary
- AC-027 per-edit versions, any version retrievable
- AC-028 30-day sweep + logged operator extensions (in-process; S3 lifecycle rule pending real object store)
- AC-016/017 partial: takedown logged+irreversible, anonymized analytics reject PII, 30-day IP sweep; status page/console/support form + counsel review NOT done
- AC-022 partial: frontend shell has labels/focus-visible; full WCAG audit not run
- AC-023 partial: docker-compose + Dockerfiles authored; not built/run here (no Docker in sandbox)

NOT satisfiable in this lane (external/human gates): AC-018 beta, AC-019 load/pen/GA, AC-020 cadence, AC-021 uptime, AC-029 five external users. All remain fail-closed per ADR-0020.

## Stage 3 — Consensus
Skipped per ticket REVIEW POLICY (Factory control plane owns independent review).

## Gap audit (5 checks)
1. Reachability: every module has a test caller; pipeline composed end-to-end in test/e2e-12shot.test.ts. No HTTP server bound yet (private staging server is next lane). NAMED GAP.
2. Data prerequisites: benchmark fixture + baseline committed; no empty schemas.
3. Cross-boundary state: DurableJobStore proven across process-equivalent restart (new store instance from disk).
4. Eval-production parity: benchmark uses the same parser/planner/generator/continuity code paths as the E2E pipeline. Mock provider is the production default per ADR-0020 until HV-001 selects paid providers.
5. Dangling identifiers: none removed; grep for deleted refs n/a.
