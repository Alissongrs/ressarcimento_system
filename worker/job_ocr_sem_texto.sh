#!/usr/bin/env bash
# job_ocr_sem_texto.sh — faturas SEM camada de texto (PDF-imagem) passam pelo OCR gratuito do próprio pipeline:
# RapidOCR (modelos do PaddleOCR em CPU, pacote rapidocr_onnxruntime; ~40 s por fatura) alimenta a identificação
# por quadro, a medição por molde (só grava consumo confirmado pelos itens da fatura) e o texto_ocr do extrator.
# Substitui a leitura visual automática (claude -p), que consumia o limite da assinatura.
#
# Fluxo: ocr_fila.py ids (fila própria FT_OCR_SEM_TEXTO + ids da ORIGEM) → BACKUP → pdf_pipeline --prod --force
# --id-file SEM --no-ocr → ocr_fila.py marcar. Usa o MESMO lock do pdf_pipeline (nunca dois pipelines juntos).
#
# Variáveis: SURE_OCR_LIMITE (faturas por rodada, default 200), SURE_OCR_PAGINAS (páginas lidas, default 3),
#            SURE_PYTHON, SURE_OCR_LOG.
set -uo pipefail

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$BUNDLE/engine"
PYTHON="${SURE_PYTHON:-python3}"
LOG="${SURE_OCR_LOG:-$BUNDLE/ocr_sem_texto.log}"
LOCK="/tmp/sure_pdf_pipeline.lock"
LIMITE="${SURE_OCR_LIMITE:-200}"
IDS="/tmp/sure_ocr_sem_texto_ids.txt"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 8>"$LOCK" || exit 0
flock -n 8 || { log "pdf_pipeline em execução — pulando."; exit 0; }
. "$BUNDLE/rotina_lib.sh"; rotina_ping ocr_sem_texto

cd "$ENGINE" || { log "pasta não encontrada: $ENGINE"; exit 0; }

# RapidOCR instalado uma vez para o usuário do cron (como o mysql-connector no job_pdf_pipeline.sh). O pacote pede o
# opencv-python inteiro (precisa de libGL); instalamos o headless antes e o rapidocr sem dependências.
if ! "$PYTHON" -c 'import rapidocr_onnxruntime' >/dev/null 2>&1; then
  log "rapidocr_onnxruntime não instalado — instalando (pip --user)…"
  "$PYTHON" -m pip install --user --quiet "opencv-python-headless" "onnxruntime" "pyclipper" "shapely" "pyyaml" "six" "pillow" "numpy" >> "$LOG" 2>&1
  "$PYTHON" -m pip install --user --quiet --no-deps "rapidocr_onnxruntime==1.4.4" >> "$LOG" 2>&1
  if "$PYTHON" -c 'import rapidocr_onnxruntime' >/dev/null 2>&1; then
    log "rapidocr_onnxruntime instalado"
  else
    log "aviso: rapidocr_onnxruntime não importa (veja acima; se faltar libGL: apt install libgl1 libglib2.0-0) — o pipeline usa o Tesseract"
  fi
fi

PYTHONUTF8=1 "$PYTHON" ocr_fila.py ids --saida "$IDS" --limite "$LIMITE" >> "$LOG" 2>&1
N="$(grep -c '[0-9]' "$IDS" 2>/dev/null || echo 0)"
if [ "${N:-0}" -eq 0 ]; then
  log "nada na fila."
  rotina_registrar ocr_sem_texto 0 "nenhuma fatura sem texto na fila"
  exit 0
fi
rotina_inicio ocr_sem_texto "$N fatura(s) sem texto → pdf_pipeline --force com OCR (RapidOCR)"

log "backup pré-OCR…"
bash "$BUNDLE/backup_sistema.sh" rotativo >> "$LOG" 2>&1 || log "aviso: backup falhou"

log "pdf_pipeline --prod --force (OCR ligado) em $N id(s) da origem"
PYTHONUTF8=1 SURE_OCR_PAGINAS="${SURE_OCR_PAGINAS:-3}" "$PYTHON" pdf_pipeline.py --prod --force --id-file "$IDS" >> "$LOG" 2>&1
RC=$?
PYTHONUTF8=1 "$PYTHON" ocr_fila.py marcar >> "$LOG" 2>&1
log "terminou (rc=$RC)"
rotina_fim "$RC" "OCR em $N fatura(s) sem texto (rc=$RC)"
exit 0
