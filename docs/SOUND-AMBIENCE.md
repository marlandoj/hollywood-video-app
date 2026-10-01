# Studio ambience beds (HV-024-12)

The studio generates its own ambience beds: room tone, wind, rain, traffic, surf, crowd murmur and night air. FFmpeg makes each one from seeded noise sources and fixed filters. No vendor, recording, sample or model output is involved, so a bed costs nothing (`costUsd: 0`, no reservation) and needs no new gate.

## The catalogue

`packages/planner/src/sound-ambience.ts` holds seven presets under recipe `hv-ambience/1`:

| id | label | made from |
|---|---|---|
| `room-tone` | Room tone | brown noise, 30–500 Hz, trimmed 2 dB |
| `wind` | Wind | pink noise, 80–1200 Hz, slow gusts (0.15 Hz tremolo), trimmed 0.5 dB |
| `rain` | Rain | white noise, 400–4000 Hz, trimmed 6 dB |
| `traffic` | Traffic hum | brown noise, 25–350 Hz, passing swells (0.1 Hz) |
| `surf` | Surf | pink noise, 60–2500 Hz, a wave every 10 s |
| `crowd` | Crowd murmur | pink noise, 250–2500 Hz, light 2.5 Hz movement, trimmed 3.5 dB |
| `night` | Night air | pink noise, 100–800 Hz, with a pulsed 4.5 kHz insect tone, trimmed 1.5 dB |

Each preset has a fixed seed. The left and right channels use the seed and the seed plus one, so the bed is wide rather than mono.

## Rendering

`packages/generator/src/sound-ambience.ts` renders 21 seconds with one filter thread. It then lays the last second over the first, which makes a 20-second loop (960,000 frames) with no click at the seam. The crossfade curves differ by part:

- **Noise** uses an equal-power crossfade, which keeps uncorrelated noise at a steady level.
- **The night preset's tone** is rendered as a separate FFmpeg output and crossfaded with equal gain. An equal-power curve would lift a periodic tone by up to 3 dB in the middle of the seam.

Every tremolo rate and the tone complete whole cycles in 20 seconds, so the crossfade joins them in phase.

The loop is scaled so its sample peak is −18 dBFS, less the preset's trim. The output is canonical 48 kHz stereo 24-bit PCM with the fixed 44-byte header.

- **Deterministic.** The same recipe, preset and FFmpeg runtime give the same bytes. A different FFmpeg build may differ in the last bits of its floating-point filters. The library keeps the bytes it rendered, and the asset's `engineVersion` names the runtime, so a delivered version never depends on rendering again.
- **Loudness.** The trims put every preset near −31 LUFS integrated, from −31.6 to −30.9 on FFmpeg 6.1. That is the middle of the tested bound of −34 to −28 LUFS, so small differences between FFmpeg builds cannot cross it. Every true peak is at or below −17 dBTP on FFmpeg's `ebur128` meter, and the tests measure every preset this way.

## Choosing a scene's bed

`ambienceForHeading` reads the scene heading. The first rule that matches wins:

1. **Weather words.** RAIN, STORM, DOWNPOUR and similar give `rain`, inside or out.
2. **Shore words.** BEACH, SHORE, COAST, OCEAN, SEA, PIER, HARBOR and DOCK give `surf`.
3. **Busy places.** BAR, PUB, RESTAURANT, CAFE, MARKET, STATION, AIRPORT, PARTY, CLUB and LOBBY give `crowd`.
4. **Roads.** STREET, CITY, ROAD, HIGHWAY, ALLEY, PARKING, CAR, TAXI and BUS give `traffic`.
5. **Open country, exteriors only.** FOREST, WOODS, FIELD, MOUNTAIN, DESERT, HILL and ROOFTOP give `wind`.
6. **Any other exterior.** `EXT.` gives `night` when the heading says NIGHT, and otherwise `wind`.
7. **Everything else.** Interiors, `INT./EXT.` with no telling word, and headings with no INT or EXT get `room-tone`.

Words match whole words only, with Unicode-aware edges: CAFÉ is a café, and CARPET is not CAR.

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

Both routes refuse a cut the sound-mix route would refuse, with that route's messages: a cut past its retention (*"This cut is no longer retained."*), and a lip-sync cut whose quality review is not accepted (*"Accept the lip-sync quality review first."*). Nothing is rendered or saved for such a cut.

- `GET /api/projects/<id>/ambience/<cutId>` returns the catalogue, each scene's span and bed, and `chosenBy` (`heading` or `creator`). It also returns `costUsd: 0`.
- `POST /api/projects/<id>/ambience/<cutId>` with `{overrides?: {"<scene>": "<preset>"|"none"}}` renders any bed the scenes need that the library does not hold. It saves each one and returns 201, or 200 when every bed was already there. The answer carries `{presets, scenes, cues, library, costUsd: 0}`. The `cues` go into the `session.cues` of `POST /sound-mixes/<cutId>`, beside any music, for review and rendering.

The route uses the server's one-at-a-time sound import slot. When the slot is busy it answers 429 *"A recording is being processed. Try again shortly."* Rendering a bed and saving it to the library check project rights and the library version, as an upload does.

A studio bed in the library is recognised by its label, its whole rights record (source, credit, terms and the `original` basis) and the loop's length. An upload that copies only some of these is not taken for the studio's bed. A withdrawn bed is not reused; the next request renders a fresh copy.

## The crew flow (HV-024-14)

The front door's Composer (`scoreFinal` in `packages/frontend/src/studio.js`) adds the beds to every scored film:

1. Once the score is in the library (the Composer's own loop, or a generated cue from HV-024-11), it asks `POST /api/projects/<id>/ambience/<cut id>` with `{}` for the final cut. It sends no overrides, so each scene gets the bed its heading picks.
2. It lays every cue the route answers into the same `sound-mix` session as the music cue, unchanged. The route sets the level, fades and ducking; the studio invents none.
3. The session with ambience is keyed `crew-score-ambience-<cut id>`. A score alone keeps `crew-score-<cut id>`. Each session has its own key, so a film first mixed without ambience is not refused as *"This key belongs to a different sound session"* when it is mixed again with it.

The route takes no request key. Asking again for the same cut answers the same cues and reuses the beds already in the library, so the cut in its URL makes a retry safe.

If the route refuses (an expired cut, a busy sound slot, a full library, a cut with too many scene beds), the film is still mixed with its score. The last approval says: *"Composer: the studio's ambience was not added (<the route's reason>); the film is shared with its score and no ambience."* A busy slot is not waited on.

When the creator answers "no music", nothing is mixed, so the film has no ambience either.

The closing credits (`creditRows` in `packages/frontend/src/titles.js`) add **Ambience: Generated by the studio**, in the beds' own words, only when the finished mix carried them. A refused request or a failed mix earns no row.

## Labelling

Every bed's rights record says what it is:

- `credit`: "Ambience generated by the studio"
- `source`: "Generated by this studio from ambience preset `<id>` (recipe hv-ambience/1, seed `<n>`)"
- `terms`: no third-party recording, sample, vendor or model output

The cue sheet of every sound version that uses a bed carries this credit beside the cue.

## Known gaps

- **A film with no music has no ambience.** The Composer's "no music" skips the whole mix, so a creator who asks for silence gets the film's own sound only. Ambience on its own would need its own session key and a choice about what "silent" means.
- **The creator can't choose a scene's bed from the front door.** The crew flow sends no overrides; only the API takes them.
- **A busy sound slot costs the ambience.** The score's own upload waits up to half an hour for the slot; the ambience request asks once.
- **Sound effects (foley, spot effects) are not generated.** A vendor for them would need its own gate (G3 covered music only).
- **Listening quality is unproven.** The beds are procedural, like the Composer's score, and no one has judged them by ear in a finished film. The loudness bounds are measured; they don't qualify a film against EBU R128 or ATSC A/85.
