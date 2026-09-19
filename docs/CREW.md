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
- **What the creator sees.** The studio shows `GET /api/projects/:projectId/spend` at each approval.
- **Crew spend is separate.** The crew's model spend is its own line (below) and does not count toward the film.

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

- **Resuming inside the studio.** A reopened project link opens the Director's desk, because the studio does not yet rebuild its step from the project.
- **Music** (the Composer's score) and **production voice** are later steps of Release 1.
- **The crew ledger lives on one host, in a JSON file.** Moving it into PostgreSQL with the rest of the accounting needs a migration and is Release 2 work.
- **Voice meetings (GPT-Live-1)** are Release 2.
