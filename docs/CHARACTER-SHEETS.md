# Generated character sheets

HV-017 now includes a private character-sheet workflow. Save an original fictional
character, open **Generate character sheets**, choose a recipe, seed and permitted
scene scope, and submit. The saved screenplay and rights attestation are required.

| Recipe | Views |
| --- | --- |
| Turnaround | Front, side, back, three-quarter |
| Expressions | Neutral, joy, sadness, anger, surprise, concern |
| Wardrobe | Default costume plus scene overrides, optionally one selected scene |
| Lighting | Soft daylight, warm side light, cool rim light, low-key light |
| Adult age variants | Young adult, middle adult, older adult |

Views are 512-square stills. A labeled contact sheet is composed without another
inference request. Per-view MP4/HLS previews are static and silent; narration,
captions and inter-view continuity repair are disabled for this stage. Each view
uses the chosen seed and pinned cast references. Vendor seed behavior remains
best effort. Age studies intentionally vary adult age while retaining other
character direction; users must review whether the provider followed it.

The gallery lists the latest ten sheets for that character and polls only while
open with unfinished jobs. Refresh preserves review selections. Select one to
four views, explicitly attest their permitted use, and choose whether to append
or replace the reference set. Adoption verifies the source bytes against their
recorded SHA-256, normalizes the images through the existing reference intake,
and saves one cast revision for the whole batch. Historical reference bytes remain
in the project catalog. Restore through cast history resets permission to pending.
The existing four-reference and 96-historical-image limits apply.

## API and execution

Owner-only routes:

- `GET /api/projects/:project/cast/:character/sheets` lists recent sheet jobs.
- `POST` to that path accepts `expectedVersion`, `generationApproved: true`,
  optional `idempotencyKey` and `settings: {kind, seed, sceneNumber}`. Use `null`
  for project scope or an actual scene number. Custom prompts are not accepted.
- `POST /api/projects/:project/cast/:character/sheets/:job/adopt` accepts
  `expectedVersion`, `attested: true`, `viewIds` and optional `replaceExisting`.

Jobs use stage `character-sheet`, a hashed fixed recipe, the admitted cast and
provider plan, and the existing queue leases, cost accounting and dispatch records.
Every view rechecks current permission. A project-wide sheet requires project-wide
permission throughout generation. Changed cast or screenplay versions prevent
adoption; permission expiry is also rechecked during the atomic cast update.
Failed batch processing may leave private unindexed bytes for the existing orphan
collector, but cannot partially update the cast. JSON mode retains its documented
local-development concurrency limits; PostgreSQL commits under the project lock.

Sheets cannot serve as a film preview approval or unlock final generation. They
are excluded from the reviewer cut and the editor's resumed film selection.
Their signed download URLs remain bound to their own job and project retention.
Provenance includes the recipe, seed, cast, provider routes, sheet checksum and
per-view checksums. Adopted assets record their source job, view and cast revision.
Archives and storage backups preserve these metadata and media. Missing sheet
exports are refused during restore just like missing film exports.

## Configuration and rollout

`HV_CHARACTER_SHEET_PROVIDER_POOL` defaults to `["mock"]`. Reference-conditioned
sheets need an explicitly configured reference-capable image adapter, such as
`["mock","image:fal:flux-2-edit"]`; the mock is ineligible when references exist.
Existing film pools are unchanged. `HV_CHARACTER_SHEET_COST_CAP_USD` defaults to
5 for the entire sheet and is divided into per-view caps. Monthly limits and tier
limits still apply (24 views free, 60 elevated). Large wardrobe studies must use
a selected scene when they exceed capacity. Rates are configured estimates, not
invoice reconciliation. No paid inference was used to validate this change.

Migration `0006_character_sheets.sql` expands the job-stage check constraint.
Drain workers, back up state/media, apply migration and start matching API/worker
releases together. Older releases do not understand sheet jobs or derived reference
metadata. Downgrading after this feature has written state requires a compatible
release or a deliberate restore of the pre-feature database and media snapshot;
that restore loses subsequent work. Do not remove new records to force a rollback.
This release has not been deployed to Zo.

## Evidence and limits

Tests cover five fixed recipes, wardrobe/scene binding, permission scopes/expiry,
revocation between views, owner isolation, film-approval separation, actual ffmpeg
sheet assembly, exact closed FLUX.2 request bodies, corruption before batch commit,
stale screenplay adoption, snapshot validation and atomic reference history.
PostgreSQL/S3 CI also exercises competing batch writes and a real generated-sheet
archive round trip to an isolated database and bucket.

Browser checks use local synthetic fixtures: four-view turnaround, review selection
persistence, adoption as one revision, a reference-conditioned single-view wardrobe
sheet, replacement and a 390-by-844 mobile viewport. These are workflow checks,
not visual identity evaluation. Fixed prompts and references do not guarantee correct
views or consistent identity. Embeddings, digital-actor contracts, reusable cast
libraries, extras, voice identity and the eight-shot visual evaluation remain open.
The known semantic/likeness and image moderation gaps in CASTING.md remain launch
requirements. This feature does not satisfy those requirements.
