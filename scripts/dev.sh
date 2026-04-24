#!/bin/bash
# Start both backend and frontend dev servers in detached tmux sessions
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_SESSION="lidar-agent-unclassified-backend"
FRONTEND_SESSION="lidar-agent-unclassified-frontend"

if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux is required but not installed."
  exit 1
fi

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -i :"$port" -t 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null || true
  fi
}

stop_session() {
  local session="$1"
  if tmux has-session -t "$session" 2>/dev/null; then
    tmux kill-session -t "$session"
  fi
}

status_line() {
  local name="$1"
  local ok="$2"
  if [ "$ok" = "1" ]; then
    echo "$name OK"
  else
    echo "$name FAILED"
  fi
}

echo "Stopping previous dev services..."
stop_session "$BACKEND_SESSION"
stop_session "$FRONTEND_SESSION"
kill_port 3000
kill_port 5173
sleep 1

echo "Starting backend in tmux session: $BACKEND_SESSION"
tmux new-session -d -s "$BACKEND_SESSION" "cd '$PROJECT_DIR' && exec npx tsx src/index.ts >> /tmp/lidar-agent-unclassified-backend.log 2>&1"

echo "Starting frontend in tmux session: $FRONTEND_SESSION"
tmux new-session -d -s "$FRONTEND_SESSION" "cd '$PROJECT_DIR/web' && exec npx vite --host >> /tmp/lidar-agent-unclassified-frontend.log 2>&1"

sleep 5

backend_ok=0
frontend_ok=0

if curl -fsS http://localhost:3000/health >/tmp/lidar-agent-unclassified-health.json 2>/dev/null; then
  backend_ok=1
fi

if curl -fsSI http://localhost:5173/ >/tmp/lidar-agent-unclassified-frontend.head 2>/dev/null; then
  frontend_ok=1
fi

status_line "Backend" "$backend_ok"
status_line "Frontend" "$frontend_ok"

if [ "$backend_ok" != "1" ] || [ "$frontend_ok" != "1" ]; then
  echo "Check logs: /tmp/lidar-agent-unclassified-backend.log and /tmp/lidar-agent-unclassified-frontend.log"
  exit 1
fi

echo "Dev servers are up."
