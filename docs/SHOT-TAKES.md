# Shot take comparison

HV-020 adds two or three alternatives of one saved source shot. Each has a label,
an independent seed and a complete normalized direction record. The plan pins the
screenplay version, source hash, cast revision, base direction revision and 24/60
shot planning limit. Rendering a group does not change the film direction.

## Creator workflow

Open **Save screenplay and direct shots**, then **Compare takes** on a source shot.
Adjust A/B/C labels, seeds, focal lengths, fixed durations and storyboard moves.
Other direction settings, including private frame anchors, inherit from the saved
shot. The API accepts every supported direction setting independently for each take.
Review the estimate and group/per-take retry caps before generation.

Preview and final groups have separate jobs and exports. Final generation requires
approval of the exact preview plan against the current screenplay, cast and base
direction. A take preview cannot approve a full-film final render or replace the
cut shown by a shared film review link.

The viewer uses the longest take's media clock, corrects drift exceeding one frame
at 30 fps and pauses all takes while an active clip buffers. Shared seeking and
frame stepping pause playback. Shorter alternatives hold their last frame. Audio
is off initially; enabling it plays only the selected take. On narrow screens the
selected take is visible while the others still follow the comparison clock.
This is browser media synchronization, not a frame-accurate editorial timeline.

Adoption explicitly copies the selected direction and seed to its original shot,
preserving other shot directions and creating a new direction version. The creator
can choose another take from the same group later if its source/cast and retained
base direction are still valid. Optimistic version checks refuse concurrent edits.
The film then needs a new full-film preview and approval. Adoption chooses settings;
it does not splice the rendered take's bytes into an existing film, and a seed does
not guarantee deterministic output from a remote model.

Unsaved take fields survive group refresh and shot-plan reload in the open page.
A full browser reload loses unsaved take fields; submitted groups remain in the
project. The UI lists the most recent 20 groups for the selected source shot.

## Private API

All routes use the owner project bearer token:

| Route | Purpose |
| --- | --- |
| `GET /api/projects/:id/takes?shotId=...` | Current context and up to 20 groups with signed per-take media links |
| `POST /api/projects/:id/takes/quote` | Read-only provider estimate and plan; no job or reservation |
| `POST /api/projects/:id/takes` | Admit `take-preview` or `take-final` |
| `POST /api/projects/:id/takes/:jobId/decision` | Approve or request changes on a finished take preview |
| `POST /api/projects/:id/takes/:jobId/adopt` | Adopt `takeId` using expected direction/script versions |

Quotes/submissions carry `expectedScriptVersion`, `expectedCastingVersion`,
`expectedDirectionVersion`, `stage`, and `settings` with `shotId`, `sourceHash`,
`takes: [{label, seed, settings}]`. Generation also requires rights attestation and
`generationApproved: true`. The UI sends the quoted `providerPlanRevision` to
reject provider configuration drift. A final submission adds `animaticJobId` for
its approved take preview. Reusing an idempotency key for another take plan or
stage is refused. The ordinary film submission endpoint rejects take stage names.

## Media, costs and recovery

Each take exports an H.264/AAC MP4, HLS playlist/segments, captions, poster and
provenance with its source, settings, requested/actual timing, seed, MP4 checksum,
render mode and recorded provider costs including retries. The group manifest
binds these exports to the saved take plan. Synthetic fixtures, generated video,
previews and supplied-image storyboards are disclosed separately. Native frame
anchor dispatch and storyboard fallback retain the contracts in FRAME-ANCHORS.md.

The generic job output points at the first take for storage compatibility; film
review and resume logic select only film stages. Group rendering bypasses continuity
repair between alternatives because each represents the same source shot. Completed
raw clips checkpoint independently; replacement workers reuse them and may reencode
exports. S3/cache restore and archive import require every take's declared files and
verify each MP4 against its saved checksum. Historical archive validation preserves
expired cast context without treating it as fresh permission for generation.

## Rollout and evidence

Migration `0007_shot_takes` extends the PostgreSQL job-stage constraint. Deploy the
API, worker and frontend together. Older workers do not understand these stages;
drain workers before replacing them. Rollback to an older runtime requires keeping
take records and media in a verified compatible backup and preventing older workers
from claiming take jobs. Do not narrow the database constraint while take rows exist.

Local fixtures verify source/version gates, separate film approvals, owner isolation,
playable independent outputs, adoption, corrupt snapshot refusal and interrupted
checkpoint resume. PostgreSQL CI covers native anchor dispatch with closed synthetic
HTTP responses, independent bills, approval gates and concurrent adoption. Archive
CI restores each take's files and refuses missing media and checksum discrepancies.
These fixtures do not measure paid model quality. Zo rollout and live Linear status
remain pending; the full AAA studio program is not complete.
