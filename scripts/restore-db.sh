#!/bin/bash
# Script de restauração do MySQL
#
# USO:
#   ./scripts/restore-db.sh backup_file.sql.gz
#
# EXEMPLO:
#   ./scripts/restore-db.sh ./backups/appdb_2025-12-12_14-30-45.sql.gz

set -euo pipefail

# Verificar se o arquivo de backup foi fornecido
if [ $# -eq 0 ]; then
    echo "❌ ERRO: Nenhum arquivo de backup especificado!"
    echo ""
    echo "USO: $0 <arquivo_backup.sql.gz>"
    echo ""
    echo "Backups disponíveis:"
    ls -lh ./backups/*.sql.gz 2>/dev/null || echo "Nenhum backup encontrado"
    exit 1
fi

BACKUP_FILE="$1"

# Verificar se o arquivo existe
if [ ! -f "$BACKUP_FILE" ]; then
    echo "❌ ERRO: Arquivo não encontrado: $BACKUP_FILE"
    exit 1
fi

# Carrega variaveis do .env se existir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../backend/.env"
if [ -f "$ENV_FILE" ]; then
    set -o allexport
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +o allexport
fi

# Configurações
DB_CONTAINER="${DB_CONTAINER:-ressarcimento_system-db-1}"
DB_NAME="${MYSQL_DATABASE:-appdb}"
DB_USER="${MYSQL_USER:-appuser}"
DB_PASSWORD="${MYSQL_PASSWORD:-App_S3cur3!}"

echo "========================================="
echo "Restauração do MySQL - Sistema de Ressarcimento"
echo "========================================="
echo "Database: $DB_NAME"
echo "Container: $DB_CONTAINER"
echo "Arquivo: $BACKUP_FILE"
echo "========================================="

# Confirmar restauração
echo ""
echo "⚠️  ATENÇÃO: Esta operação irá substituir todos os dados existentes!"
read -p "Deseja continuar? (digite 'sim' para confirmar): " CONFIRM

if [ "$CONFIRM" != "sim" ]; then
    echo "❌ Restauração cancelada pelo usuário"
    exit 0
fi

# Verifica se o container está rodando
if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo "❌ ERRO: Container $DB_CONTAINER não está rodando!"
    exit 1
fi

# Executa a restauração
echo ""
echo "🔄 Iniciando restauração..."
gunzip < "$BACKUP_FILE" | docker exec -i "$DB_CONTAINER" mysql \
    -u"$DB_USER" \
    -p"$DB_PASSWORD" \
    "$DB_NAME"

if [ $? -eq 0 ]; then
    echo ""
    echo "========================================="
    echo "✅ Restauração concluída com sucesso!"
    echo "========================================="
else
    echo ""
    echo "❌ ERRO: Restauração falhou!"
    exit 1
fi
