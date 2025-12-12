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

# Configurações
DB_CONTAINER="${DB_CONTAINER:-ressarcimento_db}"
DB_NAME="${DB_NAME:-appdb}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-root}"

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
