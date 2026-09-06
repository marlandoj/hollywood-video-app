# Shot direction

HV-020 now has a private, versioned editor for timing, still-image motion and creative camera, lighting, blocking and performance instructions. Open **Save screenplay and direct shots**, choose a shot, save its direction, then generate and approve a new preview. Automatic settings preserve existing generation behavior. The browser uses the free 24-shot plan; owner API clients can request `maxShots=60` for the operator plan. Editing directions does not grant operator access or change rendering limits.

## Behavior and limits

- Fixed durations use integer frames, 30–900 at 30 fps (1–30 seconds). The editor accepts seconds and rounds to the nearest frame. The preview uses exactly that frame count. If temporary speech plus its existing 0.3-second pad does not fit, generation cancels before requesting an image, stops fallback/retries and releases the unspent hold. Automatic duration can still grow for speech.
- Storyboard movement is deterministic motion over a still: static, push in, pull out, pan left or pan right. It is a required preview capability. Final video receives the separate creative movement instruction; still-image motion is not falsely advertised as native video camera control.
- Shot size, camera angle/height, lens type/focal length, movement/speed, screen direction, blocking, eyelines, performance, lighting sources, temperature, contrast and time of day become labeled generation instructions. Sound and transition notes remain intent in the prompt and manifest; they do not produce a mix or edit transition. Text passes the existing content gate.
- Each entry binds to the exact original action, scene grouping and dialogue of its shot. A changed heading, action, dialogue, grouping or missing shot requires explicit review/save against the fresh source, or removal. Unrelated source edits can retain matching directions. The editor preserves an unsaved draft across plan reloads, including when its shot disappears, and exposes the previous source for review.
- Changes invalidate earlier preview approvals and final admission. Accepted jobs retain their immutable direction snapshot. History restore creates a new version without silently rebinding old sources. Up to 60 entries and the latest 100 revisions are retained.

This slice does not implement a physical lens/viewfinder simulator, coverage/180-degree validation, camera path keyframes, take comparison, reusable camera presets or selective regeneration. Creative prompts alone do not establish optical accuracy, temporal continuity, identity quality or completion of the cinematography epic.

## Owner API and persistence

`GET /api/projects/:projectId/direction?maxShots=24` returns the current direction snapshot, screenplay version, source plan/hashes, defaults, choices, stale shot IDs and history summaries. Responses require the private project token and use `private, no-store`; review links cannot edit or read this source data.

`PUT /api/projects/:projectId/direction/:shotId` accepts `settings`, `expectedVersion`, `expectedScriptVersion`, `sourceHash` and optional `maxShots` (24 or 60). `POST .../:shotId/remove` accepts `expectedVersion`. `POST .../restore` accepts `version` and `expectedVersion`; version 0 resets to automatic. Stale writes return 409. Numeric ranges, enums, text limits and canonical source/revision hashes are validated centrally.

Project JSON stores `directionHistory`; jobs and provenance store the admitted `hv-direction/1` snapshot. PostgreSQL saves, admission and approval recheck current versions under the project row lock. JSON admission rechecks after the budget reservation before synchronous enqueue. Public job responses expose the direction version/revision, not the raw source snapshot. Export manifests include per-shot requested and actual duration and saved settings. Database backups and portable project archives retain direction history and immutable job snapshots; archive validation rejects invalid or mismatched source records.

No SQL migration is needed. Deploy API, workers and frontend together: older releases do not understand these optional project/job fields or fixed-duration semantics. Preserve a current storage snapshot before rollback and use a version that understands direction state to resume directed jobs.

## Verification

Planner/API tests exercise source drift, concurrent version conflicts, owner isolation, approval invalidation, capability refusal and fixed duration through preview/final generation. Closed FLUX.2/Kling O3 fixtures verify camera/lighting prompt delivery with private reference bytes; no paid provider inference occurs. A decoded-frame test verifies opposite pan endpoints and exactly 121 frames. PostgreSQL tests cover non-bypass RLS, concurrent saves, stale admission/approval and paid-hold release before image dispatch. Backup/archive tests restore direction history, active-job snapshots and a completed directed preview from durable S3 into an isolated database and cache.

Local browser checks cover all fields, fractional duration round-trip, source review, lost-shot draft recovery, history restore/refusal, new-preview enforcement, mobile layout and final export. Linux CI supplies PostgreSQL, S3 and espeak for integration verification. Live Zo deployment and actual paid cinematography evaluation remain pending local-only operation.
