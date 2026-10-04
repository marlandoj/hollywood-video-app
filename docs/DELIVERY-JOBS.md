# The delivery job

HV-027 is in progress. A deliverable — a [vertical or square cut](DELIVERY-REFRAMES.md), a
[mezzanine master](DELIVERY-MEZZANINE.md), the film with [its captions burned in](DELIVERY-CAPTIONS.md), or
since HV-026-07 a [graded cut](COLOR-GRADE.md) — is made by a **job of its own**, beside the film it is
made from.

Since HV-019-15, a **hero render** of one shot of a final render is a deliverable too. It is bound to a shot rather than to a cut's conform, it retains one file per stage of its chain plus the chain's record, and it is described in [PROVIDER-ROUTING.md](PROVIDER-ROUTING.md) ("Hero-render chain"). Everything below about idempotency, zero cost, permission re-reads and recovery applies to it unchanged.

## Why a new job and not a new file

A finished job's artifact set is sealed three ways: the output revision is computed over its whole
file list, the output validator closes the inventory, and restoring the job reproduces it. Adding a
deliverable to a completed job is refused by all three — by design, and rightly: the film someone
delivered is the film they approved, and a file that appears in it afterwards is a different film
wearing the same revision.

So a deliverable is a new job that **names** the old one. What it names is the sealed output's
revision, not the job id: a job id says which render, and the revision says which bytes.

## What it carries, and what it refuses

A delivery job carries a delivery plan and nothing else. The refusals are the contract:

| Refused | Because |
|---|---|
| A `delivery` stage with no plan, or a plan on any other stage | the stage and the plan are one fact stated twice, so they must agree |
| Any reserved or spent money | a deliverable dispatches no provider; a cost attributed to one is a charge on nothing, and the ledger refuses it |
| A screenplay, a scene plan, an animatic, a generation history | it is made from a finished file, not from a script |
| A frame count other than the film's | a deliverable runs exactly as long as the film it is made from |
| A plan naming the job's own id | a deliverable is a new job beside the film, never the film's own |
| A plan naming another project's film | a deliverable is made inside the project the film belongs to |
| Any other stage's plan, checkpoint or output | it retains one file and nothing else |

## Idempotency

The same deliverable of the same sealed output is the same job. The key is the output revision and
the kind (and, for a grade only, the grade's plan revision), and nothing else — not the job id,
which would make an identical deliverable of a re-render a different one, and not a clock. Re-admitting under the same key returns the job that
exists; a *different* deliverable under that key is refused by name rather than silently answered
with the first one.

## The film is still the film, at admission

Admission re-reads the source job's own body — not its artifact rows, because the body is
authoritative in both storage modes and says more. It must be done, sealed under the key its stage
seals under, at the revision the plan names, and its inventory must contain the master. A film
rendered again since the deliverable was planned is refused by name, not delivered from the old
bytes under the new film's name.

The project's permission is re-read at dispatch under the same fence every other independent media
job uses, so a deliverable cannot be written after a takedown.

## The quality check on the delivered file

**HV-027-06.** Sealing a deliverable measures it with the check HV-026-01 built, and keeps the
report beside it. Four increments had built that check and nothing had ever run it on a delivered
file: HV-027-01 measured its own cuts by hand, in a test.

The file is read once. `measurePictureQc` returns the digest and the size it measured, and those
*are* the deliverable's digest of record — so a lossless master of several gigabytes is not read
twice to say the same thing. The seal's own `ffprobe` still runs independently, which makes two
readings of one file taken seconds apart, and the validator makes them agree: same dimensions, same
codecs, same duration to within a second, same size. A report that describes a different file, or a
report copied from another deliverable, disagrees with one of them. `validatePictureQcReport` is
what refuses a report whose findings do not follow from its own measurement; this is the half that
ties the measurement to *this* deliverable.

**The verdict does not gate publication.** Every `fail` the check can reach on a deliverable — a
soundtrack that measures as silence end to end, one peaking at or above full scale — is inherited
from the master the deliverable copies, and the delivery route offers no way to fix a master.
Refusing here would make a film undeliverable with no remedy in the route that refused it. That is a
product decision rather than a build one; the report says what was measured, the offer list and the
deliverable list carry the verdict and the findings, and the creator decides whether to look before
they send it.

The creator's view carries the verdict, the findings and what was **not** checked — never the raw
measurement, which is the operator's own reading and stays in the retained report. A check that
shows only what it found reads as a clean bill of health, so `notChecked` travels with the findings.

## Recovery

A snapshot holding a deliverable is `hv-state/14`, and one holding a deliverable's quality check is
`hv-state/15`. An older reader is refused rather than allowed to load it, because it would drop the
delivery plan and the retained file from the job body — or, at 14, the retained measurement of the
delivered file — and write the job back without them, silently turning a finished deliverable into a
job that never had one, or a measured one into a film nobody checked. The same rules are enforced by
the archive packager, in Python, against the same schema list.

The checkpoint is the whole deliverable: one file means there is no partial progress to record. It is
immutable once taken, and completion requires it, as every other media checkpoint does.

## Creator flow

| | |
|---|---|
| `GET /api/projects/:id/deliveries/:jobId` | what that finished film can be delivered as — **every kind**, with the reason for each it cannot make — and the deliverables already made of it |
| `POST /api/projects/:id/deliveries/:jobId` | `{"idempotencyKey": "…", "kind": "mezzanine"}`; answers `202` with the job id |
| `GET /api/projects/:id/deliveries` | every deliverable this project has asked for, with a link to each finished one |

All three are owner-only and `private, no-store`. The finished file is served through the same
guarded `/artifacts/` path as everything else, under a token minted for that job and no other, and it
is sent as an attachment.

A deliverable whose project permission has lapsed, or whose link has expired, is shown as
**unavailable with the reason** rather than quietly omitted: a file that disappears without
explanation reads as a bug.

## How it is made

The worker copies the film's declared files into a **private scratch**, one at a time through the
artifact reader, which checks each file's digest and length as it streams it. Nothing in the source
job is written to. The deliverable is written under the delivery job's own prefix, replacing whatever
a previous attempt of *that job* left there — the only file it owns.

A resumed job re-verifies what it already wrote rather than rendering it again. Verification
re-digests the file, re-probes it against the plan, and — for a mezzanine — decodes its frames and
compares them with the conform's own recorded hashes, which is the same proof the render made. A
reframe is **not** reproduced: re-encoding it would cost a full render to compare an encoder against
itself and would say nothing its digest and its probe do not. That is a smaller claim than
editorial's verify-by-reproduction, and it is stated rather than implied.

## What is not here

- **A deliverable is not an editorial source.** The stages usable as sources are an allowlist and
  this one is not on it. That is deliberate: a delivery is terminal, and re-editing a crop of a crop
  is how a studio loses track of what its master is.
- **Nothing counts several deliverables of one film together.** A mezzanine is capped at half the
  editorial output budget on its own; three deliverables of the same film are not yet added up.
- **No frontend for reframes, mezzanines or burned captions.** Their routes answer JSON. A grade has a panel
  (HV-026-08, [COLOR-GRADE.md](COLOR-GRADE.md)), and `GET …/deliveries` now lists the cuts every
  kind can be made from.
- **The reframe's placement is centred.** Nothing yet decides where a vertical frame should sit, and
  the route does not expose the anchor the plan already carries.
- **Burned captions and SDH** are built (HV-027-15 and HV-027-16, [DELIVERY-CAPTIONS.md](DELIVERY-CAPTIONS.md)).
  The decision HV-027-01 left open is taken there: a burned deliverable is terminal, never admissible
  as an editorial or delivery source, which is what the source allowlists above already enforce for
  every deliverable.
