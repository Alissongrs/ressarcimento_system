#!/usr/bin/env bash
# job_pdf_pipeline.sh — extração em lote (seg/qui 02:00). Faz BACKUP antes (reversão),
# roda o pipeline e loga. Os itens de baixa confiança caem nas filas de conferência do
# front (Auditados/Desvio) — a verificação visual é feita LÁ, não no terminal.
#
# SURE_IA_DIR aponta p/ a pasta do pdf_pipeline.py (default: ia/Copia/essencial no repo).
set -uo pipefail

BUNDLE="$(cd "$(dirname "$0")" && pwd)"
REPO="${SURE_REPO:-$(dirname "$BUNDLE")}"
# engine/ = cópia do pdf_pipeline + módulos + mapas dentro do bundle (sobe junto com o worker/).
# Sem ela, usa a árvore ia/Copia/essencial do repo.
if [ -z "${SURE_IA_DIR:-}" ] && [ -f "$BUNDLE/engine/pdf_pipeline.py" ]; then
  IA_DIR="$BUNDLE/engine"
else
  IA_DIR="${SURE_IA_DIR:-$REPO/ia/Copia/essencial}"
fi
PYTHON="${SURE_PYTHON:-python3}"
LOG="${SURE_PIPELINE_LOG:-$BUNDLE/pdf_pipeline.log}"
LOCK="/tmp/sure_pdf_pipeline.lock"
EMPRESAS="4 14 32 33 42 69 80 120 144 154 180 183 189 191 202 203 204 205 206 207 208 209 210 212 214 216 217 218 219 223 224 359 362 363 366 367 371 374 375"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 8>"$LOCK" || exit 0
flock -n 8 || { log "já em execução — pulando."; exit 0; }

# 1) BACKUP antes (reversão): dump rotativo do banco
log "backup pré-pipeline…"
"$BUNDLE/backup_sistema.sh" rotativo >> "$LOG" 2>&1 || log "aviso: backup pré-pipeline falhou"

# 2) Extração (--skip-processadas = idempotente; sem --workers por sua escolha)
cd "$IA_DIR" || { log "pasta não encontrada: $IA_DIR"; exit 0; }
log "iniciando pdf_pipeline para empresas: $EMPRESAS"
# shellcheck disable=SC2086
PYTHONUTF8=1 "$PYTHON" pdf_pipeline.py --prod --empresa $EMPRESAS --no-ocr --skip-processadas >> "$LOG" 2>&1
RC=$?
log "pdf_pipeline terminou (rc=$RC). Confira as filas de conferência no front."
exit 0
