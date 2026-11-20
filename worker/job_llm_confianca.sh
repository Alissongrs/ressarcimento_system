#!/usr/bin/env bash
# job_llm_confianca.sh — faturas com campo-chave de CONFIANÇA BAIXA (uma fonte só, vazio ou divergente no confianca_json)
# vão ao modelo da OpenAI (gpt-5.4-mini, pago por token) como MAIS UMA FONTE: concordou, confirma; vazio na base e a
# origem (ou física + item) concorda, preenche; discordou, vira divergência. Nunca grava sozinho (o nano inventava
# tributos que fechavam na conta — ver tests/CONFERENCIA_VISUAL_2026-11-17_openai_*).
#
# Roda de hora em hora; SURE_LLM_POR_HORA (padrão 20) limita as chamadas, descontando o que já rodou na última hora
# (FT_LEITURA_VISUAL, modelo 'openai:…'). Custo em tokens fica em validacao_json.tokens de cada tentativa.
# Chave: OPENAI_API_KEY no backend/.env. SURE_VISUAL_GRAVAR=1 liga a gravação (padrão 0 = só registra).
set -uo pipefail

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$BUNDLE/engine"
PYTHON="${SURE_PYTHON:-python3}"
LOG="${SURE_LLM_LOG:-$BUNDLE/llm_confianca.log}"
LOCK="/tmp/sure_llm_confianca.lock"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 8>"$LOCK" || exit 0
flock -n 8 || { log "já em execução — pulando."; exit 0; }

cd "$ENGINE" || { log "pasta não encontrada: $ENGINE"; exit 0; }
GRAVAR=""
[ "${SURE_VISUAL_GRAVAR:-0}" = "1" ] && GRAVAR="--gravar"
log "início: fila confianca, motor openai (${SURE_VISUAL_MODELO:-gpt-5.4-mini}), até ${SURE_LLM_POR_HORA:-20}/h $GRAVAR"
# shellcheck disable=SC2086
PYTHONUTF8=1 SURE_VISUAL_MODELO="${SURE_VISUAL_MODELO:-gpt-5.4-mini}" "$PYTHON" leitura_visual.py rodar --fila confianca --motor openai \
  --teto "${SURE_LLM_POR_HORA:-20}" --minutos "${SURE_LLM_MAX_MIN:-50}" $GRAVAR >> "$LOG" 2>&1
log "fim (rc=$?)"
exit 0
