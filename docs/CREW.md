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

Each asks at most three questions. From HV-030-02 each persona gets a typed tool set limited to its own department's existing APIs, and every change it makes is validated exactly as a creator's edit is.

## The read-through (HV-030-01)

`POST /api/projects/:projectId/crew/read-through` takes `{"format": "reel" | "short", "tone": "<one sentence>"}` and is limited to the project's owner. It reads the latest saved script.

The answer, `hv-crew-read-through/1`, keeps two things apart.

**`facts`** are computed by the studio, deterministically. The model never states them, so it can't misstate them. They are:

- scenes, shots and speaking characters;
- the estimated runtime, against the format limit (reel 90 s, short 600 s);
- the final-video estimate from the registered price of `fal:kling-v2.5-turbo-pro`;
- the `concerns`:
  - `public_figure`
  - `content_policy`
  - `over_format`
  - `empty_script`

**The crew's voice** is written by the model: `logline`, `summary`, and `questions` (`persona`, `question`, `proposal`). Every string must pass the same prompt gate as any generation prompt. Any defect makes the whole answer unusable, and then the stand-in crew answers instead.

- **A script the gate refuses is never sent to the model.** The creator sees the concern instead.
- **The stand-in crew.** With no key, or when the model can't be reached or its answer is unusable, the voice is written deterministically from the facts: `source: "stand-in"`, with `fallbackReason` when a live model was configured. So the flow works, and is tested, without any vendor.

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
- **The answer** is `hv-crew-plan-result/1`: the look note, the crew's notes (which persona changed what), the new versions and the spend.

## The studio front door (HV-030-03)

The page opens on the studio (`packages/frontend/src/studio.js`, served at `/api/studio/app.js`). Every detailed panel, the "Director's desk", sits behind the **Advanced** switch in the header. The switch is remembered per browser in `localStorage`, never sent anywhere, and a resumed project link opens the desk.

1. **Pitch.** Script, format (reel or short), tone, and the creator's rights attestation, then the Producer's read-through. A public figure, a content-policy refusal or an empty script keeps the creator at the pitch, with the reason.
2. **Questions.** Each crew question is shown with its proposal: "Sounds good" or "Something else" with a reply. Then **Plan the film** (`/crew/plan`).
3. **Approval 1, the plan.** The crew's notes, the look, and the cast. The creator attests once that the crew's cast are original characters they may use: `POST /api/projects/:projectId/crew/approve-cast` with `{attested: true, expectedVersion}`.
   - This permits every pending **original** character in one cast version.
   - A real person's consent is never given here; that stays in the cast editor.
   - Then the storyboard and rough cut render.
4. **Approval 2, the storyboard and rough cut.** Approve to make the final, or **Ask the crew for changes**, which goes back to a fresh read-through.
5. **Approval 3, the film.** Download, or share with a reviewer, choosing how many viewers (`docs/REVIEW-LINKS.md`).

The read-through answer carries `expected` (the script, cast and direction versions it was written against). The plan step sends those back, so a project changed in another tab is refused rather than overwritten.

## What a film may spend (HV-019-04)

- **The limit.** Each film may spend up to `HV_FILM_SPEND_CAP_USD` ($40 by default) on paid generation. That counts what it has spent and what its queued renders hold. The monthly $500 cap still applies on top.
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
- **The shared cut** is the scored one. A failed mix keeps the unscored film and says so on the last approval.
- **Cost:** $0.

## Titles

The Editor titles the film (HV-025-03). After the film is voiced and scored, the studio adds an opening title card and closing credits. The creator fills in no settings. The pure helpers are in `packages/frontend/src/titles.js`.

- **The title** is the Fountain title page's `Title:`, at most 80 characters. Without one, it is the Producer's logline, shortened at a word. Without either, it is "Untitled".
- **The credits** are, in order:
  - "Written by": the title page's `Author:` or `Credit:`, else "The creator".
  - One row for each crew persona (Producer, Director, Casting, Cinematographer, Composer and Sound, Editor), each marked "(AI crew)".
  - "Voices: synthetic (Azure neural voices)", only when the cast's production voices were laid in.
  - "Original score: Composer (AI crew)", only when the score was mixed.
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
- **The shared cut** is the titled `picture-edit`.
  - If the studio has no graphics renderer (`GET /graphics` answers `rendering.available: false`), the film is shared untitled and the Editor says so on the last approval.
  - Any other failure keeps the scored cut, with an "Editor: …" note.
- **Cost:** $0. The graphics and the edit run on the studio's own machine.

## The creator's style card (HV-030-19)

Release 2's "the crew remembers you", within ADR-0018: no accounts, no cookies, no tracking. The server doesn't remember the creator. The creator carries the memory (`packages/planner/src/crew/style-card.ts`, `hv-crew-style-card/1`).

- **What it holds.** The format, the tone, the look the crew settled on, and each question with whether the creator accepted the proposal or what they said instead. It holds nothing that names a project: no ids, token, script or time.
- **Where it comes from.** `POST /crew/plan` answers with `styleCard`, made from the creator's gated answers. The server keeps no copy.
- **How it is used.** `POST /crew/read-through` takes an optional `styleCard`, only when the creator attaches one. It is read for that answer and stored nowhere.
  - The crew model reads it as the creator's preferences, never as instructions.
  - The stand-in proposes, for each crew member, what the creator settled on before. The Cinematographer falls back to the card's look.
- **Creator text, gated.** Every string passes the gate the plan step uses (`gated`), at the plan's own limits, with at most three choices per persona. A card that fails is refused whole with 400, before the model is asked anything.

## The model and its budget line

**The model** (`packages/generator/src/crew-model.ts`):

- Claude through the Anthropic Messages API, called with plain `fetch`.
- The model is `HV_CREW_MODEL`, default `claude-sonnet-5`. A model not in the price table is refused, because it can't be metered.
- The key is `ANTHROPIC_API_KEY`, entered by the operator on the staging host. It is sent only in the `x-api-key` header, and never appears in an error or a log line.

**The budget line** (`packages/operator/src/crew-ledger.ts`, `hv-crew-ledger/1`):

- Separate from the generation cost ledger and its $500 cap.
- Stored as a JSON file beside it (`HV_CREW_LEDGER_PATH`, default `crew-ledger.json` beside `HV_COST_LEDGER_PATH`).
- It records tokens and dollars per call: never prompts, never answers.
- **Alerts:** at $25, $100, $200 and $1,000 of cumulative crew spend, each once. The API logs `crew.budget_alert`.
- **Stop:** at the approved ceiling, $1,000 by default, the crew refuses with 429 `crew_budget` (`crew.budget_stopped`) before calling the model. The operator raises the ceiling with `CrewLedger.approveCeiling`, and only upwards.

## Not yet

- **Resuming inside the studio is partial (HV-016-09).** A reopened project link now opens the studio and rebuilds the furthest step whose evidence is in the project: a finished final resumes to the film and the share step; a finished rough cut resumes to the approval, so the cut already paid for is not rendered again; a saved script with nothing rendered resumes to the pitch with the script in the box; and a render still in flight is named, with the studio offering to wait for it rather than render something (HV-016-11). What the project does not hold is not invented — the read-through is the model's answer and is not stored, and neither are the format, the tone and the creator's replies to the crew's questions — so a resumed step says what it could not bring back, a resumed final is scored and titled with the Composer's own direction, and sending the crew back from a resumed rough cut is refused by name. Retaining the crew's own side of the conversation would let the whole step come back, and is not built.
- **The crew ledger is in PostgreSQL where there is one (HV-030-09), and a JSON file where there is not.** The file version guards itself with a lock on one filesystem, so two API processes on two hosts could each miss the same alert or each raise it; `PostgresCrewLedger.record` takes the budget row `FOR UPDATE` and the crossing is decided once. The spend is `sum(usd)` over an append-only event table rather than a running total, because nothing is trimmed there. The file ledger stays for a single-host deployment and for the tests, and the two answer the same things over the same sequence. A deployment that has been spending through the file and then gains a database carries its line across with `bun scripts/crew-ledger-import.ts <crew-ledger.json>`, once: it refuses a database whose crew ledger is not empty, because importing twice would double the line, and it carries the dollars the file kept but its own events could not account for as a single `carried-forward` event rather than losing them (HV-030-11).
- **Voice meetings (GPT-Live-1)** are Release 2.
