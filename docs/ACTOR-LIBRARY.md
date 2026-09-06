# Private actor library and explicit sharing

Each anonymous project keeps its own cast collection. Owners can share one saved
fictional actor revision and copy a reviewed share into another project. There is no
global directory, account requirement or synchronized actor record. This is one part
of HV-017 and does not complete the identity epic.

## Creator flow

Open **Save screenplay and edit cast**, then **Share actor across projects** on a
saved actor with current project-wide permission. Review its directions and images,
confirm permission to share them for copying, and create the link. It lasts at most
seven days, bounded by source permission expiry and project retention. Anyone with
it can view and copy that actor revision, including saved scene headings/costumes.

Recipients can start an anonymous project from the share page or paste the link into
**Import a shared actor** in an existing cast editor. Review it, adjust the name and
aliases if necessary, then explicitly import. Images become new private destination
assets. Generation permission starts pending and needs a fresh attestation before
rendering. Default wardrobe transfers; source scene costumes become named presets.
Choose a destination scene or default wardrobe to apply a preset. Applying checks
both cast and screenplay versions; removing retains the preset in cast history.

Revocation, expiry, source removal/takedown or absence of current project-wide
permission prevents subsequent reads/imports. Text edits do not change a shared
revision. Restoring project-wide permission can make an otherwise unexpired,
unrevoked share available again. Previously imported copies remain independent;
source revocation cannot recall them. Their owner controls generation and deletion.

## Access, atomicity and recovery

Actor tokens use a separate HMAC domain and exact payload binding source project,
share ID, revision and expiry. Project/review tokens cannot access share routes;
actor tokens cannot authorize project/reviewer/generation operations. Tokens stay
in UI fragments and Authorization headers (the import request carries its source
token in JSON). Responses are private, no-store and no-referrer. Cast snapshots,
render manifests and copied reference metadata contain no share keys.

`GET /api/cast-library/actor` previews one share; `/references/:id` under that route
reads only its pinned image. Owner routes under `/api/projects/:project/cast` create,
list and revoke `/:character/shares`, `/import` a share, and apply/remove
`/:character/costume-presets`. Existing limits remain: 24 characters, four references
per character and 96 historical project assets. There are up to 48 active shares and
48 imported costume presets. Name/alias collisions are checked before byte copying.

Imports validate copied PNG hashes, sizes and dimensions, then revalidate the share
after copying. PostgreSQL locks the two projects in sorted UUID order, uses only
their capability-authorized RLS scopes, and commits the destination cast and reference
catalog together. Concurrent changes, revocation while copying and stale versions
leave cast/catalog unchanged. Failed imports can leave unindexed private bytes for
existing orphan cleanup. Import itself does not use inference budget.

Optional project share records, cast library origins/presets and reference origins
are validated and hashed. Later edits/history/render manifests preserve them.
Backups and portable archives include share snapshots and catalog assets. Restoring
an imported project's archive does not require the original source project.
No SQL migration is needed. Deploy API, worker and frontend together: older binaries
do not understand the new cast fields and can drop share records on writes. Roll back
to a compatible release, or deliberately restore a prior snapshot acknowledging the
loss of subsequent work. Owner links still expire after 72 hours and projects after
30 days. This is not permanent account storage or an eternal actor registry.

## Evidence and remaining work

Domain/API tests cover token purpose, expiry/revisions, permission narrowing,
removal, pinned shares, image isolation, copying, fresh permission, costume mapping,
capacity and revocation during copying. A closed vendor HTTP fixture exercises an
imported actor through API admission and the preview worker after source deletion,
checking exact private bytes and the full cast manifest. No paid inference occurs.

PostgreSQL CI tests use non-bypass `hv_api` for competing imports, RLS isolation,
opposing imports and an observed row-lock revocation race. Backup/archive integration
restores share snapshots and copied image origins/bytes into isolated PostgreSQL/S3.
Browser checks cover both import flows, attestation, costume assignment, revocation
and independent-copy rendering. Mobile 390 × 844 fits without horizontal overflow.

Identity embeddings, evaluated multi-shot identity, signed actor contracts, voices,
likeness/image moderation, extras, global continuity and durable account-level assets
remain open. Sharing attestation is not a legal contract or likeness evaluation.
Zo deployment and Linear reconciliation remain pending during local continuation.
