#!/usr/bin/env bash
# run_testes_regras.sh — aciona o AUDITOR DE TESTES DE REGRAS (claude -p headless) na VPS.
# Chamado pelo cron a cada minuto. Só dispara o Claude se houver teste na fila
# (testes_regras.py pendentes) e nunca roda duas instâncias ao mesmo tempo (flock).
# O agente processa a fila FT_TESTES_REGRA (botão "Testar" da página /regras) e encerra.
set -uo pipefail

REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
WORKER_DIR="$REPO/worker"
PROMPT_FILE="${SURE_TESTES_PROMPT:-$WORKER_DIR/PROMPT_TESTE_REGRAS.md}"
LOG="${SURE_TESTES_LOG:-$WORKER_DIR/testes_regras.log}"
LOCK="${SURE_TESTES_LOCK:-/tmp/sure_testes_regras.lock}"
PYTHON="${SURE_PYTHON:-python3}"
CLAUDE_BIN="${SURE_CLAUDE_BIN:-$(command -v claude || echo claude)}"
MAX_SECONDS="${SURE_TESTES_TIMEOUT:-2400}"   # 61 regras numa fatura pode levar alguns minutos
# o agente só pode: rodar o script da fila, ler arquivos e escrever o laudo
CLAUDE_ARGS=(-p --permission-mode acceptEdits
  --allowedTools "Bash(python3 worker/testes_regras.py:*)" "Read" "Write")

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 9>"$LOCK" || exit 0
if ! flock -n 9; then exit 0; fi
cd "$REPO" || { log "repo não encontrado: $REPO"; exit 0; }

N="$(PYTHONUTF8=1 "$PYTHON" "$WORKER_DIR/testes_regras.py" pendentes 2>>"$LOG")"; RC=$?
if [ $RC -eq 1 ]; then exit 0
elif [ $RC -ne 0 ]; then log "testes_regras pendentes falhou (rc=$RC) — abortando."; exit 0; fi

log "fila com $N teste(s) — acionando agente…"
PYTHONUTF8=1 timeout "$MAX_SECONDS" "$CLAUDE_BIN" "${CLAUDE_ARGS[@]}" < "$PROMPT_FILE" >> "$LOG" 2>&1; RC=$?
if [ $RC -eq 124 ]; then log "agente excedeu ${MAX_SECONDS}s (timeout) — testes presos expiram sozinhos."
elif [ $RC -ne 0 ]; then log "agente terminou com erro (rc=$RC)."
else log "agente concluiu a rodada."; fi
exit 0
