# The delivery job

HV-027 is in progress. A deliverable — a [vertical or square cut](DELIVERY-REFRAMES.md), or a
[mezzanine master](DELIVERY-MEZZANINE.md) — is made by a **job of its own**, beside the film it is
made from.

Nothing creates one yet: there is no route and no renderer. This page describes the contract the
stage holds, which is what the two halves still to come are written against.

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
the kind, and nothing else — not the job id, which would make an identical deliverable of a
re-render a different one, and not a clock. Re-admitting under the same key returns the job that
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

## Recovery

A snapshot holding a deliverable is `hv-state/14`. An older reader is refused rather than allowed to
load it, because it would drop the delivery plan and the retained file from the job body and write
the job back without them — silently turning a finished deliverable into a job that never had one.
The same rule is enforced by the archive packager, in Python, against the same schema list.

The checkpoint is the whole deliverable: one file means there is no partial progress to record. It is
immutable once taken, and completion requires it, as every other media checkpoint does.

## What is not here

- **No route and no renderer.** Nothing can create a delivery job. The renderer is the next
  increment and it is small, because the deliverables themselves are built and tested.
- **A deliverable is not an editorial source.** The stages usable as sources are an allowlist and
  this one is not on it. That is deliberate: a delivery is terminal, and re-editing a crop of a crop
  is how a studio loses track of what its master is.
- **Nothing counts several deliverables of one film together.** A mezzanine is capped at half the
  editorial output budget on its own; three deliverables of the same film are not yet added up.
- **A delivery job reaching a worker fails rather than rendering.** `generationStage` refuses the
  stage, as it does for every independent media job, so it cannot be mistaken for a generation job
  while the renderer does not exist.
