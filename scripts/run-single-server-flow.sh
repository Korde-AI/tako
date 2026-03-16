#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_DIR="${1:-/tmp/tako-single-server}"
HUB_HOME="$BASE_DIR/hub"
EDGE_A_HOME="$BASE_DIR/edge-a"
EDGE_B_HOME="$BASE_DIR/edge-b"
REPORT_FILE="$BASE_DIR/report.md"
INVITE_FILE="$BASE_DIR/alpha-invite.json"

log() {
  printf '[single-server-flow] %s\n' "$*"
}

json_field() {
  local file="$1"
  local expr="$2"
  node -e "const fs=require('fs'); const obj=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const parts=process.argv[2].split('.'); let cur=obj; for (const part of parts) { cur = cur?.[part]; } if (cur === undefined) process.exit(2); if (typeof cur === 'object') console.log(JSON.stringify(cur)); else console.log(String(cur));" "$file" "$expr"
}

wait_for_file() {
  local file="$1"
  local retries="${2:-30}"
  local delay="${3:-1}"
  for _ in $(seq 1 "$retries"); do
    if [[ -f "$file" ]]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

wait_for_command() {
  local retries="${1:-30}"
  local delay="${2:-1}"
  shift 2
  for _ in $(seq 1 "$retries"); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

mkdir -p "$BASE_DIR"

log "Waiting for hub and edge daemons"
wait_for_command 40 1 bash -lc "cd '$ROOT_DIR' && bun run src/index.ts hub status --home '$HUB_HOME' --json"
wait_for_command 40 1 bash -lc "cd '$ROOT_DIR' && bun run src/index.ts status --home '$EDGE_A_HOME' --json"
wait_for_command 40 1 bash -lc "cd '$ROOT_DIR' && bun run src/index.ts status --home '$EDGE_B_HOME' --json"

EDGE_A_STATUS="$BASE_DIR/edge-a-status.json"
EDGE_B_STATUS="$BASE_DIR/edge-b-status.json"
HUB_STATUS="$BASE_DIR/hub-status.json"

cd "$ROOT_DIR"
bun run src/index.ts status --home "$EDGE_A_HOME" --json > "$EDGE_A_STATUS"
bun run src/index.ts status --home "$EDGE_B_HOME" --json > "$EDGE_B_STATUS"
bun run src/index.ts hub status --home "$HUB_HOME" --json > "$HUB_STATUS"

EDGE_A_NODE_ID="$(json_field "$EDGE_A_STATUS" 'node.nodeId')"
EDGE_B_NODE_ID="$(json_field "$EDGE_B_STATUS" 'node.nodeId')"
EDGE_A_NODE_NAME="$(json_field "$EDGE_A_STATUS" 'node.name')"
EDGE_B_NODE_NAME="$(json_field "$EDGE_B_STATUS" 'node.name')"

log "Seeding local human principals"
EDGE_A_PRINCIPAL_ID="$(bun run scripts/seed-principal.ts --home "$EDGE_A_HOME" --display-name alice --platform-user-id alice-tui --authority-level owner)"
EDGE_B_PRINCIPAL_ID="$(bun run scripts/seed-principal.ts --home "$EDGE_B_HOME" --display-name bob --platform-user-id bob-tui --authority-level owner)"

log "Creating project on edge A"
PROJECT_JSON="$BASE_DIR/project-alpha.json"
bun run src/index.ts projects create alpha --owner "$EDGE_A_PRINCIPAL_ID" --name "Alpha" --home "$EDGE_A_HOME" --json > "$PROJECT_JSON"
PROJECT_ID="$(json_field "$PROJECT_JSON" 'projectId')"

log "Creating invite from edge A to edge B"
INVITE_CREATE_JSON="$BASE_DIR/invite-create.json"
bun run src/index.ts network invite create alpha \
  --issued-by "$EDGE_A_PRINCIPAL_ID" \
  --target-node "$EDGE_B_NODE_ID" \
  --role contribute \
  --home "$EDGE_A_HOME" \
  --json | tee "$INVITE_CREATE_JSON" > "$INVITE_FILE"
INVITE_ID="$(json_field "$INVITE_CREATE_JSON" 'inviteId')"

log "Importing and accepting invite on edge B"
bun run src/index.ts network invite import "$INVITE_FILE" --home "$EDGE_B_HOME" --json > "$BASE_DIR/invite-import.json"
bun run src/index.ts network invite accept "$INVITE_ID" --home "$EDGE_B_HOME" --json > "$BASE_DIR/invite-accept.json"

log "Promoting inviter-side trust on edge A for symmetric delegation tests"
bun run scripts/set-trust.ts --home "$EDGE_A_HOME" --remote-node-id "$EDGE_B_NODE_ID" --remote-node-name "$EDGE_B_NODE_NAME" --ceiling contribute > /dev/null

log "Registering network session"
NETWORK_SESSION_JSON="$BASE_DIR/network-session.json"
bun run src/index.ts network sessions register alpha --nodes "$EDGE_B_NODE_ID" --home "$EDGE_A_HOME" --json > "$NETWORK_SESSION_JSON"
NETWORK_SESSION_ID="$(json_field "$NETWORK_SESSION_JSON" 'networkSessionId')"
bun run scripts/mirror-network-session.ts --home "$EDGE_B_HOME" --session-file "$NETWORK_SESSION_JSON" > /dev/null

log "Sending bounded delegation request"
REQUEST_JSON="$BASE_DIR/delegation-request.json"
bun run src/index.ts network delegate alpha \
  --to "$EDGE_B_NODE_ID" \
  --capability summarize_workspace \
  --network-session "$NETWORK_SESSION_ID" \
  --home "$EDGE_A_HOME" \
  --json > "$REQUEST_JSON"
REQUEST_ID="$(json_field "$REQUEST_JSON" 'requestId')"

log "Processing pending network events on edge B"
bun run scripts/process-network-events.ts --home "$EDGE_B_HOME" > "$BASE_DIR/edge-b-poll.json"

log "Processing pending network events on edge A"
bun run scripts/process-network-events.ts --home "$EDGE_A_HOME" > "$BASE_DIR/edge-a-poll.json"

log "Waiting for delegation result"
RESULT_JSON="$BASE_DIR/delegation-result.json"
rm -f "$RESULT_JSON"
for _ in $(seq 1 30); do
  TMP_RESULT="$BASE_DIR/.delegation-result.tmp"
  rm -f "$TMP_RESULT"
  if bun run src/index.ts network results show "$REQUEST_ID" --home "$EDGE_A_HOME" --json > "$TMP_RESULT" 2>/dev/null; then
    mv "$TMP_RESULT" "$RESULT_JSON"
    break
  fi
  bun run scripts/process-network-events.ts --home "$EDGE_A_HOME" > "$BASE_DIR/edge-a-poll.json" 2>/dev/null || true
  sleep 1
done

if [[ ! -s "$RESULT_JSON" ]]; then
  log "Delegation result did not arrive in time"
  exit 1
fi

EDGE_A_NETWORK_STATUS="$BASE_DIR/edge-a-network-status.json"
EDGE_B_NETWORK_STATUS="$BASE_DIR/edge-b-network-status.json"
HUB_NODES="$BASE_DIR/hub-nodes.json"
HUB_PROJECTS="$BASE_DIR/hub-projects.json"

bun run src/index.ts network status --home "$EDGE_A_HOME" --json > "$EDGE_A_NETWORK_STATUS"
bun run src/index.ts network status --home "$EDGE_B_HOME" --json > "$EDGE_B_NETWORK_STATUS"
bun run src/index.ts hub nodes --home "$HUB_HOME" --json > "$HUB_NODES"
bun run src/index.ts hub projects --home "$HUB_HOME" --json > "$HUB_PROJECTS"

RESULT_STATUS="$(json_field "$RESULT_JSON" 'status')"
RESULT_SUMMARY="$(json_field "$RESULT_JSON" 'summary')"

cat > "$REPORT_FILE" <<EOF
# Single-Server Tako Report

Date: $(date -Iseconds)
Base dir: $BASE_DIR

## Topology

- Hub home: $HUB_HOME
- Edge A home: $EDGE_A_HOME
- Edge B home: $EDGE_B_HOME
- Edge A node: $EDGE_A_NODE_NAME ($EDGE_A_NODE_ID)
- Edge B node: $EDGE_B_NODE_NAME ($EDGE_B_NODE_ID)
- Edge A principal: $EDGE_A_PRINCIPAL_ID
- Edge B principal: $EDGE_B_PRINCIPAL_ID

## Flow

1. Hub started in tmux session
2. Edge A and Edge B started as daemons
3. Local human principals seeded without Discord/Telegram
4. Project \`alpha\` created on Edge A
5. Invite created on Edge A and imported/accepted on Edge B
6. Edge A inviter-side trust promoted locally for symmetric test coverage
7. Network session registered
8. Delegation request \`summarize_workspace\` sent from Edge A to Edge B
9. Delegation result received on Edge A

## Result

- Project ID: $PROJECT_ID
- Invite ID: $INVITE_ID
- Network session ID: $NETWORK_SESSION_ID
- Delegation request ID: $REQUEST_ID
- Delegation result status: $RESULT_STATUS
- Delegation result summary: $RESULT_SUMMARY

## Notes

- No Discord or Telegram was used.
- No real LLM endpoint was used.
- TUI windows are available in tmux for manual inspection, but the admin flow is CLI-driven because current setup, invite, trust, and network operations are CLI surfaces.
- The inviter-side trust promotion is currently explicit in this harness because invite acceptance is still local-first and does not yet round-trip trust state back to the issuer automatically.
- The network session is mirrored onto Edge B explicitly in this harness so delegation results can return over the existing relay path without requiring manual remote session setup.
EOF

log "Report written to $REPORT_FILE"
cat "$REPORT_FILE"
