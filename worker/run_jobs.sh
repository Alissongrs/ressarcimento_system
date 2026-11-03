#!/usr/bin/env bash
# run_jobs.sh — roda as TAREFAS CONHECIDAS pedidas pelo chat (ex.: agua_sync) no host da VPS.
# Cron a cada minuto; nunca roda duas vezes ao mesmo tempo (flock). Não imprime credenciais.
set -uo pipefail

REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
LOG="${SURE_JOBS_LOG:-$REPO/worker/run_jobs.log}"
LOCK="${SURE_JOBS_LOCK:-/tmp/sure_run_jobs.lock}"
PYTHON="${SURE_PYTHON:-python3}"

exec 7>"$LOCK" || exit 0
flock -n 7 || exit 0
cd "$REPO" || { echo "[$(date '+%F %T')] repo não encontrado: $REPO" >> "$LOG"; exit 0; }

out="$(PYTHONUTF8=1 "$PYTHON" worker/run_jobs.py 2>&1)"
[ -n "$out" ] && { echo "[$(date '+%F %T')]"; echo "$out"; } >> "$LOG"
exit 0
