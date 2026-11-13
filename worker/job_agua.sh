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
. "$BUNDLE/rotina_lib.sh"; rotina_inicio agua

cd "$AGUA_DIR" || { log "pasta não encontrada: $AGUA_DIR"; rotina_fim 1 "pasta não encontrada: $AGUA_DIR"; exit 0; }

DESDE="$(date +%F)"  # faturas inseridas a partir de agora

# 1) prévia (não grava nada)
log "água: prévia (dry)…"
PYTHONUTF8=1 "$PYTHON" agua_sync.py dry >> "$LOG" 2>&1

# 2) aplica (insere as novas; o próprio script grava backup_agua_sync_*.json p/ reverter)
log "água: aplicando (apply)…"
PYTHONUTF8=1 "$PYTHON" agua_sync.py apply >> "$LOG" 2>&1
RC=$?
log "água terminou (rc=$RC)."

# 3) regras de água (pico FA02 + cobrança sem medição FA05) — motor do BACKEND desde 03/11/2026
#    (jobs/agua_motor.py e jobs/agua_sem_medicao.py não rodam mais). O backend grava com backup.
log "água: regras de água no backend (pico + sem medição)…"
PYTHONUTF8=1 "$PYTHON" "$BUNDLE/regras_agua.py" apply --desde "$DESDE" >> "$LOG" 2>&1; RC2=$?
log "regras de água terminaram (rc=$RC2)."
if [ "$RC" -ne 0 ]; then RCF=$RC; else RCF=$RC2; fi
rotina_fim "$RCF" "agua_sync rc=$RC; regras de água rc=$RC2"
exit 0
