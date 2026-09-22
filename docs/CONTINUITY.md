# Continuity packets and declared drift

HV-021 is in progress. The application assembles a **continuity packet** for every shot from the
project's own screenplay, cast and shot direction, and reports the contradictions between those
declarations before anything is generated. It reads no pictures. See
[COVERAGE.md](COVERAGE.md) for the camera-geometry half of the same review — the axis and eyeline
checks — and [CASTING.md](CASTING.md) for where wardrobe and reference images come from.

## What a packet holds

One per shot, all of it declared by the creator or the crew:

| Field | Where it comes from |
|---|---|
| Scene number and heading | the saved screenplay |
| Heading time | the heading's own trailing segment, read as day, night, or neither |
| Characters | the cast records the scene's text names, by name or alias |
| Wardrobe, and whether it is the scene's own, the project default, or unstated | the character's wardrobe entries |
| Preserve | the character's "prohibited changes" |
| References | how many reference images the character retains |
| Time of day, key light, fill light, back light, motivated sources | the shot's saved direction |
| Handoff | the frame anchor the shot starts from, if it has one |

Weather, props in hand and injuries are in the full scope for this packet and are **not** modelled
anywhere in the product yet, so they are absent from the record rather than filled in with something
untrue.

## What the report says

Findings carry a severity, and the severity is the point: a **warning** is a contradiction between
two things the project states, and an **unknown** is something the project has not stated, so
nothing can be checked. A **note** is advice.

| Code | Severity | Meaning |
|---|---|---|
| `look-changed` | warning | Two shots in one scene declare a different time of day, key, fill or back light, or motivated source. |
| `time-contradicts-heading` | warning | A shot's time of day is the opposite family to the heading's own: a scene headed `- DAY` with a shot directed "night". |
| `source-stale` | unknown | A saved direction's shot has changed or gone. Its continuity is not compared until it is reviewed. |
| `wardrobe-unstated` | unknown | A character the scene names has no wardrobe for it and no project default, so nothing is held constant across its shots. |
| `identity-unanchored` | unknown | A character retains no reference image, so their consistency rests on the written description alone. |
| `handoff-absent` | note | A shot does not start from a frame anchor, so it is generated without the frame before it. |

Only a direct day-against-night opposition is reported. A heading's "LATER" or "CONTINUOUS", and a
direction of "dusk" or "magic hour", contradict nothing, and guessing at them would turn a check
into one a creator learns to dismiss. A location that merely contains a time word — `INT. DAYCARE -
NIGHT` — is read as night.

Each scene and the film's totals carry **comparison counters** next to the findings:
`lookComparisons`, `wardrobeComparisons` and `handoffComparisons`. They are how many checks were
actually possible, and they are the only way to read an empty finding list correctly. A film that
declares nothing produces no warnings and no comparisons — which is not a pass.

## Creator flow

The report is served with the Director's desk, at `GET /api/projects/:id/direction`, as `continuity`
beside `coverage`. It is computed from the same shot plan, casting snapshot and direction snapshot
the desk already returns, and it carries the `castingRevision` and `directionRevision` it was
computed against plus its own `revision`, so a report can be told apart from the film it describes
after either one moves. The route is owner-only and `private, no-store`, like the rest of the desk.

The report is a pure function of those three inputs: the same screenplay, cast and direction produce
the same report, including its revision. Nothing is timed, sampled, or fetched.

## What this does not establish

This is not visual continuity, and no part of it is evidence that a film is continuous. Nothing here
compares pixels, faces, palettes, locations or composition; there is no OCR and no logo detection;
and no frame is examined at any point. The identity locks that a face-similarity check would measure
against do not exist yet (see [CASTING.md](CASTING.md): reference guidance does not establish a
visual identity lock). The synthetic `continuityScore` used by the render reuse path is a different,
also non-visual measure, described in [SELECTIVE-RENDERING.md](SELECTIVE-RENDERING.md).

Zero warnings therefore means only that the declarations do not contradict each other — never that
the shots will match. Drift detection against identity locks, wardrobe and palette matching, and the
one-click corrected re-render spec remain in the full studio scope, and the continuity report says
what it could not check rather than staying silent about it.
