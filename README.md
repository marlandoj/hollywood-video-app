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

The repository now contains a reachable private-staging stack:

- `packages/api/src/server.ts` serves health, anonymous project, script, job, review, and protected artifact routes.
- `packages/queue/src/worker.ts` claims durable jobs from disk and produces H.264/AAC MP4, HLS, captions, and provenance artifacts.
- `packages/frontend/src/index.html` drives the anonymous screenplay-to-export journey and accountless approve/request-changes flow.
- `docker-compose.yml` shares queue and artifact volumes across the API and worker and exposes the creator UI on port 8081.

```bash
bun install --frozen-lockfile
export HV_TOKEN_SECRET="replace-with-at-least-32-random-characters"
docker compose up --build api queue-worker frontend
curl --fail http://127.0.0.1:8080/health
```

For a local proof without Docker, run `bun run smoke:runtime`. It executes the complete API → durable queue → worker → protected HLS artifact path with the deterministic mock provider.

Piper remains the alpha TTS target. Until it is available, exports use the ADR-0020-required silent-audio plus captions degradation path and identify that mode in the export result. Public deployment remains blocked by the human launch gates.
