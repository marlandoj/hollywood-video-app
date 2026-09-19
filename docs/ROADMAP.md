# Rough Cut roadmap — releases

**Status:** adopted 2026-09-19 at the operator's direction ("phase it out into versions with feature-sets; the product may not need all 25 epics for its MVP").
**Replaces:** "all 25 FULL-SCOPE epics implemented" as the build program's definition of done. `docs/FULL-SCOPE.md` stays the scope envelope; this file decides the order it ships in.
**Does not change:** ADR-0018 (free, anonymous), ADR-0020 (fail-closed launch), the safety non-negotiables, the $500 paid-provider cap, or any human gate. A release ships to **private staging**. Public launch stays behind the G7 gates whichever release is current.

## How to read this

- **An epic can span releases.** Each release takes a *slice* of an epic: the part a filmmaker needs at that stage. An epic is `done` on the board only when its full FULL-SCOPE requirement is met, which for most epics is Release 2 or later.
- **A release is done when its exit criteria are met on private staging and the operator acknowledges it (G6).** Each release gets its own G6.
- **The loop selects work from the current release's build order**, top to bottom, instead of from board order. Anything not listed in the current release waits, however small it is.
- **"Exists today"** means built and tested, usually running on mock providers. That is true of more than the board suggests. Most of editorial, sound, voice direction, shot direction, casting and the living screenplay was built before the loop began, so an epic showing 0 loop increments is not an empty epic.

## Where the product stands

The whole core loop already runs end to end on staging: screenplay → rights → cast and direction → animatic → approved final → editorial and sound → review link.

It runs on mock providers. The storyboard is labelled colour slates, the final film is solid colour cards, and the voices are the free eSpeak placeholder. The fal image and video adapters exist and have been proven with real spend ($0.144 recorded so far), but staging pins every stage to mock.

So the MVP is mostly a matter of turning real output on safely and making it shareable. It is not a matter of building new departments.

---

## Release 1 — "First Cut" (the MVP)

**Promise:** a filmmaker takes a short screenplay to a watchable, shareable film with real storyboard images, generated shots with consistent characters, a real voice, titles and a mixed soundtrack. A reviewer on another device can watch it and approve it. All of it runs on private staging.

| Epic | Release 1 slice | Today |
|---|---|---|
| Staging host (HV-040 / HV-032) | Move private staging from Zo to the operator's desktop (a WSL2 host on H:) and re-record the Wave A and observability evidence there | Zo is unstable: two restarts in 15 hours, and Prometheus down since the first |
| HV-031 Provenance and Rights | **Refuse identifiable real people before any live generation.** The prompt gate is a keyword filter and did not refuse "A portrait of Taylor Swift" (CASTING.md) | Attestation, keyword gate, takedown and tombstones exist |
| HV-029 Collaboration | Make the review link work for real reviewers: stop link-unfurl prefetches from spending views, and set a view limit people can live with | One link, 72 hours, **3 views**, and prefetches count as views |
| HV-019 Generation Router | Quality presets (draft / final, HV-019-04) and a per-film spend guard; live fal video for finals | Registry, admitted plans and cost strategies exist; staging is pinned to mock |
| HV-018 Rich Animatic | Real storyboard images on staging (fal FLUX), with spend declared | Built and proven with live fal; staging uses slates |
| HV-017 Character Identity | Qualify the existing reference-conditioned path (FLUX.2-edit and Kling O3 references) with paid runs, so a cast member looks like themselves across shots | Adapters built; no paid identity evaluation yet |
| HV-022 Performance | One production voice lane (Azure Speech or Cartesia) end to end; eSpeak stays as the free temporary voice | Both adapters and the audition flow are built; no key or policy configured |
| HV-025 VFX and Motion Graphics | Titles, lower thirds and credits rendering on the staging host (pinned Chrome runtime) | Built; the runtime is not set on staging |
| HV-023 Editorial, HV-024 Sound | No new features: verify the existing editor and sound session on real media, and fix what breaks | Built on mock media |
| HV-039 Accessibility | WCAG 2.2 AA on the core-loop screens only: create, cast, animatic, final, review | Contrast tokens, status announcements, mask viewport |
| HV-038 Observability, HV-040 Storage | Carried over; re-verified on the new host | Done (HV-038's exit claim is withdrawn until Prometheus runs) |

### Build order

1. **Staging host portability.** Take the Zo-specific paths (`/etc/zo/supervisord-user.conf` in seven places, `/home/workspace/…` in the loop config) out of the scripts, so the same bootstrap runs on any Linux host. This needs no host.
2. **Likeness refusal in the prompt gate** (HV-031). It must merge before any stage leaves mock.
3. **Review links fit for reviewers** (HV-029).
4. **Local staging cutover:** bootstrap the WSL2 host, deploy, re-record evidence, keep Zo as a fallback until verified. This needs the operator's setup steps in `docs/STAGING-LOCAL.md`.
5. **Quality presets and spend guard** (HV-019-04).
6. **Live storyboard images** (HV-018), then **live finals** (HV-019), each with `spend_usd` declared.
7. **Character consistency qualified** (HV-017) with paid runs.
8. **Production voice lane** (HV-022). This needs the operator's vendor decision (G3).
9. **Titles and credits on the staging host** (HV-025).
10. **Core-loop accessibility pass** (HV-039).
11. **Release run:** the end-to-end film below, recorded as evidence, then G6.

### Exit criteria

1. On private staging, a 2–3 scene screenplay goes end to end with real providers: storyboard images, generated shots, one production voice, titles and credits, an edited and mixed export. It is recorded in `docs/evidence/release-1/` with the actual spend.
2. A reviewer on a second device opens the review link, watches the film, and approves or requests changes.
3. The likeness refusal is live and tested before the first live generation.
4. Program paid spend stays under the $450 alert. The estimate is $100–200: about $8.40 per 24-shot Kling final (ADR-0021), cents per storyboard, and cents per voice take.
5. The Wave A and observability exit evidence re-records clean on the new host, `instrumented: true` included.
6. The operator acknowledges the release (G6).

---

## Release 2 — "Post House" (the full solo-filmmaker studio)

**Promise:** one person can write, cast, shoot, cut, score, grade and deliver a short to a professional standard.

| Epic | Release 2 slice |
|---|---|
| HV-016 Writers' Room | A real script editor with live preview; FDX and PDF import and export; revision colours and locked lines; the structural-edit owner workflow |
| HV-017 Character Identity | Identity locks beyond per-shot references; a cast library |
| HV-034 Universe and Library | The style bible, and locations and props as data. Pillar P3 has no owner today |
| HV-020 Cinematography | Native camera and subject paths; direction checked against the output rather than only carried in the prompt |
| HV-022 Performance | Lip-sync as a supported path, with quality review and retakes |
| HV-023 Editorial | Interchange export (OTIO, EDL, FCPXML); sustained realtime playback |
| HV-024 Sound | Generated music, SFX and ambience (a new vendor, G3); auto-spotting |
| HV-025 VFX | Keying, stabilization, generated inserts |
| HV-026 Color and Finishing | Grade and LUTs, and QC checks (black, freeze, levels, safe area). ffmpeg only, no vendor |
| HV-027 Delivery | ProRes/HEVC mezzanine, 9:16 and 1:1 reframes, burned subtitles, SDH |
| HV-029 Collaboration | Timecoded comments, roles, per-stage approvals |
| HV-031 Provenance and Rights | Signed C2PA, a rights ledger, image and audio moderation, and separating expiry from takedown (migration, G4) |
| HV-039 Accessibility | WCAG 2.2 AA across the whole app |

## Release 3 — "Crew" (consistency and intelligence)

**Promise:** the studio checks its own work and proposes the next step.

| Epic | Release 3 slice |
|---|---|
| HV-021 Continuity Supervisor | Continuity packets, drift detection, one-click repair |
| HV-030 AI Crew and Director Loop | Bounded agents that propose, with humans approving |
| HV-028 Localization and Dubbing | Production-qualified multi-language versions |
| HV-019 Generation Router | A second video vendor, the hero-render chain, routing on measured quality |
| HV-037 Benchmark | Internal benchmark with paid runs and a blinded rubric |

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
