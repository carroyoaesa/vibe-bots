#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE="run/web.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No hay PID file ($PID_FILE). El dashboard web no parece estar corriendo."
  exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Dashboard web detenido (PID $PID)."
else
  echo "El proceso $PID ya no existe."
fi

rm -f "$PID_FILE"
