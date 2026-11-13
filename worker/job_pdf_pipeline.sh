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
# tela Tarefas (worker/run_jobs.py) pode pedir só algumas empresas: SURE_PIPELINE_EMPRESAS="4 189"
if [ -n "${SURE_PIPELINE_EMPRESAS:-}" ]; then
  EMPRESAS="$(echo "$SURE_PIPELINE_EMPRESAS" | tr -c '0-9\n' ' ' | tr -s ' ')"
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 8>"$LOCK" || exit 0
flock -n 8 || { log "já em execução — pulando."; exit 0; }
. "$BUNDLE/rotina_lib.sh"; rotina_inicio pdf_pipeline "empresas: $EMPRESAS"

# 1) BACKUP antes (reversão): dump rotativo do banco
log "backup pré-pipeline…"
bash "$BUNDLE/backup_sistema.sh" rotativo >> "$LOG" 2>&1 || log "aviso: backup pré-pipeline falhou"

# 2) Extração (--skip-processadas = idempotente; sem --workers por sua escolha)
cd "$IA_DIR" || { log "pasta não encontrada: $IA_DIR"; rotina_fim 1 "pasta não encontrada: $IA_DIR"; exit 0; }
# mysql-connector-python 8.0.x (visto na 8.0.30, 8.0.31 e 8.0.33) tem um defeito que impede conectar no banco de origem das faturas
# (MariaDB 10.4: "Character set 'utf8' unsupported" — reproduzido em 04/11/2026; a 8.4.0 conecta).
# Se for uma dessas, troca uma vez pela 8.4.0 (testada nos dois bancos) só para o usuário que roda o job.
MYV="$("$PYTHON" -c 'import mysql.connector as m; print(m.__version__)' 2>/dev/null)"
# 04/11/2026: a VPS tinha a 8.0.33 e também falhou (o traceback bate linha a linha com a 8.0.33) —
# então qualquer 8.0.x é trocada pela 8.4.0.
log "mysql-connector-python: ${MYV:-não instalado}"
case "$MYV" in
  8.0.*)
    log "mysql-connector-python $MYV tem defeito com o banco de origem — atualizando para 8.4.0…"
    if "$PYTHON" -m pip install --user --quiet "mysql-connector-python==8.4.0" >> "$LOG" 2>&1; then
      log "mysql-connector-python agora: $("$PYTHON" -c 'import mysql.connector as m; print(m.__version__)' 2>/dev/null)"
    else
      log "aviso: não consegui atualizar o mysql-connector-python (rode na VPS: $PYTHON -m pip install --user mysql-connector-python==8.4.0)"
    fi
    ;;
esac

# pdf_pipeline.py fica FORA do Git (tem as conexões do banco) e a cópia da VPS pode ser a antiga, que
# grava log e imagens em "C:/paddleocr/..." — no Linux isso é uma pasta relativa a esta; sem ela o script
# morre na 1ª linha (FileNotFoundError). Criar a pasta resolve sem mexer no script.
if grep -q '"C:/paddleocr' pdf_pipeline.py 2>/dev/null; then
  mkdir -p "C:/paddleocr/tmp" && log "aviso: pdf_pipeline.py da VPS é a versão antiga (caminho do Windows) — usando $IA_DIR/C:/paddleocr"
fi
log "iniciando pdf_pipeline para empresas: $EMPRESAS"
# shellcheck disable=SC2086
PYTHONUTF8=1 "$PYTHON" pdf_pipeline.py --prod --empresa $EMPRESAS --no-ocr --skip-processadas >> "$LOG" 2>&1
RC=$?
log "pdf_pipeline terminou (rc=$RC). Confira as filas de conferência no front."
rotina_fim "$RC" "pdf_pipeline terminou (rc=$RC); empresas: $EMPRESAS"
exit 0
