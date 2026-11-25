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
#            SURE_OCR_VERSAO (v4 | v6 | combo; default combo se os dois pacotes carregam), SURE_PYTHON, SURE_OCR_LOG.
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

# Ambiente próprio do OCR (worker/.venv_ocr): o pip --user misturava numpy 2 com pacotes do sistema compilados para
# numpy 1 (ABI mismatch, 18/11) e o RapidOCR não carregava — o pipeline caía no Tesseract, que não está no host.
# Versões = requirements-ocr.txt (base dos goldens do CI). Sem RapidOCR NÃO roda o pipeline (nada a ganhar e marcaria
# faturas à toa).
VENV="${SURE_OCR_VENV:-$BUNDLE/.venv_ocr}"
if ! "$VENV/bin/python" -c 'import rapidocr_onnxruntime, fitz, mysql.connector' >/dev/null 2>&1; then
  log "preparando $VENV (requirements-ocr.txt + rapidocr_onnxruntime)…"
  { [ -x "$VENV/bin/python" ] || "$PYTHON" -m venv "$VENV"; } >> "$LOG" 2>&1
  "$VENV/bin/python" -m pip install --quiet --upgrade pip >> "$LOG" 2>&1
  "$VENV/bin/python" -m pip install --quiet -r "$ENGINE/requirements-ocr.txt" >> "$LOG" 2>&1
  "$VENV/bin/python" -m pip install --quiet --no-deps "rapidocr_onnxruntime==1.4.4" >> "$LOG" 2>&1
fi
if ! "$VENV/bin/python" -c 'import rapidocr_onnxruntime, fitz, mysql.connector' >> "$LOG" 2>&1; then
  log "ERRO: RapidOCR não carrega em $VENV (veja acima; sem venv: apt install python3-venv; sem libGL: apt install libgl1 libglib2.0-0) — pipeline NÃO executado"
  rotina_registrar ocr_sem_texto 1 "RapidOCR indisponível no ambiente $VENV — nada processado"
  exit 0
fi
# 24/11/2026: leitor de código de barras/QR (codigos.py) — venv já existente não reinstala o requirements; opcional
"$VENV/bin/python" -c 'import zxingcpp' >/dev/null 2>&1 ||   "$VENV/bin/python" -m pip install --quiet "zxing-cpp==3.1.1" >> "$LOG" 2>&1 || log "aviso: zxing-cpp não instalou (códigos de barras/QR desligados)"
# 25/11/2026: OCR combinado — v4 (rapidocr_onnxruntime) lê; o v6 (rapidocr 3, PP-OCRv6) só completa campo que o v4
# deixou vazio e que uma conta confirma (ocr_combinado.py). Nas 50 escaneadas do gabarito: 597 → 639 certos, 12 → 12
# errados. Sem o pacote v6 segue só o v4 (combo exige os dois: sem eles o pipeline cairia no Tesseract).
"$VENV/bin/python" -c 'import rapidocr' >/dev/null 2>&1 || "$VENV/bin/python" -m pip install --quiet "rapidocr==3.10.0" >> "$LOG" 2>&1 || log "aviso: rapidocr 3 não instalou"
if [ -z "${SURE_OCR_VERSAO:-}" ]; then
  if "$VENV/bin/python" -c 'import rapidocr, rapidocr_onnxruntime' >/dev/null 2>&1; then
    export SURE_OCR_VERSAO=combo
  else
    export SURE_OCR_VERSAO=v4
    log "aviso: rapidocr 3 indisponível — OCR só v4 (sem combo)"
  fi
fi
PYTHON="$VENV/bin/python"
log "OCR versão=$SURE_OCR_VERSAO"
log "RapidOCR ok ($("$PYTHON" -c 'import numpy, onnxruntime; print("numpy", numpy.__version__, "onnxruntime", onnxruntime.__version__)' 2>/dev/null))"

PYTHONUTF8=1 "$PYTHON" ocr_fila.py ids --saida "$IDS" --limite "$LIMITE" >> "$LOG" 2>&1
N="$(grep -c '[0-9]' "$IDS" 2>/dev/null || echo 0)"
if [ "${N:-0}" -eq 0 ]; then
  log "nada na fila."
  rotina_registrar ocr_sem_texto 0 "nenhuma fatura sem texto na fila"
  exit 0
fi
rotina_inicio ocr_sem_texto "$N fatura(s) sem texto → pdf_pipeline --force com OCR (RapidOCR)"

log "backup pré-OCR…"
if ! bash "$BUNDLE/backup_sistema.sh" rotativo >> "$LOG" 2>&1; then
  log "ERRO: backup falhou — pipeline NÃO executado (nada no banco sem backup); faturas voltam para a fila"
  PYTHONUTF8=1 "$PYTHON" ocr_fila.py desfazer >> "$LOG" 2>&1
  rotina_fim 1 "backup falhou — OCR não executado"
  exit 0
fi

log "pdf_pipeline --prod --force (OCR ligado) em $N id(s) da origem"
PYTHONUTF8=1 SURE_OCR_PAGINAS="${SURE_OCR_PAGINAS:-3}" "$PYTHON" pdf_pipeline.py --prod --force --id-file "$IDS" >> "$LOG" 2>&1
RC=$?
PYTHONUTF8=1 "$PYTHON" ocr_fila.py marcar >> "$LOG" 2>&1
log "terminou (rc=$RC)"
rotina_fim "$RC" "OCR em $N fatura(s) sem texto (rc=$RC)"
exit 0
