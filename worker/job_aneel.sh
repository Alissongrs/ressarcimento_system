#!/usr/bin/env bash
# job_aneel.sh — importa as tarifas homologadas e as bandeiras da ANEEL (dados abertos), todo dia.
# Chama o endpoint interno do backend (protegido por X-Cron-Token). O backend grava em PARAM_ANEEL_TARIFAS /
# PARAM_ANEEL_BANDEIRAS (upsert pela chave natural — reimportar não duplica) e registra em PARAM_ANEEL_IMPORTACOES.
# Usado pelas regras F28, F41, F42 e F58 da aba ⚡ Usinas da Auditoria de Faturas.
set -uo pipefail

REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
ENV="${SURE_ENV:-$REPO/backend/.env}"
API="${SURE_API_BASE:-http://127.0.0.1:8080/api/v1}"
BUNDLE="$(cd "$(dirname "$0")" && pwd)"
LOG="${SURE_ANEEL_LOG:-$BUNDLE/aneel.log}"
LOCK="/tmp/sure_aneel.lock"
TOKEN="${CRON_TOKEN:-$(grep -E '^CRON_TOKEN' "$ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 6>"$LOCK" || exit 0
flock -n 6 || { log "já em execução — pulando."; exit 0; }

if [ -z "$TOKEN" ]; then
  log "CRON_TOKEN ausente — defina no backend/.env (e no ambiente do backend) antes de habilitar."
  exit 0
fi

# a ANEEL pode demorar: até 10 min
resp="$(curl -s -m 600 -X POST "$API/parametros/aneel/importar-cron" -H "X-Cron-Token: $TOKEN" 2>>"$LOG")"
log "importar-cron → ${resp:-<sem resposta>}"
exit 0
