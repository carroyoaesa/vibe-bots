#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE="run/web.pid"
LOG_FILE="logs/web.log"

mkdir -p run logs

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "El dashboard web ya está corriendo (PID $(cat "$PID_FILE"))."
  exit 0
fi

nohup node_modules/.bin/ts-node src/server.ts >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "Dashboard web iniciado (PID $!). Logs: $LOG_FILE"
