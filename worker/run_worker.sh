#!/usr/bin/env bash
# run_worker.sh — aciona o WORKER TIER-2 (claude -p headless) na VPS.
# Chamado pelo cron. Só dispara o Claude se houver fila (has_work.py) e nunca roda
# duas instâncias ao mesmo tempo (flock). O worker processa a fila e encerra.
# Autorizado por Alisson (agente autônomo, somente leitura nos dados de negócio).
set -uo pipefail

REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
WORKER_DIR="$REPO/worker"
PROMPT_FILE="${SURE_PROMPT:-$WORKER_DIR/PROMPT_WORKER.md}"
LOG="${SURE_WORKER_LOG:-$WORKER_DIR/worker.log}"
LOCK="${SURE_WORKER_LOCK:-/tmp/sure_worker.lock}"
PYTHON="${SURE_PYTHON:-python3}"
CLAUDE_BIN="${SURE_CLAUDE_BIN:-$(command -v claude || echo claude)}"
MAX_SECONDS="${SURE_WORKER_TIMEOUT:-900}"
CLAUDE_FLAGS="${SURE_CLAUDE_FLAGS:---permission-mode bypassPermissions --allowedTools Bash,Read,Grep,Glob,Write}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

exec 9>"$LOCK" || exit 0
if ! flock -n 9; then log "já em execução — pulando."; exit 0; fi
cd "$REPO" || { log "repo não encontrado: $REPO"; exit 0; }

N="$(PYTHONUTF8=1 "$PYTHON" "$WORKER_DIR/has_work.py" 2>>"$LOG")"; RC=$?
if [ $RC -eq 1 ]; then exit 0
elif [ $RC -ne 0 ]; then log "has_work falhou (rc=$RC) — abortando."; exit 0; fi

log "fila com $N pedido(s) — acionando worker…"
# shellcheck disable=SC2086
timeout "$MAX_SECONDS" "$CLAUDE_BIN" -p $CLAUDE_FLAGS < "$PROMPT_FILE" >> "$LOG" 2>&1; RC=$?
if [ $RC -eq 124 ]; then log "worker excedeu ${MAX_SECONDS}s (timeout)."
elif [ $RC -ne 0 ]; then log "worker terminou com erro (rc=$RC)."
else log "worker concluiu a rodada."; fi
exit 0
