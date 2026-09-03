# HV-000 Round-7 Remediation Post-Flight

- Date: 2026-09-03
- Branch: `factory/ZOU-1566-hv-000-a1-mtfzfmst`
- Supersedes: `evaluations/hv000-round6-remediation-postflight-2026-09-01.md`
- Trigger: `hold` from the ZOU-1566 round-7 persona diversity review of head `54516af3` (four reviewers ran, all `fail`)

## Executive summary

Round 7 raised no round-6 finding again. It rejected the branch on a new
set. The operator scoped remediation to the six findings that are defects in
the vertical slice as specified; the remaining items (rights re-attestation
on edit, revocation and prior-version routes, project-file locking, per-frame
provenance, monthly-versus-hard budget ordering, proxy-log hygiene) were
judged out of the slice's scope and are carried as backlog. All six scoped
findings are closed here.

The round-7 "flaky evidence" item turned out to be the most serious finding
of the round: the untrusted-client-certificate test was intermittent because
the server intermittently served the rogue client. That is a real
authentication bypass, closed here at the transport layer.

The round-8 work was first implemented on 2026-09-01 and lost to a sandbox
restart before it was committed; it was reconstructed on 2026-09-03 from the
surviving `r8/*` branches and the implementing agent's transcript, then
integrated as one descendant commit of `54516af3`.

## Findings and remediation

| # | Reviewer finding (reviewers) | Root cause | Fix | Evidence |
|---|---|---|---|---|
| 1 | Untrusted-client-certificate test is flaky: 127 pass / 1 fail, then green on rerun (2 of 4) | Not flakiness. `Bun.serve` with `requestCert` and `rejectUnauthorized` completes the handshake and closes the socket afterwards for a rejected chain. Under TLS 1.3 the client's first request travels in the same flight as its Finished message, so the request races the close: measured 19 of 80 rogue connections served serially and 80 of 80 in parallel; 0 of 80 under TLS 1.2. Bun PR #33755 fixes `Bun.listen` only. | The API keeps `Bun.serve` on a plaintext loopback listener and fronts it with a `Bun.listen` TLS acceptor. The acceptor verifies the peer in the `handshake` callback (checking `success`, `authorizationError`, and `socket.authorized`, because Bun 1.3.x reports success for a rejected chain and only sets the error) and opens the loopback relay only for a trusted chain. Bytes received before the verdict are held (64 KB cap) and discarded on rejection. The public `ApiServer` interface hides the pair; `stop` closes both. | `mtls.test.ts` "a client certificate from an untrusted CA is refused on every connection" (20 consecutive rogue connections, independent curl client); "a trusted client round-trips a body larger than one socket buffer" (relay back-pressure). Suite run 20 times consecutively: 20 of 20 green, 9 tests each |
| 2 | API and proxy mount the whole certificate directory, exposing the CA signing key and both service private keys (2 of 4). Round-8 refutation added: `COPY . .` with no `.dockerignore` bakes `infra/mtls/certs/` including `ca/ca.key` into the api, worker, and sweeper images; the compose guard was substring-based; `gen-certs.sh` left legacy flat keys behind | One directory held every role's material and was mounted whole; the build context was unrestricted. | `gen-certs.sh` writes a per-role layout (`ca/`, `api/`, `frontend/`), copies `ca.crt` into each role, removes any legacy flat-layout file, and sets `ca/` to mode 700. Compose bind-mounts each container exactly its own certificate, key, and `ca.crt`; `ca.key` is mounted nowhere. A `.dockerignore` excludes `infra/mtls/certs` and every `*.key`, `*.pem`, `*.p12` from every image. The api health probe moved to the proxy so the api container is not handed a copy of the proxy's client identity. CI runs each image with `find` for key material, asserts the exact mount listing of each container (`api.crt api.key ca.crt` / `ca.crt frontend.crt frontend.key`), and asserts `ca.key` is absent from both. | `mtls.test.ts` "mTLS material is mounted least-privilege and never built into an image": gen-certs layout, legacy cleanup, compose binds each container only its own identity and never `ca.key`, build context excludes the certificate tree and every private key. CI `quality` job image and mount probes |
| 3 | nginx preserves attacker-supplied `X-Forwarded-For` and the API trusts its first value (1 of 4) | `$proxy_add_x_forwarded_for` appends to whatever the client sent, and the limiter read element zero. | nginx sets `X-Forwarded-For` to `$remote_addr`. With `HV_TRUST_PROXY=1` the limiter keys on the last element (the hop the trusted proxy appended), tolerates blank trailing elements, and falls back to the socket peer when the header is absent; without it, the header is ignored entirely. | `server.test.ts` "client address resolution honours only the trusted proxy's hop" (four cases) and "a trusted proxy deployment cannot be bypassed with forged X-Forwarded-For prefixes" (a fresh forged prefix per request still exhausts one bucket) |
| 4 | Expired-lease workers can still checkpoint, charge, or complete jobs after reassignment (1 of 4, AC-024) | Mutations were keyed by job id alone. | Every running-job mutation (checkpoint, heartbeat, charge, complete, fail) resolves the job through a `holder` check: status `running`, `claimedBy` equals the caller, lease unexpired. Any other caller gets a `LeaseError` (`not_running`, `wrong_worker`, `lease_expired`) before a field is written. A claim without a worker id binds the job to a generated holder. The worker catches `LeaseError` and abandons the job without charging. | `queue.test.ts` "running-job mutations are bound to the lease holder": reassigned worker refused on all five mutations, current holder permitted, lapsed holder refused before reclaim, non-running job immutable, generated holder. The worker path is covered by the store tests; there is no worker-level stale-lease test yet (carried as a note) |
| 5 | Client idempotency keys are global, enabling cross-project job-metadata exposure and enqueue denial (1 of 4) | The key was looked up without a project qualifier. | Keys are stored and looked up as `(projectId, key)` and validated against `^[\x21-\x7e]{1,128}$`. | `server.test.ts` "idempotency keys are scoped per project": same key in two projects yields two jobs and neither project can read the other's; repeated key within one project returns the same job; malformed key rejected. `queue.test.ts` scope test |
| 6 | Safety filter checks only action-derived prompts; dialogue and named real persons bypass it; refusals become retried failed jobs (2 of 4, FR-054, V-006, AC-009) | `checkShot` saw the rendered action prompt; the worker treated a `SafetyRefusal` like any provider error. | `shotText` concatenates every prompt-bearing field (action, dialogue lines, character cues) and `checkShot` gates the whole. A refusal, from the gate or from a provider-level `SafetyRefusal`, calls `refuse()`, which marks the job `failed` with `failureKind: policy_refusal`, releases the lease, and consumes no retry; the job is never re-claimable and `GET /api/jobs/:id` reports the refusal message. | `safety.test.ts` "every prompt-bearing field is gated" (benign passes; dialogue-only violation and dialogue-only real person refused); `queue.test.ts` "content-policy refusal is terminal and never retried"; `worker.test.ts` dialogue-only, real-person-in-cue, and provider-refusal cases; `server.test.ts` refusal surfaces as a terminal job outcome |

## Verification

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx oxlint packages scripts test` | clean |
| `bun test packages test` (three consecutive runs) | **162 pass, 0 fail** each run (was 128) |
| `bun test packages/api/test/mtls.test.ts` (twenty consecutive runs) | 20 of 20 green, 9 pass each |
| `bun run build` | api 56.71 KB, worker 43.1 KB |
| `bun run smoke:runtime` | healthy; 22 responses checked; signed artifact URLs; stale animatic approval refused; restart survives |
| `bun run benchmark:compare` (same-host interleaved A/B against `54516af3`, two rounds) | pass at 5%: `perShotLatencyMsMin` 226.35 → 228.18 ms (+0.8%), `totalPipelineMs` 5870.01 → 5858.72 ms (−0.2%); deterministic metrics unchanged |

Bun stays on 1.3 (`oven/bun:1.3`, `bun-types` 1.3.12). The lost 2026-09-01
implementation had bumped to 1.4 while chasing the handshake race; the
`Bun.listen` front closes the race on 1.3.12 without it.

## Not verified here

Docker Compose staging still cannot run in this sandbox. The CI `quality`
job builds the images, generates the per-role certificates, proves the
proxied path, the closed host port, the certificate-less refusal, the
key-free images, and the least-privilege mounts.

## Carried as backlog (out of the vertical slice, per operator scope)

Rights re-attestation after screenplay edits; API and UI routes for
review-link revocation and prior-version regeneration; interprocess locking
on project, cost-ledger, and review-queue files; per-frame and per-shot
provenance beyond the sidecar manifest; monthly budget control ordered
under the hard cap; artifact bearer credentials in reverse-proxy logs.
