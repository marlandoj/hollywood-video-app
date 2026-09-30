# Captions in a deliverable

HV-027 is in progress. A finished film can be delivered with **its own captions burned into the
picture** (open captions), in the master's frame or in a [9:16 or 1:1 reframe](DELIVERY-REFRAMES.md)
of it. The job that makes one is the ordinary [delivery job](DELIVERY-JOBS.md). An SDH track is not
built yet; see the end of this page.

## Two decisions that are the whole design

**The words are the film's own.** What is burned is the sealed `conform/captions.vtt` that the picture
edit or assembly was completed with. It is the same bytes, checked against the digest the sealed
inventory names, and it holds the same number of cues. Nothing is re-worded, re-segmented, translated
or added. The timing moves only as far as the burn format forces. WebVTT counts milliseconds and the
renderer (libass) counts centiseconds, so a start is floored and an end is ceiled. No cue is shown
later, or ended sooner, than the film's own.

**A burned deliverable is terminal.** Captions in the picture cannot be taken out again. So nothing
may edit, dub, re-caption or deliver from a burned film. That was already true of every deliverable:
the editorial source allowlist names finished films, and a delivery job is not one. The delivery
source allowlist names picture edits and assemblies. The HV-027-15 test holds both refusals in place
for a burned deliverable rather than assuming them. This was the decision HV-027-01 left waiting.

## Which track, and when there is none

A deliverable's binding names the caption track only when the sealed file is **byte for byte the
track the film's own cut derives**. For a picture edit that is `editVtt` of its timeline. For an
assembly it is `editAssemblyVtt` of its plan. Then the cue count the plan carries is a fact about that
file, and the renderer checks it again: the digest, the size and the number of cues it parses.

| The film | What the burned kinds answer |
|---|---|
| Captioned, track tied to its cut | offered, with the frame and the number of cues |
| Its cut carries no spoken line | refused: *"This film has no captions to burn"* |
| Its track cannot be tied to its cut, or the binding predates this | refused: *"…could not be tied to its cut…"* |
| Its master cannot carry the frame | refused with the reframe's own reason (the 256-pixel minimum) |

The reframes and the mezzanine are unaffected. A binding without a track keeps the revision it had
before the burned kinds existed, and a retained plan still re-derives to itself.

## What a burn comes out as

| Kind | Frame | File |
|---|---|---|
| `open-captions` | the master's own | `open-captions.mp4` |
| `open-captions-9:16` | the 9:16 crop | `open-captions-9x16.mp4` |
| `open-captions-1:1` | the 1:1 crop | `open-captions-1x1.mp4` |

The picture is **cropped first and captioned after**. That way the captions are laid out for the
frame that is delivered, rather than burned into the master and then cropped off its sides. The encode
is the reframe's own (`encodeDeliveryCut`), with the same checks:

- the master's dimensions, before anything is encoded;
- the delivered frame;
- the master's own soundtrack, copied;
- no build version anywhere in the file;
- the master's length.

The caption layer is an ASS script written for the delivered frame (`PlayResX/Y` are its pixels):

- **Placement.** Bottom-centred, inside margins of 5% at the sides and 6% at the bottom.
- **Text.** White with a black outline, with no box and no shadow.
- **Size.** Sized from the frame: `min(height/18, width/16)`, never under 16 px. A 1080-line master
  gets 60 px and its 608-wide vertical cut gets 38 px.
- **Line breaks.** The caption's own breaks are kept, and libass wraps within the margins where a
  narrow frame needs it.

**Dialogue cannot restyle the burn.** An unescaped brace in ASS opens an override block, and a
backslash before `n`, `N` or `h` is a line break or a hard space. So a line of dialogue is made inert
before it is drawn. Braces are escaped, and a word joiner (which draws nothing) follows every
backslash. The test burns `{\an8}TOP \N OF IT` and shows it on one line at the bottom, like its
neighbours.

## The check on the burn

After the encode, each sampled cue is drawn **alone** on a black frame of the delivered size. It is
drawn at a frame the delivered picture actually shows it, by the same renderer and the same script.
Where its ink lands is recorded as `captions.sampled[].box`.

- **The render is refused** if a cue leaves no ink, which is what a missing font does, or if its ink
  reaches the frame's edge, which means it was cut off. Both are defects of the burn, not of the
  film. The refusal quotes the caption. The case that reaches it is one unbroken word wider than a
  narrow frame, because libass does not break words.
- **Every shown cue is sampled, up to 48.** Beyond that, an even spread including both ends is
  sampled.
- **`betweenFrames`** counts cues too short to land on any frame of a 30 fps picture. They are in the
  film's track and cannot be burned, and the count says so rather than implying otherwise.

The retained check is validated with the output, like HV-027-06's quality report:

- it must name the plan's track digest and cue count, and the delivered frame;
- it must sample the right number of cues;
- every sample must have ink, inside the frame.

Only a burned kind may carry one. The creator's view shows `{cues, checked, betweenFrames}`, and the
boxes stay in the retained record.

The picture quality check (HV-027-06) runs on a burned deliverable exactly as on any other.

## What is not built

- **An SDH track** (speaker identification and non-speech sound cues).
- **A pinned font.** libass asks the host's fontconfig for DejaVu Sans. The staging host and a test
  host may draw different glyphs, and the edge check is what stands between that and a cut-off
  caption.
- **Placement that avoids the picture.** The captions sit at the bottom whatever is there. Nothing
  moves them off a face or out of on-screen text.
- **Line breaking for a narrow frame beyond libass's own.** The caption's 42-character breaks are the
  conform's. A vertical frame wraps them again, and it can refuse an unbreakable word, but it does not
  re-segment the cue.
- **Burned captions for a 9:16 frame of a 640×360 master.** The reframe's 256-pixel minimum applies
  unchanged.
