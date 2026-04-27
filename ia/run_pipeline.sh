#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# run_pipeline.sh  — executa pdf_pipeline.py em loop contínuo
#
# Uso:
#   ./run_pipeline.sh 14               # empresa 14, loop a cada 5 min
#   ./run_pipeline.sh 14 --extrator plumber  # só plumber
#   ./run_pipeline.sh 4 14 32          # múltiplas empresas juntas
#
# Em background (um processo por cliente):
#   ./run_pipeline.sh 14 &
#   ./run_pipeline.sh 4  &
#
# Com nohup (sobrevive ao fechar o terminal):
#   nohup ./run_pipeline.sh 14 > /dev/null &
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configurações ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
PADDLE_DIR="${PADDLE_DIR:-$HOME/paddleocr}"

# Intervalo em segundos entre cada rodada (quando não há faturas novas)
INTERVALO_SEM_FATURA="${INTERVALO:-300}"   # 5 minutos
# Intervalo após erro (crash) antes de reiniciar
INTERVALO_ERRO=30

# ── Validação ─────────────────────────────────────────────────────────────────
if [ $# -eq 0 ]; then
    echo "Uso: $0 <empresa> [args extras para pdf_pipeline.py]"
    echo "  Ex: $0 14"
    echo "  Ex: $0 14 --extrator plumber"
    exit 1
fi

EMPRESA="$1"
shift
EXTRA_ARGS=("$@")   # restante dos args passa direto para o pipeline

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/pipeline_${EMPRESA}.log"

export PADDLE_DIR

# ── Loop principal ────────────────────────────────────────────────────────────
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Iniciando loop — empresa=$EMPRESA  log=$LOG_FILE"

while true; do
    TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[$TIMESTAMP] ──── rodada empresa=$EMPRESA ────" | tee -a "$LOG_FILE"

    set +e
    "$PYTHON" "$SCRIPT_DIR/pdf_pipeline.py" \
        --empresa "$EMPRESA" \
        "${EXTRA_ARGS[@]}" \
        2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=${PIPESTATUS[0]}
    set -e

    TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
    if [ "$EXIT_CODE" -eq 0 ]; then
        echo "[$TIMESTAMP] Rodada concluída (sem erros). Próxima em ${INTERVALO_SEM_FATURA}s..." \
            | tee -a "$LOG_FILE"
        sleep "$INTERVALO_SEM_FATURA"
    else
        echo "[$TIMESTAMP] Processo encerrou com código $EXIT_CODE. Reiniciando em ${INTERVALO_ERRO}s..." \
            | tee -a "$LOG_FILE"
        sleep "$INTERVALO_ERRO"
    fi
done
