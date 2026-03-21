#!/bin/bash
# Script para testar ML API dentro do Docker

set -e

API_URL="${API_URL:-http://localhost:8001}"
MAX_RETRIES=30
RETRY_INTERVAL=2

echo "=========================================="
echo "🐳 TESTE DE API ML EM DOCKER"
echo "=========================================="
echo "API URL: $API_URL"
echo ""

# Função para verificar API
wait_for_api() {
    echo "[*] Aguardando API estar pronta..."
    local count=0
    while [ $count -lt $MAX_RETRIES ]; do
        if curl -s "$API_URL/health" > /dev/null 2>&1; then
            echo "[OK] API respondendo!"
            return 0
        fi
        count=$((count + 1))
        echo "[.] Tentativa $count/$MAX_RETRIES..."
        sleep $RETRY_INTERVAL
    done
    echo "[!] API não respondeu após $MAX_RETRIES tentativas"
    return 1
}

# Função para testar endpoint
test_endpoint() {
    local endpoint=$1
    local payload=$2
    local name=$3

    echo ""
    echo "Testando: $name"
    echo "POST $API_URL$endpoint"

    response=$(curl -s -X POST \
        "$API_URL$endpoint" \
        -H "Content-Type: application/json" \
        -d "$payload")

    if echo "$response" | grep -q '"prediction"\|"is_anomaly"\|"will_be_late"'; then
        echo "[OK] ✓ Resposta válida"
        echo "$response" | python -m json.tool 2>/dev/null || echo "$response"
        return 0
    else
        echo "[!] ✗ Resposta inválida ou erro"
        echo "$response"
        return 1
    fi
}

# Aguardar API
if ! wait_for_api; then
    echo ""
    echo "[!] Falha: API não está respondendo"
    echo "    Verifique logs com: docker-compose logs api_servidor"
    exit 1
fi

# Testar Saúde
echo ""
echo "=========================================="
echo "Health Check"
echo "=========================================="
curl -s "$API_URL/health" | python -m json.tool 2>/dev/null || echo "OK"

# Testar Modelo 1: Crédito
echo ""
echo "=========================================="
echo "📊 MODELO 1: Previsão de Crédito"
echo "=========================================="

test_endpoint "/predict/credito" \
    '{"dias_para_deferimento": 30, "valor_estimado": 5000, "num_movimentacoes": 4, "num_anexos": 2, "passou_analise": 1}' \
    "Caso normal" || true

test_endpoint "/predict/credito" \
    '{"dias_para_deferimento": 10, "valor_estimado": 15000, "num_movimentacoes": 8, "num_anexos": 5, "passou_analise": 1}' \
    "Caso valor alto" || true

# Testar Modelo 2: Anomalia
echo ""
echo "=========================================="
echo "🚨 MODELO 2: Detecção de Anomalias"
echo "=========================================="

test_endpoint "/detect/anomaly" \
    '{"valor_estimado": 5000, "num_movimentacoes": 4, "num_anexos": 2, "dias_para_deferimento": 30, "cliente": "COPEL"}' \
    "Processo normal" || true

test_endpoint "/detect/anomaly" \
    '{"valor_estimado": 500000, "num_movimentacoes": 20, "num_anexos": 50, "dias_para_deferimento": 120, "cliente": "Desconhecido"}' \
    "Processo atípico" || true

# Testar Modelo 3: SLA
echo ""
echo "=========================================="
echo "⏱️  MODELO 3: Previsão de SLA"
echo "=========================================="

test_endpoint "/predict/sla" \
    '{"num_movimentacoes_etapa": 3, "tempo_medio_geral": 20, "dias_totais": 25}' \
    "Processo rápido" || true

test_endpoint "/predict/sla" \
    '{"num_movimentacoes_etapa": 10, "tempo_medio_geral": 85, "dias_totais": 100}' \
    "Processo lento" || true

echo ""
echo "=========================================="
echo "[OK] ✓ TESTES CONCLUÍDOS"
echo "=========================================="
