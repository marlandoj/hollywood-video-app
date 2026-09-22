# The mezzanine master

HV-027 is in progress. A rendered film can be delivered as a **mezzanine** — the form another edit
suite takes it in, rather than the form a viewer watches it in. This is the mezzanine part of the
epic's Release 2 slice; see [DELIVERY-REFRAMES.md](DELIVERY-REFRAMES.md) for the vertical and square
cuts. Burned subtitles and SDH are not built.

## The decision that is the whole design

**A mezzanine is not made from the delivered file.** The delivered `export.mp4` is H.264 at CRF 18.
Re-encoding it into ProRes produces a bigger file that is no better, because nothing can put back
what the H.264 encode threw away. A master made that way is a large file wearing a master's clothes.

The conform already writes a **lossless FFV1 picture master** and a 48 kHz 24-bit mix on its way to
that MP4, and seals both as artifacts. So the mezzanine is those two streams, **copied**:
`-c:v copy -c:a copy`. Nothing is encoded, nothing is transcoded, nothing is re-compressed. The bytes
of the picture are the bytes the conform made.

## Why it is not ProRes

ProRes 422 HQ is 4:2:2 and ten-bit. The conform's picture master is 4:2:0 and eight-bit, so a ProRes
wrap would carry no more information than the FFV1 already does, while costing more and changing
every pixel on the way. Measured on a three-second fixture:

| | Bytes | Frames identical to the conform's picture |
|---|---|---|
| FFV1 rewrap (this) | 1,539,214 | 90 of 90 |
| ProRes 422 HQ | 4,217,081 | 0 of 90 |
| The delivered H.264 master | 255,786 | 0 of 90 |

A wider codec around a narrower picture is the same trade this epic already refused for scaling: a
delivery dressed up as something it is not. If a recipient's suite needs ProRes, that conversion is
theirs to make, from a master that has lost nothing.

## The proof

The conform records a hash of **every frame** of its picture master as it builds it. The mezzanine's
plan carries `contentHash` of that list — sixty-four bytes — and the render decodes the file it has
just written, hashes its frames, and compares. **A single differing frame is refused.** That is the
difference between "a file of the right size and shape" and "this film".

So the result can say, and mean, that the mezzanine's picture is the conform's own.

## What it comes out as

Matroska, carrying FFV1 yuv420p at 30 fps and `pcm_s24le` at 48 kHz stereo, with all metadata
stripped: no tags, no encoder string, no source paths.

What it does **not** carry is printed every time it runs, not only here:

- captions or a subtitle track — the conform's WebVTT is delivered beside it;
- a timecode track or a start timecode;
- the separate audio lanes: one stereo mix, as the conform made it;
- colour primaries, transfer or matrix tagging beyond what the picture master already carries;
- an alpha channel;
- any wider colour — the picture master is eight-bit 4:2:0, and a ten-bit or 4:2:2 wrap would carry
  no more of it.

## Size, and the film that is too long for one

A mezzanine is the largest thing an editorial output contains, and it is retained beside the output
it came from, so it may take at most **half the editorial output budget** — 24 GiB of
`EDIT_STORAGE_LIMITS.outputBytes`. The plan knows the size before anything is written, because both
streams already exist on disk: it is their bytes plus an allowance for the container's own
bookkeeping, and the result records what it actually took.

A film long enough to exceed that budget is refused, with the number, rather than filling a disk. A
lossless master of a feature does not fit beside the feature. That is a real limit of this studio,
not a policy.

The mix's size is not a report but arithmetic — a 44-byte header and six bytes per sample of stereo
48 kHz 24-bit sound, for exactly the film's frames — so it is **checked** rather than believed. A mix
of the wrong length means the plan is not describing this conform.

## Running it

```
bun scripts/delivery-mezzanine.ts --conform <job>/conform [--out mezzanine.mkv]
```

The conform directory is the one an editorial render leaves. Nothing in it is written to, so this can
be run on a sealed output as often as it is wanted. It exits 0 when the mezzanine was written and
proved, and 1 when it could not be made or could not be proved — there is no middle verdict, because
an unproved mezzanine is not one.

## What this does not establish

This is a faithful copy, not a delivery specification. It is not a broadcast or festival package,
there is no IMF or DCP, no ladder, no other ratio, and no colour management of any kind — the picture
carries exactly the colour the conform gave it and nothing has been graded, tagged or transformed.
Nothing calls this automatically: no job, worker or deployment step makes a mezzanine, and a creator
cannot ask for one. An operator runs it on a rendered job.
