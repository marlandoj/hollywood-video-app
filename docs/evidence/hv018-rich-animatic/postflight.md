# HV-018 integration postflight (in progress)
Authorization: full execution, integration and private deployment approved by operator on 2026-09-05.

Implemented: image-to-motion clips, temporary local speech, sequential switchable/burned captions,
signed scene-grouped thumbnails, atomic stage reservations, per-attempt cost accounting and rollback.
219 tests / 1039 assertions pass with Bun 1.4.0. Typecheck/lint/runtime smoke pass.
Same-host legacy benchmark: pipeline +2.0% vs 39ae2b6, below existing 5% limit.
Full mock Spud: 16 scenes, 24 frames/clips, 601.967 seconds, 14 narrated shots, $0, no reservation remaining.
A dedicated rich-animatic benchmark now gates 24 posters, 720 frames and $0 separately, because a
same-host timing comparison to an older implementation that cannot render images is not meaningful.

Live fal evaluation: 24 FLUX Schnell frames, $0.072 recorded, 24 cost events, no reservation remaining.
Pending: CI final head, private deployment, browser QA, Linear milestone reconciliation.
Temporary speech is a table-read voice. This work does not implement identity lock or final voice casting.
Shadow persona evidence represents a configuration/routing check, not independent reviewer approval.
