
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
- resolved: 2026-09-19 Kevin chose **Azure Speech**. The adapter is pinned to the standard neural service in **East US** (`docs/NATIVE-VOICE-PERFORMANCE.md`), so the operator creates one Azure AI Speech resource in `eastus` and enters its key on the staging host as `HV_AZURE_SPEECH_KEY`; the build session writes the voice policy file (`HV_AUDIO_POLICY_FILE`) in the Release 1 voice increment. Same day, Kevin approved copying `FAL_KEY` from Zo's staging environment to the new host; that copy happens host to host at cutover and is never printed or left on `H:`.

## G12-202609191900 real people in a film: by consent, not refused outright
- raised: 2026-09-19T19:00Z
- gate: safety-refusal change (`CLAUDE.md`: refusals in `packages/safety` may grow, never shrink without a human gate)
- detail: Release 1 build step 2 was planned as "refuse identifiable real people before any live generation", because the prompt gate did not refuse "A portrait of Taylor Swift". The operator does not want real people refused outright: he wants to cast himself from his own photos. The cast editor offered only an original-fictional-character declaration, so a real person could not be cast legitimately at all.
- resolved: 2026-09-19 Kevin approved the build session's proposal ("this is fine. lets proceed."):
  - A cast member may be a **real person who consented**: the creator ("this is me") or someone who gave the creator permission. The declaration is required to permit rendering, is scoped, expirable and revocable like any cast permission, and is per project: a real person's actor record cannot be shared as an actor-library link.
  - **Named public figures are refused** wherever they appear (prompt text, dialogue, cast name, aliases, appearance), whatever the cast record says. This grows the refusals; nothing is removed.
  - The consent is a declaration. The studio is anonymous (ADR-0018) and cannot verify identity. That is acceptable on private staging; before any public launch it is part of the counsel and moderation review already under G7.
  - A voice clone of the operator is not part of this. Azure's custom-voice programme needs Microsoft's approval and would be a separate decision.
- implemented by: HV-031-04.

## G13-202609192200 the product becomes a studio with an AI crew
- raised: 2026-09-19T22:00Z
- gate: G6-class (the program's definition of done) and G3 (a new vendor: the Anthropic API for the crew, and later OpenAI for voice)
- detail: Testing staging, the operator found the app a long series of settings. His scenario: a writer or content creator brings a script, and Hollywood Video is the studio whose AI persona crew brings it to life, asking for details and offering art, creative, cinematography and directional advice as an option. Voice conversation (GPT-Live-1) would be welcome.
- resolved: 2026-09-19 Kevin decided:
  - Release 1 pivots to the crew experience: script → crew conversation → three approvals → film, for reels and shorts. Today's detailed panels become the "Director's desk", hidden behind an **Advanced** switch.
  - The crew's language model is **Claude (Anthropic API)**. The key is entered by the operator on the staging host, as the other keys are.
  - **Voice (GPT-Live-1) comes after the text crew works.** It is Release 2, with its own G3 when the OpenAI key is entered.
  - **Crew spend has its own budget line.** Alerts go to the operator at **$25, $100, $200 and $1,000** of cumulative crew spend. At **$1,000 the crew stops** until he approves more (confirmed the same day). The $500 generation cap and its $450 alert are unchanged.
- implemented by: `docs/ROADMAP.md` (Release 1 "Studio"), then the HV-030 increments in its build order.

## G14-202609210000 Release 1 acknowledged, and a second voice vendor
- raised: 2026-09-21T00:00Z
- gate: G6 (Release 1 close-out) and G3 (a vendor and key not present in staging's environment)
- detail: Release 1's run is recorded in `docs/evidence/release-1/release-run.json`: two films from pasted scripts through the studio's front door, both approved by the operator on a second device, $14.44 of generation spend against the $450 alert, $0 on the crew's line. Separately, the operator asked why Azure was chosen for speech over ElevenLabs or Deepgram. It was not chosen on merit: the rules forbid the build session adding a vendor or account, the repository already had Azure and Cartesia adapters, and the operator already had an Azure Speech resource.
- resolved: 2026-09-21 Kevin acknowledged Release 1 ("I ankowledge"), and approved **ElevenLabs as a second voice vendor**:
  - **ElevenLabs is primary, Azure is the fallback.** The crew casts ElevenLabs voices; Azure stays authorized for when a voice is unavailable or the vendor's line is spent.
  - **Its own budget line: $25, with alerts at $5 and $15.**
  - **A fixed set of premade voices**, chosen by the build session and authorized from the operator's own catalogue evidence.
  - The key was provisioned by the operator into the staging host's `secrets.env` as `HV_ELEVENLABS_API_KEY` (mode 600) and never entered the chat, the repository or any evidence file. The account answers as Starter, annual, active, with a 90,000-character monthly allowance; Starter carries the commercial licence that Free does not.
- implemented by: HV-022-05 (the contract), then the adapter, the authorized catalogue and the casting rule in the increments that follow it.

## G15-202609301223 the decisions listed in PROGRESS.md
- raised: 2026-09-30 (PROGRESS.md, "Decisions waiting on Kevin")
- gate: G3, G4, G14, and two product calls
- resolved: 2026-09-30T12:23Z Kevin approved the build session's recommendations ("approve as recommended"):
  - **G14 / ElevenLabs key:** no action; verified on the host that `HV_ELEVENLABS_API_KEY` is set in the staging secrets file (mode 600, loaded by the workers) and the catalogue carries ElevenLabs voices valid to 2027-09-21. The live voiced proof remains, inside the $25 line.
  - **G3 music vendor:** ElevenLabs Music on the existing Starter account; no new vendor, account or key. Its own **$10 line, alerts at $3 and $7**. Kevin confirmed 2026-09-30 20:27 UTC that usage-based billing is on, with Starter's monthly credits as a backup.
  - **G3 GPT-Live-1:** deferred to Release 2's end. Still open: whether to provision an Anthropic API key for the crew.
  - **C2PA signing key:** a self-issued ES256 key generated on the staging host, mode 600, never printed or moved; public validators will show an unrecognized signer. A trust-list certificate is a Release 4 (G7) item.
  - **G4 expiry/takedown:** an additive `expired_at`; takedown columns untouched; rows the sweeper already mislabelled are flagged, not rewritten, in this migration (their correction is a separate G8-class decision).
  - **`reviewViewerId` when `sessionStorage` throws:** tell the reviewer that this browser cannot be remembered and reloads will count; the owner's copy says reloads don't count in most browsers. Stays cookie-free (ADR-0018).
  - **G4 on `.github/workflows/ci.yml`:** the push trigger ignores `docs/loop/**` and `docs/PROGRAM-EXECUTION.md`. Not `docs/**`: ten suites read `docs/evidence/**`. `pull_request` stays unfiltered so required checks never wait.

## G16-202610011400 Release 2 exit criteria, the deferred list, and the crew's model vendors
- raised: 2026-10-01 (the build session's proposal in HV-030-22, PR #341, and its answer on why the crew needs a model key)
- gate: G6-class (Release 2's definition of done) and G3 (new vendors for the crew's language model)
- detail: The crew calls a language model from the server. A Claude subscription covers Anthropic's own apps, not a server calling the API, and the operator cannot supply an Anthropic API key, so the crew has run on its deterministic stand-in. The operator holds API keys for Synthetic.new, OpenRouter, Kimi and OpenCode.
- resolved: 2026-10-01 Kevin decided:
  - **Release 2 exit criteria 1–7 are agreed** as proposed in `docs/ROADMAP.md` by HV-030-22: two films by one creator, the second pitched with the first's style card; reviewed on a second device with a timecoded comment and a stage decision; every Release 2 part exercised or deferred against a gate entry; within declared spend on every line; signed C2PA sidecars verify when the host holds the key; each step names its surface; the operator acknowledges.
  - **The deferred list is accepted:** voice meetings with the crew (GPT-Live-1, already deferred in G15); generated sound effects (no vendor approved); image and audio moderation (no configured vendor offers it); crew line notes, unless a crew model is live for the run.
  - **G3: OpenRouter and Synthetic.new are approved as the crew's language-model vendors.** Adapters are built for both. Keys are entered by the operator on the staging host, never in chat or the repository.
  - **The crew's spending limits are standard across providers:** one crew line, whichever vendor answers, with G13's alerts at $25, $100 and $200 and the stop at $1,000.
- implemented by: HV-030-22 (criteria), HV-030-24 (the OpenRouter and Synthetic crew adapters), HV-030-23 (the exit run).

## G17-202610021300 the repository goes public, to stop paying for CI
- raised: 2026-10-02 (GitHub Actions minutes: the private repo used its full 3,000 included minutes for October; CI runs about 3.5 hours per PR plus a full rerun on each merge to main, and PRs #346–#348 were cancelled at the quota)
- gate: G4-class (CI configuration) and a publication call under ADR-0020
- detail: PR #349 (Kevin's) adds `concurrency` to cancel superseded PR runs and hang guards on `quality` (300 min) and `benchmark-gate` (180 min). A full-history secret scan (gitleaks plus targeted patterns for every vendor key in use, all 1,225 commits on every branch and PR ref) found no real secrets: every hit is a test fixture, a documented example key or a file hash. Becoming public also exposes the operator's tailnet hostname in four historical commits (reachable only inside his tailnet), his commit email, the draft Terms and content policy under `docs/legal/` (marked drafts), the working name "Rough Cut", and this log.
- resolved: 2026-10-02 Kevin decided:
  - **Merge #349** (merged at 3f866d0).
  - **Make the repository public**, accepting the exposures above. The build session's token cannot change visibility; Kevin does it in the repository settings.
  - This is not a launch: ADR-0020's fail-closed rules stand. Staging stays private on the tailnet; no public DNS, branding, terms publication or live paid generation for end users. Draft legal text in a public repository is not publication of terms.
- implemented by: #349, and the visibility change in the repository settings.

## G18-202610021430 CI runs the test suite in parallel shards
- raised: 2026-10-02 (Kevin asked whether tests take the bulk of the build time; the build session showed CI's single `bun test packages test` step takes about 3 h 30 min per PR and proposed splitting it across parallel jobs, which cost nothing on a public repository after G17)
- gate: G4-class (`.github/workflows/**` is frozen without a human gate)
- resolved: 2026-10-02 Kevin approved: "proceed with the recommended fix. splitting the suite across parallel CI jobs."
  - The suite runs as four `tests` shards. Each shard is a fresh runner with the same services, env and setup as before, and runs whole test files.
  - `quality` proves the shards cover every test file exactly once, and no longer runs the suite itself.
  - Every PR still runs the complete suite. Only the layout changes, not what has to pass.
  - Optimizing production's per-access checks (HV-016-34's options 1 and 2) is not part of this approval.
- implemented by: HV-016-36.

## G6-202610030339 Release 2 acknowledged
- raised: 2026-10-03T03:39Z (the Release 2 run, HV-030-23, PR #351)
- gate: G6 (Release 2 close-out)
- detail: Release 2's run is recorded in `docs/evidence/release-2/release-run.json` and held to the criteria agreed in G16 by `test/release-2-run.test.ts`, which passes against it.
  - Film A came from a Fountain script and film B from a Final Draft file, by one creator. B was pitched with A's style card, and the crew read it.
  - Both films were reviewed on the operator's phone. Film A got changes requested, with two timecoded comments. Film B was approved, with two timecoded comments.
  - 18 of the 21 parts were exercised. Voice meetings (G15), SFX (G16) and moderation (G16) are deferred.
  - $0.33 was spent against $2 declared. Picture ran on mock. The voice line holds $14.44 of its $25.
  - Both shared films' signed C2PA sidecars verify. Their signer is the host's own key, so verifiers report it as untrusted.
  - The first pass (2026-10-01) is recorded under `stoppedAttempts`. #346, #347 and #348 fixed what it found.
- resolved: 2026-10-03T03:39Z Kevin acknowledged Release 2 ("I acknowledge Release 2").
  - His review note on film A, "Voice seems fake", was a test comment, typed to complete the review step. Kevin said on 2026-10-03 that the voices were fine. No follow-up is needed.

## G19-202610030430 Release 3's scope: a short feature, English only, no voice meetings
- raised: 2026-10-03 (the build session's cost breakdown of Release 3; a full feature is about 1,500 shots, about $525 of video at $0.35 per 5-second clip, over the $500 cap)
- gate: G1-class (spend and scope) and G3 (a vendor not added)
- resolved: 2026-10-03 Kevin decided:
  - **Release 3 is proven on a 15–20 minute feature,** about 200–240 shots, rendered live: about $70–85 of video. The exit run will declare about $120, with room for retakes, under the $450 alert. The $500 cap is unchanged. A full-length feature render stays a separate, later decision.
  - **English only.** Multi-language versions (HV-028 Localization and Dubbing) leave Release 3 and move to a later release.
  - **Voice meetings with the crew are dropped, not deferred.** Text chat with the crew is the interface. GPT-Live-1 is not added as a vendor, and `HV-030.voice-meetings` is closed.
  - Still needing his approval before any spend: a second video vendor for the hero-render chain (G3).
- implemented by: the roadmap update that follows; Release 3's exit criteria are proposed in their own increment.

## G20-202610031349 Release 3's exit criteria, the feature's film limit, its picture profile and its approvals
- raised: 2026-10-03 (HV-030-27, PR #353: Release 3's proposed exit criteria, parts and build order)
- gate: G6-class (Release 3's definition of done) and G1-class (a per-film spend limit)
- resolved: 2026-10-03 Kevin decided:
  - **Release 3's nine exit criteria and the 16-step build order in PR #353 are agreed.** Build starts with the feature format.
  - **A feature gets its own film limit of $150.** Reels and shorts stay at $40. The $500 program cap and the $450 alert don't change.
  - **The live feature uses the look-matched (anchored) picture profile,** at about $0.42 a shot: about $84–101 for 200–240 shots.
  - **Approvals:** the look is approved once for the whole feature, then the rough cut and final per sequence. That is about 21 approvals, not 30.
  - The second video vendor stays in Release 3's scope, but only after its own G3 approval, which comes with a cost proposal before it spends.
- implemented by: HV-030-27 (the criteria), then Release 3's build order.

## G21-202610041254 Release 3's paid benchmark, native camera and the second video vendor
- raised: 2026-10-04 (the Release 3 build, at step 14: HV-037-02 priced the paid benchmark pass; HV-020-01 found no fal model accepts camera control; build step 13 needs a vendor approval)
- gate: G1-class (spend) and G3 (a vendor not added)
- resolved: 2026-10-04 Kevin decided:
  - **The paid benchmark pass is approved,** at about $11. That covers Kling 2.5 Turbo Pro on the 24-shot corpus and Kling O3 reference on its 10 reference shots, inside the about-$20 benchmark line agreed in G20. Its own increment declares the spend and names both fal models. The measured results are committed under `docs/evidence/release-3/`, so quality routing (HV-019-14) has real scores.
  - **`HV-020.native-camera` is deferred to this entry.** No fal model in the pool accepts a camera-control input, so camera moves stay local crops and each one is recorded as such (HV-020-01). The native path stays built for a model that supports it.
  - **The second video vendor is deferred to a later release** (`HV-019.second-vendor` is deferred to this entry). Release 3 renders on fal only. No vendor or key is added.
  - **The run order:** after the open PRs merge, a $0 rehearsal of the whole feature runs on mock pictures (build step 15). The build session then asks Kevin before the live run (step 16, about $120 declared).
- implemented by: the paid benchmark increment (HV-037), HV-030-31 (run driver), then steps 15 and 16.

## G22-202610041528 Release 3's live run uses a referenced profile, so locked characters render from their locks
- raised: 2026-10-04 (the $0 rehearsal stopped at sequence 1: no provider on the mock profile took reference images (fixed by HV-019-16). That fix found the same gap on every live profile: FLUX Schnell stills take no references, and Kling O3 keyframes only take images with a pinned first frame, which a feature's finals don't have)
- gate: G1-class (the live run's profile and price; supersedes G20's anchored profile for the live run)
- resolved: 2026-10-04 Kevin decided:
  - **Release 3's live run uses a new referenced profile, still all fal, with no new vendor or key.**
    - Storyboard stills: FLUX.2 edit, about $0.011 each.
    - Finals: Kling O3 reference, $0.42 a 5-second shot, for shots with a locked character.
    - Shots without a locked character: Kling 2.5 Turbo Pro, $0.35.
    - The feature should cost about $85–100, inside the $120 declared and the $150 film limit. No cap changes.
  - **Each shot carries at most 4 reference images,** the vendors' limit. When two locked characters share a shot, each gets 2.
- implemented by: the referenced-profile increment (HV-019), then the rehearsal and the live run.

## G23-202610050215 Release 3's live run starts, with $135 declared
- raised: 2026-10-05 (Release 3 build step 15 is done: the strict-$0 rehearsal 4 on mock pictures made the whole feature at the front door. That was 202 shots in 10 sequences, every sequence scored, joined, titled and shared in about 20 minutes, with no spend line moving. It ran on main 91e6643, after HV-030-32, HV-019-18, HV-030-33 and HV-030-34 fixed what rehearsals 2 and 3 found. The rehearsal contract's remaining problems are the phone review (live run only), quality routing (a host setting) and the driver's interchange and VFX steps, which HV-030-35 (#377) fixes.)
- gate: G1-class (live paid generation for the release run)
- resolved: 2026-10-05 Kevin decided:
  - **Start the live run (build step 16) with $135 declared.** The feature's $150 film limit, the $500 program cap and the $450 alert don't change.
  - **The profile is G22's `live-film-referenced`, all on fal:**
    - FLUX.2 edit and FLUX Schnell stills;
    - Kling O3 reference finals for shots with a locked character;
    - Kling 2.5 Turbo Pro for the other shots.
  - **Quality routing is on**, using the benchmark results committed by HV-037-04.
  - **Voices, music and the crew** stay on their own lines (ElevenLabs voice, ElevenLabs Music, the crew's model through OpenRouter).
  - **The run stops** if the generation line's spend passes $100 before the last sequence.
- implemented by: HV-030-36 (the Release 3 run), then Kevin's review on his phone, the evidence and the G6 acknowledgement.
- amended: 2026-10-05 14:30 UTC Kevin moved the stop line from $100 to $120 of generation spend before the last sequence, nothing else changed. Mid-run, finals were averaging about $0.49 a shot, Kling O3 reference bills 7 seconds a shot ($0.588), and about $3.50 of the spend so far is booked for refused (422) attempts. That put the whole feature at about $110–115, so $100 would have stopped it just before sequence 10. The $135 declared, the $150 film limit and the $500 cap are unchanged.
