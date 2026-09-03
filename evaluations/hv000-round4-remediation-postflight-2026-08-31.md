# HV-000 Round-4 Remediation Post-Flight

- Date: 2026-08-31 Arizona
- Branch: `factory/ZOU-1566-hv-000-a1-mtfzfmst`
- Supersedes: `evaluations/hv000-remediation-postflight-2026-08-30.md`
- Trigger: unanimous 4/4 `fail` from the ZOU-1566 round-4 persona diversity review

## Executive summary

Round 4 was the first review round in which all four reviewers actually
executed. They converged independently on the same conclusion: the mechanical
checks passed while the production path did not. Eleven defects were confirmed.
All eleven are addressed here, each with a test or a runtime probe that fails if
the defect returns.

The earlier rounds were infra phantoms (ZOU-1575 defects 1-3). This round was
real, and the remediation is behavioural, not documentary.

## Defects and remediation

| # | Reviewer finding | Root cause | Fix | Evidence |
|---|---|---|---|---|
| 1 | HLS playlist loads but its media segment returns 401 | Artifact auth read the token from `?token=`. Segment URIs inside the playlist are relative, so segment requests carried no token. | Artifacts authenticate from `Authorization: Bearer` or the `hv_artifact` HttpOnly cookie scoped to `/artifacts/`, issued by `POST /api/projects/:id/artifact-session`. Relative segment URIs now carry the cookie automatically. | `scripts/runtime-smoke.ts` fetches the playlist *and* a media segment and asserts a non-empty body; `server.test.ts` "artifact access control" |
| 2 | Valid project tokens stop working after an API restart | `ProjectService` held projects, versions, and review links in in-memory `Map`s. | `ProjectService` persists to `HV_PROJECT_STATE_PATH` with an atomic temp-file rename, reloading before every read and persisting after every mutation. | `api.test.ts` "durable project state"; smoke restarts the API on the same state path and re-reads the job |
| 3 | Review links cannot display the cut (GET returns 404) | No read endpoint existed — only `POST /api/reviews/:token/decision`. | `GET /api/reviews/:token` consumes one view, returns the latest finished cut's artifact URLs, and sets a project-scoped artifact cookie so the reviewer can play it. | smoke `reviewLink: "playable"`; `server.test.ts` "review links surface the cut" |
| 4 | Generation starts without rights attestation (202) | The API never asked; the worker called `attestRights()` on itself, server-side. | `POST /api/projects/:id/rights` records the attestation on the project; the job carries `rightsAttestedAt`; the worker refuses a job without it. `attestRights()` now requires the captured timestamp and throws otherwise. | `worker.test.ts` "refuses generation without a recorded rights attestation"; `server.test.ts`; smoke asserts 403 before attestation |
| 5 | The animatic approval gate was bypassed | Jobs went straight to full generation; there was no animatic stage. | Jobs carry `stage: "animatic" \| "final"`. The first job is always an animatic (640x360, 1s shots). A `final` job requires an `approved` decision for that animatic, and is refused with 409 if the screenplay changed after approval. The worker enforces the same gate. | `server.test.ts` "human-in-the-loop gates"; `worker.test.ts`; smoke asserts 403 before approval |
| 6 | Anonymous clients self-select elevated 1080p capacity | `body.tier === "elevated"` was honoured verbatim. | The tier is server-decided. `elevated` requires a grant signed with a separate `HV_OPERATOR_GRANT_SECRET`, bound to one project id and TTL-limited. With no grant secret configured every project is free tier. `bun run operator:grant` mints one out of band. | `server.test.ts` "capacity tier is server-controlled" (self-select, forged, wrong-project, and valid grant cases); `api.test.ts` |
| 7 | Monthly spend hardcoded to zero; completed jobs record no cost | `monthSpendUsd: 0` was a literal, and the worker never touched `CostLedger`. | `CostLedger` persists to `HV_COST_LEDGER_PATH`. The worker records one event per shot; `Job.costUsd` accumulates and the per-job cap cancels an over-budget job. The API reads real month-to-date spend into `capacity.decide` and reports it on `/health`. | `worker.test.ts` "records a cost event per shot"; `queue.test.ts` cost-cap accumulation; `/health` exposes `monthSpendUsd` |
| 8 | Failover, fair share, timeout, and backoff existed only as unwired test helpers | The worker instantiated `DeterministicMockProvider` directly and `claimNext()` sorted by job id. | The worker generates through `FailoverGenerator` under `HV_PROVIDER_TIMEOUT_MS` and enforces a per-job deadline. `claimNext(now, gpuSecondsByProject)` orders through `fairShareOrder` with elevated-tier priority and skips jobs still inside their retry backoff; `fail()` sets an exponential `nextEligibleAt`. `OperatorReviewQueue` is durable and receives every flagged shot. | `worker.test.ts` failover and timeout cases; `queue.test.ts` "retry backoff and fair-share claim order" |
| 9 | Crashed running jobs cannot resume; retries ignore checkpoints | The shot loop always restarted at index 0 and no clip metadata survived the crash. | Clip metadata is written to `clips/manifest.json` after every shot, and `checkpoint(id, shots, frames)` records both counters. A resumed job replays completed clips from the manifest and generates only the remaining shots. | `worker.test.ts` "resumes a crashed job from its checkpoint" — asserts **zero** provider calls on the resumed run |
| 10 | Benchmark gate red at 72-77% latency regression | A 5% gate on wall-clock ffmpeg-spawn latency measured host noise, not code. Byte-identical output failed the gate on a busy host. | Split into two lanes. Deterministic metrics (visual quality proxy, continuity, cost per shot, fixture digest, shot count) still block at 5%. Latency is the run's noise floor divided by a same-run 256 KB×400 sha256 calibration probe (run-to-run spread <1%), gated at 35%. Raw avg/p99/total are reported as advisories. A baseline without calibration is rejected rather than silently passed. | Three consecutive runs: normalized 3.156 / 3.167 / 3.161 (0.4% spread), all pass; `benchmark.test.ts` proves host noise is advisory and a real regression still blocks |
| 11 | Frontend hardcodes localhost; capability tokens in query strings | `apiBase` defaulted to `http://localhost:8080` and artifact URLs embedded `?token=`. | The frontend resolves its API base from `?api=`, `window.HV_API_BASE`, a `<meta>` tag, then `location.origin`. nginx proxies `/api/`, `/artifacts/`, and `/health` to the API, so the browser sees one origin. Artifact URLs are plain paths; no token appears in any query string. | `grep -c localhost packages/frontend/src/index.html` → 0; `server.test.ts` asserts no `token=` in any returned artifact URL; CI now smokes `http://127.0.0.1:8081/health` and `POST /api/projects` through the frontend origin |

### ZOU-1575 defect 5 — the false deterministic pass

The reported `git diff --check passed` was vacuous: it ran against a clean
working tree, where it can only pass. Run over the committed range it fails on
trailing whitespace in `evaluations/hv000-remediation-postflight-2026-08-30.md`.
That whitespace is removed, and CI now runs `git diff --check <base> HEAD` with
`fetch-depth: 0` so the check is capable of failing.

## Verification

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx oxlint packages scripts test` | clean |
| `bun test packages test` | **76 pass, 0 fail**, 279 assertions (was 44 tests) |
| `bun run build` | api 39.54 KB, worker 30.94 KB |
| `bun run smoke:runtime` | `artifacts: reachable`, `hlsSegments: reachable`, `reviewLink: playable`, `restartSurvives: true`, and 403 on both bypass attempts |
| `bun run benchmark:compare` | pass on three consecutive candidate runs |
| `git diff --check <base> HEAD` | clean after this commit |
| GitHub CI on `5f659c3` | `quality` pass (2m25s), `benchmark-gate` pass (31s) |

### Docker Compose — verified in CI, not locally

No Docker daemon exists in this sandbox, so the compose stack was verified by the
CI `quality` job rather than here. Run 33359457010 built the api, queue-worker,
and frontend images, then served `/health` on both the API port and the nginx
frontend origin and completed `POST http://127.0.0.1:8081/api/projects` through
the proxy, returning a signed project token. The nginx same-origin path and the
new `app-state` volume are therefore exercised, just not on this machine.

## Not verified here
- **Real provider economics.** All generation still runs through
  `DeterministicMockProvider`; `costPerShotUsd` is 0 by default. The cost ledger,
  cap, and budget throttle are wired and tested, but the numbers they enforce are
  synthetic until a real provider is attached.
- **TTS.** Exports remain on the ADR-0020 silent-audio-plus-captions degradation
  path. Piper is still the alpha target.
- **Public deployment.** Unchanged: fail-closed behind the ADR-0020 human launch
  gates. Nothing here loosens them.
