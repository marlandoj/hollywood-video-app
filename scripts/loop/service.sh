#!/usr/bin/env bash
# RETIRED (2026-09-14): the headless conveyor no longer runs. Kept for the record; see
# docs/loop/EXECUTION-LOOP.md and docs/loop/HANDOFF-2026-09-14.md for how the loop runs now.
# Long-running wrapper (written for Zo, which no longer exists): one conveyor iteration every 30 minutes.
cd "$(dirname "$0")/../.." || exit 1
while true; do
  scripts/loop/conveyor.sh >> .loop/conveyor-service.log 2>&1
  sleep 1800
done
