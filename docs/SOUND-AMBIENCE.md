# Studio ambience beds (HV-024-12)

The studio generates its own ambience beds: room tone, wind, rain, traffic, surf, crowd murmur and night air. FFmpeg makes each one from seeded noise sources and fixed filters. No vendor, recording, sample or model output is involved, so a bed costs nothing (`costUsd: 0`, no reservation) and needs no new gate.

## The catalogue

`packages/planner/src/sound-ambience.ts` holds seven presets under recipe `hv-ambience/1`:

| id | label | made from |
|---|---|---|
| `room-tone` | Room tone | brown noise, 30–500 Hz |
| `wind` | Wind | pink noise, 80–1200 Hz, slow gusts (0.15 Hz tremolo) |
| `rain` | Rain | white noise, 400–4000 Hz, trimmed 4 dB |
| `traffic` | Traffic hum | brown noise, 25–350 Hz, passing swells (0.1 Hz) |
| `surf` | Surf | pink noise, 60–2500 Hz, a wave every 10 s |
| `crowd` | Crowd murmur | pink noise, 250–2500 Hz, light 2.5 Hz movement, trimmed 2 dB |
| `night` | Night air | pink noise, 100–800 Hz, with a pulsed 4.5 kHz insect tone |

Each preset has a fixed seed. The left and right channels use the seed and the seed plus one, so the bed is wide rather than mono.

## Rendering

`packages/generator/src/sound-ambience.ts` renders 21 seconds with one filter thread. It then lays the last second over the first with an equal-power crossfade, which makes a 20-second loop (960,000 frames) with no click at the seam. Every tremolo rate and the tone complete whole cycles in 20 seconds, so the crossfade joins them in phase.

The loop is scaled so its sample peak is −18 dBFS, less the preset's trim. The output is canonical 48 kHz stereo 24-bit PCM with the fixed 44-byte header.

- **Deterministic.** The same recipe, preset and FFmpeg runtime give the same bytes. A different FFmpeg build may differ in the last bits of its floating-point filters. The library keeps the bytes it rendered, and the asset's `engineVersion` names the runtime, so a delivered version never depends on rendering again.
- **Loudness.** Every preset measures between −34 and −28 LUFS integrated, with a true peak at or below −17 dBTP, on FFmpeg's `ebur128` meter. The tests measure every preset this way.

## Choosing a scene's bed

`ambienceForHeading` reads the scene heading. The first rule that matches wins:

1. **Weather words.** RAIN, STORM, DOWNPOUR and similar give `rain`, inside or out.
2. **Shore words.** BEACH, SHORE, COAST, OCEAN, SEA, PIER, HARBOR and DOCK give `surf`.
3. **Busy places.** BAR, PUB, RESTAURANT, CAFE, MARKET, STATION, AIRPORT, PARTY, CLUB and LOBBY give `crowd`.
4. **Roads.** STREET, CITY, ROAD, HIGHWAY, ALLEY, PARKING, CAR, TAXI and BUS give `traffic`.
5. **Open country, exteriors only.** FOREST, WOODS, FIELD, MOUNTAIN, DESERT, HILL and ROOFTOP give `wind`.
6. **Any other exterior.** `EXT.` gives `night` when the heading says NIGHT, and otherwise `wind`.
7. **Everything else.** Interiors, `INT./EXT.` with no telling word, and headings with no INT or EXT get `room-tone`.

Words match whole words only, so CARPET is not CAR.

The studio never chooses silence. The creator can override any scene with a catalogue id or `"none"`. An override for a scene that isn't in the cut, or for a preset that isn't in the catalogue, is refused rather than ignored.

## The scenes of a cut

A cut's scenes come from its base film's shots in cut order (`shot-<scene>-<n>`, each `round(durationSec × 30) × 1600` samples) and the headings in the film's screenplay. Consecutive shots of one scene make one span. If the shots do not name scenes in the screenplay, or do not add up to the cut's length, the whole cut is one span under the first heading.

## Cues and the mix

`ambienceCues` makes one looping `ambience` cue for each run of neighbouring scenes that share a bed, so a cut between two rooms with the same bed does not dip. Each cue is set as follows:

- **Level.** −6 dB, ducked 6 dB under measured voice windows. The attack is 0.1 s and the release is 0.4 s.
- **Fades.** One second at the film's start and end, and a quarter-second at a scene boundary where the bed changes. No fade is longer than a quarter of its cue.
- **Identity.** Cue ids are derived from the cut's id, so asking again answers the same cues.

These are ordinary sound-session cues. The existing mixer, cue sheet, SDH labels (`[ambience: Surf]`), archive and restore contracts handle them unchanged. M&E and the mix include the ambience stem as before.

## API

- `GET /api/projects/<id>/ambience/<cutId>` returns the catalogue, each scene's span and bed, and `chosenBy` (`heading` or `creator`). It also returns `costUsd: 0`.
- `POST /api/projects/<id>/ambience/<cutId>` with `{overrides?: {"<scene>": "<preset>"|"none"}}` renders any bed the scenes need that the library does not hold. It saves each one and returns 201, or 200 when every bed was already there. The answer carries `{presets, scenes, cues, library, costUsd: 0}`. The `cues` go into the `session.cues` of `POST /sound-mixes/<cutId>`, beside any music, for review and rendering.

The route uses the server's one-at-a-time sound import slot. When the slot is busy it answers 429 *"A recording is being processed. Try again shortly."* Rendering a bed and saving it to the library check project rights and the library version, as an upload does.

A studio bed in the library is recognised by four things: its label, its rights source, the `original` basis and the loop's length. A withdrawn bed is not reused; the next request renders a fresh copy.

## Labelling

Every bed's rights record says what it is:

- `credit`: "Ambience generated by the studio"
- `source`: "Generated by this studio from ambience preset `<id>` (recipe hv-ambience/1, seed `<n>`)"
- `terms`: no third-party recording, sample, vendor or model output

The cue sheet of every sound version that uses a bed carries this credit beside the cue.

## Known gaps

- **The crew flow does not ask for ambience yet.** `studio.js` scores the final in `scoreFinal`, which open PR #335 (HV-024-11) is changing. Adding the ambience cues to that session is a follow-up after #335 merges.
- **Titles and credits don't name the ambience yet.** The closing credits in `titles.js` are also being changed by #335. The credit is in the cue sheet and the library's rights record today.
- **Sound effects (foley, spot effects) are not generated.** A vendor for them would need its own gate (G3 covered music only).
- **Listening quality is unproven.** The beds are procedural, like the Composer's score, and no one has judged them by ear in a finished film. The loudness bounds are measured; they don't qualify a film against EBU R128 or ATSC A/85.
