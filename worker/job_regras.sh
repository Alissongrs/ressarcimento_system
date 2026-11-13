#!/usr/bin/env bash
# job_regras.sh — aplica as regras "passadas ao banco" (todo dia 00:00).
# Chama o endpoint interno do backend (protegido por X-Cron-Token). O backend grava
# em DM_REGRAS com backup em DM_REGRAS_BACKUP (reversível por regra).
set -uo pipefail

REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
ENV="${SURE_ENV:-$REPO/backend/.env}"
API="${SURE_API_BASE:-http://127.0.0.1:8080/api/v1}"
BUNDLE="$(cd "$(dirname "$0")" && pwd)"
LOG="${SURE_REGRAS_LOG:-$BUNDLE/regras.log}"
LOCK="/tmp/sure_regras.lock"
# token: env CRON_TOKEN ou lido do backend/.env
TOKEN="${CRON_TOKEN:-$(grep -E '^CRON_TOKEN' "$ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 6>"$LOCK" || exit 0
flock -n 6 || { log "já em execução — pulando."; exit 0; }

. "$BUNDLE/rotina_lib.sh"
if [ -z "$TOKEN" ]; then
  log "CRON_TOKEN ausente — defina no backend/.env (e no ambiente do backend) antes de habilitar."
  rotina_registrar regras 1 "CRON_TOKEN ausente no backend/.env"
  exit 0
fi

TMP="$(mktemp)"
code="$(curl -s -m 60 -o "$TMP" -w '%{http_code}' -X POST "$API/rules/aplicar-agendadas" -H "X-Cron-Token: $TOKEN" 2>>"$LOG")"; RC=$?
resp="$(cat "$TMP" 2>/dev/null)"; rm -f "$TMP"
[ $RC -eq 0 ] && [ "${code:-000}" != "200" ] && RC=1
log "aplicar-agendadas → HTTP ${code:-?} ${resp:-<sem resposta>}"
rotina_registrar regras "$RC" "HTTP ${code:-?} ${resp:-sem resposta do backend}"
exit 0
