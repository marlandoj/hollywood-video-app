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

- **Persona tool sets and applying answers to the project** are HV-030-02.
- **The studio front door** (pitch, questions, three approvals) is HV-030-03.
- **The crew ledger lives on one host, in a JSON file.** Moving it into PostgreSQL with the rest of the accounting needs a migration and is Release 2 work.
- **Voice meetings (GPT-Live-1)** are Release 2.
