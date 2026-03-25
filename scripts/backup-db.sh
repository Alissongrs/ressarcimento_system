#!/bin/bash
# Script de backup automático do MySQL
#
# USO:
#   ./scripts/backup-db.sh
#
# CONFIGURAÇÃO:
#   Edite as variáveis abaixo ou use variáveis de ambiente

set -euo pipefail

# Carrega variaveis do .env se existir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../backend/.env"
if [ -f "$ENV_FILE" ]; then
    set -o allexport
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +o allexport
fi

# Configurações (editar ou usar env vars)
DB_CONTAINER="${DB_CONTAINER:-ressarcimento_system-db-1}"
DB_NAME="${MYSQL_DATABASE:-appdb}"
DB_USER="${MYSQL_USER:-appuser}"
DB_PASSWORD="${MYSQL_PASSWORD:-App_S3cur3!}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# Criar diretório de backups se não existir
mkdir -p "$BACKUP_DIR"

# Nome do arquivo de backup (formato: appdb_2025-12-12_14-30-45.sql.gz)
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"

echo "========================================="
echo "Backup do MySQL - Sistema de Ressarcimento"
echo "========================================="
echo "Database: $DB_NAME"
echo "Container: $DB_CONTAINER"
echo "Arquivo: $BACKUP_FILE"
echo "========================================="

# Verifica se o container está rodando
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo "❌ ERRO: Container $DB_CONTAINER não está rodando!"
    exit 1
fi

# Executa o backup
echo "🔄 Iniciando backup..."
docker exec "$DB_CONTAINER" mysqldump \
    -u"$DB_USER" \
    -p"$DB_PASSWORD" \
    --single-transaction \
    --quick \
    --lock-tables=false \
    --routines \
    --triggers \
    --events \
    --hex-blob \
    "$DB_NAME" | gzip > "$BACKUP_FILE"

# Verifica se o backup foi criado
if [ -f "$BACKUP_FILE" ]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "✅ Backup criado com sucesso: $BACKUP_FILE ($SIZE)"
else
    echo "❌ ERRO: Backup falhou!"
    exit 1
fi

# Remove backups antigos (mantém apenas os últimos N dias)
echo "🧹 Limpando backups antigos (mantendo últimos $RETENTION_DAYS dias)..."
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime +$RETENTION_DAYS -delete

# Lista backups existentes
echo ""
echo "📂 Backups existentes:"
ls -lh "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null || echo "Nenhum backup encontrado"

echo ""
echo "========================================="
echo "✅ Backup concluído com sucesso!"
echo "========================================="
