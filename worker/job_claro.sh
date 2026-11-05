#!/usr/bin/env bash
# job_claro.sh — processa na VPS os lotes (zips) da Claro que o backend baixou do portal PDP (cron, a cada minuto).
#
# Para cada lote na fila (worker/claro_fila, montada no backend em /app/claro_fila):
#   1) no container do backend: descompacta e extrai as faturas → FATURA_CLARO_DADOS_EXTRAIDOS (processar.py preparar)
#   2) aqui no host: rclone sobe os PDFs para o Google Drive (<remote>/sp_<seq>) e lista os ids dos arquivos
#   3) no container: grava os links do Drive (só onde link IS NULL), apaga zip/PDFs e marca done/<seq>
# Se cair no meio, a próxima rodada continua do passo em que parou (sem extrair de novo).
# Substitui o processamento no PC (ferramentas/claro_pdp/iniciar.ps1). Nunca roda dois ao mesmo tempo (flock).
#
# Variáveis (opcionais): SURE_REPO, SURE_CLARO_DRIVE (padrão gdrive:Faturas — a mesma pasta usada pelo PC),
# SURE_RCLONE_BIN (padrão rclone), SURE_BACKEND_SERVICE (padrão backend).
set -uo pipefail

REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
FILA="$REPO/worker/claro_fila"
DRIVE="${SURE_CLARO_DRIVE:-gdrive:Faturas}"
RCLONE="${SURE_RCLONE_BIN:-rclone}"
SERVICE="${SURE_BACKEND_SERVICE:-backend}"
LOCK="/tmp/sure_claro.lock"
LOG="$FILA/claro.log"

mkdir -p "$FILA" 2>/dev/null
# o backend (usuário 1000 do container) também escreve nesta pasta
chmod 0777 "$FILA" 2>/dev/null
[ -e "$LOG" ] || : > "$LOG"
chmod 0666 "$LOG" 2>/dev/null

ts() { date '+%d/%m %H:%M:%S'; }
log() { echo "[$(ts)] [host] $*" >> "$LOG"; }
vivo() { echo "$*" > "$FILA/worker_vivo" 2>/dev/null; }

exec 9>"$LOCK" || exit 0
if ! flock -n 9; then
  touch "$FILA/worker_vivo" 2>/dev/null   # rodada anterior ainda trabalhando
  exit 0
fi

# o Drive precisa estar configurado no rclone do host (ver worker/RCLONE_SETUP.md)
REMOTE_NOME="${DRIVE%%:*}"
if ! command -v "$RCLONE" >/dev/null 2>&1; then
  vivo "rclone não está instalado na VPS — os lotes ficam na fila até instalar (worker/RCLONE_SETUP.md)"
  exit 0
fi
if ! "$RCLONE" listremotes 2>/dev/null | grep -qx "${REMOTE_NOME}:"; then
  vivo "o rclone da VPS não tem o remote '${REMOTE_NOME}' — os lotes ficam na fila até configurar (worker/RCLONE_SETUP.md)"
  exit 0
fi
vivo "ok"

cd "$REPO" || exit 0
dentro() { docker compose exec -T "$SERVICE" python /app/claro/processar.py "$@"; }

for _ in $(seq 1 20); do   # até 20 lotes por rodada; o resto fica para o próximo minuto
  out="$(dentro preparar 2>>"$LOG")"; rc=$?
  linha="$(grep -E '^(LOTE|NADA)' <<<"$out" | tail -1)"
  if [ $rc -ne 0 ] || [ -z "$linha" ]; then
    log "falha ao preparar (rc=$rc) — tento de novo no próximo minuto"
    break
  fi
  [ "$linha" = "NADA" ] && break
  seq_lote="$(awk '{print $2}' <<<"$linha")"
  rel="$(awk '{print $3}' <<<"$linha")"
  case "$seq_lote$rel" in *..*|*' '*) log "resposta inesperada do preparar: $linha"; break ;; esac
  origem="$FILA/$rel"
  destino="$DRIVE/sp_$seq_lote"
  vivo "subindo o lote $seq_lote para o Drive"
  log "lote $seq_lote: subindo PDFs para $destino"
  if ! "$RCLONE" copy "$origem" "$destino" --transfers 16 --checkers 16 --retries 5 --low-level-retries 10 >>"$LOG" 2>&1; then
    log "lote $seq_lote: upload para o Drive falhou — tento de novo no próximo minuto"
    vivo "falhou o upload do lote $seq_lote para o Drive (ver claro.log)"
    break
  fi
  mapa="$FILA/mapa_sp_$seq_lote.txt"
  if ! "$RCLONE" lsf -R --files-only --format ip --separator "|" "$destino" > "$mapa" 2>>"$LOG"; then
    log "lote $seq_lote: não consegui listar o Drive — tento de novo no próximo minuto"
    rm -f "$mapa"
    break
  fi
  chmod 0666 "$mapa" 2>/dev/null
  fim="$(dentro concluir "$seq_lote" 2>>"$LOG" | tail -1)"
  case "$fim" in
    OK*) vivo "ok" ;;
    *) log "lote $seq_lote: não concluiu ($fim) — tento de novo no próximo minuto"; break ;;
  esac
done
exit 0
