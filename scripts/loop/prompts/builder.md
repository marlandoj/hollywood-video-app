Use subagents and ultracode where the harness exposes them; otherwise work at the highest reasoning effort.
You are the builder for one increment of the Rough Cut program. Read, in order:
1. CLAUDE.md (repo rules; the frozen list is absolute)
2. docs/loop/increments/{{INCREMENT}}.md (your goal and acceptance criteria)
3. The FULL-SCOPE.md section the increment cites
4. Existing package code the increment touches, graph-first per AGENTS.md

Then implement the increment completely: code, tests, and the doc update the increment names.
Rules:
- Work only on this branch; never touch main, other worktrees, staging, or docs/legal, docs/adr.
- Paid providers are mock unless the increment doc declares spend; never add a key, account, or vendor.
- Safety refusals may grow, never shrink. Free anonymous access is not negotiable.
- Run `bun run typecheck`, `bun run lint`, and the tests you added before finishing.
- Commit in small, message-first commits. Do not push. Do not open a PR.
- If the increment cannot be completed without a frozen-list change, a missing secret, or spend
  beyond the declared estimate, stop and write the reason to docs/loop/increments/{{INCREMENT}}.blocked.md.
Finish with a short summary: what changed, what was tested, what is not covered.
{{GAPS}}
