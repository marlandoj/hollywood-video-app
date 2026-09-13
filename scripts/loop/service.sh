#!/usr/bin/env bash
# Long-running wrapper for Zo hosted-service registration: one conveyor iteration every 30 minutes.
cd "$(dirname "$0")/../.." || exit 1
source /root/.zo_secrets 2>/dev/null || true
while true; do
  scripts/loop/conveyor.sh >> .loop/conveyor-service.log 2>&1
  sleep 1800
done
