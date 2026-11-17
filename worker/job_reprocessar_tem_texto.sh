#!/usr/bin/env bash
# job_reprocessar_tem_texto.sh — faturas que a leitura visual marcou `tem_texto` (PDF com camada de texto que a
# base não guardou — caminho antigo da Claro) voltam ao pdf_pipeline determinístico (etapas 1 e 2: identificação
# por quadro + medição por molde). O --revalidar não serve (usa o texto JÁ salvo, que aqui não existe): roda o
# caminho normal com --force nos ids da ORIGEM (Faturas_Registradas_Cache.id, via uid), baixando o PDF de novo.
# Faz BACKUP antes (reversão), como o job_pdf_pipeline.sh, e usa o MESMO lock dele (nunca dois pipelines juntos).
#
# Variáveis: SURE_REPROC_LIMITE (faturas por rodada, default 300), SURE_PYTHON, SURE_IA_DIR.
set -uo pipefail

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$BUNDLE/engine"
PYTHON="${SURE_PYTHON:-python3}"
LOG="${SURE_REPROC_LOG:-$BUNDLE/reprocessar_tem_texto.log}"
LOCK="/tmp/sure_pdf_pipeline.lock"
LIMITE="${SURE_REPROC_LIMITE:-300}"
IDS="/tmp/sure_tem_texto_ids.txt"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 8>"$LOCK" || exit 0
flock -n 8 || { log "pdf_pipeline em execução — pulando."; exit 0; }
. "$BUNDLE/rotina_lib.sh"; rotina_ping reprocessar_tem_texto

cd "$ENGINE" || { log "pasta não encontrada: $ENGINE"; exit 0; }
PYTHONUTF8=1 "$PYTHON" leitura_visual.py tem-texto-ids --saida "$IDS" --limite "$LIMITE" >> "$LOG" 2>&1
N="$(grep -c '[0-9]' "$IDS" 2>/dev/null || echo 0)"
if [ "${N:-0}" -eq 0 ]; then
  log "nada a reprocessar."
  rotina_registrar reprocessar_tem_texto 0 "nenhuma fatura tem_texto"
  exit 0
fi
rotina_inicio reprocessar_tem_texto "$N fatura(s) tem_texto → pdf_pipeline --force"

log "backup pré-reprocesso…"
bash "$BUNDLE/backup_sistema.sh" rotativo >> "$LOG" 2>&1 || log "aviso: backup falhou"

log "pdf_pipeline --prod --force --no-ocr em $N id(s) da origem"
PYTHONUTF8=1 "$PYTHON" pdf_pipeline.py --prod --force --no-ocr --id-file "$IDS" >> "$LOG" 2>&1
RC=$?
if [ "$RC" -eq 0 ]; then
  PYTHONUTF8=1 "$PYTHON" leitura_visual.py tem-texto-marcar --limite "$LIMITE" >> "$LOG" 2>&1
fi
log "terminou (rc=$RC)"
rotina_fim "$RC" "pdf_pipeline --force em $N fatura(s) tem_texto (rc=$RC)"
exit 0
