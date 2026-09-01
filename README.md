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
- `docker-compose.yml` shares queue, artifact, and state volumes across the API, worker, and sweeper, and serves the creator UI on port 8081. nginx proxies `/api/`, `/artifacts/`, and `/health` to the API so the browser sees a single origin.

```bash
bun install --frozen-lockfile
export HV_TOKEN_SECRET="replace-with-at-least-32-random-characters"
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
- **Artifacts** are served only through signed URLs: `/artifacts/<signature>/<project>/<job>/...`, where the signature is a one-hour, project-bound token minted into each job or review response. No cookie is set anywhere, no token appears in a query string, and the relative media segment URIs inside an HLS playlist resolve under the same signed prefix, so segments authenticate exactly like the playlist.
- **State** — projects, script versions, attestations, approvals, review links, jobs, and the cost ledger — is written to disk under `/data/state` and `/data/queue`, so an API or worker restart does not invalidate a live project token.
- **Cost** is enforced end to end: the worker records each shot into the durable ledger, the per-job cap cancels an over-budget job, and the API reads real month-to-date spend when deciding capacity.

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
