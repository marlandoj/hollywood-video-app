#!/usr/bin/env bash
# Deterministic VERIFY stage. Usage: gates.sh <worktree> <base-ref>
set -euo pipefail
WT="$1"; BASE="$2"; cd "$WT"
fail(){ echo "GATE FAIL: $*" >&2; exit 1; }
bun install --frozen-lockfile >/dev/null
bun run typecheck || fail typecheck
bun run lint || fail lint
git diff --check "$BASE"...HEAD || fail whitespace
# frozen list
CHANGED=$(git diff --name-only "$BASE"...HEAD)
echo "$CHANGED" | grep -E '^(docs/legal/|docs/adr/|\.github/workflows/)' && fail "frozen path changed"
if echo "$CHANGED" | grep -q '^packages/safety/'; then
  git diff "$BASE"...HEAD -- packages/safety | grep -E '^-\s*("|\x27)' && fail "safety refusal removed"
fi
git diff "$BASE"...HEAD -- docker-compose.yml | grep -E '^\+.*HV_(MONTHLY_BUDGET|COST_CAP_PER_SHOT)_USD' && fail "budget default raised"
# secrets
git diff "$BASE"...HEAD | grep -EiA0 '^\+.*(api[_-]?key|secret|token)\s*[:=]\s*["\x27][A-Za-z0-9_\-]{16,}' && fail "secret-like literal"
# docs updated
echo "$CHANGED" | grep -qE '^docs/loop/increments/|^docs/PROGRAM-EXECUTION.md|^docs/[A-Z-]+\.md' || fail "no doc update"
# tests + benchmark
bun test packages test || fail tests
bun run benchmark:compare || fail benchmark
echo "GATES PASS"
