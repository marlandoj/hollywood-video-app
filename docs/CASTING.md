# Versioned cast direction

HV-017 is in progress. The application now supports owner-scoped text direction
for up to 24 original fictional characters per project. This is the persisted
cast and permission foundation for P2; it does not establish visual identity.

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

The project owner bearer link authorizes GET, PUT, remove and restore routes
under `/api/projects/:id/cast`. Review links and other projects cannot access
these routes. Responses are private and not cached. Cast history is included in
existing JSON/PostgreSQL project persistence and backup bodies; no schema
migration, asset upload, external reference fetch or new secret is required.

## Safety limits and remaining P2 work

All cast-enriched prompts pass through the existing content gate before
generation. That gate is a keyword filter, not a semantic or likeness detector.
During local testing on 2026-09-06, the appearance direction
"A portrait of Taylor Swift" was not refused by that filter. No provider request
was made for that probe. Tests cover propagation of known blocked phrases, and
do not claim the broader named-person policy is enforced.

Reliable detection of named real people, consent/likeness abuse, minors and
semantic paraphrases requires a separate evaluated moderation system before
public launch. Provider-side safeguards and a creator checkbox are insufficient
evidence for that launch requirement. A real-person consent/rights workflow is
not implemented by this fictional-character declaration.

Reference images, embeddings, identity-conditioned provider calls, turnaround
sheets, digital-actor contracts, voice identity, character reuse/extras and an
eight-shot visual identity evaluation remain open. Text directions cannot
substitute for those deliverables. No paid identity evaluation or Zo rollout
has been performed for this change.

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
removal, restore-to-pending refusal and renewal. A 390-by-844 viewport fit without
horizontal overflow; buttons, fields and disclosure targets met 44 px sizing
(checkboxes use their surrounding label). No browser console errors were seen.
The fixture worker was stopped and temporary browser viewport reset afterward.
