# HV-000 Round-5 Remediation Post-Flight

- Date: 2026-09-01
- Branch: `factory/ZOU-1566-hv-000-a1-mtfzfmst`
- Supersedes: `evaluations/hv000-round4-remediation-postflight-2026-08-31.md`
- Trigger: unanimous 4/4 `fail` from the ZOU-1566 round-5 persona diversity review, bound to head `7534454e`

## Executive summary

Round 5 was the first round in which the review gate worked end to end, and it
rejected the branch on five product findings rather than on infrastructure. All
five are closed here. Two of them (the approval bypass and the cookie) were
design errors in the round-4 remediation itself, not regressions, so this
round replaces those designs rather than patching them.

## Findings and remediation

| # | Reviewer finding (reviewers) | Root cause | Fix | Evidence |
|---|---|---|---|---|
| 1 | Animatic approval gate is bypassable: edit the screenplay after the animatic renders, approve the stale animatic, final generation is accepted (3 of 4) | The approval recorded the project's *current* screenplay version at approval time, not the version the animatic was rendered from. Jobs did not record a version at all, so nothing could tie an animatic to the text it visualised. | Every job records `scriptVersion` at enqueue. `POST /animatic/decision` binds the approval to the animatic job's version and refuses with 409 (reporting both versions) if the screenplay has been edited since that animatic rendered. A `final` job is refused unless its animatic exists in the same project, is approved, and both the animatic and the approval are at the current version. The worker re-checks that the animatic exists, is finished, and matches the final job's version before generating. | `server.test.ts` "an animatic rendered from an older screenplay cannot be approved after an edit", "an approval recorded before an edit does not carry over", "a final job cannot name an animatic from another project"; `worker.test.ts` stale-version and orphan-animatic cases; smoke asserts 409 on the stale approval and refuses the stale final |
| 2 | Anonymous project URLs omit the signed token; refresh or resume cannot authorise the 72-hour journey (3 of 4) | `projectUrl` was `/?project=<id>` and the token lived only in page memory. | The project URL is `<origin>/#/p/<token>` (FR-007: "a signed, expiring token embedded in a URL"). The fragment never reaches a server log and is not a query string. New `GET /api/projects/:id` returns the screenplay, version, attestation, approvals, and jobs, and the frontend resumes from the fragment: it restores the editor, and re-attaches to a running job, a pending animatic decision, or the finished export. Review links moved to `/#/review/<token>` for the same reason. | `server.test.ts` "anonymous access is a signed URL, not a cookie" (URL shape, resume, 401 without the token or with another project's token); smoke `projectResume: "reachable"` |
| 3 | Artifact playback sets a cookie, violating the no-cookie constraint (2 of 4) | Round 4 introduced an `hv_artifact` HttpOnly cookie so that relative HLS segment URIs would carry authorisation. FR-053 and the build spec say "no cookies" and "signed URLs for artifact access". | Artifact URLs are signed: `/artifacts/<signature>/<project>/<job>/...`, where the signature is a one-hour, project-bound token minted into every job or review response. Relative segment URIs resolve under the same prefix, so segments authenticate like the playlist with no cookie and no query string. The cookie, the artifact-session endpoint, `credentials: "include"`, and `Access-Control-Allow-Credentials` are gone; artifact responses carry `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`. | `server.test.ts` "artifact access is by signed URL only" (signed shape, segment resolution, unsigned/tampered/wrong-project/project-token rejection, path escape); "no response in the creator journey sets a cookie"; smoke checks every one of its 22 responses for `Set-Cookie` and reports `cookiesSet: 0` |
| 4 | Benchmark regression gate is red: normalized latency +106%, +108.7%, +185.8% against a 35% limit (3 of 4) | The round-4 design divided per-shot latency by a CPU calibration probe. Per-shot latency here is dominated by spawning ffmpeg, which does not scale with hashing speed: on this host the candidate's per-shot floor matched the baseline's to within 1 ms while the calibration differed by 45%, so the "normalized" figure moved 44% on identical code. No cross-host latency figure, raw or normalized, can separate a code regression from a different machine. | Latency is gated at 5% (AC-002) as an interleaved same-host A/B: `benchmark:compare` checks the merge base out into a temporary worktree and runs base and candidate alternately on the same host, comparing the noise floor of `perShotLatencyMsMin` and `totalPipelineMs` across rounds. Deterministic metrics still gate at 5% against the committed baseline; the baseline's latency fields are a record of the recording host and print as advisories. CI passes the pull-request base SHA and runs the gate on every PR and push. The previous `benchmark-gate` job had also been skipping silently: its change detector ran `git diff` against a base SHA that a shallow checkout did not have. | Two-round A/B of this tree against `7534454e` on this host: `perShotLatencyMsMin` 256.62 → 256.18 ms (−0.2%), `totalPipelineMs` 6296.63 → 6323.45 ms (+0.4%), pass at 5%. `benchmark.test.ts` covers the A/B gate, the noise-floor rule, the missing-base and missing-field cases, and base-commit resolution |
| 5 | `bun run benchmark:compare` crashes with `ERR_INVALID_ARG_TYPE` when invoked as documented (1 of 4) | The script required two positional file paths and read `undefined` otherwise. | Without arguments the script runs the full gate described above. Two arguments still compare recorded files on the deterministic lane. Any other shape prints usage and exits 2. | `benchmark.test.ts` "benchmark:compare command line" spawns all three forms |

## Verification

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx oxlint packages scripts test` | clean |
| `bun test packages test` | **97 pass, 0 fail** (was 76) |
| `bun run build` | api 40.38 KB, worker 31.44 KB |
| `bun run smoke:runtime` | `cookiesSet: 0` over 22 responses, `artifacts: "signed-url"`, `hlsSegments: "reachable"`, `staleAnimaticApproval: "refused"`, `projectResume: "reachable"`, `reviewLink: "playable"`, `restartSurvives: true` |
| `bun run benchmark:compare` (no arguments, `HV_BENCHMARK_BASE_REF=HEAD`, 2 rounds) | pass: latency −0.2% / +0.4% against `7534454e` on the same host |
| `git diff --check <base> HEAD` | clean |

## Not verified here

- **Docker Compose** — no daemon in this sandbox. The CI `quality` job builds
  and smokes the compose stack through the nginx origin; the nginx config is
  unchanged apart from its comment.
- **Real provider economics** and **TTS** — unchanged from the round-4
  post-flight: mock provider, `costPerShotUsd` 0, silent-audio plus captions.
- **Public deployment** — unchanged: fail-closed behind the ADR-0020 human
  launch gates.
