#!/usr/bin/env bash
# One conveyor iteration: at most one increment from SELECT through RECORD. Idempotent, lock-guarded.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
source scripts/loop/loop.env; [ -f .loop/loop.env ] && source .loop/loop.env
mkdir -p .loop/wt docs/loop/increments
exec 9>.loop/lock; flock -n 9 || { echo "conveyor already running"; exit 0; }
[ -f .loop/paused ] && { echo "paused on $(cat .loop/paused)"; exit 0; }
git fetch -q origin && git checkout -q main && git pull -q --ff-only origin main

# daily API spend guard (G2)
TODAY=$(date -u +%F); SPENT=$(grep "^$TODAY" .loop/api-ledger.jsonl 2>/dev/null | awk '{s+=$2} END{print s+0}')
awk -v s="$SPENT" -v m="$LOOP_MAX_USD_PER_DAY" 'BEGIN{exit !(s>=m)}' && { scripts/loop/alert.sh G2 "Daily Claude Code spend cap reached" "Spent \$$SPENT today, cap \$$LOOP_MAX_USD_PER_DAY"; exit 0; }

# SELECT
INC=$(bun scripts/loop/status.ts next) || { echo "nothing selectable"; exit 0; }
[ -z "$INC" ] && { echo "program complete or blocked; see docs/loop/STATUS.md"; exit 0; }
EPIC=${INC%%-[0-9][0-9]}; BR="loop/$INC"; WT=".loop/wt/$INC"; DOC="docs/loop/increments/$INC.md"
echo "== increment $INC (epic $EPIC)"

run_claude(){ # run_claude <mode> <prompt-file> <cwd> [extra args]
  local mode="$1" prompt="$2" cwd="$3"; shift 3
  local out; out=$(cd "$cwd" && timeout "$LOOP_WALL_CLOCK_PER_INCREMENT" claude -p "$(cat "$prompt")" \
      --permission-mode "$mode" --max-turns "$LOOP_MAX_TURNS" --max-budget-usd "$LOOP_MAX_USD_PER_BUILD" \
      --output-format json "$@") || true
  echo "$TODAY $(echo "$out" | jq -r '.total_cost_usd // 0') $INC $mode" >> "$ROOT/.loop/api-ledger.jsonl"
  echo "$out"
}

# PLAN (only if no increment doc yet)
if [ ! -f "$DOC" ]; then
  sed "s/{{INCREMENT}}/$INC/g" scripts/loop/prompts/planner.md > .loop/plan.prompt
  run_claude acceptEdits .loop/plan.prompt "$ROOT" --allowedTools "Read,Grep,Glob,Write(docs/loop/increments/*)" >/dev/null
  [ -f "$DOC" ] || { scripts/loop/alert.sh G5 "Planner produced no increment doc for $INC" "See .loop/api-ledger.jsonl"; exit 0; }
  git add "$DOC" && git commit -qm "loop: plan $INC" && git push -q origin main
fi
if grep -q '^epic_complete: true' "$DOC"; then
  bun scripts/loop/status.ts set "$EPIC" review; git add docs/loop && git commit -qm "loop: $EPIC awaiting operator acknowledgement" && git push -q origin main
  scripts/loop/alert.sh G6 "$EPIC ready for acknowledgement" "Reply \"$EPIC accepted\" or list gaps. Evidence: $DOC"; exit 0
fi
grep -qiE '^spend_usd:\s*[1-9]' "$DOC" && awk -v s="$(bun scripts/loop/status.ts paid-total)" -v a="$LOOP_PAID_ALERT_USD" 'BEGIN{exit !(s>=a)}' && \
  { scripts/loop/alert.sh G1 "Paid envelope alert before $INC" "Ledger at \$$(bun scripts/loop/status.ts paid-total) of \$$LOOP_PAID_ENVELOPE_USD"; exit 0; }

# BUILD in worktree
git worktree add -q -B "$BR" "$WT" main 2>/dev/null || true
BASE=$(git rev-parse main); GAPS=""
for round in $(seq 1 "$LOOP_CRITIC_ROUNDS"); do
  sed -e "s/{{INCREMENT}}/$INC/g" -e "s|{{GAPS}}|$GAPS|g" scripts/loop/prompts/builder.md > .loop/build.prompt
  run_claude acceptEdits .loop/build.prompt "$WT" >/dev/null
  [ -f "$WT/docs/loop/increments/$INC.blocked.md" ] && { scripts/loop/alert.sh G4 "$INC blocked by builder" "$(cat "$WT/docs/loop/increments/$INC.blocked.md")"; exit 0; }
  # VERIFY
  if ! scripts/loop/gates.sh "$WT" "$BASE" > .loop/gates.log 2>&1; then GAPS="Previous round failed deterministic gates: $(tail -5 .loop/gates.log)"; continue; fi
  # CRITIC
  sed -e "s/{{INCREMENT}}/$INC/g" -e "s/{{BASE}}/$BASE/g" scripts/loop/prompts/critic.md > .loop/critic.prompt
  VERDICT=$(run_claude default .loop/critic.prompt "$WT" --allowedTools "Read,Grep,Glob,Bash(bun test*),Bash(git diff*)" | jq -r '.result')
  if echo "$VERDICT" | jq -e '.verdict=="PASS"' >/dev/null 2>&1; then GAPS=""; break; fi
  GAPS="Critic gaps to close: $(echo "$VERDICT" | jq -c '.gaps' 2>/dev/null || echo "$VERDICT")"
done
[ -n "$GAPS" ] && { scripts/loop/alert.sh G5 "$INC unresolved after $LOOP_CRITIC_ROUNDS rounds" "$GAPS"; exit 0; }

# PR / CI / MERGE
( cd "$WT" && git push -q -u origin "$BR" && gh pr create --fill --base main --head "$BR" --label loop >/dev/null 2>&1 || true )
PR=$(gh pr list --head "$BR" --json number -q '.[0].number')
for try in $(seq 1 "$LOOP_CI_RETRIES"); do
  if gh pr checks "$PR" --watch --fail-fast >/dev/null 2>&1; then
    gh pr merge "$PR" --merge --delete-branch >/dev/null && MERGED=1 && break
  fi
  sed -e "s/{{INCREMENT}}/$INC/g" -e "s|{{GAPS}}|CI failed: $(gh pr checks "$PR" 2>/dev/null | grep -v pass | head -5)|g" scripts/loop/prompts/builder.md > .loop/build.prompt
  run_claude acceptEdits .loop/build.prompt "$WT" >/dev/null; ( cd "$WT" && git push -q )
done
[ "${MERGED:-0}" = 1 ] || { scripts/loop/alert.sh G5 "$INC CI red $LOOP_CI_RETRIES times" "PR #$PR"; exit 0; }

# DEPLOY + RECORD
git checkout -q main && git pull -q --ff-only origin main; SHA=$(git rev-parse HEAD)
python3 scripts/deploy-private-staging.py --root "$LOOP_STAGING_ROOT" --repo "$ROOT" --sha "$SHA" > .loop/deploy.log 2>&1 || \
  scripts/loop/alert.sh G8 "Staging deploy failed for $SHA" "$(tail -20 .loop/deploy.log)"
bun scripts/loop/status.ts record "$INC" "$SHA" "$PR"
git add docs/loop docs/PROGRAM-EXECUTION.md && git commit -qm "loop: record $INC merged as $SHA" && git push -q origin main
git worktree remove -f "$WT" || true
echo "== $INC merged as $SHA"
