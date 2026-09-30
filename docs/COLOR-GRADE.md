# Grading a finished cut

HV-026 is in progress. A finished picture edit or assembly can be **graded**: given one reviewed,
versioned colour decision — primary corrections and a look from the studio's own library — and made
into a new graded cut with ffmpeg. The graded cut is checked before it is offered, and a grade that
clips what the cut did not, or leaves the broadcast tolerance, is **withheld** with the reason.

This is the grade-and-LUT half of the epic's Release 2 slice. The measurement half is
[PICTURE-QC.md](PICTURE-QC.md), and it runs on every graded cut.

## A grade is a deliverable

A grade is a delivery kind, `grade`, beside the two reframes, the mezzanine and the burned-caption
kinds ([DELIVERY-JOBS.md](DELIVERY-JOBS.md)). That one decision carries everything else, unchanged:

- It is a **new job that names the cut's sealed output revision**. The cut is read and never written,
  so a grade is non-destructive by construction: it can be changed, compared and thrown away as often
  as wanted.
- It is admitted at **zero cost** (`requestedUsd: 0`, no reservation, no spend) because it dispatches
  no provider.
- It carries the cut's **cast and source permission** and its **retention** (HV-027-14): a grade of a
  withdrawn or lapsed cut is not offered, admitted, rendered, listed with a link or served.
- The worker copies **the cut's master alone** through the artifact reader, as a reframe does.
- It is sealed with the **picture quality check** of the file it wrote (HV-027-06) and with its own
  grade check, below.
- A grade is made only from a picture edit or an assembly — never from another grade, because a
  delivery is not a delivery source. A grade of a grade would compound two encodes and two sets of
  clipping.

## The decision

Eight numbers in hundredths and a look. Anything outside its range, off its step, or not one of these
controls is refused by name.

| Control | Range | Neutral | What it does |
|---|---|---|---|
| `exposure` | −2 to 2 | 0 | A gain of 2^stops on the encoded signal (not scene-linear light) |
| `temperature` | −1 to 1 | 0 | Red × (1 + 0.1 t), blue × (1 − 0.1 t): warm positive |
| `tint` | −1 to 1 | 0 | Green × (1 − 0.1 t): magenta positive |
| `saturation` | 0 to 2 | 1 | Mixed toward Rec.709 luma: 0 is monochrome |
| `lift` | −0.2 to 0.2 | 0 | Raises (or lowers) the blacks, leaving white where it is |
| `gain` | 0.5 to 2 | 1 | Scales the whole range |
| `contrast` | 0.5 to 2 | 1 | About mid-grey |
| `gamma` | 0.5 to 2 | 1 | Above 1 brightens the mids |
| `look` | the library | `neutral-709` | Applied last, as a 3D LUT |

The decision's plan is hashed into a revision, and the revision joins the deliverable's idempotency
key: the same decision on the same cut is one job whatever request key asks for it, and a changed
decision is a different grade. The other kinds' keys are exactly what they were, so a deliverable
retained before grades existed still validates.

## The ffmpeg chain

Derived from the decision, recorded in the plan, and re-derived from the decision whenever the plan is
read — never supplied by a caller.

```
scale=in_color_matrix=bt709:in_range=tv, format=rgb48le,
colorchannelmixer=<white balance × exposure, then saturation>,
lutrgb=<lift, gain, contrast, gamma — the same transfer on every channel>,
lut3d=file=look.cube:interp=tetrahedral,
scale=out_color_matrix=bt709:out_range=tv, format=yuv420p
```

Graded in 16-bit RGB so that five stages do not band. It is **packed** 16-bit RGB (`rgb48le`), not
planar: `lutrgb` on planar 16-bit RGB in the ffmpeg this studio runs does not map a channel to itself
(an identity `val` expression moved the red channel by an MSE of 11,240), which was found while
building this and is why the plan states the format.

The picture is H.264 CRF 18 with the same metadata rules as a reframe (HV-027-07), and the cut's own
soundtrack is copied: a grade cannot change what the film sounds like.

## The looks

Four `.cube` files, **authored in this repository** by the functions in
`packages/planner/src/color-grade.ts` and shipped in `packages/generator/looks/`. No third-party LUT is
used or downloaded. Each is a 17-point cube.

| Look | What it does |
|---|---|
| `neutral-709` | Identity: the primary corrections alone, delivered in Rec.709 legal range |
| `warm` | Red raised and blue held back through the mids (per-channel powers 0.92, 0.98, 1.10) |
| `cool` | The reverse (1.10, 0.99, 0.92) |
| `film-contrast` | A print-film S about mid-grey, a shade steeper in blue so the toe is faintly warm |

Every look keeps 0 at 0 and full scale at full scale and rises monotonically on every channel, so **a
look never clips anything on its own**; only a primary correction pushed too far can. A grade is bound
to its look's bytes by SHA-256: the renderer refuses a look file on disk that is not the one the grade
was decided with. `bun scripts/color-looks.ts` rewrites the files and prints their digests, and a
test holds the files, the authoring functions and the recorded digests to one another.

## The check, and why a grade is gated

The quality check on a reframe or a mezzanine **does not gate** it (HV-027-06): every failure it can
find is inherited from the cut, and the delivery route offers no remedy. A grade is different. What it
is judged on is its own doing, and the remedy is in the creator's hands — lower the gain, raise the
lift — so a grade is gated.

Measured as the grade is made:

- **Clipping.** In the same decode that grades the picture, a mask marks every pixel with *any* RGB
  channel at 0, and another every pixel with any channel at full scale, on the graded picture and on
  the cut's own; the cut's mask is subtracted pixel by pixel, so only what the grade clipped counts. A
  red channel pushed off the top counts even when the pixel is not white. A sky the cut had already
  blown is not blamed on the grade.
- **Levels.** The graded file is read back as encoded, for the share of each frame's luma under 14 and
  over 241.

| Finding | Withholds when | Remedy it names |
|---|---|---|
| `highlights-clipped` | more than 5% of frames have 1% or more of their pixels newly at full scale | lower the gain or the exposure |
| `blacks-crushed` | more than 5% of frames have 1% or more newly at 0 | raise the lift or lower the contrast |
| `illegal-levels` | any frame has 1% or more of its luma outside 14–241 | raise the lift / lower the gain |
| `levels-unmeasured` | the file's quality check carried no luma reading | — |

Clipping under the 5% is a note. Luma extremes past the nominal 16–235 on less than 1% of any frame
are a note.

The level tolerance is the one EBU R 103 gives luma, −1% to 103% of the nominal range (14 to 241 in
8-bit codes), judged over at least 1% of the picture rather than on the single most extreme pixel.
That choice was measured, not assumed: the grade itself cannot leave the range (it is converted to
limited range from RGB), but H.264 rings past every hard edge whatever the grade does. The one-second
test pattern the renderer is tested on reads 8–214 at its extremes before it is graded at all, and
3–214 after the `cool` look, which clips nothing. A check that judged the single most extreme pixel
would have withheld that grade, and every grade of that cut.

The check is bound three ways — to the grade's plan revision, to the file's SHA-256 and size, and to
the luma extremes the file's own quality check read — and it is re-derived from its measurement
whenever it is read, so a withheld grade edited to read "offered" is refused.

**A withheld grade is sealed, listed and never served.** The job completes; the file and its
measurement are the record. The deliverables list shows it with no link, `unavailable` carrying every
withholding reason, and the decision and the check beside it. The artifact route answers 404 even to
a valid token that names the file. Asking for the same decision again, under any request key,
returns the withheld job rather than rendering it again, since it would clip the same way; changing
the decision is a new grade.

## The routes

`GET /api/projects/:id/deliveries/:cutJobId` answers the `grade` offer with the others, and a `grade`
object: the controls and their ranges, the step, the neutral decision, the looks with their labels
and descriptions, the thresholds, and what is not checked.

`POST /api/projects/:id/deliveries/:cutJobId` with `{"idempotencyKey", "kind": "grade", "grade": {…}}`
admits one. A grade without a decision, a decision on any other kind, and a decision out of range
are each refused (400).

## What this does not establish

- **No frontend.** The routes answer JSON; there is no grading panel yet.
- **One decision for the whole cut.** No shot-to-shot matching, no per-shot grade, no windows or
  keys, no look lock across a project.
- **Exposure is a gain on the encoded signal,** not scene-linear light.
- **Rec.709 only.** No colour management, no HDR, no other display.
- **Gamut inside the RGB cube is not judged**: clipping is counted, a hue that shifts inside the cube
  is not. The delivered file's chroma levels and RGB gamut are not read against a tolerance; only its
  luma is.
- **A graded cut cannot be reframed, made a mezzanine or have its captions burned in**, because a
  deliverable is not a delivery source. A graded 9:16, or a graded cut with open captions, is not yet
  a thing.
- **"Reviewed" means checked and versioned.** There is no approval step on a grade beyond the check;
  per-stage approvals are HV-029's.
- **The PostgreSQL worker path is not exercised by a grade test.** It runs the same render and seal
  functions as every deliverable; only the JSON path is driven end to end here.
