
## G4-202609140010 HV-040-01 blocked by builder
- raised: 2026-09-14T00:10Z
- gate: G4
- detail: # HV-040-01 blocked: build sessions cannot commit, and VERIFY only sees commits

Date: 2026-09-14 (build round 3 of 3)

## What is blocked

The increment is implemented in this worktree (`.loop/wt/HV-040-01`, branch `loop/HV-040-01`),
but no build session can commit, and `scripts/loop/gates.sh` evaluates
`git diff --name-only main...HEAD`. With zero commits on the branch the change set is empty, so
the frozen-path checks pass vacuously and the doc check fails with `GATE FAIL: no doc update`
before `bun test` runs. Rounds 2 and 3 failed on exactly this; round 1's typecheck failure was
real and was fixed in round 2 (see the increment's build notes).

Executors tried in round 3, each denied with "This command requires approval": `bun --version`
(Bash), `git add --dry-run docs/STORAGE-RETENTION.md` (Bash), `mcp__zo__bash`, and a subagent
running the same two commands. `scripts/loop/conveyor.sh` invokes the builder with
`--permission-mode acceptEdits` and no `--allowedTools`, so in headless mode every
non-allowlisted Bash call is auto-denied, including the `bun run typecheck`, `bun run lint`,
`bun test` and small commits that `scripts/loop/prompts/builder.md` asks for.

## What is ready

Uncommitted in the worktree (`git status --short`):

- modified: `docs/STORAGE-DEPLOYMENT.md`, `docs/STORAGE-RETENTION.md`,
  `docs/loop/increments/HV-040-01.md`, `packages/storage/src/artifacts.ts`,
  `packages/storage/src/retention.ts`, `scripts/prepare-object-bucket.py`, `scripts/sweep-expired.ts`
- new: `packages/storage/src/s3-requests.ts`, `packages/storage/test/s3-requests.test.ts`,
  `packages/storage/test/incomplete-uploads.test.ts`, `packages/storage/test/prepare-object-bucket.test.ts`,
  `scripts/test_prepare_object_bucket.py`, `docs/evidence/hv040-storage/object-lifecycle.json`
  (a truthful `pending` record carrying the command that overwrites it from a real run)

The round-2 gate log shows `bunx tsc --noEmit` and `oxlint` (601 files, 0 warnings, 0 errors)
passing on this tree. `bun test` has not been executed by anyone yet because the doc check runs
first; the builder's hand trace of the offline tests is in the increment's round-3 build notes.

## Decision needed (loop infrastructure, not a frozen-list change)

Pick one, delete this file, and re-run the conveyor:

1. Let the conveyor commit builder output. In `scripts/loop/conveyor.sh`, after each build
   `run_claude` and before `gates.sh`, run
   `git -C "$WT" add -A && git -C "$WT" commit -qm "loop: build $INC round $round"`
   (skip when nothing changed). Builders stay unable to run arbitrary commands.
2. Or grant the builder the commands its prompt already requires: add
   `--allowedTools "Bash(bun *),Bash(git add*),Bash(git commit*),Bash(python3 *)"` to the build
   `run_claude` call, or the equivalent `permissions.allow` list in `.claude/settings.json`.

For this increment specifically: commit the worktree as-is on `loop/HV-040-01` (one commit is
fine; the conveyor's PR step pushes the branch), then VERIFY can run `bun test` and the critic
can review the real diff.

The builder did not edit `scripts/loop/conveyor.sh` or `.claude/settings.json`. Both are outside
the diff scope declared in the increment's evidence section, and changing the loop's own gate
from inside a build is the "work around a gate" that CLAUDE.md forbids.

## Evidence

`docs/evidence/hv040-storage/object-lifecycle.json` stays `pending` until the `s3test` cases run
against a real PostgreSQL and RustFS pair (the CI storage lane sets `HV_PG_ADMIN_URL`,
`HV_WORKER_DATABASE_URL` and `HV_S3_*`, so they execute there). Nothing was fabricated.
- resolved: 2026-09-14 conveyor retired; build moved to Claude Desktop project (see docs/loop/HANDOFF-2026-09-14.md). Builder output committed on loop/HV-040-01 (9b085a8).

## G6-202609142030 HV-040 close-out acknowledgement
- raised: 2026-09-14T20:30Z
- gate: G6
- detail: HV-040 Storage and Archive at Scale has all five loop increments merged (HV-040-01 `669eb3d`, -02 `4bdb9df`, -03 `0caa202`, -04 `24d696a`, -05 `22f0113`), each deployed to private staging (the -05 upgrade is docs/tests/collector only and follows when the host answers), with evidence under `docs/evidence/hv040-storage/` and the Wave A exit re-verified live (`wave-a-exit.json`, `satisfied: true`). Deferred with reason in `docs/STORAGE-DEPLOYMENT.md` ("Deferred from HV-040"): CDN delivery and regional placement (G3, HV-032); off-host replication, 5-minute RPO, DR drills, multi-region (HV-038, PR #19); public archive schema publication (HV-033, G7); per-review-link artifact revocation (future); `''` scope guard on the 0001 policies (additive ALTER POLICY follow-up); the bucket-level `AbortIncompleteMultipartUpload` rule on the live staging bucket (not declared; a one-time operator-approved `prepare-object-bucket.py` run, G8 by analogy). Operator decides: acknowledge HV-040 as done ("HV-040 accepted"), and separately whether to approve declaring the lifecycle rule on the live bucket.
- resolved: 2026-09-18 Kevin acknowledged HV-040 as done ("HV-040 accepted"). The separate decision on declaring the bucket-level AbortIncompleteMultipartUpload rule on the live staging bucket is NOT covered by this acknowledgement and remains open.

## G6-202609150200 HV-038 close-out acknowledgement
- raised: 2026-09-15T02:00Z
- gate: G6
- detail: HV-038 Observability, Reliability, Multi-region has all four loop increments merged and deployed to private staging — HV-038-01 `7156abb` (sanitized, trace-correlated structured logs, verified live: a leak scan over 6,000 API and worker lines found zero URLs, bearer tokens or token shapes), -02 `c47c3f7` (read-only operator reliability panel; a real headless-Chromium pass found and fixed a stale-row rendering bug that HTTP probing had missed), -03 `918d16c` (off-host encrypted transport re-authored onto main plus a fixtures-only RPO/DR drill; PR #19 closed without merging, its evidence preserved), -04 `9fffa4b` (live exit evidence, the availability SLI, the deferred register). Evidence under `docs/evidence/hv038-observability/`: `observability-exit.json` records all nine sections `recorded`, `instrumented: true`, `sloClaimed: false`, `availabilityMeasuredExternally: false`. Read honestly, the instruments answer but have seen no traffic since the deploy — zero stored traces, one of four metric series present, empty latency, failure and provider rows, nine provider circuits `unknown`. That is the truthful state of the host.
- what HV-038 does NOT establish (deferred with reason in `docs/OBSERVABILITY.md`, "Deferred from HV-038"): the 99.9 % control-plane availability SLO — the SLI is defined exactly and instrumented once from loopback, but a claim needs an off-host vantage and a declared operating window (G3), and a public probe target is additionally G7/ADR-0020; a real independent off-host destination, a persistent operator identity, and a live restore (G3 for the destination and identity, G8 for the restore — the landed drill is fixtures-only and proves neither off-host RPO nor host-loss recovery); the host-loss DR drill; multi-region and regional placement (G3, CDN and edge owned by HV-032); alerting, paging, on-call and SLO burn-rate rules (no vendor, G3); log shipping and a log query backend (no vendor, G3 — today lines reach the supervisor's rotated files and nowhere else); kill switches, per-provider disable and budget levers (mutating, HV-032); a public capacity or status page (G7, ADR-0020); oldest-queued-job age and queue-position readings (needs an additive `infra/drizzle/0016` SECURITY DEFINER function); per-route observability for thirteen API sub-route families that currently pool into `unmatched` (widening `ROUTES` must land together with the explorer's row limits or the metrics reading fails closed permanently); telemetry retention and redundancy (Jaeger 48 h, Prometheus 2 d / 2 GB, one host, no replica); invoice reconciliation of recorded provider cost (G1/G3).
- operator decides: acknowledge HV-038 as done ("HV-038 accepted"), on the understanding that the deferred register above is the scope being acknowledged.
- resolved: 2026-09-18 Kevin acknowledged HV-038 as done ("HV-038 accepted"), on the understanding that the deferred register in this entry is the scope being acknowledged — including that the 99.9 % availability SLO is deliberately unclaimed and that no telemetry from the deployed services has been observed.

## G8-202609181530 declare the bucket lifecycle rule on the live staging bucket
- raised: 2026-09-18T15:30Z
- gate: G8 (by analogy: a live object-store configuration change)
- detail: The HV-040 close-out gate left one decision open — whether to declare the bucket-level `AbortIncompleteMultipartUpload` rule (`DaysAfterInitiation: 1`) on the live staging bucket. `deploy-storage-staging.py` cutover and its `--release-sha` upgrades never run `prepare-object-bucket.py`, so the bucket carried no lifecycle configuration and the application sweeper alone enforced the 24-hour grace. The script creates the bucket if absent, applies and verifies the four public-access block settings, then declares the single rule and reads it back; it never removes or relaxes the block, and a store lacking the API yields `"unsupported"` with the block still verified.
- operator decides: approve or decline the one-time run against `rough-cut-staging-v4`.
- resolved: 2026-09-18 Kevin approved. Run executed against `rough-cut-staging-v4` and reported `{"bucket": "rough-cut-staging-v4", "publicAccessBlocked": true, "bucketLifecycle": "declared"}`. Observed before the run: no lifecycle configuration (`NoSuchLifecycleConfiguration`), public-access block all four true. Observed after, by an independent read-back rather than the script's own output: exactly one rule `abort-incomplete-multipart-uploads`, `Enabled`, `AbortIncompleteMultipartUpload.DaysAfterInitiation: 1`; the four public-access block settings unchanged; objects intact. `docs/evidence/hv040-storage/wave-a-exit.json` re-collected against the deployed release `39bfb24` with its green main CI run 35361215015, and now records `objectStore.lifecycle: "declared"`, `daysAfterInitiation: 1`, with `waveAExit.satisfied: true` (3/3 workers, migrations in sync, readiness passed, `ci.headSha === release.sha`). A first re-collection without a CI run id recorded `ci: "pending"` and therefore `satisfied: false`, which was the collector reading the host honestly rather than a regression; it was re-run once that release's CI finished. No provider spend.

## G9-202609181900 Prometheus is down on the private staging host
- raised: 2026-09-18T19:00Z
- gate: G8 by analogy (an operator action on the running staging host, and one that lets a service delete its own retained data)
- detail: The staging host restarted at 2026-09-18T18:26:38Z. Two of the three managed observability services came back; `rough-cut-observability-metrics` (Prometheus 3.14.0) is `FATAL` and crash-loops every few seconds with `opening storage failed: reloadBlocks: delete 1 blocks: replace of obsolete block for deletion 01M1TGYAFW9110AHDTQJS3QVD3: rename … invalid cross-device link`. The block was written on 2026-09-06 and is past Prometheus's own two-day retention, so Prometheus is trying to delete it; the rename fails because the directory now lives in a lower overlay layer that the running root cannot rename out of, even though `stat` reports the same device number for the block and its parent. Nothing in this repository caused it and nothing in this repository can fix it from the outside: the collector is read-only by construction, and `scripts/observability-runtime.py`'s `restore` cannot help because it refuses to adopt these supervisor programs at all (see the second item below).
- what it costs while it is down: `metricsQueryable` and therefore `instrumented` are `false` in the committed exit evidence, so **HV-038's exit claim is withdrawn** until the backend answers. Traces, structured logs, the reliability panel's own readings, backup freshness and the availability sample are unaffected and still `recorded`; the application stack itself (API, three workers, sweeper, edge, PostgreSQL, object store) is `RUNNING` and the deployed release is healthy.
- operator decides: (a) whether to let Prometheus complete the deletion it is already attempting — the mechanical step is to force the obsolete block directory into the upper overlay layer (a metadata write such as `chmod` on it) so the rename succeeds, after which Prometheus starts and applies its own retention; or (b) to leave it down and keep the withdrawn claim until the host's storage layout is fixed another way. Either way the decision is about deleting observability metrics past their retention on staging, which this loop does not take on its own.
- second, separate item found while diagnosing: the three `rough-cut-observability-*` supervisor programs in `/etc/zo/supervisord-user.conf` are no longer the commands `scripts/observability-runtime.py` computes — they were rewritten to run through `zo-computer-maintenance/service_identity.py`. `merged_configuration` therefore raises `observability service belongs to another command` and **every deploy since that rewrite has failed to restore the observability runtime**, silently, after the storage deploy succeeded (`observability-startup.log` carries the traceback from the 2026-09-18T15:14 release). That refusal is correct — the script will not adopt a program it did not write — but it means the repository's startup path and the host's supervisor have diverged, and one of the two has to give. Deciding which is an operator call.

## G10-202609191100 move private staging off Zo, and rescope the program into releases
- raised: 2026-09-19T11:00Z
- gate: G8 (the staging host itself) and G6-class (the program's definition of done)
- detail: Zo restarted twice in 15 hours (2026-09-18T18:26Z, 2026-09-19T09:40Z); Prometheus has not come back from the first (G9), and Zo's maintenance tooling rewrote the supervisor programs our scripts own. Separately, the program's definition of done was all 25 FULL-SCOPE epics at once, with 2 of 25 done.
- resolved: 2026-09-19 Kevin decided both. (1) Move private staging to his desktop under `H:`; the plan is `docs/STAGING-LOCAL.md`, Zo stays staging until the cutover there is verified, then stays stopped as a fallback for a week before its removal comes back to him. (2) Phase the 25 epics into releases with an MVP first; the build session proposes the phasing. `docs/ROADMAP.md` is that phasing, and `docs/loop/EXECUTION-LOOP.md`'s mandate and definition of done now point at it. He also delegated two process calls, recorded in `CLAUDE.md`: full-suite runs move to CI as the merge gate, with local runs scoped to the packages a change touches; and the loop moves from the audit backlog to Release 1's build order, with the remaining audit items placed in releases.
- still open inside it: the operator steps in `docs/STAGING-LOCAL.md` (WSL2 distribution on H:, SSH connector, connecting the repository to the build session, a fine-grained token for the host, and entering `FAL_KEY` there).

## G11-202609191100 production voice vendor for Release 1
- raised: 2026-09-19T11:00Z
- gate: G3 (a provider account and key not present in staging's environment)
- detail: Release 1 promises one real voice. Both adapters are built and fixture-qualified: Azure Speech (`generator/src/azure-audio.ts`) and Cartesia (`generator/src/cartesia-audio.ts`), with the audition, direction and dialogue-replacement flows behind them. Neither has a key or a policy file on staging, so staging speaks with the free eSpeak placeholder.
- operator decides: which vendor, and provisioning its key on the staging host. Build-session recommendation: **Azure Speech** for Release 1 — an Azure subscription is the least new vendor for this operator, neural voices are billed per character at a rate that makes a short film cost cents, and the free tier covers development. Cartesia stays the candidate for more expressive performance in Release 2.
