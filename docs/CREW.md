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

Each of the first six asks at most three questions. The Continuity Supervisor asks none: it is on the roster (`CREW`) but not in `PERSONAS`, the list the read-through tells the model about and the only personas a question, an answer or a style-card choice may name. It speaks in the plan's notes, below. From HV-030-02 each persona gets a typed tool set limited to its own department's existing APIs, and every change it makes is validated exactly as a creator's edit is.

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
  - "Continuity by: Continuity Supervisor (AI crew)" (HV-021-09), only when the plan answered with the Supervisor's notes from the continuity report and `continuityComparisons` above zero. "Nothing to compare yet" earns no credit, and neither does a resumed film whose plan wasn't retained.
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
- **Validated, never repaired.** At most 12 notes. A note whose `before` isn't the exact current line, that repeats a line already noted, or that fails any check above is dropped. So is a note the gate refuses: its `after`, its `after` with its `reason`, or the script with the note applied. Dropped notes are counted in `dropped` and never shown.
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

## The model and its budget line

**The model** (`packages/generator/src/crew-model.ts`). Three vendors, each called with plain `fetch`. Anthropic was approved in G13; OpenRouter and Synthetic.new in G16-202610011400 (G3).

| `HV_CREW_PROVIDER` | Endpoint | Key | Default model (`HV_CREW_MODEL`) | Metered at |
|---|---|---|---|---|
| unset | Anthropic if `ANTHROPIC_API_KEY` is set, otherwise the stand-in (as before HV-030-24) | | | |
| `anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY`, in `x-api-key` | `claude-sonnet-5` | the price table |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `HV_OPENROUTER_API_KEY`, as a bearer token | `anthropic/claude-sonnet-5.5` | the larger of the price table and OpenRouter's own `usage.cost` |
| `synthetic` | `https://api.synthetic.new/openai/v1/chat/completions` | `HV_SYNTHETIC_API_KEY`, as a bearer token | `hf:moonshotai/Kimi-K3` | $0, with its tokens: a flat subscription |

- **Choosing.** `HV_CREW_MODEL` takes the vendor's own id, and it must be in the price table for that vendor. A model not in the table is refused at startup, because it can't be metered.
  - OpenRouter: `anthropic/claude-sonnet-5.5` and `anthropic/claude-sonnet-5` ($2 in / $10 out per million tokens), `anthropic/claude-haiku-4.5` ($1 / $5), `anthropic/claude-opus-5.5` ($4 / $20).
  - Synthetic: `hf:moonshotai/Kimi-K3`, `hf:deepseek-ai/DeepSeek-V4.1-Flash`, `hf:zai-org/GLM-5.3-Flash`, `hf:Qwen/Qwen3.8-27B`, `hf:openai/gpt-oss-120b`.
- **Startup.** A provider named without its key stops the API at startup, with a message naming the variable, never its value. So does a provider that isn't one of the three.
- **The request.** OpenRouter and Synthetic share one class, `OpenAiCompatibleCrewModel`. The crew's system prompt goes first as a `system` message, then the conversation, with `max_tokens`. OpenRouter is sent `X-Title: Rough Cut` and no `HTTP-Referer`, so nothing names the private staging host. Each call times out after 90 seconds.
- **The answer.** The text is `choices[0].message.content`. An answer that has no text, is declined (`refusal`), is cut off at its length limit or is withheld by the vendor's filter is not used: the stand-in answers (`fallbackReason: "model_unusable"`), and the call's cost still goes on the crew line. An answer with no readable `usage` is an error, because it can't be metered.
- **Who answered.** A read-through, a plan or line notes the model wrote has `source` set to the vendor that answered: `anthropic`, `openrouter` or `synthetic`. The stand-in's is `stand-in`, as before.
- **Rate limits.** A 429 is treated as any unavailable model: the stand-in answers (`model_unavailable`) and nothing is spent. The crew then doesn't ask that vendor again until its `Retry-After` has passed (30 seconds if it gives none, at most 5 minutes), so it never retries into the limit. Synthetic allows one request at a time per model, so the crew sends it one at a time. Up to four more wait their turn, and the next is told the crew is busy.
- **Keys.** Entered by the operator on the staging host, never in chat or the repository. A key is sent only in its vendor's auth header, and never appears in an error, a log line or a request body.
- **The gate first.** Every prompt passes the gate before any vendor is called, whichever vendor it is.

**Setting it up (the operator, on the staging host).** The key goes in at a masked prompt, as `FAL_KEY` and `HV_AZURE_SPEECH_KEY` did (docs/STAGING-LOCAL.md), never in chat or a file on `H:`.

1. Add the key and the choice to the runtime secrets. For OpenRouter:
   ```
   . /etc/rough-cut/host.env
   read -rsp 'OpenRouter key: ' KEY; echo
   printf 'HV_OPENROUTER_API_KEY=%s\nHV_CREW_PROVIDER=openrouter\n' "$KEY" >> "$RC_RUNTIME/secrets.env"; unset KEY
   ```
   For Synthetic, use `HV_SYNTHETIC_API_KEY` and `HV_CREW_PROVIDER=synthetic`. Add a line `HV_CREW_MODEL=<id>` to choose a model other than the default. The file stays mode 600.
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

- **Resuming inside the studio is partial (HV-016-09).** A reopened project link now opens the studio and rebuilds the furthest step whose evidence is in the project: a finished final resumes to the film and the share step; a finished rough cut resumes to the approval, so the cut already paid for is not rendered again; a saved script with nothing rendered resumes to the pitch with the script in the box; and a render still in flight is named, with the studio offering to wait for it rather than render something (HV-016-11). What the project does not hold is not invented — the read-through is the model's answer and is not stored, and neither are the format, the tone and the creator's replies to the crew's questions — so a resumed step says what it could not bring back, a resumed final is scored and titled with the Composer's own direction, and sending the crew back from a resumed rough cut is refused by name. Retaining the crew's own side of the conversation would let the whole step come back, and is not built.
- **The crew ledger is in PostgreSQL where there is one (HV-030-09), and a JSON file where there is not.** The file version guards itself with a lock on one filesystem, so two API processes on two hosts could each miss the same alert or each raise it; `PostgresCrewLedger.record` takes the budget row `FOR UPDATE` and the crossing is decided once. The spend is `sum(usd)` over an append-only event table rather than a running total, because nothing is trimmed there. The file ledger stays for a single-host deployment and for the tests, and the two answer the same things over the same sequence. A deployment that has been spending through the file and then gains a database carries its line across with `bun scripts/crew-ledger-import.ts <crew-ledger.json>`, once: it refuses a database whose crew ledger is not empty, because importing twice would double the line, and it carries the dollars the file kept but its own events could not account for as a single `carried-forward` event rather than losing them (HV-030-11).
- **Voice meetings (GPT-Live-1)** are Release 2.
