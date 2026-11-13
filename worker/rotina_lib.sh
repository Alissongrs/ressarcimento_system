#!/usr/bin/env bash
# rotina_lib.sh — funções que os scripts do cron chamam para dizer ao SURE que rodaram
# (painel "Rotinas" em Tarefas do sistema; registrar_execucao.py grava no banco).
# Uso:  . "$(dirname "$0")/rotina_lib.sh"
#       rotina_ping NOME                    # "estou vivo" (a cada disparo; barato)
#       rotina_inicio NOME [RESUMO]         # abre uma execução (guarda o id em ROTINA_ID)
#       rotina_fim RC [RESUMO]              # fecha a execução aberta (rc 0 = ok)
#       rotina_registrar NOME RC [RESUMO]   # execução que já terminou, de uma vez
# Nunca falha nem derruba o script que chamou; sem banco, só perde o registro.
SURE_REG="${SURE_REG:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/registrar_execucao.py}"
SURE_REG_PY="${SURE_PYTHON:-python3}"
ROTINA_ID=""

rotina_ping()      { PYTHONUTF8=1 "$SURE_REG_PY" "$SURE_REG" ping "$1" >/dev/null 2>&1 || true; }
rotina_inicio()    { ROTINA_ID="$(PYTHONUTF8=1 "$SURE_REG_PY" "$SURE_REG" inicio "$1" "${2:-}" 2>/dev/null || true)"; }
rotina_fim()       { [ -n "${ROTINA_ID:-}" ] && PYTHONUTF8=1 "$SURE_REG_PY" "$SURE_REG" fim "$ROTINA_ID" "${1:-0}" "${2:-}" >/dev/null 2>&1 || true; ROTINA_ID=""; }
rotina_registrar() { PYTHONUTF8=1 "$SURE_REG_PY" "$SURE_REG" registrar "$1" "${2:-0}" "${3:-}" >/dev/null 2>&1 || true; }
