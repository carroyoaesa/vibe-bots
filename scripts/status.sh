#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

echo "=== Servicios nativos ==="
for svc in postgresql redis-server minio grafana-server; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "desconocido")
  printf "  %-16s %s\n" "$svc" "$status"
done

echo
echo "=== Dashboard web (Vibe Bots) ==="
PID_FILE="run/web.pid"
WEB_PORT="${WEB_PORT:-4000}"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PID=$(cat "$PID_FILE")
  echo "  Corriendo (PID $PID)"
  curl -s -o /dev/null -w "  /api/health -> HTTP %{http_code}\n" "http://localhost:${WEB_PORT}/api/health"
else
  echo "  Detenido. Iniciar con: ./scripts/start-web.sh"
fi
