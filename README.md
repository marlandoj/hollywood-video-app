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

- `packages/api/src/server.ts` serves health, anonymous project, script, rights attestation, animatic approval, job, review, and cookie-protected artifact routes.
- `packages/queue/src/worker.ts` claims durable jobs from disk, generates through a primary/secondary failover provider under a per-job timeout, records every shot into the cost ledger, checkpoints after each shot, and produces H.264/AAC MP4, HLS, captions, and provenance artifacts.
- `packages/frontend/src/index.html` drives the anonymous screenplay → animatic → approval → export journey and the accountless review flow. It talks to its own origin; there is no hardcoded API host.
- `docker-compose.yml` shares queue, artifact, and state volumes across the API, worker, and sweeper, and serves the creator UI on port 8081. nginx proxies `/api/`, `/artifacts/`, and `/health` to the API so the browser sees a single origin.

```bash
bun install --frozen-lockfile
export HV_TOKEN_SECRET="replace-with-at-least-32-random-characters"
docker compose up --build api queue-worker frontend
curl --fail http://127.0.0.1:8081/health
```

For a local proof without Docker, run `bun run smoke:runtime`. It walks the full
production path — project creation, rights attestation, the animatic approval
gate, final generation, HLS playlist *and media segment* fetch, the reviewer
view, and an API restart — and fails if any gate can be bypassed.

## Gates and state

- **Rights attestation (FR-017)** is captured on the project and copied onto the job. The worker refuses any job without it.
- **Animatic approval (FR-023)** is the only human-in-the-loop gate. A `final` job is refused unless an `approved` decision exists for its animatic and the screenplay has not changed since.
- **Capacity tier (FR-030)** is server-decided. A client cannot request `elevated`; it requires a grant signed with `HV_OPERATOR_GRANT_SECRET`, minted out of band with `bun run operator:grant <projectId> [hours]`. With no grant secret configured, every project is free tier.
- **Artifacts** are served only to a bearer token or the short-lived `hv_artifact` HttpOnly cookie scoped to `/artifacts/`. Tokens never appear in query strings, and HLS media segments authenticate the same way the playlist does.
- **State** — projects, script versions, attestations, approvals, review links, jobs, and the cost ledger — is written to disk under `/data/state` and `/data/queue`, so an API or worker restart does not invalidate a live project token.
- **Cost** is enforced end to end: the worker records each shot into the durable ledger, the per-job cap cancels an over-budget job, and the API reads real month-to-date spend when deciding capacity.

## Benchmark gate

`bun run benchmark` records the 24-shot baseline; `bun run benchmark:compare`
gates a candidate against it. Deterministic metrics (visual quality proxy,
continuity, cost per shot, fixture digest, shot count) block the merge at 5%.
Wall-clock latency is normalized against a same-run CPU calibration probe and
gated at a wider band, with raw avg/p99/total reported as advisories. Host noise
is not a merge blocker; a real slowdown still is.

Piper remains the alpha TTS target. Until it is available, exports use the
ADR-0020-required silent-audio plus captions degradation path and identify that
mode in the export result. Public deployment remains blocked by the human launch
gates.
