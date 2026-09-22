# Quality check on a delivered film

HV-026 is in progress. A finished film can be measured — its picture, its levels and its container —
and the measurement is kept as the evidence. This is the QC half of the epic's Release 2 slice; the
grade and LUT half is not built.

Nothing here changes a pixel or a sample. The check reads the delivered file and writes nothing
beside it, so it can be run on a master as often as it is wanted without touching what was
delivered, and it sits outside the deterministic render path entirely — it cannot move a frame hash.

## What is measured

One `ffprobe` and one decode:

| Measured | How |
|---|---|
| Container and streams | `ffprobe -show_streams -show_format`: duration, dimensions, frame rate, pixel format, video and audio codecs, channels, sample rate, bytes |
| Black picture | `blackdetect=d=0.5:pic_th=0.98:pix_th=0.10` — spans of at least half a second |
| Frozen picture | `freezedetect=n=0.001:d=2` — spans of at least two seconds with no change |
| Luma levels | `signalstats` YMIN and YMAX per frame, judged against the 16–235 this delivery's limited range allows |
| Sound levels | `volumedetect` over the whole programme: mean and peak |

A span that runs to the end of the programme is closed at its duration rather than left open. A
silent soundtrack measures as *nothing*, not as a very small number, and a frame that carried no
luma statistic is counted rather than assumed.

## What a finding means

The severity is the whole point, and it is decided by one table of thresholds in the recipe:

| Code | Severity | Cause |
|---|---|---|
| `audio-missing` | fail | The file carries no audio stream. |
| `silent-programme` | fail | The soundtrack measures as silence from end to end. |
| `clipping` | fail | Peak at or above full scale: samples are being clipped. |
| `quiet-programme` | warning | Mean below −45 dB. |
| `loud-programme` | warning | Mean above −12 dB. |
| `black-picture` | warning | At least half a second of black, with the times. |
| `frozen-picture` | warning | At least two seconds with no change, with the times. |
| `illegal-levels` | warning | Luma outside 16–235; a conforming player will clip it. |
| `unexpected-frame-rate` | note | Not 30/1. |
| `unexpected-pixel-format` | note | Not yuv420p. |
| `levels-unmeasured` | note | No frame carried a luma statistic, so levels were not judged. |

The verdict is `pass` only when nothing above a note was found, and `review` otherwise. `review` means
a person has to look, not that the film is broken: a deliberate fade to black and a held frame both
report, because the check cannot tell them from a missing render, and saying so is more use than
staying quiet.

The −45 dB and −12 dB bounds are the range finished films have actually measured in here, recorded
in `docs/evidence/release-1/live-reel-voiced.json` and `docs/evidence/release-2/elevenlabs-voiced.json`.
They are a house observation, not a broadcast standard. The loudness that *is* measured to a standard
is the soundtrack's own, in [SOUND-FINISHING.md](SOUND-FINISHING.md), and this check does not repeat
or replace it.

## The report

A report carries the recipe revision it was made by, the ffmpeg runtime revision, the file's SHA-256
and size, every measurement, the findings, the verdict, and its own revision. It also carries
`notChecked`, in the report itself rather than in this document, because a check that lists only what
it found reads as a clean bill of health. Today that list is: safe area and title-safe margins;
caption overflow and readability; decodability across players and devices; colour accuracy, gamut and
any colour-managed transform; high dynamic range; audio channel assignment beyond the stream's own
count.

A retained report is re-derived from its own measurement before it is believed — the whole report,
not its revision, so a kept revision cannot vouch for findings edited under it. A report made by an
older recipe is refused rather than reinterpreted, and the check is run again.

## What this does not establish

This is measurement, not certification. Passing means the file did not trip any of the checks above
on the machine that ran them; it is not a delivery specification, a broadcast QC, or evidence that a
player will decode the file. Nothing here looks at colour: there is no colour management, no grade,
no LUT, and no transform of any kind, and the epic's `grade`, `lut` and `look_lock` work is
untouched. No paid or third-party QC system has been run against these results.
