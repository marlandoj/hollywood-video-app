#!/usr/bin/env bash
# Raise a human gate: alert.sh <G#> "<title>" "<detail>". Pauses the conveyor.
set -euo pipefail
G="$1"; TITLE="$2"; DETAIL="$3"; ROOT="$(git rev-parse --show-toplevel)"
TS=$(date -u +%Y-%m-%dT%H:%MZ); ID="$G-$(date -u +%Y%m%d%H%M)"
mkdir -p "$ROOT/.loop"; echo "$ID" > "$ROOT/.loop/paused"
cat >> "$ROOT/docs/loop/HUMAN-GATES.md" <<MD

## $ID $TITLE
- raised: $TS
- gate: $G
- detail: $DETAIL
- resolved: (operator: replace this line with "resolved: <decision>")
MD
# Linear issue under the program
if [ -n "${LINEAR_API_KEY:-}" ]; then
  Q=$(jq -n --arg t "[$G] $TITLE" --arg d "$DETAIL\n\nRepo: hollywood-video-app, gate id $ID" \
    '{query:"mutation($t:String!,$d:String!){issueCreate(input:{title:$t,description:$d,teamId:\"'"${LINEAR_TEAM_ID:-}"'\"}){success issue{identifier url}}}",variables:{t:$t,d:$d}}')
  curl -s -H "Authorization: $LINEAR_API_KEY" -H 'Content-Type: application/json' -d "$Q" https://api.linear.app/graphql | tee -a "$ROOT/.loop/alerts.log" >/dev/null || true
fi
# Zo notification email (skill-based; best effort)
[ -x /home/workspace/Skills/agentmail-send-email/scripts/send.sh ] && \
  /home/workspace/Skills/agentmail-send-email/scripts/send.sh "Rough Cut human gate $ID: $TITLE" "$DETAIL" || true
echo "PAUSED on $ID"
