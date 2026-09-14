# Signed media access

Every media URL the API emits has the shape `/artifacts/<token>/<projectId>/<jobId>/<path>`.
The token is an HMAC-SHA256 capability from `packages/api/src/tokens.ts`, wire format
`base64url(JSON payload).base64url(MAC)`, signed with `HV_TOKEN_SECRET`, and its payload is
exactly `{kind: "artifact", projectId, jobId, exp, nonce}`. It binds one project and one job:
the route (`packages/api/src/server.ts`, the `artifacts` branch) refuses a token whose
`projectId` or `jobId` differs from the path segments with 401, so a link to one cut never
opens another cut in the same project, and a project or review token in the token position
is refused the same way. Within the job the token authorizes the whole job directory; the
per-kind file allow-lists in the route (graphic, lip-sync, dialogue, sound, editorial,
assembly and audio outputs are served only for paths the job's recorded file list names)
narrow that further for jobs that carry one. The token is honoured only as the path segment:
the same string in a `?token=` query or an `Authorization: Bearer` header on an unsigned
path is 401, and an artifact token presented as a bearer token to an API route or as a
review token is refused there (401, or 404 on `/api/jobs/:id`, which never confirms a job
exists to an unauthorised caller; 403 on `/api/reviews/:token`). Playlists work because the
relative segment URIs inside an HLS playlist resolve under the same signed prefix. There is
no query string and no cookie (FR-053). The signed prefix is re-minted with a fresh nonce on
every job, project or review read; the `exp` stays the same for the life of the link.

## Lifetimes and the mint clamp

Artifact links live until `min(job.linkExpiresAt, project.deleteAfter)`, computed by
`artifactLinkExpiry` in `server.ts`, where `linkExpiresAt` is set by the worker at completion
to `completedAt + DOWNLOAD_LINK_TTL_MS` (30 days, `packages/queue/src/index.ts`) and
`deleteAfter` is the project's retention date. `mintArtifactToken(projectId, jobId, expiresAt,
now)` refuses an `expiresAt` that is not a safe integer and signs
`exp = min(expiresAt, now + ARTIFACT_TOKEN_TTL_MS)`; `ARTIFACT_TOKEN_TTL_MS` is exported from
`tokens.ts` and asserted equal to `DOWNLOAD_LINK_TTL_MS` by `packages/api/test/tokens.test.ts`.
Every present caller already passes the retention-capped value, so the clamp changes no
user-visible expiry; it bounds future callers and clock drift. The other capability lifetimes
for reference: project (owner) tokens 72 hours, review links 7 days and at most three views,
operator diagnostics tokens 15 minutes, operator capacity grants 24 hours by default with no
lifetime bound at mint. The job view reports the link's end as `artifactUrlsExpireAt` and
`artifactUrlsExpireInSeconds`.

## Expiry boundary and the two-stage check

A token is expired when `exp <= now`: at `T - 1 ms` it is served, at `T` it is 401. This is the
boundary `verifyActorToken` and `verifyDiagnosticsToken` already used, and the route's own
`deleteAfter <= Date.now()` rule. A request passes two checks in order. First the token: MAC,
shape, kind and binding, answered with 401 `{"error":"unauthorized"}` when any fails. Then the
project: it must exist, not be taken down, and `deleteAfter` must still be in the future,
answered with 404 `{"error":"not found"}` otherwise. A token still inside its own `exp` is
therefore refused with 404 the instant the project's retention date passes, even though the
signature verifies.

## Clock rule

The verifying host's clock is authoritative and there is no skew allowance. A verifier whose
clock runs ahead shortens links; it can never lengthen one. `linkExpiresAt` originates from the
worker's clock at completion, so drift between the worker and the API host moves a link's end
by the size of the drift, but the mint clamp means no link ends later than 30 days from the
API host's own clock at the time the URL was minted. On private staging the API and its worker
slots run on the same host and read the same clock.

## Verifier strictness

`verifyToken` rejects, before computing any MAC, a token longer than 1024 characters or one
that does not match `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$`. The MAC is compared with
`timingSafeEqual`. After the MAC check it rejects a payload that is not a JSON object, an `exp`
that is not a safe integer (a MAC-valid `{"exp":"tomorrow"}` or a payload without `exp` used
to verify forever, because `NaN < now` is false), a key set other than exactly
`exp,kind,nonce,projectId` for a project token, `exp,kind,nonce,permission,projectId` with
`permission` in `{read, approve}` for a review token, or `exp,jobId,kind,nonce,projectId` for an
artifact token, a `projectId` or `jobId` that is not a non-empty string of at most 128
characters, or a `nonce` that is not a non-empty string of at most 64 characters. Operator
grants (`verifyOperatorGrant`, separate secret) keep their own key set and gain only the
generic length, format, object and integer checks. The verifier never throws on input. Tokens
minted by `mintProjectToken`, `mintReviewToken`, `mintArtifactToken` and `mintOperatorGrant`
already satisfy every rule, so tokens live in private staging keep verifying; the wire format
and `HV_TOKEN_SECRET` are unchanged. `packages/api/test/tokens.test.ts` signs each malformed
payload with the test secret and asserts `null`.

## Path validation and the 404 rule

Immediately after the token check the route validates the raw path after the token segment,
`<projectId>/<jobId>/<path>`, with `artifactKey` from `packages/storage/src/artifacts.ts`: at
most 1024 characters, only `A-Za-z0-9._/-`, no empty, `.` or `..` segment, and the
`<projectId>/<jobId>/` prefix. Failure answers 404 `{"error":"not found"}` in local and S3
mode alike; the S3 branch used to surface the `artifactKey` throw through the generic catch
as 400 `{"error":"invalid artifact path"}`. Because the check reads the raw path rather than
the filtered route parts, an empty segment (`//export.mp4`, a trailing `/`) is refused instead
of being collapsed. Percent-encoded separators (`..%2F..%2Fjobs.json`, `%5C`) are never
decoded and fail the character class. Bun's URL parser normalises `.`, `..` and `%2e%2e`
segments, and reads `\` as `/`, before the request reaches the handler, so a dot segment
directly under the job resolves to a path outside the job and the binding check refuses it
with 401, while a dot segment deeper in the path stays inside the job and reaches the path
rule and the file lookup; no such request serves a file. The local branch additionally
resolves the path under the job directory and refuses anything that escapes it.

## Backend behaviour

With `HV_ARTIFACT_STORAGE=s3` the route hands the validated key to
`PostgresArtifactStore.response`, which looks the key up in `hv_artifacts` scoped to the
project and job, honours a single `Range` (206 with `content-range`, 416 with
`content-range: bytes */<size>` for an unsatisfiable range), answers `HEAD` with the same
headers and no body, and sets `accept-ranges: bytes`, `content-length`, `etag` (the recorded
SHA-256), `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and
`cache-control: private, no-store`. The object is streamed from the private bucket through the
API; the bucket blocks public access and answers an anonymous object GET with 403. In local
mode the route serves the whole file from the artifact root with `content-type` from the
extension, `cache-control: private, no-store` and `referrer-policy: no-referrer`; range
requests are not supported on the local backend. `POST`, `PUT` and `DELETE` on a signed URL
match no route and answer 404 without touching the file. Telemetry records only the route
template `/artifacts/:token/:projectId/:jobId/:file` (`packages/observability/src/index.ts`),
never a token or a path. Artifact requests are budgeted by the `artifacts` rate limit
(`HV_RATE_LIMIT_ARTIFACTS_PER_MINUTE`, default 600 per address per minute), separately from
the API limit.

## Revocation levers and the review-link limit

Three levers revoke media access. Project takedown: `ProjectService.takedown` is visible on
the next request because the route reloads project state per request (`peekProject`,
`isTakenDown`), so a signed URL that served 200 answers 404 immediately afterwards; the
PostgreSQL service does the same through the database, and the S3 lane's takedown assertion
in `packages/storage/test/artifacts.test.ts` covers it. Project retention: once `deleteAfter`
passes every link to the project is 404, and the sweeper removes the objects
(`docs/STORAGE-RETENTION.md`). `HV_TOKEN_SECRET` rotation: every token signed with the old
secret stops verifying at once; rotation with overlap is out of scope for this increment
(gate G8). The limit to state honestly: revoking a review link, or exhausting its three
views, does not invalidate artifact URLs already fetched through it. The artifact token does
not carry the link identity, so such URLs live until their `exp` or until one of the three
levers above fires. Binding artifact tokens to the review link they were fetched through needs
a versioned payload and a lookup per media request and is proposed as a later increment.

## Why not presigned object URLs

A presigned S3 URL is bound to a key pair, not to project state: it cannot be refused after a
takedown or after retention passes, and it cannot be revoked short of rotating the storage
credentials. ADR-0018 requires revocable capability tokens rather than account-bound access,
so media passes through the capability-authorised API, which checks project state on every
request. No presigned URL is issued anywhere: `grep -rn presign packages scripts` is empty, and
the contract test asserts that every `*Url` field in a job view, a project listing and a
review view matches `^/artifacts/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/<projectId>/<jobId>/` and
contains no `X-Amz-` parameter. CDN delivery and regional placement stay out of scope (vendor,
gate G3); nothing may cache a signed URL in a shared cache, which `private, no-store` states.

## Evidence

`docs/evidence/hv040-storage/signed-media-access.json` (schema `hv-signed-media-access/1`) is
written only by a real run of
`HV_SIGNED_MEDIA_EVIDENCE=docs/evidence/hv040-storage/signed-media-access.json bun test packages/api/test/signed-media-access.test.ts`
and records every observed row of the offline matrix, the token lifetimes, the verifier
rejections and the boundary results. Its `s3Lane` section is `pending`, with the lane command,
until `packages/storage/test/artifacts.test.ts` has run against a real PostgreSQL and object
store with `HV_SIGNED_MEDIA_S3_LANE` naming a result file that a re-run of the offline suite
then merges. The existing cross-job, cross-project and tampered-signature cases stay in
`packages/api/test/server.test.ts` and are not duplicated.
