# Rough Cut roadmap — releases

**Status:** adopted 2026-09-19 at the operator's direction ("phase it out into versions with feature-sets; the product may not need all 25 epics for its MVP"). **Redrawn the same day around the AI studio crew (G13-202609192200):** the operator's product is a studio whose AI crew brings a creator's script to the screen, not a control room of settings.
**Replaces:** "all 25 FULL-SCOPE epics implemented" as the build program's definition of done. `docs/FULL-SCOPE.md` stays the scope envelope; this file decides the order it ships in.
**Does not change:** ADR-0018 (free, anonymous), ADR-0020 (fail-closed launch), the safety non-negotiables, the $500 paid-provider cap, or any human gate. A release ships to **private staging**. Public launch stays behind the G7 gates whichever release is current.

## How to read this

- **An epic can span releases.** Each release takes a *slice* of an epic: the part a filmmaker needs at that stage. An epic is `done` on the board only when its full FULL-SCOPE requirement is met, which for most epics is Release 2 or later.
- **A release is done when its exit criteria are met on private staging and the operator acknowledges it (G6).** Each release gets its own G6.
- **The loop selects work from the current release's build order**, top to bottom, instead of from board order. Anything not listed in the current release waits, however small it is.
- **"Exists today"** means built and tested, usually running on mock providers. That is true of more than the board suggests. Most of editorial, sound, voice direction, shot direction, casting and the living screenplay was built before the loop began, so an epic showing 0 loop increments is not an empty epic.

## Where the product stands

The whole core loop already runs end to end on staging: screenplay → rights → cast and direction → animatic → approved final → editorial and sound → review link. It runs on mock providers. The fal image and video adapters exist and have been proven with real spend, but staging pins every stage to mock.

That loop is driven by the creator, panel by panel. The operator's verdict (2026-09-19): too many settings. The product is a **studio**. A writer or creator brings a script, and an AI crew of personas brings it to the screen, asking only what matters and offering creative advice along the way. The engine stays. The crew drives it, and the panels move behind an **Advanced** switch as the "Director's desk".

---

## Release 1 — "Studio" (reels and shorts, the MVP)

**Promise:** a creator pastes a script, answers a short conversation with the crew, approves three times, and gets a shareable reel (up to 90 s) or short (up to 10 min) with real storyboard images, generated shots with consistent characters, a real voice, music and titles. A reviewer on another device can watch and approve it. All of it runs on private staging.

### The experience

1. **Pitch.** Paste or upload the script, then pick a format (reel or short) and a tone in a sentence.
2. **Read-through.** The Producer summarizes the film back, proposes a length and budget, and flags what it can't make: public figures, content-policy problems, and scope over the format.
3. **Crew questions.** Director, Casting, Cinematographer, Composer/Sound and Editor each ask at most three questions, each with a proposed answer the creator can accept in one click. Every setting the app has is filled in by a persona.
4. **Three approvals, with the estimate shown at each:**
   - the look (storyboard frames);
   - the rough cut (animatic with temporary voices);
   - the final.

   At each one the crew offers optional advice.
5. **Share.** A review link (HV-029-05).

### Crew rules

- **A persona is a prompt plus a typed tool set, not a new engine.** It can only call the existing APIs for its department, and its changes are validated by the same code as a human edit: permissions, the likeness rules, budgets.
- **Nothing a persona does spends money on its own.** Generation spend is admitted only at an approval, under the existing caps and the $500 program cap (alert at $450).
- **Crew thinking is Claude, through the Anthropic API (G13, and G3 when the key is entered).** It is metered on its **own budget line**. Alerts go to the operator at **$25, $100, $200 and $1,000**; at **$1,000 the crew stops** until the operator approves more.
- **Voice** (GPT-Live-1) is Release 2, on the same crew.
- **The Director's desk** (today's panels) is hidden behind an **Advanced** switch.

### Build order

| # | Increment | Notes |
|---|---|---|
| — | Done: host portability (HV-032-03), consented casting (HV-031-04), review links (HV-029-05), staging on the desktop (HV-032-04) | |
| 1 | **Crew conversation core** (HV-030) | Claude client behind a switch (deterministic stand-in replies until the key is entered); the conversation record; the crew budget meter; the Producer read-through |
| 2 | **Persona tool sets** (HV-030) | Each persona drives the existing APIs of its department, validated as a human edit is |
| 3 | **Studio front door** (HV-030, HV-039) | Pitch → questions → three approvals. The panels move behind Advanced. Accessibility on the new screens |
| 4 | **Spend guard and draft/final** (HV-019) | A per-film cap, and estimates at each approval |
| 5 | **Live storyboards, then live finals** (HV-018, HV-019, HV-017) | fal, with `spend_usd` declared; character consistency checked on these runs |
| 6 | **Production voice** (HV-022) | Azure Speech for dialogue |
| 7 | **Music and titles** (HV-024, HV-025) | The Composer uses the existing sound tools; titles render on the host |
| 8 | **Release run** | One reel and one short, script to shared film, recorded with actual spend, then G6 |

The Wave A and observability exit evidence is re-recorded on the desktop host once, as housekeeping, when the host is upgraded to a release carrying HV-032-04.

### Exit criteria

1. A creator goes from pasted script to shared film for one reel and one short on private staging, by conversation and three approvals, without opening the Director's desk. It is recorded in `docs/evidence/release-1/` with actual generation and crew spend.
2. A reviewer on a second device opens the review link, watches, and approves or requests changes.
3. Consented casting and the public-figure refusal hold for everything the crew writes.
4. Generation spend stays under the $450 alert, and crew spend is reported on its own line.
5. The operator acknowledges the release (G6).

## Release 2 — "Voice and crew depth"

**Promise:** talk the film through with the crew, and the crew remembers you.

| Epic | Release 2 slice |
|---|---|
| HV-030 AI Crew | Voice meetings with the crew (GPT-Live-1; a new vendor, G3), dropped in G19, since text chat is the crew's interface; crew memory of a creator's style across projects |
| HV-021 Continuity Supervisor | A continuity persona: drift detection and one-click repair |
| HV-017 Character Identity | Identity locks beyond per-shot references; a cast library |
| HV-022 Performance | A second voice vendor: ElevenLabs, primary with Azure behind it (G14), on its own $25 line |
| HV-024 Sound | Generated music, SFX and ambience (a new vendor, G3) |
| HV-026 Color and Finishing | Grade and LUTs, QC checks. ffmpeg only |
| HV-027 Delivery | 9:16 and 1:1 reframes, burned subtitles, SDH, mezzanine |
| HV-016 Writers' Room | FDX and PDF import; the crew suggests script revisions the writer accepts line by line |
| HV-029 Collaboration | Timecoded comments and per-stage approvals |
| HV-031 Provenance and Rights | Signed C2PA, image and audio moderation, separating expiry from takedown (migration, G4) |
| HV-039 Accessibility | WCAG 2.2 AA across the whole app, the Director's desk included |

### Release 2 exit criteria (proposed; agreed at G6)

Proposed by HV-030-22, run by HV-030-23, and agreed by the operator at Release 2's G6. The run is
recorded in `docs/evidence/release-2/release-run.json` (schema `hv-release-run/2`), and
`test/release-2-run.test.ts` holds that record to these criteria and to the two tables below.

1. **Two films by the same creator, the second pitched with the first's style card.** Film A goes
   from a pasted script to a shared film through the studio's front door, and the creator keeps its
   style card. Film B is pitched with that card attached, and its read-through says the crew read it.
2. **Reviewed on a second device.** Each film's review link is opened on the operator's phone. Each
   link carries at least one timecoded comment and a decision that names the stage it decides.
3. **Every Release 2 slice is accounted for.** Each part in the table below is either exercised, with
   real ids in the record, or explicitly deferred, citing an entry that exists in
   `docs/loop/HUMAN-GATES.md`. A part can't be left unsaid.
4. **Within declared spend on every line.** The record declares its spend. The run's spend across the
   lines stays within it, and each line stays within its own limit below.
5. **Signed C2PA sidecars verify when the host holds the key.** Every shared film's export carries a
   `provenance.c2pa` whose bytes match its record and which `scripts/verify-c2pa.ts` reads as valid.
   If the host holds no key, the signed-C2PA part is deferred instead.
6. **Each step names the surface it used.** Release 1 ran without opening the Director's desk.
   Release 2's slices live mostly behind it, so the record says, step by step, which surface did the
   work. It makes no claim that the desk was never opened.
7. The operator acknowledges the release (G6).

**The surfaces.**

- `front-door` is the studio flow (`createStudioFlow`), driven by `scripts/studio-run.ts`.
- `desk-api` is the Director's desk's own routes, driven by `scripts/release-2-run.ts`.
- `reviewer` is the review link, opened on a second device.
- `operator` is a host script the operator runs, with its output committed under
  `docs/evidence/release-2/`.
- `audit` is a repository audit.

For `operator` and `audit` the record's ids are repository paths. For the others they are the
studio's own ids: project, job, character, comment and asset UUIDs, review-link digests and file
SHA-256s.

**The parts of each slice.**

| Part | Epic | Surface | Exercised when |
|---|---|---|---|
| HV-030.voice-meetings | HV-030 | front-door | A voice meeting with the crew is held (GPT-Live-1) |
| HV-030.style-memory | HV-030 | front-door | Film B's read-through read film A's style card |
| HV-021.continuity-repair | HV-021 | desk-api | The Supervisor's report and repair are reviewed, and any edits it proposes are applied |
| HV-017.identity-lock | HV-017 | desk-api | A character's look is locked to its retained images |
| HV-017.cast-library | HV-017 | desk-api | An actor from film A is shared and imported into film B |
| HV-022.elevenlabs-voice | HV-022 | front-door | A film's voices are cast from ElevenLabs and its takes are done |
| HV-024.music | HV-024 | desk-api | A generated music cue lands in a film's sound library |
| HV-024.ambience | HV-024 | desk-api | The studio's ambience beds are made for a film's scenes |
| HV-024.sfx | HV-024 | desk-api | A generated sound effect lands in a film's sound library |
| HV-026.grade-qc | HV-026 | desk-api | A grade is delivered with its own quality check |
| HV-027.reframes | HV-027 | desk-api | The 9:16 and 1:1 reframes are delivered |
| HV-027.captions | HV-027 | desk-api | Burned subtitles and the SDH track are delivered |
| HV-027.mezzanine | HV-027 | desk-api | The mezzanine is delivered |
| HV-016.import | HV-016 | desk-api | A Final Draft or PDF screenplay is imported and read back |
| HV-016.line-notes | HV-016 | desk-api | The crew's line notes are asked for and at least one is accepted |
| HV-029.timecoded-comments | HV-029 | reviewer | A reviewer pins a comment to a frame |
| HV-029.stage-approvals | HV-029 | reviewer | A reviewer's decision names the stage it decides |
| HV-031.signed-c2pa | HV-031 | desk-api | Each shared export's signed sidecar matches its record and verifies |
| HV-031.moderation | HV-031 | desk-api | Image and audio moderation refuses on a run |
| HV-031.expiry-takedown | HV-031 | operator | The expiry report runs on the host and its output is committed |
| HV-039.wcag | HV-039 | audit | The accessibility audit has no failing cell |

**The spend lines.**

| Line | Limit (USD) | Basis |
|---|---|---|
| generation | 450 | The program's alert, under the $500 cap |
| voice | 25 | ElevenLabs' own line (G14) |
| music | 10 | ElevenLabs Music's own line (G15) |
| crew | 25 | The crew line's first alert (G13); the crew stops at $1,000 |

## Release 3 — "Features" (longer films)

**Promise:** a feature, produced as a series of sequences.

| Epic | Release 3 slice |
|---|---|
| HV-030 AI Crew | A Showrunner persona that splits a feature into sequences, each produced like a short, and holds continuity across them |
| HV-017, HV-021 | Identity and continuity that survive hundreds of shots |
| HV-019 Generation Router | A second video vendor, the hero-render chain, routing on measured quality |
| HV-020, HV-023, HV-034, HV-025 | Native camera paths, interchange export, the style bible, VFX, as the crew needs them |
| HV-037 Benchmark | Internal benchmark with paid runs |

**English only (G19).** Multi-language versions (HV-028) moved out of Release 3. They come back when
the operator asks for them.

**The proof is a short feature (G19).** A full feature is about 1,500 shots, about $525 of video at
$0.35 per 5-second clip, which is over the $500 program cap. Release 3 is proven instead on a 15–20
minute feature of about 200–240 shots, rendered live: about $70–85 of video. The exit run declares
about $135, which leaves room for retakes. G20 planned about $120; the operator raised it to $135 when
the live run started (G23). The cap is unchanged. Rendering a full-length feature
is a separate operator decision (G1) for later. The second video vendor for the hero-render chain
still needs the operator's approval (G3) before it spends.

### Release 3 exit criteria (proposed; agreed at G6)

Proposed by HV-030-27 and agreed at G20-202610031349. The run will be recorded in
`docs/evidence/release-3/release-run.json` (schema `hv-release-run/3`), and
`test/release-3-run.test.ts` (HV-030-31) holds that record to these criteria and to the two tables
below, as `test/release-2-run.test.ts` does for Release 2. The run's drivers and runbook are in
`docs/loop/increments/HV-030-31.md`.

1. **One feature, from pasted script to one shared film, with live picture.** One original script
   of 15–20 minutes (900–1,200 s of planned shots, about 200–240 shots) is pitched at the front door
   as a `feature`. The Showrunner splits it into sequences, and each sequence is produced like a
   short. The sequences are joined into one film with one review link. Every shot in the shared film
   comes from the live fal profile; none is a mock slate.
2. **One cast and one look across every sequence.** Each recurring character is locked once and
   every shot that character appears in, in every sequence, is rendered from that lock. The
   Continuity Supervisor's report covers the whole feature, including across each sequence boundary,
   and each finding is repaired or explicitly kept before the final.
3. **Reviewed on a second device.** The feature's review link is opened on the operator's phone. It
   carries timecoded comments in at least three different sequences and a decision that names the
   stage it decides.
4. **Every Release 3 slice is accounted for.** Each part in the table below is either exercised, with
   real ids in the record, or explicitly deferred, citing an entry that exists in
   `docs/loop/HUMAN-GATES.md`. A part can't be left unsaid. `HV-019.second-vendor` can be exercised
   only after a G3 entry approves that vendor; until then it can only be deferred.
5. **Within declared spend on every line.** The record declares its spend: about $120 for the
   feature. The run's spend across the lines stays within it, each line stays within its own limit
   below, and the feature stays within its own film limit. No cap or default is raised by the run.
6. **The crew's rules hold at feature length.** Consented casting and the public-figure refusal hold
   for everything the crew and the Showrunner write. The film is in English only.
7. **The shared feature carries its provenance.** Its export has a signed C2PA sidecar whose bytes
   match its record and which `scripts/verify-c2pa.ts` reads as valid.
8. **Each step names the surface it used**, as in Release 2.
9. The operator acknowledges the release (G6).

**The surfaces** are Release 2's: `front-door`, `desk-api`, `reviewer`, `operator` and `audit`.

**The parts of each slice.**

| Part | Epic | Surface | Exercised when |
|---|---|---|---|
| HV-030.feature-format | HV-030 | front-door | A 15–20 minute script is pitched as a feature, and the read-through quotes its runtime, shots and cost against the feature's limits |
| HV-030.showrunner | HV-030 | front-door | The Showrunner splits the feature into sequences, and each sequence passes its approvals like a short |
| HV-030.feature-assembly | HV-030 | front-door | The approved sequences are joined into one film, shared with one review link |
| HV-030.feature-review | HV-030 | reviewer | The feature is reviewed on a second device, with comments in at least three sequences and a decision |
| HV-017.feature-identity | HV-017 | front-door | Every shot of each locked character, in every sequence, is rendered from that character's lock |
| HV-021.cross-sequence-continuity | HV-021 | desk-api | The Supervisor's report compares across every sequence boundary, and its repair is reviewed and applied |
| HV-019.second-vendor | HV-019 | front-door | Shots of the feature are rendered by a second video vendor, after its G3 approval |
| HV-019.hero-chain | HV-019 | desk-api | A hero shot goes through the hero-render chain, and each stage records its own provenance |
| HV-019.quality-routing | HV-019 | front-door | The feature's finals are routed on a measured quality score, and each provider plan names the benchmark record behind it |
| HV-020.native-camera | HV-020 | desk-api | A camera move reaches the provider as its own camera control, not as a local crop |
| HV-023.interchange | HV-023 | desk-api | The feature's cut is exported as OTIO and as a CMX 3600 EDL, and each reads back to the same shots and frames |
| HV-034.style-bible | HV-034 | front-door | The Showrunner writes the feature's style bible once, and every sequence's plan reads it |
| HV-025.titles-credits | HV-025 | front-door | The feature carries an opening title and an end-credit roll |
| HV-025.vfx-composite | HV-025 | desk-api | A masked composite is rendered into a shot of the feature |
| HV-037.paid-benchmark | HV-037 | operator | The benchmark corpus runs on the live profile, and its record and spend are committed under `docs/evidence/release-3/` |

**The spend lines.**

| Line | Limit (USD) | Basis |
|---|---|---|
| generation | 450 | The program's alert, under the $500 cap. The feature run declares about $135 (G23); the paid benchmark declares its own, about $20 |
| voice | 25 | ElevenLabs' own line (G14) |
| music | 10 | ElevenLabs Music's own line (G15) |
| crew | 25 | The crew line's first alert (G13); the crew stops at $1,000 |

The feature's own film limit is a separate check, not a line: it bounds what one film may have
spent and held, as the $40 limit does for a reel or a short. Its value is a G6 decision (see
HV-030-27).

### Build order

| # | Increment | Notes |
|---|---|---|
| — | Done: Release 2 acknowledged (G6-202610030339); Release 3 scope set (G19-202610030430) | |
| 1 | **Feature format and its film limit** (HV-030, HV-019) | `feature` beside reel and short, up to 1,200 s. Its own film limit, agreed at G6; reel and short keep $40. The read-through quotes the profile's real price |
| 2 | **Showrunner** (HV-030) | Splits a feature into sequences of at most 24 shots, the per-render limit. Each sequence gets its rough cut and final; the look is approved once |
| 3 | **Style bible** (HV-034) | Written once by the Showrunner from the creator's answers and style card; every sequence's plan reads it |
| 4 | **Identity across sequences** (HV-017) | Each character's lock is carried into every sequence's renders, and the record can show it per shot |
| 5 | **Continuity across sequences** (HV-021) | The Supervisor compares each sequence's last scene with the next one's first, as it does across a `CONTINUOUS` heading |
| 6 | **Voice holds at feature scale** (HV-022) | A take holds the price of its own line, not of 10,000 characters, so 200 lines fit the $25 line. No cap is raised |
| 7 | **Feature assembly, titles and review** (HV-030, HV-025, HV-029) | Sequences join into one film with an opening title and end credits; one review link |
| 8 | **Interchange export** (HV-023) | OTIO and CMX 3600 EDL of the feature's cut, read back in a test |
| 9 | **Benchmark with paid runs** (HV-037) | Measured scores, starting with identity similarity; one paid pass of the 24-shot corpus per fal video model, about $20, declared |
| 10 | **Routing on measured quality** (HV-019) | A `quality` routing strategy that ranks eligible providers by the benchmark's scores, never by invented ones |
| 11 | **Hero-render chain** (HV-019) | Upscale, frame rate and denoise on a chosen shot, each stage with its own provenance; any paid stage is declared |
| 12 | **Native camera paths and a VFX composite, as the crew needs them** (HV-020, HV-025) | Native camera control only where a provider in the pool takes it; otherwise the part is deferred to a gate entry |
| 13 | **Second video vendor** (HV-019) | Only after a G3 entry approves a vendor; otherwise `HV-019.second-vendor` is deferred to that entry |
| 14 | **Release 3 run driver and contract** (HV-030) | As HV-030-22 did for Release 2: the driver, the record's schema and the contract test, proved on a synthetic fixture |
| 15 | **Mock rehearsal** | The whole feature on the mock profile, at $0, to find what breaks at 20 minutes and 240 shots before money is spent |
| 16 | **Release run** | The feature, live, with about $120 declared; then G6 |

## Release 4 — "Platform" (public-facing; every item here sits behind G7 and ADR-0020)

| Epic | Release 4 slice |
|---|---|
| HV-032 Capacity | GPU lane, CDN, public capacity page |
| HV-033 Platform SDK | Public REST API with OpenAPI, CLI, MCP server, webhooks |
| HV-038 Observability | SLO, alerting, log shipping, multi-region |
| HV-040 Storage | CDN and multi-region |
| HV-037 Benchmark | The public leaderboard |
| HV-027 Delivery | Festival, DCP and IMF packages; publishing adapters |

## Horizon — "Beyond the Frame"

| Epic | Scope |
|---|---|
| HV-035 3D Previs and Virtual Production | As FULL-SCOPE P18 |
| HV-036 Interactive and Immersive | As FULL-SCOPE P18 |
| HV-028 Localization and Dubbing | Multi-language versions, moved out of Release 3 by G19; brought back when the operator asks |

These are not scheduled. They are revisited after Release 3.

---

## The audit backlog, placed

| Item | Release | Why there |
|---|---|---|
| Review-link view burn | 1 | Sharing is part of the MVP promise |
| Graphic-receipt versioning | 2 | Titles work without it |
| Generator manifests with no timestamp of their own (five stages) | 2 | Part of HV-031's signed provenance |
| Retention sweeper writing takedown records for ordinary expiry | 2 | Needs a migration (G4); part of HV-031 |
| Five divergent `class Element` test DOM stubs | Whenever a frontend test is touched | Hygiene, not a deliverable |
