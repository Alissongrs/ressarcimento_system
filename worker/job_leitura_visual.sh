#!/usr/bin/env bash
# job_leitura_visual.sh — leitura visual noturna (etapa 3 da captura de alto nível).
# Faturas que o motor não fechou (PDF só imagem ou gate "reprovado") são lidas pelo `claude -p`
# (assinatura do Claude Code da VPS, sem API) a partir das imagens das páginas; o JSON passa pelas
# contas da fatura e cada tentativa fica em FT_LEITURA_VISUAL. Só preenche colunas VAZIAS de
# FATURA_DADOS_EXTRAIDOS, e só com SURE_VISUAL_GRAVAR=1 (default 0 = lê, valida e registra, não grava).
#
# Variáveis: SURE_VISUAL_TETO (faturas por noite, default 300), SURE_VISUAL_MAX_MIN (default 300),
#            SURE_VISUAL_GRAVAR (0/1), SURE_CLAUDE_BIN, SURE_PYTHON.
set -uo pipefail

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$BUNDLE/engine"
PYTHON="${SURE_PYTHON:-python3}"
LOG="${SURE_VISUAL_LOG:-$BUNDLE/leitura_visual.log}"
LOCK="/tmp/sure_leitura_visual.lock"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 8>"$LOCK" || exit 0
flock -n 8 || { log "já em execução — pulando."; exit 0; }
. "$BUNDLE/rotina_lib.sh"; rotina_ping leitura_visual

command -v "${SURE_CLAUDE_BIN:-claude}" >/dev/null 2>&1 || { log "claude não encontrado no PATH"; rotina_registrar leitura_visual 1 "claude não encontrado no PATH"; exit 0; }
cd "$ENGINE" || { log "pasta não encontrada: $ENGINE"; exit 0; }
log "iniciando (teto=${SURE_VISUAL_TETO:-300}, gravar=${SURE_VISUAL_GRAVAR:-0})"
PYTHONUTF8=1 "$PYTHON" leitura_visual.py rodar >> "$LOG" 2>&1
RC=$?
log "terminou (rc=$RC)"
exit 0
