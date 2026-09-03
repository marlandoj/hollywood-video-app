# HV-000 Private-Staging Remediation Post-Flight

- Date: 2026-08-30 Arizona
- Status: superseded by `evaluations/hv000-round4-remediation-postflight-2026-08-31.md`

## Executive summary

The first Factory diversity review correctly held promotion because the initial artifact had no reachable HTTP server or worker, an inert frontend form, a permissive token-secret fallback, and non-reproducible CI. This remediation closes those defects without weakening ADR-0020 public-launch holds.

## Implemented

- Reachable Bun API with `/health`, anonymous project creation, script validation, durable job enqueue/status, signed review decisions, and protected artifact delivery.
- Separate durable worker entrypoint with disk-backed cross-process queue state, checkpointed shot processing, retry state, deterministic generation, and MP4/HLS/captions/provenance output.
- Functional WCAG-oriented creator flow with explicit rights attestation, queue/running/error states, HLS playback with MP4 fallback, downloads, and accountless approve/request-changes links.
- Fail-closed token signing: startup and token operations require `HV_TOKEN_SECRET` with at least 32 characters.
- Reproducible Bun 1.3.12 toolchain and committed lockfile. CI installs dependencies, treats lint as blocking, runs TypeScript/tests/build/runtime smoke, builds Compose images, and checks the containerized API health endpoint.
- Default export raised from 320x180/24 fps to 1920x1080/30 fps; free-tier worker generation remains capped at 1280x720 per AC-011. HLS VOD playlists are generated for every export.

## Mechanical evidence

- `bun run typecheck`: pass.
- `bun run lint`: pass, zero warnings/errors.
- `bun run build`: pass for API and worker entrypoints.
- `bun test packages test`: 44 pass, 0 fail, 195 assertions across 12 files.
- `bun run smoke:runtime`: pass. API health, anonymous project, queue, worker completion, and authenticated HLS retrieval all verified.
- Playwright creator-flow validation: pass at desktop and 390×844 mobile viewport; export and review-link creation succeeded with zero browser console errors.
- Local Docker verification unavailable because the Zo sandbox has no Docker CLI. GitHub CI owns Compose config/build/up/health/down evidence.

## Retained gates and named gaps

- Public deployment, operating terms, name clearance, counsel, public beta, penetration test, uptime, and external-user gates remain fail-closed under ADR-0020.
- Piper TTS is not bundled. The mandated silent plus captioned degradation path remains active and explicitly reported.
- Live video providers remain disabled; private staging uses the deterministic mock provider until operator budget and provider gates clear.
- GitHub CI must pass the new container checks before merge.
- Factory persona diversity review must return `advance_to_verified=true` against the remediated commit before promotion.

## Five-check gap audit

1. **Reachability:** API, worker, frontend, lifecycle sweeper, HLS, and review decisions have concrete entrypoints and callers. Verified by runtime smoke.
2. **Data prerequisites:** queue and artifact volumes are declared; token secret is mandatory; mock providers need no external key.
3. **Cross-boundary state:** API and worker exchange authoritative queue state through the shared disk file; the smoke test caught and verified the reload boundary.
4. **Eval-production parity:** tests and smoke use the same API server, durable store, worker, assembler, and artifact-serving code as Docker private staging.
5. **Dangling identifiers:** repository sweep found no active MinIO dependency, inert API-as-worker command, development token fallback, obsolete 320×180/24 fps defaults, or leaked credential patterns.
