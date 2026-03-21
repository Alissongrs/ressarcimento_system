-- ============================================================================
-- SQL QUERIES CORRETAS - ESTRUTURA REAL DO BANCO
-- ============================================================================
-- Copie e execute uma por vez no MySQL

-- ============================================================================
-- MODELO 1: PREVISÃO DE STATUS (APROVADO vs INDEFERIDO)
-- Salve em: backend/ia/data/status_training_data.csv
-- ============================================================================

SELECT
    p.id_processo,
    p.data_criacao,
    COALESCE(DATEDIFF(d.data_procedencia, p.data_criacao), 30) as dias_para_deferimento,
    COALESCE(d.status_analise, 'Desconhecido') as status_analise,
    COALESCE(p.uc, 'Desconhecido') as estado,
    COALESCE(p.concessionaria, 'Desconhecida') as concessionaria,
    COALESCE(p.ressarcimento_estimado, 0) as valor_estimado,
    COALESCE(COUNT(DISTINCT h.id_historico), 0) as num_movimentacoes,
    COALESCE(COUNT(DISTINCT a.id_anexo), 0) as num_anexos,
    CASE WHEN MAX(h.etapa_nova) = 'Distribuidora' OR MAX(h.etapa_anterior) = 'Distribuidora' THEN 1 ELSE 0 END as passou_analise,
    COALESCE(p.nome_tipo_irregularidade, 'DÚVIDA') as tipo_irregularidade
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_requisicao
WHERE d.id_processo IS NOT NULL
  AND p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR)
GROUP BY p.id_processo
ORDER BY p.data_criacao DESC;

-- ============================================================================
-- MODELO 2: DETECÇÃO DE ANOMALIAS
-- Salve em: backend/ia/data/anomaly_training_data.csv
-- ============================================================================

SELECT
    p.id_processo,
    p.data_criacao,
    COALESCE(p.ressarcimento_estimado, 0) as valor_estimado,
    COALESCE(COUNT(DISTINCT h.id_historico), 0) as num_movimentacoes,
    COALESCE(COUNT(DISTINCT a.id_anexo), 0) as num_anexos,
    COALESCE(DATEDIFF(d.data_procedencia, p.data_criacao), 30) as dias_para_deferimento,
    COALESCE(p.cliente, 'Cliente Desconhecido') as cliente,
    CASE
        WHEN d.credito_dobro > d.credito_simples THEN 'Dobro'
        WHEN d.credito_simples > 0 THEN 'Simples'
        ELSE 'Desconhecido'
    END as tipo_credito
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_requisicao
WHERE p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR)
GROUP BY p.id_processo
ORDER BY p.data_criacao DESC;

-- ============================================================================
-- MODELO 3: PREVISÃO DE SLA (ATRASO DE PRAZOS)
-- Salve em: backend/ia/data/sla_training_data.csv
-- ============================================================================

SELECT
    p.id_processo,
    COALESCE(COUNT(DISTINCT h.id_historico), 0) as num_movimentacoes_etapa,
    COALESCE(DATEDIFF(d.data_procedencia, p.data_criacao), 30) as dias_em_processamento,
    CASE
        WHEN p.etapa = 'Distribuidora' THEN 10
        WHEN p.etapa = 'Ouvidoria' THEN 15
        WHEN p.etapa = 'ANEEL' THEN 20
        ELSE 30
    END as sla_dias_target,
    (
        SELECT AVG(DATEDIFF(d2.data_procedencia, p2.data_criacao))
        FROM FT_PROCESSOS p2
        LEFT JOIN FT_DEFERIMENTOS d2 ON p2.id_processo = d2.id_processo
        WHERE p2.data_criacao >= DATE_SUB(NOW(), INTERVAL 90 DAY)
        AND d2.data_procedencia IS NOT NULL
    ) as tempo_medio_geral,
    COALESCE(p.nome_coluna, 'Normal') as prioridade,
    COALESCE(DATEDIFF(d.data_procedencia, p.data_criacao), 30) as dias_totais
FROM FT_PROCESSOS p
LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
WHERE p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR)
GROUP BY p.id_processo
ORDER BY p.data_criacao DESC;

-- ============================================================================
-- QUERIES DE VALIDAÇÃO
-- ============================================================================

-- 1. Quantos processos com deferimento temos?
SELECT
    COUNT(*) as total_processos_com_deferimento,
    COUNT(DISTINCT p.id_processo) as processos_distintos
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
WHERE d.id_processo IS NOT NULL;

-- 2. Distribuição de tipos de credito
SELECT
    CASE
        WHEN credito_dobro > credito_simples THEN 'Dobro'
        WHEN credito_simples > 0 THEN 'Simples'
        ELSE 'Nenhum'
    END as tipo_credito,
    COUNT(*) as quantidade
FROM FT_DEFERIMENTOS
GROUP BY tipo_credito
ORDER BY quantidade DESC;

-- 3. Distribuição de etapas
SELECT
    p.etapa,
    COUNT(*) as quantidade,
    AVG(p.ressarcimento_estimado) as valor_medio
FROM FT_PROCESSOS p
WHERE p.etapa IS NOT NULL
GROUP BY p.etapa
ORDER BY quantidade DESC;

-- 4. Estatísticas de valores
SELECT
    COUNT(*) as total,
    MIN(ressarcimento_estimado) as valor_min,
    MAX(ressarcimento_estimado) as valor_max,
    AVG(ressarcimento_estimado) as valor_medio,
    STDDEV(ressarcimento_estimado) as valor_desvio
FROM FT_PROCESSOS
WHERE ressarcimento_estimado IS NOT NULL AND ressarcimento_estimado > 0;

-- 5. Top concessionárias
SELECT
    p.concessionaria,
    COUNT(*) as total_processos,
    AVG(p.ressarcimento_estimado) as valor_medio
FROM FT_PROCESSOS p
WHERE p.concessionaria IS NOT NULL
GROUP BY p.concessionaria
ORDER BY total_processos DESC
LIMIT 10;

-- 6. Top clientes
SELECT
    p.cliente,
    COUNT(*) as total_processos,
    AVG(p.ressarcimento_estimado) as valor_medio
FROM FT_PROCESSOS p
WHERE p.cliente IS NOT NULL
GROUP BY p.cliente
HAVING COUNT(*) >= 3
ORDER BY total_processos DESC
LIMIT 10;

-- 7. Tipos de irregularidade
SELECT
    p.nome_tipo_irregularidade,
    COUNT(*) as quantidade
FROM FT_PROCESSOS p
WHERE p.nome_tipo_irregularidade IS NOT NULL
GROUP BY p.nome_tipo_irregularidade
ORDER BY quantidade DESC;

-- 8. Distribuição de movimentações por processo
SELECT
    num_movimentacoes,
    COUNT(*) as num_processos
FROM (
    SELECT p.id_processo, COUNT(DISTINCT h.id_historico) as num_movimentacoes
    FROM FT_PROCESSOS p
    LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
    GROUP BY p.id_processo
) t
GROUP BY num_movimentacoes
ORDER BY num_movimentacoes;

-- 9. Distribuição de anexos
SELECT
    num_anexos,
    COUNT(*) as num_processos
FROM (
    SELECT p.id_processo, COUNT(DISTINCT a.id_anexo) as num_anexos
    FROM FT_PROCESSOS p
    LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_requisicao
    GROUP BY p.id_processo
) t
GROUP BY num_anexos
ORDER BY num_anexos;

-- 10. Processos com dados completos (para treino)
SELECT
    COUNT(*) as total,
    COUNT(CASE WHEN d.id_processo IS NOT NULL THEN 1 END) as com_deferimento,
    COUNT(CASE WHEN h.id_historico IS NOT NULL THEN 1 END) as com_historico,
    COUNT(CASE WHEN a.id_anexo IS NOT NULL THEN 1 END) as com_anexos
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_requisicao
WHERE p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR);
