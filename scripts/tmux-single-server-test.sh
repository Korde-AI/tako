#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${SESSION_NAME:-tako-single-server}"
BASE_DIR="${1:-/tmp/tako-single-server}"
HUB_HOME="$BASE_DIR/hub"
EDGE_A_HOME="$BASE_DIR/edge-a"
EDGE_B_HOME="$BASE_DIR/edge-b"
HUB_PORT="${HUB_PORT:-28790}"
EDGE_A_PORT="${EDGE_A_PORT:-28801}"
EDGE_B_PORT="${EDGE_B_PORT:-28802}"

write_edge_config() {
  local home="$1"
  local port="$2"
  mkdir -p "$home/workspace"
  cat > "$home/tako.json" <<EOF
{
  "providers": {
    "primary": "anthropic/claude-sonnet-4-6"
  },
  "channels": {},
  "tools": {
    "profile": "minimal"
  },
  "memory": {
    "workspace": "workspace"
  },
  "gateway": {
    "bind": "127.0.0.1",
    "port": $port
  },
  "network": {
    "hub": "http://127.0.0.1:$HUB_PORT",
    "heartbeatSeconds": 5
  }
}
EOF
}

rm -rf "$BASE_DIR"
mkdir -p "$HUB_HOME" "$EDGE_A_HOME" "$EDGE_B_HOME"
write_edge_config "$EDGE_A_HOME" "$EDGE_A_PORT"
write_edge_config "$EDGE_B_HOME" "$EDGE_B_PORT"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" -n hub "bash -lc 'cd \"$ROOT_DIR\" && bun run src/index.ts hub start --home \"$HUB_HOME\" --port \"$HUB_PORT\"; echo; echo hub window exited; exec bash'"
sleep 2
cd "$ROOT_DIR"
tmux new-window -t "$SESSION_NAME" -n status "bash -lc 'cd \"$ROOT_DIR\" && while true; do clear; bun run src/index.ts hub status --home \"$HUB_HOME\" --json; echo; bun run src/index.ts network status --home \"$EDGE_A_HOME\" --json; echo; bun run src/index.ts network status --home \"$EDGE_B_HOME\" --json; sleep 2; done'"
tmux new-window -t "$SESSION_NAME" -n edge-a "bash -lc 'cd \"$ROOT_DIR\" && bun run src/index.ts start --home \"$EDGE_A_HOME\" --port \"$EDGE_A_PORT\"; echo; echo edge-a window exited; exec bash'"
tmux new-window -t "$SESSION_NAME" -n edge-b "bash -lc 'cd \"$ROOT_DIR\" && bun run src/index.ts start --home \"$EDGE_B_HOME\" --port \"$EDGE_B_PORT\"; echo; echo edge-b window exited; exec bash'"
tmux new-window -t "$SESSION_NAME" -n admin "bash -lc 'cd \"$ROOT_DIR\" && bash \"$ROOT_DIR/scripts/run-single-server-flow.sh\" \"$BASE_DIR\"; echo; echo Report:; cat \"$BASE_DIR/report.md\"; echo; echo Press Enter to exit this window shell.; read'"

cat <<EOF
tmux session created: $SESSION_NAME
base dir: $BASE_DIR

Windows:
- hub: foreground hub server
- status: live hub/edge JSON summaries
- edge-a: foreground edge A runtime
- edge-b: foreground edge B runtime
- admin: automated project/invite/session/delegation flow and report

Attach with:
  tmux attach -t $SESSION_NAME

Report file:
  $BASE_DIR/report.md
EOF
