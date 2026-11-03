#!/usr/bin/env bash
# backup_sistema.sh — backup do sistema (dump do banco + arquivos essenciais).
# Uso:  backup_sistema.sh rotativo   → mantém 3 gerações (job "a cada 2 dias")
#       backup_sistema.sh semanal    → gaveta semanal (job "sextas")
# Reversível por natureza: restaura-se a partir do .sql.gz. NÃO imprime credenciais.
set -uo pipefail

MODO="${1:-rotativo}"
REPO="${SURE_REPO:-/opt/ressarcimento/ressarcimento_system}"
BASE="${SURE_BACKUP_DIR:-/opt/ressarcimento/backups}"
LOG="${SURE_BACKUP_LOG:-$BASE/backup.log}"
ENV="${SURE_ENV:-$REPO/backend/.env}"
KEEP_ROT="${SURE_BACKUP_KEEP_ROT:-6}"     # quantos manter no rotativo (6 = 6 dias de backup diário)
KEEP_SEM="${SURE_BACKUP_KEEP_SEM:-4}"     # quantos manter no semanal
# tabelas de FATURAS (pesadas) — o backup guarda a ESTRUTURA delas, mas NÃO os dados
# (são regeneráveis pela extração/sync). Deixe vazio p/ dump 100% completo.
EXCLUDE_TABLES="${SURE_BACKUP_EXCLUDE:-TBL_FDE FATURA_CLARO_DADOS_EXTRAIDOS FATURA_AGUA_DADOS}"
INCLUDE_FILES="${SURE_BACKUP_FILES:-1}"   # 1 = também tar dos arquivos essenciais

case "$MODO" in
  rotativo) DIR="$BASE/rotativo"; KEEP="$KEEP_ROT" ;;
  semanal)  DIR="$BASE/semanal";  KEEP="$KEEP_SEM" ;;
  *) echo "uso: $0 rotativo|semanal"; exit 2 ;;
esac
mkdir -p "$DIR"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] [$MODO] $*" >> "$LOG"; }
STAMP="$(date '+%Y%m%d_%H%M%S')"

# --- lê DB_APP_URL do .env (user:senha@tcp(host:porta)/db) ---
DSN="$(grep -E '^DB_APP_URL' "$ENV" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
if [[ ! "$DSN" =~ ^([^:]+):(.*)@tcp\(([^:]+):([0-9]+)\)/([^?]+) ]]; then
  log "DB_APP_URL ausente/ inválida em $ENV"; exit 1
fi
DB_USER="${BASH_REMATCH[1]}"; DB_PASS="${BASH_REMATCH[2]}"
DB_HOST="${BASH_REMATCH[3]}"; DB_PORT="${BASH_REMATCH[4]}"; DB_NAME="${BASH_REMATCH[5]}"

EXARGS=()
for t in $EXCLUDE_TABLES; do EXARGS+=("--ignore-table=${DB_NAME}.${t}"); done

SQLGZ="$DIR/db_${DB_NAME}_${STAMP}.sql.gz"
log "iniciando dump de $DB_NAME (dados excluídos: ${EXCLUDE_TABLES:-nenhuma}) ..."
# 1) dump principal — dados de tudo, menos as tabelas de faturas. Senha via MYSQL_PWD
#    (não aparece na linha de comando / ps).
MYSQL_PWD="$DB_PASS" mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
    --single-transaction --quick --routines --events --no-tablespaces \
    "${EXARGS[@]}" "$DB_NAME" 2>>"$LOG" | gzip -c > "$SQLGZ"
if [ "${PIPESTATUS[0]}" != "0" ]; then log "FALHA no mysqldump"; rm -f "$SQLGZ"; exit 1; fi
# 2) só a ESTRUTURA (sem dados) das tabelas de faturas, anexada ao mesmo .gz
#    (membros gzip concatenados descompactam normalmente). Falha aqui não é fatal.
if [ -n "$EXCLUDE_TABLES" ]; then
  # shellcheck disable=SC2086
  MYSQL_PWD="$DB_PASS" mysqldump -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
      --no-data --no-tablespaces "$DB_NAME" $EXCLUDE_TABLES 2>>"$LOG" | gzip -c >> "$SQLGZ" \
      && log "estrutura das tabelas de faturas anexada (sem dados)." \
      || log "aviso: não anexei a estrutura das tabelas de faturas."
fi
log "dump ok: $(basename "$SQLGZ") ($(du -h "$SQLGZ" | cut -f1))"

if [ "$INCLUDE_FILES" = "1" ]; then
  FILESGZ="$DIR/files_${STAMP}.tar.gz"
  tar -czf "$FILESGZ" -C "$REPO" \
    --exclude='**/node_modules' --exclude='.git' --exclude='**/__pycache__' \
    --exclude='**/*.log' --exclude='backups' \
    backend/.env docker-compose.prod.yml worker 2>>"$LOG" || log "aviso: tar de arquivos parcial"
  [ -f "$FILESGZ" ] && log "arquivos ok: $(basename "$FILESGZ") ($(du -h "$FILESGZ" | cut -f1))"
fi

# --- rotação: mantém só as KEEP gerações mais novas ---
rotaciona() {
  local pat="$1"
  mapfile -t velhos < <(ls -1t "$DIR"/$pat 2>/dev/null | tail -n +$((KEEP+1)))
  for f in "${velhos[@]}"; do rm -f "$f" && log "removido (rotação): $(basename "$f")"; done
}
rotaciona 'db_*.sql.gz'
rotaciona 'files_*.tar.gz'
log "concluído."
