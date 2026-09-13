# Rough Cut (working title; codename Hollywood Video) — rules for Claude Code

Read docs/loop/EXECUTION-LOOP.md before any loop work. Read AGENTS.md for retrieval order.

## Non-negotiable
- Free anonymous access (ADR-0018): no accounts, payments, cookies, tracking, paid tiers.
- Fail-closed launch (ADR-0020): no public DNS, branding, terms publication, or live paid
  generation for end users. Never fabricate launch, legal, or provider evidence.
- Safety refusals in packages/safety may grow, never shrink.
- Paid providers stay `mock` unless the current increment doc declares `spend_usd` and names the provider.
- Never add keys, accounts, or vendors. Secrets come only from the environment (Zo Secrets).
- Frozen without a human gate: docs/legal/**, docs/adr/**, .github/workflows/**, budget defaults upward, destructive staging migrations.

## Working agreement
- One increment, one branch, one PR. Small commits, message first. Never push to main from a build session.
- Every criterion gets a real test. `bun run typecheck && bun run lint && bun test` before finishing.
- Runtime and contract notes go in the epic's docs/*.md; execution history goes in docs/PROGRAM-EXECUTION.md (via the conveyor, not by hand).
- Bun 1.4.0 is the pinned runtime. ffmpeg is on PATH. PostgreSQL and RustFS run natively on Zo; tests use a per-run database/bucket prefix, never the staging data.
- If blocked, write docs/loop/increments/<inc>.blocked.md with the reason and stop. Do not work around a gate.
