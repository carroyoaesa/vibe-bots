#!/usr/bin/env bash
# Métricas custom de espacio de vibe-bots para el textfile collector de node_exporter
# (Fase 13) - corre por crontab cada 5 min, mismo mecanismo que trade/ingest/watchdog
# (ver "Automatización (cron)" en CLAUDE.md). Escribe atómico (archivo temporal + mv)
# para que node_exporter nunca lea un .prom a medio escribir.
set -euo pipefail

OUT_DIR="/var/lib/prometheus/node-exporter"
OUT_FILE="$OUT_DIR/vibebots.prom"
TMP_FILE="$(mktemp "$OUT_DIR/.vibebots.prom.XXXXXX")"

MINIO_BUCKET_BYTES=$(du -sb /var/lib/minio/vibe-bots 2>/dev/null | cut -f1)
LOGS_DIR_BYTES=$(du -sb /root/bots/vibe-bots/logs 2>/dev/null | cut -f1)

{
  echo "# HELP vibebots_minio_bucket_bytes Tamaño en bytes del bucket MinIO de vibe-bots (snapshots ingest/trading)."
  echo "# TYPE vibebots_minio_bucket_bytes gauge"
  echo "vibebots_minio_bucket_bytes ${MINIO_BUCKET_BYTES:-0}"
  echo "# HELP vibebots_logs_dir_bytes Tamaño en bytes del directorio logs/ de vibe-bots."
  echo "# TYPE vibebots_logs_dir_bytes gauge"
  echo "vibebots_logs_dir_bytes ${LOGS_DIR_BYTES:-0}"
} > "$TMP_FILE"

chmod 644 "$TMP_FILE"
mv "$TMP_FILE" "$OUT_FILE"
