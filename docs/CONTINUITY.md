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
| Characters | the cast records the scene's text names, by name or alias — stated **once per scene**, because every shot in a scene is compared against the same cast state |
| Wardrobe, and whether it is the scene's own, the project default, or unstated | the character's wardrobe entries |
| Preserve | the character's "prohibited changes" |
| References, and whether they are locked | how many reference images the render will actually be conditioned on: the character's **locked look** where one is set, and the whole retained set otherwise |
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
| `time-contradicts-previous` | warning | A scene headed `CONTINUOUS` declares the opposite time of day from the scene it continues. |
| `wardrobe-contradicts-previous` | warning | A character in a `CONTINUOUS` scene and the scene before it is given a different wardrobe in each. |
| `source-stale` | unknown | A saved direction's shot has changed or gone. Its continuity is not compared until it is reviewed. |
| `wardrobe-unstated` | unknown | A character the scene names has no wardrobe for it and no project default, so nothing is held constant across its shots. |
| `identity-unanchored` | unknown | A character has no reference image the render can be conditioned on, so their consistency rests on the written description alone. |
| `handoff-absent` | note | A shot does not start from a frame anchor, so it is generated without the frame before it. |

Only a direct day-against-night opposition is reported. A heading's "LATER" or "CONTINUOUS", and a
direction of "dusk" or "magic hour", contradict nothing, and guessing at them would turn a check
into one a creator learns to dismiss. A location that merely contains a time word — `INT. DAYCARE -
NIGHT` — is read as night.

## A CONTINUOUS scene and the scene it continues

A heading such as `INT. STAIRWELL - CONTINUOUS` says the scene picks up in the same moment the one
before it ends. So two things are checked against the **immediately preceding scene** in the
screenplay (HV-021-08):

- **Time of day.** A scene's time is its heading's own, where the heading states one; otherwise it is
  what the scene's shots are directed. A `- DAY` scene continued by a scene directed "night" is a
  `time-contradicts-previous` warning on the continuing scene, naming both scenes and both values. A
  heading that states the opposite time names every shot of the scene; a directed time names only the
  shots that oppose. A shot directed against its *own* heading is already `time-contradicts-heading`
  and is not reported a second time against the scene before.
- **Wardrobe.** For each character the cast finds in both scenes, the wardrobe that resolves for each
  — the scene's own entry, else the project default — is compared. A coat in one and a jumper in the
  other is a `wardrobe-contradicts-previous` warning naming the character, both wardrobes and both
  scenes. All of a scene's changed characters are in one finding.

Only what both scenes declare is compared. A wardrobe one scene does not state, a time of day that is
neither day nor night ("dusk"), and a character who is in only one of the two scenes contradict
nothing; the first is already `wardrobe-unstated`. Only a heading segment that is exactly `CONTINUOUS`
counts: "LATER" and "MOMENTS LATER" are a jump in story time, and nothing is carried across them. A
`CONTINUOUS` first scene has nothing before it.

Each scene and the film's totals carry **comparison counters** next to the findings:
`lookComparisons`, `wardrobeComparisons`, `handoffComparisons` and `continuousComparisons` (one for
the time of day when both scenes of a `CONTINUOUS` pair declare one, and one per shared character
whose wardrobe both state). They are how many checks were
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

## The one repair the Supervisor offers

`POST /api/projects/:id/direction/continuity/repair` reads the report back with a **repair proposal**
and a sentence a creator can act on: *"Hold key light across 2 shots, matching the first shot that
states each."* Reviewing changes nothing. `.../repair/accept` applies it, taking the edits the
creator was shown, the direction version and the screenplay version — and the edits are recomputed on
the server and must match the caller's copy exactly, so a repair can only ever apply what was
actually offered. Each edit moves a setting and nothing else: the entry keeps the source and the hash
it was saved against, so a repair can never re-bind a shot to a source the creator did not review.

**It repairs exactly one thing**: a look a scene declares more than once. The value the scene holds is
the one its first declaring shot states — the Supervisor does not judge between two looks, it makes
the scene agree with what the creator set first.

Everything else the report finds is named in the proposal's notes and deliberately left alone:

- A scene **directed against its own heading's time** is drift the studio can see and cannot resolve.
  Either the heading is wrong or the direction is, and only the creator knows which. Offering to fix
  it would make the studio pick, silently, and be right about half the time.
- A **`CONTINUOUS` scene whose time of day contradicts the scene before it** is the same choice
  between two declarations, one scene boundary over. Neither scene of the pair gets a time-of-day
  edit: holding the continuing scene to its first shot could turn a shot that agreed with the scene
  before into one that does not, and the repair would have spread the contradiction it names.
- **Wardrobe** belongs to the cast record, not to a shot's direction — including a wardrobe that
  changes across a `CONTINUOUS` heading.
- A **missing reference image** has to be made or uploaded; no direction edit can do it.
- **Carrying the approved last frame forward** is a choice about rendering, and the studio does not
  make it for the creator.
- A **stale source** is reviewed before any repair of that scene is trusted.

## When no repair can be made

The repair carries at most 240 edits. A sixty-shot film drifting in all five look fields reaches 295,
which is reachable on the plan the route itself offers — so the review answers with the **report and
the reason the repair is unavailable**, rather than with an error. Losing the report would be losing
the one thing that names the scenes to fix.

And the one-line summary says what is true of the proposal. "Nothing in this film's declared look
contradicts itself" is said only when nothing does: a scene directed against its own heading, and a
`CONTINUOUS` scene whose time or wardrobe contradicts the scene before it, are contradictions this
repair deliberately will not resolve, and the summary names them (the first used to be reported as none at all).
A wardrobe nobody stated is *not* a contradiction — it is something the project has not said — and
the summary does not claim otherwise.

## What this does not establish

This is not visual continuity, and no part of it is evidence that a film is continuous. Nothing here
compares pixels, faces, palettes, locations or composition; there is no OCR and no logo detection;
and no frame is examined at any point.

A character can now have a **locked look** — a chosen set of their retained images, which is what the
render is conditioned on, and what this report counts. That is the reference-set half of the identity
lock and only that half: there is no embedding, and nothing measures a generated frame against it, so
the similarity check a face lock implies still has nothing to measure against (see
[CASTING.md](CASTING.md): reference guidance does not establish an evaluated visual identity lock).
A locked look makes a report's reference count mean something firmer; it does not make the report
visual. The synthetic `continuityScore` used by the render reuse path is a different, also non-visual
measure, described in [SELECTIVE-RENDERING.md](SELECTIVE-RENDERING.md).

Zero warnings therefore means only that the declarations do not contradict each other — never that
the shots will match. Drift detection against identity locks, wardrobe and palette matching, and the
one-click corrected re-render spec remain in the full studio scope, and the continuity report says
what it could not check rather than staying silent about it.
