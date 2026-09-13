Plan increment {{INCREMENT}} for the Rough Cut program. Read CLAUDE.md, docs/loop/STATUS.md,
docs/FULL-SCOPE.md (the epic's section and its §10 row), docs/PROGRAM-EXECUTION.md, and the
existing docs/*.md for this epic. Choose the next smallest increment that is independently
testable and moves the epic toward its FULL-SCOPE "Full scope" and "Exceed" text.
Write docs/loop/increments/{{INCREMENT}}.md with exactly these sections:
# {{INCREMENT}} — <title>
epic: HV-0NN
spend_usd: <0 or a number with the provider named>
## Goal
## Acceptance criteria   (numbered; each quotes or cites the FULL-SCOPE sentence it satisfies)
## Tests to add
## Evidence required     (files/receipts the critic must find)
## Out of scope
## Doc to update         (which docs/*.md gets the runtime/contract notes)
Write nothing else. Do not implement.

If the epic already satisfies every FULL-SCOPE criterion with merged, tested, documented code,
write instead a file containing only `epic_complete: true` followed by a list of the evidence
files that prove each criterion. The conveyor will raise gate G6 for operator acknowledgement.
