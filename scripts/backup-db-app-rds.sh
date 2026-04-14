#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/backend/.env}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
KEEP_LAST="${KEEP_LAST:-2}"
TARGET_DSN_VAR="${TARGET_DSN_VAR:-DB_APP_URL}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DSN="${!TARGET_DSN_VAR:-}"
if [[ -z "$DSN" ]]; then
  echo "ERRO: variável $TARGET_DSN_VAR não encontrada."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TS="$(date +%Y-%m-%d_%H-%M-%S)"
RAW_FILE="$BACKUP_DIR/db_app_${TS}.sql"
GZ_FILE="${RAW_FILE}.gz"

echo "== Backup banco app =="
echo "DSN var: $TARGET_DSN_VAR"
echo "Arquivo: $GZ_FILE"

cd "$ROOT_DIR/backend/cmd/dbbackup"
go run . -dsn "$DSN" -out "$RAW_FILE"

gzip -f "$RAW_FILE"

mapfile -t OLD_BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db_app_*.sql.gz' | sort -r | tail -n +"$((KEEP_LAST + 1))")
if [[ ${#OLD_BACKUPS[@]} -gt 0 ]]; then
  printf '%s\0' "${OLD_BACKUPS[@]}" | xargs -0 rm -f
fi

echo "Backup concluído: $GZ_FILE"
