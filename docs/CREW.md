# The studio crew

**Owner:** HV-030 (AI Crew and Director Loop). **Decision:** G13-202609192200. **Roadmap:** Release 1 "Studio", `docs/ROADMAP.md`.

A creator brings a script. The crew, AI personas each with a department, reads it, asks only what matters, and proposes an answer to every question. The creator accepts with one click or says otherwise. The engine underneath is the rest of this repository. The crew drives it; it is not a second engine.

## Personas

Defined in `packages/planner/src/crew/personas.ts`.

| Id | Title | Owns |
|---|---|---|
| `producer` | Producer | scope, format, schedule and budget |
| `director` | Director | tone, pacing, performance and the ending |
| `casting` | Casting | who plays each character and how they look (real people only with consent, `docs/CASTING.md`) |
| `cinematographer` | Cinematographer | the look: framing, camera movement, light and colour |
| `sound` | Composer and Sound | music, atmosphere and voices |
| `editor` | Editor | the cut: rhythm, length and titles |
| `continuity` | Continuity Supervisor | what each scene holds from shot to shot: its look, its heading's time, wardrobe and reference images (HV-021-09) |
| `showrunner` | Showrunner | a feature's sequences: where each begins and ends, and the order they are made in (HV-030-29); the feature's style bible (HV-034-02) |

Each of the first six asks at most three questions. The Continuity Supervisor and the Showrunner ask none. The Supervisor is on the roster (`CREW`) but not in `PERSONAS`, the list the read-through tells the model about and the only personas a question, an answer or a style-card choice may name. It speaks in the plan's notes, below. The Showrunner is on the roster the same way (`SHOWRUNNER`, `speaks: "sequence-plan"`): it proposes a feature's sequence boundaries and writes its style bible, and nothing else. From HV-030-02 each persona gets a typed tool set limited to its own department's existing APIs, and every change it makes is validated exactly as a creator's edit is.

## The read-through (HV-030-01)

`POST /api/projects/:projectId/crew/read-through` takes `{"format": "reel" | "short" | "feature", "tone": "<one sentence>"}` and is limited to the project's owner. It reads the latest saved script. Any other format is refused with 400. A reel or a short is read as one render's plan (24 shots); a feature is read whole, up to 240 shots (HV-030-28).

The answer, `hv-crew-read-through/1`, keeps two things apart.

**`facts`** are computed by the studio, deterministically. The model never states them, so it can't misstate them. They are:

- scenes, shots and speaking characters;
- the estimated runtime, against the format limit (reel 90 s, short 600 s, feature 1,200 s; `packages/planner/src/crew/formats.ts`);
- the final-video estimate (`estimate: {videoSpec, basis, finalVideoUsd}`). Since HV-030-28 it quotes the active final profile's lead lane: the first entry of the configured final pool priced by the billed second and not retired, the one the `configured` routing strategy tries first. Each shot is priced at the clip the Editor will pace it to on that pool (at least its billed floor, longer for its lines). On `live-film-anchored` that is Kling O3 keyframes, $0.42 a 5 s shot; on `live-film`, Kling 2.5, $0.35. With no such lane (the mock profile) it quotes the registered price of `fal:kling-v2.5-turbo-pro`, as before, with `basis: "reference"`. The runtime is still the planned runtime before the Editor's pacing;
- the `concerns`:
  - `public_figure`
  - `content_policy`
  - `over_format`
  - `empty_script`

**The crew's voice** is written by the model: `logline`, `summary`, and `questions` (`persona`, `question`, `proposal`). Every string must pass the same prompt gate as any generation prompt.

- **What makes the whole answer unusable.** Any string the gate refuses, anywhere in the parsed answer, before anything is dropped: every value and every key at any depth, so a persona id, a bare-string item, a nested array, an extra key and a question that would be left out are all read. Also: no JSON, JSON of another shape, or a `logline` or `summary` that is empty or over its limit (200 and 1200 characters). Then the stand-in crew answers instead.
- **What drops one question, not the answer (HV-030-25).** A question over 300 characters or a proposal over 400, a crew member the studio doesn't have, a question or proposal that isn't text, and a crew member's fourth question onwards (the first three are kept). The question is left out whole: nothing is cut short. The rest keep their order and are numbered `q1`, `q2`, ... `dropped` says how many were left out, and the studio tells the creator ("1 of the crew's questions couldn't be used and was left out."). If questions were asked and none is left, the answer is unusable. An answer that asks no questions is still used, as the prompt allows.
- **Read leniently where it is safe.** A crew member's id is read without regard to case or surrounding spaces. The JSON runs from the first `{` to the last `}`, so a fenced block or prose around it is fine.
- **Output budget.** The read-through asks for up to 6000 output tokens, the plan step's budget. Until HV-030-25 it asked for 2000, which the longest answer its own prompt allows couldn't fit: eighteen questions (six crew members, three each) with the logline and summary come to about 14,000–15,000 characters. The worst case is about $0.30 of output per read-through or plan, at the dearest priced model (6000 tokens at $50 per million). The crew line's $1,000 stop is checked before each call, so calls already in flight can pass it.

- **A script the gate refuses is never sent to the model.** The creator sees the concern instead.
- **The stand-in crew.** With no key, or when the model can't be reached or its answer is unusable, the voice is written deterministically from the facts: `source: "stand-in"`, with `fallbackReason` when a live model was configured. So the flow works, and is tested, without any vendor. With `model_unusable`, `unusableReason` says why (see "Why an answer was unusable" below).

## The production plan (HV-030-02)

`POST /api/projects/:projectId/crew/plan` takes:

- `{format, tone, answers, expected: {scriptVersion, castingVersion, directionVersion}}`;
- each answer as `{id, persona, question, proposal, accepted, reply}`.

It turns the creator's answers into the studio's own settings (`packages/planner/src/crew/production-plan.ts`).

- **Casting** proposes an original character for each speaking role that has no cast record yet. The record is validated by `characterRecord` and saved with **permission pending**. The creator attests at the look approval, never the crew.
- **Director, Cinematographer, Composer/Sound and Editor** propose each shot's size, angle, movement, key light, time of day, performance, sound intent and transition intent, validated by `directionSettings`. This covers only shots the creator has not directed.
- **Applied in one step** (`applyCrewChanges`): one new cast version and one new direction version. A pass is a single entry in each history, and the creator can restore the previous one.
- **Stale versions are refused (409),** and the crew may only add cast and direct undirected shots. It never overwrites the creator.
- **The model's plan must use the script's own character names and the planner's own shot ids.** Every string passes the prompt gate. Anything else falls back to the stand-in plan, whose conservative defaults are naturalistic light, wide establishing shots and close-ups for dialogue.
- **Still all or nothing (HV-030-25).** Unlike the read-through's questions, a defective part of the plan isn't dropped. A plan is applied as the film's cast and direction: a dropped cast entry would leave a speaking character with no look, and a dropped shot would go undirected, under a plan credited to the model. The stand-in's plan is whole. The fallback now carries `unusableReason`.
- **The answer** is `hv-crew-plan-result/1`: the look note, the crew's notes (which persona changed what), the new versions and the spend.

### The Showrunner splits a feature into sequences (HV-030-29)

Release 3 step 2 (G20-202610031349). A feature is longer than one render: the free tier renders at most
24 shots (`TIERS.free.maxShots`), and a 15–20 minute feature is about 200–240 shots. At the plan step,
a `feature` is split into **sequences**: runs of consecutive scenes, each at most 24 shots, each made like
a short (`packages/planner/src/sequences.ts`, `packages/planner/src/crew/showrunner.ts`).

- **The feature's shots.** Each scene is planned on its own: one shot per beat, as a short of up to 24
  beats is; a scene of more than 24 beats is grouped into 24 shots, as a short of that one scene would be;
  a scene with accepted coverage keeps its coverage's shots (a scene whose coverage is past 24 shots is
  refused with 409 before anything is asked or spent). So the shots don't depend on where the sequences
  break, and a sequence's 24-shot render plans exactly its scenes' shots. The crew directs all of them
  once, in the same plan step (`featureShots`); a project's direction now holds up to 240 shots
  (`DIRECTION_ENTRY_LIMIT`, was 60), and a feature past 240 shots is refused at the plan step.
- **The split.** The Showrunner's one tool is a list of boundaries, `{"sequences": [{"firstScene",
  "lastScene"}]}`, by scene number. It is shown each scene's heading and shot count, never the script's
  action. The studio counts the shots itself and validates the split: every scene exactly once, in
  order, no gap or overlap, at least one scene and at most 24 shots each. Anything else is unusable
  (`unusableReason`, as for every crew answer, logged with `step: "showrunner"`), and the stand-in's
  split is used: greedy, deterministic, closing a sequence when the next scene would take it past 24.
  With no model, or when the whole feature fits one render, the stand-in splits and nothing is spent.
  A paid answer goes on the crew line as `persona: "crew-showrunner"`, up to 2,000 output tokens.
- **Kept on the project.** The plan (`hv-sequence-plan/1`: the script version it splits, each sequence's
  first and last scene and shots, and a revision) is stored as `sequences` in the same write as the
  format, cast and direction. It's absent for a reel or a short, and planning a feature again as one
  removes it. A project load and a state snapshot refuse a plan that isn't the Showrunner's shape, a
  plan on anything but a feature, and a plan for a screenplay version the project doesn't have.
- **The answer** carries `sequences: {source, fallbackReason?, unusableReason?, revision, sequences:
  [{number, firstScene, lastScene, shots}]}` for a feature only, and the Showrunner's note goes first in
  `notes`, in the studio's words.
- **Rendering.** A feature with a plan renders one sequence at a time: `POST /jobs` takes `sequence`,
  1 to N, and a rough cut or final without one is refused with 400, as is a sequence for a reel or a
  short. The job carries the sequence (`{number, of, firstScene, lastScene, planRevision}`); every
  place a film render's shots are derived (admission, the worker, the PostgreSQL ledger, snapshots,
  re-renders and dialogue sources) reads the feature's shots and keeps the sequence's. A plan for an
  older screenplay, or whose coverage no longer fits, is refused with 409 ("Plan the film again"). A
  final must follow its own sequence's approved rough cut (409 otherwise, and the worker and the
  PostgreSQL ledger check it again). The request key names the sequence, so a repeat is the same job
  and another sequence another job. Selective reuse is refused for a sequence.
- **Spend.** Each sequence's render is its own admission, held to the feature's one film limit ($150).
  `GET /spend` adds `sequences: [{number, firstScene, lastScene, shots, spentUsd, heldUsd}]` for a
  feature, from the jobs of its current plan; a reel's and a short's answer is unchanged.

### The Showrunner writes the style bible (HV-034-02)

Release 3 step 3 (G20-202610031349). A feature is made as sequences, and each sequence's render read only
its own shots, so nothing said sequence 7 should look like sequence 1. The **style bible** is one bounded
statement of the feature's look, written once by the Showrunner at the plan step and read by every
sequence's render (`packages/planner/src/style-bible.ts`, `packages/planner/src/crew/style-bible.ts`,
`hv-style-bible/1`).

- **What it holds.** Six lines: look (up to 400 characters), palette, lighting, lens and framing (240
  each), tone (200) and sound (400); each principal character (up to 24); each recurring location (up to
  40, a name of up to 120 and a description of up to 300); its `version`, the `scriptVersion` it was
  written for, its `source` (the vendor, `stand-in` or `creator`) and a `revision` hash.
- **Who names what.** The studio names the locations, from the scene headings (`INT. KITCHEN - NIGHT`
  is KITCHEN), and the characters, from the cast the plan leaves: each character's entry is its cast
  record's own appearance (and default wardrobe), never the model's words, and a consented real person
  is never re-described ("A consented real person: their look is the cast record's, within what their
  consent allows."). The model writes the six lines and a description for each named location.
- **When it is written.** For a `feature`, after the Showrunner's split and before the crew's plan: the
  crew's plan prompt reads it, as the look every sequence keeps. It is written **once**: planning the
  feature again carries the bible forward (no model is asked, nothing is spent), with the cast as it
  now is and the script's locations as they now are (a location kept keeps its description; a new one
  gets the stand-in's). It is a new version only if that changed it.
- **From what.** The creator's answers, the style card they attached and the screenplay's headings and
  characters. `POST /crew/plan` takes an optional `styleCard`, read as the read-through reads one:
  validated and gated whole (400 when refused), and stored nowhere; only the bible's own lines are
  kept. The front door sends the card with a feature's plan when it sent one with the read-through.
- **The model's answer, field by field.** Unlike the plan, a bible is used line by line. A line that is
  missing, not text, past its limit, refused by the gate or naming a public figure is replaced by the
  stand-in's line, and so is a location description; a location the studio didn't name is left out.
  Nothing is cut short. The answer's `dropped` lists each `{field, reason}` (`missing`, `bad_shape`,
  `too_long`, `gate_refused`, `public_figure`, `unknown_location`). An answer with no JSON, nothing
  usable, or lines that together fail the gate is unusable (`unusableReason`, logged with `step:
  "style-bible"`), and the stand-in's whole bible is used. A paid answer goes on the crew line as
  `persona: "crew-style-bible"`, up to 1,500 output tokens; a script the read-through flags is never sent.
- **The stand-in** writes it deterministically: the look from the Cinematographer's answer, then the
  card's; the tone from the creator's tone, then the card's, then the Director's answer; the sound
  from the Composer's answer, then the card's; otherwise, and for the palette, lighting and lens, the
  stand-in plan's own conventions. If the creator's words together fail the gate, only the conventions.
- **Gated when written, checked when read.** Every string passes the gate and the public-figure check
  alone, and the whole bible passes the gate together. A stored bible is checked for its shape, limits
  and revision on load and in a state snapshot; it is gated again in every render's prompt, so a
  refusal added later refuses the render rather than making the project unreadable.
- **Kept on the project** as `styleBible`, in the same write as the format, sequences, cast and
  direction. Only a feature has one; planning it again as a reel or a short removes it. A project load
  and a state snapshot refuse a bible that isn't the studio's shape or changed after it was written,
  one on anything but a feature, and one for a screenplay version the project doesn't have.
- **Every sequence's render reads it.** A sequence render's job carries the bible and names its revision
  (`sequence.bibleRevision`), and each shot's prompt gains one block after the cast and shot direction:
  "Style bible (one look for the whole feature, the same in every sequence; ...)", the six lines, and
  the shot's location. So sequence 1 and sequence 7 share the same look lines, and the same cast
  descriptions (the cast is project-wide). Admission, the worker, re-renders and snapshots read it the
  same way; the request key names the revision. A feature planned before this step has no bible and
  renders as it did.
- **The answer** carries `styleBible: {kept, source, fallbackReason?, unusableReason?, dropped, bible}`
  for a feature, each sequence names `bibleRevision`, and the Showrunner's second note says it wrote
  (or kept) the bible and how many characters and locations it holds.
- **At the desk.** `GET /api/projects/:projectId/style-bible` (the owner) answers the bible and, for each
  sequence of the current plan, `madeWith` (the revisions its rough cuts and finals read) and
  `needsRoughCut`. `PUT` the same path with `{expectedRevision, look, palette, lighting, lens, tone,
  sound, locations?: [{name, description}]}` edits it: every field meets the same rules and any failure
  refuses the edit whole (400, with the reason); a stale revision is 409; the characters aren't
  editable here (edit the cast). A reel or a short has no bible (404).
- **The rule after an edit.** A sequence render reads the bible current when it is admitted. A sequence
  already made keeps the revision it read and is marked `needsRoughCut` until it has a rough cut of the
  current revision; its final must read the same revision as its approved rough cut (409 "The style
  bible changed after this sequence's rough cut. Make its rough cut again..."). Sequences not yet made
  read the new revision. Nothing re-renders on its own.
- **The joined feature (HV-030-30) keeps one look.** The join takes each sequence's newest final that
  read the bible the feature has now, refuses a final made with an older bible or none ("Sequence k's
  final was made with an older style bible. Make its rough cut and final again, so the feature keeps
  one look."), and its plan records `bibleRevision`. A feature with no bible joins as before.

### The Continuity Supervisor's notes (HV-021-09)

Once the plan is applied, the Supervisor reads the continuity report (`docs/CONTINUITY.md`) over the cast and direction the plan just made. It is the same `continuityReport` call `GET /direction` makes, at its default 24 shots. Its notes go last in `notes` (`packages/planner/src/crew/continuity-supervisor.ts`).

- **One sentence per kind of finding**, naming the scenes it is in and, for wardrobe and reference images, the cast the report names. Twenty drifting shots still read as a few lines. A note lists up to six scenes or names and counts the rest. There are at most six notes; past that, the last one counts the kinds left over.
- **Nothing it doesn't find.** Every sentence comes from a finding in the report, and a kind the report doesn't find is never mentioned. A kind this file doesn't know yet is said in the report's own words.
- **Nothing to compare is not a pass.** With no planned shots, or nothing stated twice, the note says there is nothing to compare yet. A report with comparisons and no findings says what was compared, and that it reads declarations, not pictures.
- **Marked as its own.** Each note is `{persona: "continuity", change, source: "continuity-report"}`. No other note carries `source`, so the Supervisor's words can't be taken for a model's.
- **How much it checked.** The answer carries `continuityComparisons`, the number of comparisons that report could make. The credits use it, below.
- **Where it points.** A drifting look's note names "Review continuity repair" under Continuity at the Director's desk, and the overflow note points to the same section. That panel is HV-021-07's (PR #323), which this increment waits for.
- **No model, no spend.** The crew model is asked for the plan and nothing else. The notes are free and deterministic: the same report gives the same notes.

Why the plan step: the read-through comes before the crew has directed anything, so its report would be empty. The plan step is the first place with the cast and direction the report compares, and its notes are already shown at the look approval.

## The studio front door (HV-030-03)

The page opens on the studio (`packages/frontend/src/studio.js`, served at `/api/studio/app.js`). Every detailed panel, the "Director's desk", sits behind the **Advanced** switch in the header. The switch is remembered per browser in `localStorage`, never sent anywhere, and a resumed project link opens the desk.

1. **Pitch.** Script, format (reel, short or feature), tone, and the creator's rights attestation, then the Producer's read-through. A public figure, a content-policy refusal or an empty script keeps the creator at the pitch, with the reason.
2. **Questions.** Each crew question is shown with its proposal: "Sounds good" or "Something else" with a reply. Then **Plan the film** (`/crew/plan`).
3. **Approval 1, the plan.** The crew's notes, the look, and the cast. The creator attests once that the crew's cast are original characters they may use: `POST /api/projects/:projectId/crew/approve-cast` with `{attested: true, expectedVersion}`.
   - This permits every pending **original** character in one cast version.
   - A real person's consent is never given here; that stays in the cast editor.
   - Then the storyboard and rough cut render.
4. **Approval 2, the storyboard and rough cut.** Approve to make the final, or **Ask the crew for changes**, which goes back to a fresh read-through.
5. **Approval 3, the film.** Download, or share with a reviewer, choosing how many viewers (`docs/REVIEW-LINKS.md`).

**A feature (HV-030-29, G20).** The look is approved once for the whole feature, then each sequence's
rough cut and its final, one sequence after another: 1 + 2 × N approvals ("Approval 4 of 21: sequence 2 of
10, its storyboard and rough cut").

- Approval 1 is the plan, the look and the cast, as for a short. It renders the first sequence's
  storyboard and rough cut. An animatic renders at most one render's 24 shots, so a storyboard of the
  whole feature isn't admitted; each later sequence's storyboard is shown at its own rough cut, and the
  look is not asked again.
- Each sequence's final follows its own approved rough cut. Its film's approval offers "Approve sequence
  k and make sequence k+1's rough cut"; the next sequence is admitted only then.
- Each sequence is finished like a short (production voices for its own scenes' lines only, the score),
  except titles: a sequence carries no title or credits, which belong to the joined feature. Until the
  last sequence, downloads and review links name the sequence.
- **The feature, joined (HV-030-30).** After the last sequence's film is finished, the Editor joins every
  sequence's film into one film, with one opening title and one end credits ("The feature's film",
  below). That film is what the last approval shows ("Approval 21 of 21: the whole feature, its 10
  sequences joined into one film"), and the one film downloaded and shared, with one review link. A join
  that stops keeps the last sequence's film on screen, with the Editor's note and "Ask the Editor to join
  the sequences again", which asks for the same join (nothing is made twice).
- Each approval shows the sequence's running cost and the feature's against its limit: "Sequence 2 of 3
  so far: $1.00. The whole feature so far: $2.00 of its $150.00 limit."
- With a final profile that starts from a still, a sequence's storyboard stills are not pinned yet (the
  desk's plan is still one render's), and the rough cut says so.
- Approval 1 shows the style bible's summary (HV-034-02): its look, palette, lighting and lens, and how
  many characters and locations it holds, "described once for the whole feature".

The read-through answer carries `expected` (the script, cast and direction versions it was written against). The plan step sends those back, so a project changed in another tab is refused rather than overwritten.

## What a film may spend (HV-019-04)

- **The limit.** Each film may spend up to `HV_FILM_SPEND_CAP_USD` ($40 by default) on paid generation. That counts what it has spent and what its queued renders hold. The monthly $500 cap still applies on top. The setting is plain dollars (`40`, `12.50`), never above the monthly cap; anything else stops the API at startup (HV-024-13).
- **A feature's own limit (HV-030-28, G20-202610031349).** A film planned as a `feature` may spend up to `HV_FEATURE_FILM_SPEND_CAP_USD` ($150 by default; held to the monthly cap if that is smaller and the setting is unset). Reels, shorts and films never planned stay at `HV_FILM_SPEND_CAP_USD`. The format is the one the crew's plan step last named, kept on the project (`format`, absent until a plan names one); planning a feature again as a short puts it back under $40. `GET /spend` reports the limit for that film. Neither the monthly cap nor the alert changes.
- **When a render would pass it,** the render is refused with 429 `budget_exhausted` and nothing is held.
- **What the creator sees.** The studio shows `GET /api/projects/:projectId/spend` at each approval, and the figure is read again as soon as a render lands, before any finishing step runs — so the number beside a button is never the number from before the render that button already paid for.
- **Pressing a button twice pays once (HV-030-07).** The studio sends **no** `idempotencyKey` for the storyboard, the pinned re-cut or the final. `POST /jobs` then derives one from what the render is of — `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}` — and answers a repeat with the job it already admitted. A re-plan, a new script version or a pinned still moves that key, so nothing is deduplicated that should not be.
- **A finishing step that fails costs a note, not a film.** The rough cut and the final go into the studio's state the moment they are rendered, before the voices, the score, the titles or the still-pinning are attempted. Each of those says what it could not do on the approval screen, and the film is kept.
- **Crew spend is separate.** The crew's model spend is its own line (below) and does not count toward the film.

## How the stand-in casts and paces (HV-017-05)

- **Casting from the script.** With no live model, Casting reads how the script introduces each character (`packages/planner/src/crew/introductions.ts`):
  - the sentence that first names them, in the screenplay's capitals first;
  - sex and age words right beside the name, from a fixed table (for example "the old keeper", "Her grandson TEO", "A young woman, SAM");
  - a pronoun after the name, when that sentence names no one else;
  - a kinship word another character calls them by ("Grandma!"), when only the two of them speak in the scene.
- **What it writes.** A plain lead ("An older woman.") plus the script's own sentence. Conflicting cues are left out, and an age the script never gives is written as "not stated in the script" rather than guessed.
- **When the text can't be used.** If the description would name a public figure, or would trip the content gate beside the script's action, the stand-in drops to the lead and then to the old placeholder.
- **Pacing.** When the final pool is paid per billed second, the Editor holds each shot the crew directs to at least the provider's shortest billed clip (Kling: 5 s), and longer when its lines need it. With a free pool, shot timing is unchanged.

## The final starts from the approved storyboard (HV-017-06)

When the final pool has a provider that starts a clip from a given frame (today `fal:kling-o3-standard-keyframes`), the plan answer carries `finalAnchors: true`. The studio then does this at the look approval:

1. It renders the storyboard and rough cut.
2. It pins each still as its shot's first frame. The still is stored as a private `shot-anchor` image, and the direction gets `frameAnchors: {frames: [{at: 0}], fallback: "stop"}`. This uses the same upload and save endpoints as the Director's desk.
3. It re-cuts the rough cut from the pinned stills, with no new pictures and at $0.

The creator approves that second rough cut, and every final clip begins from the exact picture they approved. Shots the creator anchored themselves, and stills from older renders, are left alone. A pinned shot whose provider fails stops the final rather than quietly becoming a slideshow.

## The final speaks with the approved rough cut's dialogue (HV-022-01)

The paid final providers render picture only (Kling is asked for no audio). So when a final shot comes back with no sound of its own, and the approved rough cut has a speech receipt for exactly this shot's lines at exactly this length, the worker lays that verified voice track under the final picture (`packages/queue/src/final-dialogue.ts`).

- The voice file is copied and checked against its recorded SHA-256.
- The shot's render record carries the same speech receipt as the rough cut.
- A silent shot that doesn't qualify (another length, other lines) gets a silent track and is marked `silent-captioned`. A shot with its own sound is left alone.

The Editor's pacing (HV-017-05) is what makes the lengths match.
## The crew casts production voices (HV-022-02)

When the operator has an authorized Azure catalogue (`HV_AUDIO_POLICY_FILE`), the Composer/Sound persona gives each speaking character a production voice in the same cast version as the plan (`packages/planner/src/crew/voice-casting.ts`). No model is used and nothing is spent until a take is made.

- **Sex.** It follows the script's own introduction. When the script doesn't say, any authorized voice may be chosen.
- **Sharing out.** Voices are shared evenly, least-used first, in the catalogue's fixed order (Guy, Davis, Jane).
- **Speed** starts at 1.1.
- **What is never touched.** A voice the creator chose is kept. A real (consented) cast member is never given a synthetic voice.
- **When no voice fits.** With no authorized voice of the stated sex, the character keeps the temporary voice. Every Azure voice is an adult's. The crew says so in either case.
- **No catalogue.** With none, or an unreadable one, the plan is unchanged.

## The final speaks with the cast's production voices (HV-022-03)

After the final renders, the studio does two things:

1. It records one take for each line whose character has a production voice. Each take's idempotency key is fixed by the scene, line, source, character and voice policy, so nothing is paid twice.
2. It lays those takes over the final's temporary dialogue as a dialogue replacement. Each line keeps its start.

The voiced cut is what the creator watches and shares. A line whose take fails or doesn't fit its window keeps the temporary voice. With no authorized catalogue, nothing is recorded.

## The Composer scores the film (HV-024-02)

Release 1 has no music vendor, so the Composer writes its own bed (`packages/frontend/src/score.js`). It is a slow chord pad and bass from fixed tables, rendered by the application's code as a 48 kHz WAV.

- **What decides the music.** The tone picks major or minor and the tempo. If the creator answered the Sound question with "no music", there is no score.
- **The recording's rights.** It is uploaded once to the project's sound library, with a rights record that says it is the application's own output: no third-party recording, sample or model output.
- **How it is mixed.** A `sound-mix` loops it under the finished cut (voiced when voices are on), fading in and out and ducking under every line. The request key is fixed by the cut.
- **How long the score runs (HV-030-33).** The mix runs for the picture as the worker assembled it. A final whose shots carry no recorded speech dissolves each shot into the next over 15 frames, so it runs 15 frames shorter per join than its shot records add up to (a 22-shot final of 2 s shots: 1,005 frames, not 1,320). The score is pinned to that length, and its ambience scenes are placed on it. The worker still measures the picture and refuses a score whose picture is any other length.
- **The shared cut** is the scored one. A failed mix keeps the unscored film and says so on the last approval. For a feature, the joined film's approval also names each earlier sequence whose finishing fell short ("Sequence 3 of 10: Composer: the score could not be mixed (…)"), and `scripts/studio-run.ts` records each sequence's finishing and lists the unscored sequences (`feature.unscored`).
- **Cost:** $0.

**A generated cue, when the studio has a music vendor (HV-024-11).** The sound library's listing says
whether the studio has a music vendor (`music: {generated, provider, note}`). When it has one, the
Composer asks it for one instrumental cue as long as the film, up to two minutes, with the request key
`crew-music-<final id>`, named by the picture it scores (HV-030-39: a final scored again on its voiced cut
gets the cue already made); the prompt is the Composer's own direction plus the tone. The cue goes into the
sound library and is mixed exactly where the Composer's loop would be. If the music line, the safety
gate or the vendor stops it, the Composer's own score is used and the last approval says why. A
generated cue is credited as **Music: Composer (AI crew), generated with ElevenLabs Music**, never as an
original score. With no vendor, which is the default, nothing changes. See
[SOUND-SESSIONS.md](SOUND-SESSIONS.md#generated-music-cues-hv-024-11).

**The studio's ambience, under the score (HV-024-14).** Once the score or cue is in the library, the
studio asks `POST /ambience/<cut id>` for the cut's beds and lays every cue it answers into the same
session, at the route's own levels. A session with ambience is keyed `crew-score-ambience-<cut id>`; a
score alone keeps `crew-score-<cut id>`. If the route refuses, the score is mixed alone and the last
approval says why. "No music" mixes nothing, so it has no ambience either. See
[SOUND-AMBIENCE.md](SOUND-AMBIENCE.md#the-crew-flow-hv-024-14).

## Titles

The Editor titles the film (HV-025-03). After the film is voiced and scored, the studio adds an opening title card and closing credits. The creator fills in no settings. The pure helpers are in `packages/frontend/src/titles.js`.

- **The title** is the Fountain title page's `Title:`, at most 80 characters. Without one, it is the Producer's logline, shortened at a word. Without either, it is "Untitled".
- **The credits** are, in order:
  - "Written by": the title page's `Author:` or `Credit:`, else "The creator".
  - One row for each crew persona (Producer, Director, Casting, Cinematographer, Composer and Sound, Editor), each marked "(AI crew)".
  - "Continuity by: Continuity Supervisor (AI crew)" (HV-021-09), only when the plan answered with the Supervisor's notes from the continuity report and `continuityComparisons` above zero. "Nothing to compare yet" earns no credit, and neither does a resumed film whose plan wasn't retained.
  - "Voices: synthetic (Azure neural voices)", only when the cast's production voices were laid in.
  - "Original score: Composer (AI crew)", only when the score was mixed.
  - "Ambience: Generated by the studio" (HV-024-14), only when the finished mix carried the studio's ambience beds.
- **The graphics.**
  - The title is about 4 s, transparent, over the start of the film.
  - The credits are about 6 s on a dark card, scrolling, after the film's last frame.
  - Type is sized from the frame's short side (7% for the title, 5% for the credits), so a vertical reel fits too.
  - Both are saved as motion graphics with the fixed ids `crew-title` and `crew-credits`. They are saved again only when their plan changes, and rendered with keys fixed by the saved revision.
- **The edit.**
  - The sequence is `crew-titles-<cut id>`, holding the finished cut and both graphics.
  - One timeline insert lays the title on the picture layer above the film from frame 0. The credits go after the film, and the sequence grows by their length.
  - When the cut is a scored `sound-mix`, a stretch of its music stem plays under the credits, faded out. Without a score, the credits are silent.
  - The `picture-edit` export has the fixed key `crew-titles-<cut id>`. A second attempt reuses the saved graphics and the sequence, and completes whatever an interrupted one left.
- **The shared cut** is the titled `picture-edit`. A feature's sequences carry no titles; its one title and credits are laid by the join (HV-030-30, above).
  - If the studio has no graphics renderer (`GET /graphics` answers `rendering.available: false`), the film is shared untitled and the Editor says so on the last approval.
  - Any other failure keeps the scored cut, with an "Editor: …" note.
- **Cost:** $0. The graphics and the edit run on the studio's own machine.

### The feature's film (HV-030-30)

Release 3 step 7 (G20-202610031349). A feature's sequences join into one film with an opening title and
end credits, and one review link. The join is a job of its own stage, `feature-film`
(`packages/planner/src/feature-film.ts`, `packages/assembler/src/feature-film.ts`,
`packages/queue/src/feature-film-worker.ts`, `packages/api/src/feature-film-api.ts`).

- **The assembler joins the films.** Every sequence's finished film (its final, or the dialogue
  replacement or sound mix that finished it) is joined in sequence order in one ffmpeg run: a 12-frame
  (0.4 s) dissolve at each join, the picture by `xfade` and the sound by `acrossfade`, as the assembler
  joins a film's shots, so the sound runs on unbroken from one sequence into the next. A film shorter
  than 1.6 s joins with a straight cut. Each film's captions are moved to its place in the feature.
- **One title and one credits.** The Editor renders the same two graphics as a short's (`crew-title`,
  `crew-credits`, from `titlePlans` at the feature's size), and the join lays the title over the first
  sequence's start and appends the credits card after the last frame, silent. The credits are a short's
  rows plus "Sequences by: Showrunner (AI crew)", a feature's only; voices, music and ambience are
  credited when any sequence carried them. Without a graphics renderer the films are joined untitled,
  and the Editor says so.
- **The export** is the assembler's: H.264 and AAC with its settings, the ffprobe gate (`validateExport`:
  codec, size, 30 fps, the duration of the films less the dissolves plus the credits, bitrate, sound)
  before anything is recorded, HLS segments, and a `provenance.json` (`hv-feature-film-result/1`) that
  records the join (`join: {planRevision, scriptVersion, sequences: [{number, firstScene, lastScene,
  finalJobId, filmJobId}]}`), the graphics, each film's duration, sha256 and start, and the content
  credentials. With the host's key, the export is signed beside its record (`provenance.c2pa`,
  `exportCredentials`), as every other export is.
- **`GET /api/projects/:projectId/feature-film`** answers the feature's size (its finals' render size),
  the dissolve, each sequence of the current split with its newest finished final, and the joins made.
  **`POST`** with `{idempotencyKey, generationApproved: true, sequences: [{number, jobId}], title,
  credits}` admits the join at $0, under the month and the feature's own film limit. The studio's key is
  fixed by the films and graphics it names (`featureJoinKey`), so a repeat is the same job
  (`admitted: false`).
- **What is refused (409).** A sequence with no film named; a film that isn't this project's; one that
  isn't finished; one not made from a sequence's final; one of another sequence, or of an older split;
  one whose final is stale (the screenplay, the cast or the shot directions changed after it was made,
  or its rough cut is no longer approved); one whose sequence has a newer final; a film named twice; a
  title or credits that isn't this project's finished graphic of that kind; anything but a feature
  with a split. The worker checks again before the join and before it completes (and the PostgreSQL
  ledger and job store in their transactions) that every film and graphic is still the one admitted,
  unexpired, and that every film's cast still permits it.
- **Read from the object store (HV-030-34).** On `HV_ARTIFACT_STORAGE=s3` each film, caption file and
  graphic is copied to the worker's scratch by `copyStoredArtifact` (`packages/queue/src/stored-artifact.ts`):
  streamed into a writer, its size and sha256 checked against the file its job recorded (a dialogue
  replacement, lip-sync version, sound mix or graphic lists its files; a plain final doesn't, so the
  store's checksummed record is used), then renamed into place. A missing, changed, short or long source
  fails the join and names it. The copy stops at the job's abort, at its deadline, and when the stream
  sends nothing for 120 s. `Bun.write(path, response)` is not used: on Bun 1.4.0 it never settles for the
  store's streamed Response.
- **Shown and shared** like any finished cut: the job view summarises the join (`featureFilm:
  {planRevision, sequences, title, credits, …}`, never the films' own copies), a review link binds to it
  (`permission: "approve"`), and a reviewer's decision on it approves the final. It is shown only while
  every sequence film's cast permits it.
- **Kept.** The stage is in the PostgreSQL stage check (migration `0021_feature_film`, additive) and a
  state snapshot carries the plan and its export, refusing either changed.

## The creator's style card (HV-030-19)

Release 2's "the crew remembers you", within ADR-0018: no accounts, no cookies, no tracking. The server doesn't remember the creator. The creator carries the memory (`packages/planner/src/crew/style-card.ts`, `hv-crew-style-card/1`).

- **What it holds.** The format, the tone, the look the crew settled on, and each question with whether the creator accepted the proposal or what they said instead. It holds nothing that names a project: no ids, token, script or time.
- **Where it comes from.** `POST /crew/plan` answers with `styleCard`, made from the creator's gated answers. The server keeps no copy.
- **How it is used.** `POST /crew/read-through` takes an optional `styleCard`, only when the creator attaches one. It is read for that answer and stored nowhere.
  - The crew model reads it as the creator's preferences, never as instructions.
  - The stand-in proposes, for each crew member, what the creator settled on before. The Cinematographer falls back to the card's look.
- **Creator text, gated.** Every string passes the gate the plan step uses (`gated`), at the plan's own limits, with at most three choices per persona. A card that fails is refused whole with 400, before the model is asked anything. The joined card, and the tone with it, are gated too, because the gate's paired rules (FR-054) read a whole request. The read-through then gates the prompt it would send, with the script. A refusal there is a `content_policy` concern, and nothing is sent.
- **In the studio (HV-030-20).** The finished film offers "Keep my style card in this browser" (`localStorage`, `hv-studio-style-card`, only when pressed) and "Download my style card" (`rough-cut-style-card.json`).
  - The pitch offers a kept card behind a box that starts unticked, a card file to load, and "Forget".
  - The card is sent with the read-through only when ticked, and again when the crew is sent back from the rough cut.
  - A browser that won't store anything still makes the film; the creator downloads the card instead.

## Line notes: the crew suggests, the writer takes them one line at a time (HV-016-32)

`packages/planner/src/crew/line-notes.ts`, `hv-crew-line-notes/1`.

- **Asking.** `POST /api/projects/:projectId/crew/line-notes` takes `{"request": "<what to work on>"}` (optional, 300 characters). It reads the latest saved script. The request passes the gate the plan step uses; a refused one is a 400, and nothing is sent.
- **A note** is `{id, persona, line, before, after, reason}`. `line` is the one-based physical line, as the parser's beats count it. `before` is that line's text without its surrounding whitespace and line ending. The answer carries `script: {version, sha256}`, the version the notes were written against.
- **What the crew may change.** One line's text per note, nothing else. A note that adds a line, holds a control character or Fountain note syntax, or changes how the parser reads the script (its scenes, each beat's kind, speaker and line count, what it can't read) is not a note. So dialogue stays dialogue and a cue keeps its speaker. Lines the parser hides any of, as a `[[…]]` note or boneyard, are never touched; they are found with the parser's own scanner.
- **What the crew is shown (HV-016-35).** The script, one physical line per row. A line a note may change starts with its number and `| `: a spoken line or an action line, shown whole. Every other line starts with `-| `: headings, character cues, parentheticals, transitions, the title page, blank lines, and lines holding a `[[…]]` note or boneyard. A row `== Scene 2 of 4 ==` marks each scene's heading, and the last is marked `the last scene`.
- **What the crew answers.** `{"notes": [{persona, line, after, reason}]}`: the line's number and its new text. The studio takes `before` from the script, so it is always the line's exact text. The answer may also be a bare array, either one in a code fence, or with prose around it. A `line` sent as a numeric string, a persona in capitals, or an `after` that starts with its own `36| ` are read as meant. A `before` the crew sends anyway must quote the line it numbers, counting only letters and digits (so curly quotes, spacing and the cue don't matter); otherwise the note is dropped.
- **Validated, never repaired.** At most 12 notes. A note on a line it may not change, that repeats a line already noted, or that fails any check above is dropped. So is a note the gate refuses: its `after`, its `after` with its `reason`, or the script with the note applied. Dropped notes are counted in `dropped` and never shown. This was already per note, and HV-030-25 left it so: each note is a separate edit the writer takes or skips, and a refused one is never shown.
- **Why each was dropped (HV-016-35).** `droppedReasons` counts the dropped notes by the first check each failed (only reasons with a count appear; `{}` when none):
  - `unknown_line`: no such line, a blank line, or a `before` that quotes another line.
  - `locked_line`: a line the crew doesn't change (above).
  - `unchanged`: the line as it is. `too_long`: `after` over 1000 or `reason` over 300 characters.
  - `element_change`: a line break, or the parser would read the line as another kind.
  - `gate_refused`: the gate refused it. `duplicate`: a second note on a line.
  - `malformed`: an unknown crew member, a missing or empty field, control characters or Fountain note syntax. `too_many`: past the first 12.
  - When the crew offered notes and none survived, `message` says how many and the commonest reason, in the studio's words: "The crew suggested 3 line notes, but none could be used. The most common reason, for 2 of them: …". An empty list says "The crew read the script and has no line changes to suggest." Neither ever quotes the model.
- **An answer that can't be read** is `fallbackReason: "model_unusable"` with `unusableReason`, in HV-030-25's shared codes (see "Why an answer was unusable" below). Reading the text gives `no_json` (no JSON in it) or `bad_shape` (JSON with no list of notes, HV-016-35); a reply the crew model's adapter couldn't use keeps the vendor's code (`cut_off`, `empty`, `refused_by_model`, `bad_shape`). The `message` names the reason in the studio's words, never the model's, its cost stays on the crew line, and the API logs it as `crew.answer_unusable` with `step: "line-notes"`.
- **Gated before it is sent.** A script the gate refuses, alone or with the request beside it, is never sent: `fallbackReason: "content_policy"`.
- **Spend.** The same budget line as the read-through and the plan: `assertCanSpend` first (429 `crew_budget` at the ceiling), then one event, `persona: "crew-line-notes"`.
- **The stand-in writes no notes.** With no key, or when the model can't be reached or its answer is unusable, there are no notes and the `message` says why. It never invents an edit.
- **Taking them.** `POST …/crew/line-notes/accept` takes `{version, notes, acceptedIds}` (and optionally `sha256`). `applyLineNotes` applies only the accepted notes to the script under the project's lock, and commits it as `PUT /script` commits a save. Each note replaces only its line's text and keeps the line's indentation, trailing spaces and line ending; every other byte is untouched, CRLF included.
  - **Stale:** the current script isn't that version (or its SHA-256): 409, nothing written.
  - **Refused:** a `before` that no longer matches, two accepted notes on one line, an unknown id, or a note that fails any check above: 400, nothing written.
  - **Retried:** the same accept again, after it landed, answers with the version it made (`replayed: true`) and writes nothing.
- **In the studio (HV-016-33).** The Director's desk shows "Line notes from the crew" under the screenplay (`packages/frontend/src/line-notes.js`, served as `/api/line-notes.js`).
  - "Ask the crew for line notes" saves the box first, then asks, with the optional "what should the crew work on" (300 characters). If the box no longer holds the text that was saved (a save of older text was already in flight), the crew isn't asked.
  - Each note shows its line as it is now, the proposed line, the crew member and the reason. Every note starts skipped. Accept and Skip are buttons with `aria-pressed`, updated in place so focus stays on the one pressed, and pressing them sends nothing.
  - "Apply accepted notes" is off until a note is accepted. It sends `{version, sha256, notes, acceptedIds}` once, however often it is pressed, and the panel is busy while it is out.
  - While it is out, the box is read-only and every desk save refuses. On success the box reloads to the new version, and focus moves to the panel's heading. If the box changed anyway, it is kept as the writer's unsaved draft and the panel says so. The version reported is the one the desk now holds.
  - The notes are bound to the saved version and the text in the box they were asked for. Typing in the box, or a new version saved anywhere in the desk, sets them aside before anything is sent.
  - A 409 shows the server's message and sets the notes aside. It is not retried; the writer asks again. Any other refusal keeps the notes, so the writer can skip the one refused.
  - Without a crew model, the stand-in's message is shown and there is nothing to take. Crew text is set with `textContent`, never as markup.
  - When some notes were dropped, the panel adds "N of the crew's notes couldn't be used and were left out." When none are left, it shows the server's message alone, which already counts them (HV-016-35).

## The model and its budget line

**The model** (`packages/generator/src/crew-model.ts`). Three vendors, each called with plain `fetch`. Anthropic was approved in G13; OpenRouter and Synthetic.new in G16-202610011400 (G3).

| `HV_CREW_PROVIDER` | Endpoint | Key | Default model (`HV_CREW_MODEL`) | Metered at |
|---|---|---|---|---|
| unset | Anthropic if its key is set, otherwise the stand-in (as before HV-030-24) | | | |
| `anthropic` | Anthropic Messages API | `HV_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`), in `x-api-key` | `claude-sonnet-5` | the price table |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `HV_OPENROUTER_API_KEY`, as a bearer token | `anthropic/claude-sonnet-5.5` | the larger of the price table and OpenRouter's own `usage.cost` (a number, or a string holding one); the table alone when no cost is reported |
| `synthetic` | `https://api.synthetic.new/openai/v1/chat/completions` | `HV_SYNTHETIC_API_KEY`, as a bearer token | `hf:moonshotai/Kimi-K3` | $0, with its tokens: a flat subscription |

- **Choosing.** `HV_CREW_MODEL` takes the vendor's own id, and it must be in the price table for that vendor. A model not in the table is refused at startup, because it can't be metered.
  - OpenRouter: `anthropic/claude-sonnet-5.5` and `anthropic/claude-sonnet-5` ($2 in / $10 out per million tokens), `anthropic/claude-haiku-4.5` ($1 / $5), `anthropic/claude-opus-5.5` ($4 / $20).
  - Synthetic: `hf:moonshotai/Kimi-K3`, `hf:deepseek-ai/DeepSeek-V4.1-Flash`, `hf:zai-org/GLM-5.3-Flash`, `hf:Qwen/Qwen3.8-27B`, `hf:openai/gpt-oss-120b`.
- **Startup.** A provider named without its key stops the API at startup, with a message naming the variable, never its value. So does a provider that isn't one of the three.
- **The request.** OpenRouter and Synthetic share one class, `OpenAiCompatibleCrewModel`. The crew's system prompt goes first as a `system` message, then the conversation, with `max_tokens`. OpenRouter is sent `X-Title: Rough Cut` and no `HTTP-Referer`, so nothing names the private staging host. Each call times out after 90 seconds.
- **The answer.** The text is `choices[0].message.content`, or its text parts joined when it is a list. An answer that has no text, is declined (`refusal`), is cut off at its length limit or is withheld by the vendor's filter is not used: the stand-in answers (`fallbackReason: "model_unusable"`), and the call's cost still goes on the crew line.
- **Never under-metered.** An answered call whose tokens can't be read (missing, fractional, or a body that won't parse) is not used either, and is still charged: its reported cost if it gave one, otherwise an upper bound, `max_tokens` of output plus the request's bytes as input tokens, at the table's price. It is recorded with those estimated tokens. OpenRouter always reports usage, so the crew doesn't send its deprecated `usage: {include: true}`.
- **Why an answer was unusable (HV-030-25).** A paid answer the studio can't use carries one fixed code, `unusableReason`, in the read-through, plan and line-notes answers:
  - from the vendor: `cut_off` (stopped at its token limit: OpenAI's `finish_reason: "length"`, Anthropic's `stop_reason: "max_tokens"`), `empty` (no choice, or no text), `refused_by_model` (a `refusal`, or `finish_reason: "content_filter"`), `bad_shape` (token counts that can't be read);
  - from the studio reading the text: `no_json`, `bad_shape` (not the shape asked for), `gate_refused`, `too_long`, `unknown_persona`.

  The API logs it as `crew.answer_unusable`, at `warn`, with `step` (`read-through`, `plan`, `line-notes`, `showrunner` or `style-bible`), `vendor`, `model` (the metered id), `reason`, `costUsd` and `projectId`. Each of those keys is accepted only from its closed set (the vendors, the price table's ids, the eight reasons), so the line can't carry the model's text, the prompt or a key.
- **Who answered.** A read-through, a plan or line notes the model wrote has `source` set to the vendor that answered: `anthropic`, `openrouter` or `synthetic`. The stand-in's is `stand-in`, as before.
- **Rate limits.** A 429 is treated as any unavailable model: the stand-in answers (`model_unavailable`) and nothing is spent. The crew then doesn't ask that vendor again until its `Retry-After` has passed, in seconds or as an HTTP date (30 seconds if it gives neither, at most 5 minutes), so it never retries into the limit. Synthetic allows one request at a time per model, so the crew sends it one at a time. Up to four more wait their turn, and the next is told the crew is busy. Waiting and the call share one 90-second budget: a request still waiting when it runs out, or that is aborted, leaves the queue as busy and the stand-in answers. So no crew request outlasts the staging edge's 120-second idle timeout.
- **Keys.** Entered by the operator on the staging host, never in chat or the repository. The storage launcher (`scripts/storage-runtime-launch.py`) passes only `HV_` variables, and it passes `HV_ANTHROPIC_API_KEY`, `HV_OPENROUTER_API_KEY` and `HV_SYNTHETIC_API_KEY` to the API alone, because no other process runs the crew. A key is sent only in its vendor's auth header, and never appears in an error, a log line or a request body.
- **The gate first.** Every prompt passes the gate before any vendor is called, whichever vendor it is.

**Setting it up (the operator, on the staging host).** The key goes in at a masked prompt, as `FAL_KEY` and `HV_AZURE_SPEECH_KEY` did (docs/STAGING-LOCAL.md), never in chat or a file on `H:`.

1. Add the key and the choice to the runtime secrets. For OpenRouter:
   ```
   . /etc/rough-cut/host.env
   read -rsp 'OpenRouter key: ' KEY; echo
   printf 'HV_OPENROUTER_API_KEY=%s\nHV_CREW_PROVIDER=openrouter\n' "$KEY" >> "$RC_RUNTIME/secrets.env"; unset KEY
   ```
   For Synthetic, use `HV_SYNTHETIC_API_KEY` and `HV_CREW_PROVIDER=synthetic`; for Anthropic, `HV_ANTHROPIC_API_KEY` and `HV_CREW_PROVIDER=anthropic`. Add a line `HV_CREW_MODEL=<id>` to choose a model other than the default. The file stays mode 600.
2. Check the names, never the values: `grep -o '^[A-Z_]*=' "$RC_RUNTIME/secrets.env"`.
3. Restart the API: `supervisorctl -c "$HV_SUPERVISOR_CONFIG" restart rough-cut-staging-api`. If the key is missing it won't start, and its log names the variable.
4. To go back to the stand-in, remove those lines and restart the API.

**The budget line** (`packages/operator/src/crew-ledger.ts`, `hv-crew-ledger/1`):

- Separate from the generation cost ledger and its $500 cap.
- Stored as a JSON file beside it (`HV_CREW_LEDGER_PATH`, default `crew-ledger.json` beside `HV_COST_LEDGER_PATH`).
- It records tokens and dollars per call: never prompts, never answers.
- **One line for every vendor (G16).** Whichever vendor answers, the call goes on this line, with the same alerts and the same stop. A Synthetic call is recorded at $0 with its tokens, and still can't be made once the line is stopped. Each event's `model` names the vendor: Anthropic's ids as they have always been recorded (`claude-sonnet-5`), and `openrouter:<id>` or `synthetic:<id>` for the other two.
- **Alerts:** at $25, $100, $200 and $1,000 of cumulative crew spend, each once. The API logs `crew.budget_alert`.
- **Stop:** at the approved ceiling, $1,000 by default, the crew refuses with 429 `crew_budget` (`crew.budget_stopped`) before calling the model. The operator raises the ceiling with `CrewLedger.approveCeiling`, and only upwards.

## Not yet

- **The style bible is read, not enforced (HV-034-02).** It is text in every sequence's prompts; no
  picture is compared against it, and nothing re-renders a sequence made before an edit.
- **The Director's desk still plans a feature as one render** (24 or 60 shots), so a feature's shots
  past that aren't editable at the desk, and a feature isn't resumed sequence by sequence (HV-030-29);
  a reopened link doesn't bring back the earlier sequences' films, so it doesn't join them (HV-030-30).
- **The joined feature isn't a picture edit (HV-030-30).** It can't be opened at the editorial desk or
  re-cut there, and no deliverable or interchange export is made from it yet (step 8 reads the cut).
- **Resuming inside the studio is partial (HV-016-09).** A reopened project link now opens the studio and rebuilds the furthest step whose evidence is in the project: a finished final resumes to the film and the share step; a finished rough cut resumes to the approval, so the cut already paid for is not rendered again; a saved script with nothing rendered resumes to the pitch with the script in the box; and a render still in flight is named, with the studio offering to wait for it rather than render something (HV-016-11). What the project does not hold is not invented — the read-through is the model's answer and is not stored, and neither are the format, the tone and the creator's replies to the crew's questions — so a resumed step says what it could not bring back, a resumed final is scored and titled with the Composer's own direction, and sending the crew back from a resumed rough cut is refused by name. Retaining the crew's own side of the conversation would let the whole step come back, and is not built.
- **The crew ledger is in PostgreSQL where there is one (HV-030-09), and a JSON file where there is not.** The file version guards itself with a lock on one filesystem, so two API processes on two hosts could each miss the same alert or each raise it; `PostgresCrewLedger.record` takes the budget row `FOR UPDATE` and the crossing is decided once. The spend is `sum(usd)` over an append-only event table rather than a running total, because nothing is trimmed there. The file ledger stays for a single-host deployment and for the tests, and the two answer the same things over the same sequence. A deployment that has been spending through the file and then gains a database carries its line across with `bun scripts/crew-ledger-import.ts <crew-ledger.json>`, once: it refuses a database whose crew ledger is not empty, because importing twice would double the line, and it carries the dollars the file kept but its own events could not account for as a single `carried-forward` event rather than losing them (HV-030-11).
- **Voice meetings (GPT-Live-1)** are Release 2.
