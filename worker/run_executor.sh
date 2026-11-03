#!/usr/bin/env bash
# run_executor.sh — roda o EXECUTOR DETERMINÍSTICO das solicitações do chat (#sistema)
# DENTRO do container do backend (o binário /app/executor_solicitacoes já vem na imagem).
# Chamado pelo cron a cada minuto: pega FT_SOLICITACOES aprovadas e aplica as operações da
# whitelist (editar campo de processo, repasse, inserir histórico, MOVIMENTAR, relatório).
# Nunca roda duas vezes ao mesmo tempo (flock). Não imprime credenciais.
set -uo pipefail

REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
LOG="${SURE_EXECUTOR_LOG:-$REPO/worker/executor.log}"
LOCK="${SURE_EXECUTOR_LOCK:-/tmp/sure_executor.lock}"
SERVICE="${SURE_BACKEND_SERVICE:-backend}"

exec 8>"$LOCK" || exit 0
flock -n 8 || exit 0
cd "$REPO" || { echo "[$(date '+%F %T')] repo não encontrado: $REPO" >> "$LOG"; exit 0; }

out="$(docker compose exec -T "$SERVICE" /app/executor_solicitacoes 2>&1)"; rc=$?
# só registra quando houve trabalho ou erro (evita 1 linha "nada a fazer" por minuto)
if [ $rc -ne 0 ] || ! grep -q "nada a fazer" <<<"$out"; then
  { echo "[$(date '+%F %T')] rc=$rc"; echo "$out"; } >> "$LOG"
fi
exit 0
