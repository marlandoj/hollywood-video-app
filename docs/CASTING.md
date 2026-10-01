# Versioned cast direction and visual references

Explicit cross-project actor sharing and private import are described in
[ACTOR-LIBRARY.md](ACTOR-LIBRARY.md), including fresh permission and costume presets.

HV-017 is in progress. The application now supports owner-scoped text direction
and visual references for up to 24 original fictional characters per project.
This is the persisted cast and permission foundation for P2. A character's look
can be locked to a chosen, ordered set of its own images (see [The locked
look](#the-locked-look)), which fixes what every render of that character is
conditioned on; it does not establish an evaluated visual identity lock.

## Creator flow

Save a screenplay and open **Save screenplay and edit cast**. Use the character's
screenplay name and optional aliases. Add appearance, age range, ethnicity,
physical traits, hair/makeup, expressions, movement, relationships, arc notes and
traits to preserve. Wardrobe supports a default and overrides for named scene
numbers. Additional fields are behind disclosure controls.

Permission is pending, permitted or revoked, with a project or selected-scenes
scope and optional expiry. Marking a record permitted requires the creator's
explicit original-fictional-character attestation. This is a declaration; the
application has not independently verified ownership, identity or likeness.
The cast list also provides a direct revoke action, so withdrawing permission
never requires repairing wardrobe bindings after screenplay scenes are removed.

Every save, removal or restore creates a new cast revision. Stale writes return
409 and require reloading. The last 100 revisions remain available for restoring;
render jobs independently retain their complete admitted cast snapshot.
Restoration always resets permissions to pending. Removing a character can be
undone through history, with fresh permission required.

## Rendering and permission boundaries

- Names and aliases match whole words in scene headings, action and dialogue.
  The character's directions apply as context to the shots in that scene. This
  does not perform entity recognition or decide which shots visibly show them.
- Scene-specific wardrobe and permissions record the current heading with the
  scene number. Changed or missing headings require reviewing and saving the
  character again. Identical repeated headings are not stable scene identities;
  full screenplay scene IDs and semantic continuity remain future work.
- Admission saves the normalized, hashed cast snapshot in the job. The preview,
  approval and final admission must agree on its project, version and hash.
  Cast edits clear the current preview approval flow in the editor; unsaved
  edits block preview creation and approval.
- Each dispatch checks both the admitted permission and current permission.
  Revocation, expiry, removal and scope narrowing stop subsequent attempts.
  A scene-scoped permission renewed against a different heading cannot authorize
  the old queued scene. An already dispatched provider request cannot be recalled.
- Editing appearance does not rewrite a queued job's prompt. A finished export
  retains its original cast version, and the creator must preview the updated
  cast before generating a new final.
- PostgreSQL admission and permission checks use the existing project/budget
  transaction locks. JSON mode re-reads the project before each attempt; it
  remains a local development store without PostgreSQL's multi-process guarantees.
- Export provenance includes the complete cast snapshot. Storyboard captions
  retain the screenplay text rather than exposing long direction blocks.

The project owner bearer link authorizes GET, PUT, remove, revoke and restore routes
under `/api/projects/:id/cast`. Review links and other projects cannot access
these routes. Responses are private and not cached. Cast history is included in
existing JSON/PostgreSQL project persistence and backup bodies. Text direction
alone requires no schema migration or new secret; character sheets require migration 0006.

## Private reference images

Open **Visual references** on a saved character. Choose a PNG or JPEG and
confirm that it depicts an original fictional character whose image rights
permit generation. Uploads accept at most 10 MiB and 4096 by 4096 pixels. The API
decodes a single frame, strips metadata, fits it within 1024 by 1024, and stores
a PNG of at most 4 MiB. URL, vector, invalid raster and excessive inputs are
refused. Intake has bounded body reading, decoder time and concurrency.

Each character supports four references; the project catalog holds at most 96
uploads including historical assets. Attaching or detaching creates a cast
revision, invalidating the earlier preview approval. Ordinary text edits retain
references. History restoration recovers the images with permission pending.
Detached images remain available to historical casts and renders until project
deletion; detaching does not reclaim the historical upload allowance.

## The locked look

Until a character's look is locked, every render is conditioned on **whatever images the character
holds at that moment, in upload order** — so adopting one more sheet view silently changes every
shot the character appears in. **Lock look** ends that: choose one to four of the character's own
images, in the order the render should number them, and name the look (for example "Act two, after
the storm"). From then on those images, in that order, are what conditions every render of the
character, and adopting or uploading another image changes nothing until the look is locked again.

The lock names the bytes as well as the image, so an image re-uploaded under a reused identity
cannot pass as the locked look. Removing a locked image is refused, naming the character, rather
than quietly unlocking: unlocking, or locking to other images, is the creator's own decision and
takes its own cast version like any other cast change.

A locked look travels with a shared actor (HV-017-15). The import finds each locked image's copy by
the source image it came from, checks the copy's bytes against the hash the lock named, and locks
the imported actor to those copies in the same order, with the same name and note. If any locked
image is missing or changed, the actor is imported unlocked and the import says why; it is never
half-locked. (Today the import route refuses a changed image before that point, so the note is a
guard rather than something a creator sees.) A locked character's card names its look and offers
**Unlock look**. See [docs/ACTOR-LIBRARY.md](ACTOR-LIBRARY.md).

The look is locked from the character's card (HV-017-16). A character with images and no lock
offers **Choose a locked look**: tick one to four of its images, and the order you tick them in is
the order renders number them, shown on each image ("Reference 3 · 1st in the look") and as one
line ("Render order: Reference 3, then Reference 2."). Name the look (required, up to 120
characters) and add a note if you like (up to 400), then **Lock look**. The page sends
`PUT /api/projects/:id/cast/:characterId/reference-lock` with
`{expectedVersion, lock: {assetIds, label, note}}`, the same body the API always took.

The name and note pass the content policy before the lock is kept, as other creator text does. A
name or note naming a public figure, or a brand, is refused, and nothing is saved. Refusals appear
in the desk's status line. If the cast changed in another session, the desk reloads the cast and
says so; it does not send the lock again. While a look is locked, its images show "In the locked
look. Unlock the look first to remove it." instead of a remove button, and a sheet's views are
added beside its images rather than offered as a replacement set.

This is the **reference-set** part of P2's identity lock, and only that part. The embedding and the
optional per-project fine-tune the full scope also describes are not built; see the remaining work
below.

Metadata records original and normalized SHA-256 hashes, dimensions, byte count,
project, generated asset ID and attestation time. Original bytes and filenames
are discarded. PNG objects remain in private S3 storage (or the local development
cache). The owner-only image route is `/api/projects/:id/references/:assetId`;
review links cannot read it. The editor fetches thumbnails only when expanded,
uses private blob URLs and revokes those URLs on replacement or page exit.

The worker reads and verifies the job's pinned reference bytes and passes PNG
data URIs to explicitly configured reference-capable adapters. It never sends a
signed owner URL. Numbered references identify their character in the prompt.
A scene with more than four total references cannot use the current adapters;
admission refuses it. Text-only providers are ineligible for any referenced
shot, and reference-only providers require at least one image. Mixed projects
need a pool that also supports their unreferenced shots. No fallback silently
discards the references.

The project catalog and every cast snapshot travel through PostgreSQL/JSON
persistence. Storage backups include the private PNG objects under the existing
snapshot/deletion lock; portable archives include and verify their bytes.
Orphan collection preserves cataloged references, even after detachment.
Project purge removes them through the existing storage deletion outbox.
Operator archive imports still require an offline empty database and a separate
empty bucket. See REFERENCE-PROVIDERS.md for adapter configuration and evidence.

## Real people: by consent only (G12)

A cast member is either an **original fictional character** or a **real person who
consented** (`kind: "consented-real-person"`): the creator ("this is me") or someone
who gave the creator permission. Permitting a real person to render requires the
attestation and whose consent it is (`permission.consent`: `self` or `permission`).
Like any permission it has a scope and an optional expiry, and it can be revoked;
revoking or restoring an old cast version drops the consent and returns the record to
pending. Reference photos attach the same way as for a fictional character, with an
attestation worded for a photo of that person.

Consent stays in its project: a real person cannot be shared as an actor-library
link (refused at mint and at every read).

**Named public figures are refused**, whatever the cast says:
`packages/safety/src/public-figures.ts` lists widely known living people and recently
deceased people whose likeness is commercially managed. It is matched on whole words,
ignoring case, accents and separators, in every prompt, dialogue line, and **every
free-text field of a cast record** — the twelve described fields, the aliases and every
wardrobe description, which is the same text `describeCharacter` puts into a shot
prompt (HV-031-05; it used to be the name, the aliases and the appearance only, so a
figure written into `hairMakeup` saved clean and was refused at generation instead).
A cast record naming one is refused when saved. It is a keyword list, not a likeness
detector: a photo of a public figure uploaded as a "consented" reference is caught only
by the uploader's attestation.

Matching folds away what a person cannot see. Zero-width and other `\p{Cf}` characters
are stripped before the text is matched, and the common Cyrillic and Greek letters that
are drawn as Latin ones are mapped back to what they look like. Both are folds, so they
can only add refusals.

Whitespace between two words is one space to the gate (HV-031-14). A line break, tab,
no-break space, any other Unicode space, or several in a row used to hide the rules
written with a single space (`harry potter`, `a famous actor`, `the sitting president`),
including when a route joins two fields with a line break before gating them. The gate
first reads the text as written and folded, exactly as before, so a refusal it made
keeps its category and message. Only if nothing matches does it read spaced versions
(every whitespace run as one space): the text as written, the folded text, and the text
spaced before and after folding. NEL (`\u0085`) is both an invisible control and a line
break. The fold deletes a NEL inside a word, and spacing makes a NEL between words a
space. A text with NELs in both places ("Harry\u0085Pot\u0085ter") still passes; see
HV-031-14's known gaps.

**A record already saved is not re-judged on read.** The list only grows, and a name
added to it tomorrow must not make a cast saved today unreadable — the studio would
refuse to open a project rather than refuse to render it. The same list still refuses
every prompt that carries the name, so such a record can be read and edited and cannot
be filmed. An **actor import is a save, not a read**: the text it carries was written in
another project under whatever list stood then, so `importedActor` reads it at the
border, including the costume preset descriptions, which nothing had read before.

The consent is a declaration. The studio has no accounts (ADR-0018) and cannot
verify identity. That is accepted on private staging; before public launch it is part
of the counsel and moderation review under G7. Describe a real cast member by
appearance ("short dark hair, trimmed beard"), not as "a real person": the older
real-person keyword rules still refuse that wording in prompts.

## Safety limits and remaining P2 work

All cast-enriched prompts pass through the existing content gate before
generation. That gate is a keyword filter, not a semantic or likeness detector.
During local testing on 2026-09-06, the appearance direction
"A portrait of Taylor Swift" was not refused by that filter; since HV-031-04 it is,
by the named-public-figure list. No provider request
was made for that probe. Tests cover propagation of known blocked phrases, and
do not claim the broader named-person policy is enforced.

Reliable detection of named real people, consent/likeness abuse, minors and
semantic paraphrases requires a separate evaluated moderation system before
public launch. Provider-side safeguards and a creator checkbox are insufficient
evidence for that launch requirement. The consented real-person workflow above is a
declaration, not verification.

Reference storage, image/video reference transport and the locked reference set
above are implemented. Embedding identity locks, digital-actor contracts, voice
identity, character reuse/extras and an eight-shot visual identity evaluation
remain open. A locked look fixes **what a render is conditioned on**; it
establishes nothing about what comes back, and reference transport cannot
substitute for evaluated visual identity. No paid identity evaluation or Zo
rollout has been performed for this change. Uploaded
images do not yet have an independently evaluated image moderation system.

Generated turnaround, expression, wardrobe, lighting and adult-age sheets are
available with explicit view review and batch reference adoption. See
[CHARACTER-SHEETS.md](CHARACTER-SHEETS.md) for configuration, boundaries and migration.

## Verification

Local planner/API tests exercise snapshot tampering and project isolation,
permission scopes/expiry, stale revisions, restore behavior, the 100-version
retention boundary, changed scene headings, admission/approval invalidation,
mock preview-to-final provenance and revocation between two shot dispatches.
PostgreSQL integration tests exercise concurrent saves, stale atomic admission,
revocation before a later provider attempt and project-locked approval.

Browser checks used a loopback-only API and worker with an explicit mock-only
pool: three previews and one final, all completed for $0. They exercised cast
editing and persistence, per-scene wardrobe, unsaved-edit guards, stale approval
removal, restore-to-pending refusal, renewal and direct revocation. A 390-by-844 viewport fit without
horizontal overflow; buttons, fields and disclosure targets met 44 px sizing
(checkboxes use their surrounding label). No browser console errors were seen.
The fixture worker was stopped and temporary browser viewport reset afterward.

Reference browser checks used closed provider HTTP fixtures and real API/worker
media assembly: one preview and one final, explicit upload attestation, private
thumbnail loading, detachment, restore-to-pending refusal and reload persistence.
The 390-by-844 viewport had no horizontal overflow; the restored thumbnail
decoded at 640 by 512. No console errors were recorded. The fixture ledger
recorded configured estimates of $0.024 and $0.252; actual inference spend was
$0 because every vendor request was intercepted. The owned worker and tab were
closed and the temporary viewport reset.
