#!/usr/bin/env bash
# job_agua.sh — faturas de água (ter/qui 02:00). Compara origem × FATURA_AGUA_DADOS e
# INSERE só as novas (mesmas empresas). agua_sync.py já grava backup das chaves inseridas
# (reversível por DELETE dessas chaves). Roda 'dry' (loga a prévia) e depois 'apply'.
#
# SURE_AGUA_DIR = pasta do agua_sync.py (default: worker/jobs, a mesma cópia que o chat usa via run_jobs.py
# — ela corrige a acentuação estragada da origem; a de ia/claro_bf não corrige).
set -uo pipefail

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
REPO="${SURE_REPO:-$(dirname "$BUNDLE")}"
AGUA_DIR="${SURE_AGUA_DIR:-$BUNDLE/jobs}"
PYTHON="${SURE_PYTHON:-python3}"
LOG="${SURE_AGUA_LOG:-$BUNDLE/agua.log}"
LOCK="/tmp/sure_agua.lock"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 7>"$LOCK" || exit 0
flock -n 7 || { log "já em execução — pulando."; exit 0; }

cd "$AGUA_DIR" || { log "pasta não encontrada: $AGUA_DIR"; exit 0; }

# 1) prévia (não grava nada)
log "água: prévia (dry)…"
PYTHONUTF8=1 "$PYTHON" agua_sync.py dry >> "$LOG" 2>&1

# 2) aplica (insere as novas; o próprio script grava backup_agua_sync_*.json p/ reverter)
log "água: aplicando (apply)…"
PYTHONUTF8=1 "$PYTHON" agua_sync.py apply >> "$LOG" 2>&1
RC=$?
log "água terminou (rc=$RC)."

# 3) regra de PICO de consumo (FA02) nas faturas inseridas hoje → aba 💧 Água do front
log "água: regra de pico de consumo (agua_motor apply)…"
PYTHONUTF8=1 "$PYTHON" "$BUNDLE/jobs/agua_motor.py" apply >> "$LOG" 2>&1
log "motor de água terminou (rc=$?)."

# 4) regra de COBRANÇA SEM MEDIÇÃO (FA05): mesmo m³ cobrado ≥3 meses seguidos, acima de 1,5× o normal
log "água: cobrança sem medição (agua_sem_medicao apply)…"
PYTHONUTF8=1 "$PYTHON" "$BUNDLE/jobs/agua_sem_medicao.py" apply >> "$LOG" 2>&1
log "cobrança sem medição terminou (rc=$?)."
exit 0
