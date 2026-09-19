# Rough Cut (working title; codename Hollywood Video) — rules for Claude Code

Read docs/loop/EXECUTION-LOOP.md before any loop work. Read AGENTS.md for retrieval order.

## Non-negotiable
- Free anonymous access (ADR-0018): no accounts, payments, cookies, tracking, paid tiers.
- Fail-closed launch (ADR-0020): no public DNS, branding, terms publication, or live paid
  generation for end users. Never fabricate launch, legal, or provider evidence.
- Safety refusals in packages/safety may grow, never shrink.
- Paid providers stay `mock` unless the current increment doc declares `spend_usd` and names the provider.
- Never add keys, accounts, or vendors. Secrets come only from the staging host's environment, entered by the operator (Zo Secrets until the local-host cutover in docs/STAGING-LOCAL.md).
- Frozen without a human gate: docs/legal/**, docs/adr/**, .github/workflows/**, budget defaults upward, destructive staging migrations.

## Working agreement
- One increment, one branch, one PR. Small commits, message first. Never push to main from a build session.
- Every criterion gets a real test. Before opening a PR: `bun run typecheck && bun run lint`, plus `bun test` over every package the change touches and every suite the increment doc names. CI's full suite on the exact head is the merge gate; run the full suite locally only to reproduce a CI failure or when a change touches `packages/queue` or `packages/storage` schemas.
- Evidence files (`docs/evidence/**`) are pushed only after the tests that read them pass locally.
- Work comes from the current release's build order in docs/ROADMAP.md. The product is a studio whose AI crew drives the engine (G13): prefer a persona deciding a setting over a new setting for the creator to fill in.
- Runtime and contract notes go in the epic's docs/*.md; execution history goes in docs/PROGRAM-EXECUTION.md (via the conveyor, not by hand).
- Bun 1.4.0 is the pinned runtime. ffmpeg is on PATH. PostgreSQL and RustFS run natively on the staging host (Zo until the cutover in docs/STAGING-LOCAL.md); tests use a per-run database/bucket prefix, never the staging data.
- If blocked, write docs/loop/increments/<inc>.blocked.md with the reason and stop. Do not work around a gate.
