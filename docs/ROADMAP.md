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
| HV-030 AI Crew | Voice meetings with the crew (GPT-Live-1; a new vendor, G3); crew memory of a creator's style across projects |
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

## Release 3 — "Features" (longer films)

**Promise:** a feature, produced as a series of sequences.

| Epic | Release 3 slice |
|---|---|
| HV-030 AI Crew | A Showrunner persona that splits a feature into sequences, each produced like a short, and holds continuity across them |
| HV-017, HV-021 | Identity and continuity that survive hundreds of shots |
| HV-019 Generation Router | A second video vendor, the hero-render chain, routing on measured quality |
| HV-028 Localization and Dubbing | Multi-language versions |
| HV-020, HV-023, HV-034, HV-025 | Native camera paths, interchange export, the style bible, VFX, as the crew needs them |
| HV-037 Benchmark | Internal benchmark with paid runs |

A feature is about 1,500 shots, so about $525 in video generation at today's prices. That is above the $500 program cap, and needs the operator's decision (G1) before the first one.

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
