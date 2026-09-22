# Vertical and square cuts of a finished film

HV-027 is in progress. A finished 16:9 film can be cut to **9:16** or **1:1** for the places a
widescreen master cannot go. This is the reframe half of the epic's Release 2 slice; burned
subtitles and SDH are not built. The mezzanine master is in
[DELIVERY-MEZZANINE.md](DELIVERY-MEZZANINE.md), and the job that makes either one is in
[DELIVERY-JOBS.md](DELIVERY-JOBS.md).

## Two decisions that are the whole design

**Nothing is scaled.** A cut is a crop of the master, so it can never be sharper than the master and
never pretends to be. A 9:16 cut of a 720-line film is 720 lines tall, not 1920. A platform that
wants 1080×1920 needs a master with 1920 lines, and this studio does not make one — the editorial
timeline is capped at 1080 — so the honest answer is a 608×1080 cut from an HD master, not an upscale
dressed up as a delivery.

**The sound is the master's own**, copied rather than re-encoded. A reframe cannot change what the
film sounds like, and the delivered cut carries the same codec, rate, channels and level as the film
it came from.

## What a cut comes out as

The crop keeps the master's full height and takes the width the format asks for, rounded to the
nearest even pixel, because 4:2:0 chroma is shared between pairs of pixels. The plan records how far
that rounding lands from the exact ratio rather than claiming the ratio is exact.

| Master | 9:16 | 1:1 |
|---|---|---|
| 1920×1080 | 608×1080 | 1080×1080 |
| 1280×720 | 406×720 | 720×720 |
| 640×360 (animatic) | refused — 202 px wide | 360×360 |

A cut under 256 pixels on either edge is refused, naming what it would have been. An animatic is too
small to deliver vertically, and saying so is more use than delivering a 202-pixel-wide film.

## Where the frame sits

By default the crop is centred. It can be placed anywhere across the master in ten-thousandths — 0 is
hard left, 10000 hard right — and the offset is always rounded to an even pixel for the same chroma
reason. A plan is re-derived from its own source before it is used, so a plan cannot be edited into
describing a master it was not made for, and the render refuses a master whose dimensions differ from
the plan's before it encodes anything.

**The frame is not subject-aware.** It does not follow a face, and it does not know where the action
is. FULL-SCOPE asks for shot-aware reframing; this is a placed crop, which is the part that can be
built honestly without a vision model, and the crew choosing a placement per shot is later work.

## What is not built

- **Burned-in subtitles, SDH and an audio-description track.** Note that the assembler's existing
  burn-in marks its output as carrying captions, and editorial, dialogue replacement and source
  admission all refuse such a picture. A burned deliverable must therefore be terminal — it can never
  be admitted back as a source — and that is a design decision to make deliberately.
- **A mezzanine master** (ProRes/DNx), other ratios (4:5, 2.39:1), ladders, and every package format.
- **Nothing calls this yet.** A deliverable belongs to a job, and a finished job's artifact set is
  sealed by design: adding a file to it is refused. Carrying a cut therefore needs its own job stage,
  which is its own increment.
