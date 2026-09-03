# Hollywood Video App

Private implementation repository for the Hollywood Video working-title project.

The product is a free, anonymous, script-first filmmaking studio. The first
vertical slice turns a Fountain screenplay into a reviewed animatic and a
validated H.264 MP4 without signup, payment, or a watermark.

## Release boundary

This repository is private while the working title and operating terms remain
under review. Public branding, public deployment, live paid generation, and
terms publication are fail-closed until the name, counsel, benchmark, budget,
security, and launch acceptance gates pass.

## Canonical inputs

- `docs/PRD.md` — product requirements
- `docs/ADR-0018-free-anonymous-access.md` — access model
- `docs/ADR-0020-factory-execution-defaults.md` — execution defaults and launch hold
- `docs/spec/build-spec.json` — canonical Agentic Build Specification
- `docs/spec/factory-seed.yaml` — immutable Factory seed candidate

## Private staging

The repository contains a reachable private-staging stack:

- `packages/api/src/server.ts` serves health, anonymous project creation and resume, script, rights attestation, animatic approval, job, review, and signed-URL artifact routes.
- `packages/queue/src/worker.ts` claims durable jobs from disk, generates through a primary/secondary failover provider under a per-job timeout, records every shot into the cost ledger, checkpoints after each shot, and produces H.264/AAC MP4, HLS, captions, and provenance artifacts.
- `packages/frontend/src/index.html` drives the anonymous screenplay → animatic → approval → export journey and the accountless review flow. The signed project token lives in the URL fragment, so reopening the link resumes the project. It talks to its own origin; there is no hardcoded API host.
- `docker-compose.yml` shares queue, artifact, and state volumes across the API, worker, and sweeper, and serves the creator UI on port 8081. nginx proxies `/api/`, `/artifacts/`, and `/health` to the API so the browser sees a single origin. The API port is not published on the host; the proxy reaches it over mTLS on the compose network.

```bash
bun install --frozen-lockfile
export HV_TOKEN_SECRET="replace-with-at-least-32-random-characters"
./infra/mtls/gen-certs.sh
docker compose up --build api queue-worker frontend
curl --fail http://127.0.0.1:8081/health
```

For a local proof without Docker, run `bun run smoke:runtime`. It walks the full
production path — project creation, rights attestation, the animatic approval
gate, a stale-animatic approval attempt after a screenplay edit, final
generation, HLS playlist *and media segment* fetch through signed URLs, project
resume, the reviewer view, and an API restart — and fails if any gate can be
bypassed or if any response sets a cookie.

## Gates and state

- **Rights attestation (FR-017)** is captured on the project and copied onto the job. The worker refuses any job without it.
- **Anonymous access (FR-007, FR-053)** is a signed 72-hour token embedded in the project URL fragment (`/#/p/<token>`). There is no cookie, no account, and no token in any query string; `GET /api/projects/:id` with the token resumes the project after a refresh or in a new tab. Review links use the same shape (`/#/review/<token>`).
- **Animatic approval (FR-023)** is the only human-in-the-loop gate. Every job records the screenplay version it rendered. An approval binds to the animatic job's version, is refused with 409 if the screenplay has been edited since that animatic rendered, and a `final` job is refused unless an `approved` decision exists for a still-current animatic. The worker re-checks the binding before generating.
- **Capacity tier (FR-030)** is server-decided. A client cannot request `elevated`; it requires a grant signed with `HV_OPERATOR_GRANT_SECRET`, minted out of band with `bun run operator:grant <projectId> [hours]`. With no grant secret configured, every project is free tier.
- **Artifacts** are served only through signed URLs: `/artifacts/<signature>/<project>/<job>/...`, where the signature is a token bound to that one cut and minted into each job or review response. The link is valid for 30 days from completion (FR-040), capped at the project's retention date; `artifactUrlsExpireAt` reports the moment. No cookie is set anywhere, no token appears in a query string, and the relative media segment URIs inside an HLS playlist resolve under the same signed prefix, so segments authenticate exactly like the playlist.
- **Export validation (FR-044)** runs ffprobe on every export and refuses it unless the codec is H.264, the audio is AAC, and the resolution, frame rate, duration, and bitrate match what was requested.
- **State** — projects, script versions, attestations, approvals, review links, jobs, and the cost ledger — is written to disk under `/data/state` and `/data/queue`, so an API or worker restart does not invalidate a live project token. Every write to the shared job file happens under an interprocess lock, so the API and any number of workers can share one queue without losing each other's updates.
- **Durability (AC-024)** — a claimed job carries a lease that the worker renews before every shot. If the worker dies, the lease lapses and the next claim (or any worker's startup) returns the job to the queue to resume from its last checkpoint. `HV_JOB_LEASE_MS` sets the lease (default five minutes).
- **Queue-behind (FR-032)** — when capacity says a job must queue behind existing work (the project's concurrency limit, or the free tier at 80% of the monthly budget), the job records which jobs were ahead of it and no worker starts it until every one of them has finished. The worker also enforces each tier's concurrency limit at claim time.
- **Cost** is enforced end to end: the worker records each shot into the durable ledger, the per-job cap cancels an over-budget job, and the API reads real month-to-date spend when deciding capacity.

## Security baseline (C-008, NFR-004, FR-053)

- **mTLS between services.** `./infra/mtls/gen-certs.sh` writes an internal CA plus the API server certificate and the proxy's client certificate to `infra/mtls/certs` (git-ignored, never baked into an image), laid out per role: `ca/` holds the CA signing key and stays on the host only, `api/` holds `api.crt`, `api.key`, and `ca.crt`, and `frontend/` holds `frontend.crt`, `frontend.key`, and `ca.crt`. Compose bind-mounts each of those files read-only into its own container and nothing else, so the CA key can never be read from a runtime container and neither service can see the other's private key; CI asserts the mounted set in both containers. With `HV_TLS_CERT_PATH`, `HV_TLS_KEY_PATH`, and `HV_TLS_CLIENT_CA_PATH` set, the API serves HTTPS and refuses any connection that does not present a certificate issued by that CA; nginx presents the only such certificate and verifies the API's. Setting some but not all three fails closed. Leaving all three unset keeps plain HTTP for local development and tests.
- **Rate limiting.** Every request is budgeted per client address: `HV_RATE_LIMIT_API_PER_MINUTE` (default 120), `HV_RATE_LIMIT_PROJECTS_PER_HOUR` (default 20, for `POST /api/projects`), and `HV_RATE_LIMIT_ARTIFACTS_PER_MINUTE` (default 600). Over budget answers 429 with `Retry-After`. The address is stored only as a keyed hash, and every record is deleted after 30 days. `HV_TRUST_PROXY=1` (set in compose, where nginx terminates the connection) makes the API read `X-Forwarded-For`, honouring only its last hop, the value the proxy set; nginx overwrites the inbound header with the peer address rather than appending to it, so a client-supplied value never reaches the limiter. Without the flag the header is ignored and the socket peer address is used.
- **Frontend origin.** The page talks only to its own origin or to the build-time `hv-api-base` meta tag. There is no query-string or global override, so a crafted link cannot redirect the bearer token elsewhere.
- **Content policy (FR-054).** The safety gate refuses identifiable real persons, political deepfakes, and trademarked brands and characters, in addition to minors, non-consensual intimate content, incitement, and dehumanising hate, before any provider call.

## Benchmark gate

`bun run benchmark` records the 24-shot baseline; `bun run benchmark:compare`
gates the working tree and runs on every pull request and push. Deterministic
metrics (visual quality proxy, continuity, cost per shot, fixture digest, shot
count) block the merge at 5% against the committed baseline.

Latency is gated at the same 5%, but never against the committed baseline:
wall-clock per-shot latency depends on the host, and the same commit measured
identically on two machines whose CPU speed differed by 45%, so no cross-host
figure can tell a code regression from a different machine. Instead the gate
checks the merge base out into a temporary worktree and runs it interleaved
with the candidate on the same host (three rounds each by default), comparing
the noise floor of each side. The latency figures in the committed baseline
describe the host that recorded them and are printed as advisories only.

`HV_BENCHMARK_BASE_REF` overrides the base commit (CI passes the pull request
base; `none` skips the A/B), `HV_BENCHMARK_ROUNDS` changes the round count, and
`bun run benchmark:compare <baseline.json> <candidate.json>` still compares two
recorded files on the deterministic lane.

Piper remains the alpha TTS target. Until it is available, exports use the
ADR-0020-required silent-audio plus captions degradation path and identify that
mode in the export result. Public deployment remains blocked by the human launch
gates.
