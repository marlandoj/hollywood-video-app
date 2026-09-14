# Execution loop: Claude Code on Zo

> **2026-09-14: the Zo conveyor described here is retired.** Policy sections (mandate, frozen list, gates, budgets) still govern; execution now happens from the Claude Desktop project. See `HANDOFF-2026-09-14.md`.

**Owner:** Claude (Anthropic), operating under Kevin's direction
**Mandate:** all 25 epics in `docs/FULL-SCOPE.md` (HV-016 to HV-040) implemented, verified, deployed to private staging, and closed by the operator.
**Governing rules:** ADR-0018 (free anonymous access), ADR-0020 (fail-closed launch gates), `docs/PROGRAM-EXECUTION.md` operator authorization of 2026-09-05, $500 paid-provider evaluation envelope.

## Shape

One conveyor, one increment at a time, one PR per increment. Every increment passes the same
sequence. Nothing skips a stage; a stage that cannot complete stops the conveyor and raises a
human gate rather than improvising.

```
SELECT → PLAN → BUILD → VERIFY → CRITIC → PR/CI → MERGE → DEPLOY → RECORD
   ↑                       └── gaps (≤3 rounds) ──┘
   └──────────────── next increment ───────────────────────────────┘
```

| Stage | Actor | Bounded by |
|---|---|---|
| SELECT | `scripts/loop/status.ts` | Dependency order in FULL-SCOPE §10; only epics whose dependencies are `done`; never two increments on one epic in flight |
| PLAN | Claude Code (`--permission-mode plan`) | Writes `docs/loop/increments/HV-0NN-MM.md`: goal, acceptance criteria quoted from FULL-SCOPE, tests to add, evidence required, paid spend estimate (USD, must be 0 or explicit) |
| BUILD | Claude Code headless, isolated worktree, `--permission-mode acceptEdits`, `--max-turns`, `--max-budget-usd` | `scripts/loop/prompts/builder.md`; may not touch anything in the frozen list below |
| VERIFY | `scripts/loop/gates.sh` (no LLM) | typecheck, lint, `bun test`, `benchmark:compare`, `git diff --check`, secret scan, frozen-list diff check, docs updated |
| CRITIC | Claude Code, fresh session, read-only tools | `scripts/loop/prompts/critic.md`; compares the real diff against the increment's acceptance criteria; returns JSON `{verdict, gaps[]}` |
| PR/CI | `gh pr create`, GitHub Actions | All four CI jobs green on the exact head |
| MERGE | conveyor | Routine merges are operator-authorized (PROGRAM-EXECUTION.md); merge only the CI-verified head, `--squash` off, history preserved |
| DEPLOY | `scripts/deploy-private-staging.py` | Merged commit only; refuses active jobs; backup handle recorded |
| RECORD | conveyor | Appends to `docs/PROGRAM-EXECUTION.md`, updates `docs/loop/STATUS.md`, comments on the Linear epic (ZOU-1585..1609) |

## Frozen list (build may not change without a human gate)

- `packages/safety/**` refusal categories: may grow, never shrink
- Anything that introduces accounts, payment, cookies, tracking, or paid tiers (ADR-0018)
- `HV_MONTHLY_BUDGET_USD`, `HV_COST_CAP_PER_SHOT_USD` defaults upward
- Public DNS, public branding, TOS/content-policy publication, launch copy (ADR-0020)
- `docs/legal/**`, `docs/adr/**` (proposals go in the increment doc, not in place)
- Destructive migrations against the staging database or object store
- CI workflow gates (`.github/workflows/ci.yml`) loosened in any way

## Human gates (conveyor STOPS, alerts, waits)

| # | Trigger | What Kevin decides |
|---|---|---|
| G1 | Paid-provider ledger reaches $450 (90% of $500), or any single evaluation estimated > $50 | Raise the envelope, or defer live evaluation and continue on mock |
| G2 | Claude Code API spend reaches the per-day or per-epic ceiling (`scripts/loop/loop.env`) | Raise the ceiling or pause |
| G3 | Increment needs a provider/vendor/account/secret that is not present in Zo Secrets | Provision it, or mark the capability deferred |
| G4 | Increment needs a frozen-list change | Approve the specific change (recorded in the increment doc) |
| G5 | Builder/critic still has gaps after 3 rounds, or CI red 3 times on the same increment | Steer, split, or defer the increment |
| G6 | Epic close-out: every increment merged, evidence linked in `docs/loop/STATUS.md` | Acknowledge the epic as done (lightweight; reply "HV-0NN accepted") |
| G7 | Anything ADR-0020 fail-closed: name clearance, counsel review, beta cohort, load/pen test, public deployment | Provide the external evidence; the loop never fabricates it |
| G8 | Irreversible staging operation (data loss, restore, key rotation) | Approve explicitly |

Alert path (`scripts/loop/alert.sh`): append the gate to `docs/loop/HUMAN-GATES.md`, create or update a Linear issue labeled `human-gate` under ZOU-1584, and send a Zo notification email. The conveyor writes `.loop/paused` and polls for `resolved:` in the gate entry or the Linear issue closing. No further build starts while paused; VERIFY/CI on an already-open PR may finish.

## Budgets and limits

Defined in `scripts/loop/loop.env` (committed defaults, override locally):

- `LOOP_MAX_TURNS` per build session (default 200)
- `LOOP_MAX_USD_PER_BUILD` (default 25), `LOOP_MAX_USD_PER_DAY` (default 150) — Claude Code API spend, tracked in `.loop/api-ledger.jsonl` from `total_cost_usd` in each result
- `LOOP_PAID_ENVELOPE_USD=500`, `LOOP_PAID_ALERT_USD=450` — provider spend from the app's CostLedger plus `.loop/paid-ledger.jsonl`
- `LOOP_CRITIC_ROUNDS=3`, `LOOP_CI_RETRIES=3`
- `LOOP_WALL_CLOCK_PER_INCREMENT=4h`

## Isolation

- Every build runs in `git worktree add .loop/wt/<branch>`; the main checkout is never dirtied.
- `bun test` in the loop points at the Zo-native PostgreSQL/RustFS runtimes with a per-run database name and bucket prefix; staging data is never the test target.
- Paid adapters are reachable only when the increment doc declares spend and G1 has not tripped; otherwise `HV_PROVIDER_*=mock` is forced in the build environment.

## Scheduling

`scripts/loop/conveyor.sh` is idempotent and lock-guarded (`.loop/lock`). Run it under a Zo
scheduled task every 30 minutes; each run performs at most one full increment and exits.
Resumption reads only `docs/loop/STATUS.md`, the increment docs, and open PR state, never
narrative memory.

## Definition of done (program)

All 25 epics in `docs/loop/STATUS.md` are `done` with an operator acknowledgement (G6), the
private staging runs the final merged commit, and the ADR-0020 external gates are listed with
their actual status. Public launch is outside this loop's authority.
