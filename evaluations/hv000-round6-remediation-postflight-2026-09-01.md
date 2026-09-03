# HV-000 Round-6 Remediation Post-Flight

- Date: 2026-09-01
- Branch: `factory/ZOU-1566-hv-000-a1-mtfzfmst`
- Supersedes: `evaluations/hv000-round5-remediation-postflight-2026-08-31.md`
- Trigger: `hold` from the ZOU-1566 round-6 persona diversity review of head `c00b80b0` (three reviewers ran, all `fail`; the fourth was blocked by an empty transport response, not a judgment)

## Executive summary

Round 6 raised no round-5 finding again. It rejected the branch on a new set:
one design error introduced by the round-5 signed-URL work (a one-hour link
where the spec requires 30 days), three durability and capacity gaps in the
queue, a provenance defect, and a security baseline that the build spec
requires but the branch had not implemented. All nine substantiated findings
are closed here. Docker Compose staging is still not verifiable in this
sandbox; the CI `quality` job builds and exercises it, and this round makes
that job prove the new mTLS boundary as well.

## Findings and remediation

| # | Reviewer finding (reviewers) | Root cause | Fix | Evidence |
|---|---|---|---|---|
| 1 | Artifact and export links expire after one hour; AC-013 / FR-040 require a 30-day download link (3 of 3) | Round 5 replaced the cookie with a project-bound signature and gave it a one-hour TTL as a safety reflex, then reported the assembler's unused `linkExpiresAt` as if it were the link. | The job records `completedAt` and `linkExpiresAt = completedAt + 30 days` when it finishes. Every job and review response signs its URLs to that moment, capped at the project's retention date, and reports `artifactUrlsExpireAt`. The signature is bound to the cut as well as the project, so one link cannot open another cut. The assembler's decorative `linkExpiresAt` is gone. | `server.test.ts` "download links are valid for 30 days and bound to one cut": expiry arithmetic, token payload, cross-cut rejection, retention cap, no link before completion |
| 2 | A worker crash leaves the job `running` forever; startup claims only `queued`, so checkpointed jobs never resume (1 of 3, AC-024) | The claim path had no notion of a live worker. | A claim carries a lease (`HV_JOB_LEASE_MS`, default five minutes) that the worker renews before every shot and at every checkpoint. `recoverAbandoned` runs at worker start and inside every claim: a `running` job whose lease has lapsed returns to the queue with `resumedCount` incremented and a user notification, and the next claim resumes it from its checkpoint without regenerating finished shots. | `queue.test.ts` "abandoned running jobs resume from their checkpoint": lease lapse and re-claim with the checkpoint intact, startup recovery that leaves a live job alone, heartbeat keeping a long job alive |
| 3 | The 80% `queue_behind` decision does not delay anything; workers claim those jobs immediately (1 of 3, AC-011) | The capacity decision was returned to the client and then discarded. | The API records `queueAction` and `queueReason` on the job. A `queue_behind` job snapshots the ids of the jobs ahead of it (every active job for the budget throttle; the project's own for the concurrency limit) and is not eligible until each of them is terminal. The worker also enforces each tier's `maxConcurrent` at claim time, independent of what the API decided. The 202 response reports the action, reason, how many jobs are ahead, and the user-facing message. | `queue.test.ts` "queue-behind holds a job until the jobs ahead of it finish" (budget throttle, project concurrency, tier limits at claim); `server.test.ts` "queue-behind is reported to the client and honoured by the worker" |
| 4 | JSON queue claim/write is not interprocess-atomic between the API and worker processes (1 of 3) | Each process reloaded, mutated, and rewrote the whole file with no exclusion; two processes could interleave and lose an update or double-claim. | Every mutation runs under an O_EXCL lock file beside the queue (`withFileLock`): reload, apply, persist, release. A lock older than 30 s belongs to a dead process and is broken. Temporary files are per-process and per-write, so two writers cannot collide on the rename. | `queue.test.ts` "claims are atomic across processes": four spawned worker processes drain one queue of 40 jobs; every job is claimed exactly once and more than one process wins claims |
| 5 | Provenance records `projectId` as the literal string `shot` (1 of 3) | The assembler derived the project id from the first shot id's prefix. | `assemble` takes `projectId` and the worker passes the job's. | `assembler.test.ts` asserts the manifest's `projectId` |
| 6 | ffprobe validates only H.264; FR-044 requires codec, resolution, duration, bitrate, and audio (1 of 3) | The gate checked one field. | `validateExport` is a pure check over the ffprobe output: H.264 video, AAC audio, exact requested resolution and frame rate, duration within a frame-pair of the expected total, a positive bitrate, and an audio sample rate. It runs on every export before the job completes and its result is the export's `ffprobe` record. | `assembler.test.ts` "ffprobe export gate checks every required property": conforming probe, and rejection of wrong resolution, frame rate, duration, missing bitrate, wrong or missing audio, non-H.264 video |
| 7 | No rate limiting and no mTLS on the API port (1 of 3; C-008, NFR-004, FR-053, FR-059) | Neither had been built; the API was also published on the host as `8080:8080`. | **mTLS:** with `HV_TLS_CERT_PATH`, `HV_TLS_KEY_PATH`, and `HV_TLS_CLIENT_CA_PATH` set, the API serves TLS with `requestCert` and `rejectUnauthorized` against the internal CA; a partial configuration throws rather than falling back to plaintext. `infra/mtls/gen-certs.sh` issues the CA, the API server certificate, and the proxy's client certificate into a git-ignored directory mounted read-only. nginx proxies over `https://api:8443` with `proxy_ssl_certificate` and `proxy_ssl_verify on`. Compose no longer publishes the API port. CI generates the certificates, proves the proxied path works, proves the host port is closed, and proves the API refuses a connection without a client certificate. **Rate limiting:** a sliding-window limiter keyed by an HMAC of the client address budgets API requests, project creation, and artifact fetches separately (`HV_RATE_LIMIT_*`), answers 429 with `Retry-After`, sweeps records older than 30 days, and reads `X-Forwarded-For` only when `HV_TRUST_PROXY=1`. | `mtls.test.ts`: no certificate refused, untrusted-CA certificate refused, proxy certificate accepted over TLS, partial configuration fails closed (negative cases use curl as an independent client). `server.test.ts` "rate limiting protects the API and artifact paths": creation budget with `Retry-After`, general budget, artifact budget, spoofed `X-Forwarded-For` ignored |
| 8 | Arbitrary API-origin configuration can forward bearer tokens off-origin (1 of 3) | `index.html` accepted `?api=<origin>` and a `window.HV_API_BASE` global. | The API base comes only from the build-time meta tag or the page's own origin. | `frontend/test/origin.test.ts` asserts the override paths are absent and the meta tag ships empty |
| 9 | Safety filter omits the required real-person and trademark cases (1 of 3; FR-054, V-006) | The gate covered minors, non-consensual intimate content, incitement, and hate only. | Three categories added: `identifiable_real_person`, `political_deepfake`, `trademark_brand` (named brands and characters, plus logo/brand cues). The battery gains eight prompts across them and every entry is refused before any provider call. Benign prompts that share vocabulary (a fictional senator, a chess-club president, apples on a table, a cola) still pass. | `safety.test.ts` battery plus the new category and benign-prompt cases |

## Verification

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx oxlint packages scripts test` | clean |
| `bun test packages test` | **128 pass, 0 fail** (was 97) |
| `bun run build` | api 51.28 KB, worker 40.90 KB |
| `bun run smoke:runtime` | `cookiesSet: 0` over 22 responses, `artifacts: "signed-url"`, `hlsSegments: "reachable"`, `staleAnimaticApproval: "refused"`, `projectResume: "reachable"`, `reviewLink: "playable"`, `restartSurvives: true`, with the default rate limits in force |
| `bun run benchmark:compare` (same-host interleaved A/B against the merge base) | pass at 5%: two-round A/B against `c00b80b0` on this host, `perShotLatencyMsMin` 267.20 → 267.24 ms (+0.0%), `totalPipelineMs` 7460.81 → 7278.01 ms (−2.5%); deterministic metrics unchanged |
| `git diff --check <base> HEAD` | clean |

## Not verified here

- **Docker Compose** — no daemon in this sandbox. The CI `quality` job
  generates the mTLS material, builds the images, starts the stack, and now
  asserts three things the sandbox cannot: the proxied origin serves `/health`
  and creates a project, the API port is closed on the host, and the API
  refuses a client-certificate-less connection from inside the network.
- **Penetration test (FR-059, V-017)** and the other human gates remain
  operator-owned and fail-closed per ADR-0020.
