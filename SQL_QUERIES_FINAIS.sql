-- ============================================================================
-- SQL QUERIES FINAIS - AJUSTADAS PARA SUAS TABELAS REAIS
-- ============================================================================
-- Copie e cole uma por vez no seu MySQL, exporte cada resultado em CSV

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
    CASE WHEN MAX(h.etapa_nova) = 'Análise Técnica' OR MAX(h.etapa_anterior) = 'Análise Técnica' THEN 1 ELSE 0 END as passou_analise_tecnica,
    COALESCE(p.nome_tipo_irregularidade, 'Desvio KWh') as tipo_irregularidade
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_requisicao
WHERE d.status_analise IS NOT NULL
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
    COALESCE(d.status_analise, 'Desconhecido') as label_anomalia
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
        WHEN p.etapa = 'Análise' THEN 10
        WHEN p.etapa = 'Deferimento' THEN 5
        WHEN p.etapa = 'Fluxo' THEN 15
        ELSE 20
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
-- QUERIES DE VALIDAÇÃO - Rodar para entender os dados
-- ============================================================================

-- 1. Quantos processos temos?
SELECT COUNT(*) as total_processos FROM FT_PROCESSOS;

-- 2. Quantos têm deferimento?
SELECT COUNT(*) as total_com_deferimento
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
WHERE d.status_analise IS NOT NULL;

-- 3. Distribuição de status de análise
SELECT
    d.status_analise,
    COUNT(*) as quantidade,
    ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM FT_DEFERIMENTOS WHERE status_analise IS NOT NULL), 2) as percentual
FROM FT_DEFERIMENTOS d
WHERE d.status_analise IS NOT NULL
GROUP BY d.status_analise
ORDER BY quantidade DESC;

-- 4. Distribuição de etapas
SELECT
    p.etapa,
    COUNT(*) as quantidade
FROM FT_PROCESSOS p
WHERE p.etapa IS NOT NULL
GROUP BY p.etapa
ORDER BY quantidade DESC;

-- 5. Estatísticas de valores
SELECT
    COUNT(*) as total,
    MIN(ressarcimento_estimado) as valor_min,
    MAX(ressarcimento_estimado) as valor_max,
    AVG(ressarcimento_estimado) as valor_medio,
    STDDEV(ressarcimento_estimado) as valor_desvio
FROM FT_PROCESSOS
WHERE ressarcimento_estimado IS NOT NULL;

-- 6. Top concessionárias
SELECT
    p.concessionaria,
    COUNT(*) as total_processos,
    AVG(p.ressarcimento_estimado) as valor_medio
FROM FT_PROCESSOS p
WHERE p.concessionaria IS NOT NULL
GROUP BY p.concessionaria
ORDER BY total_processos DESC
LIMIT 10;

-- 7. Top clientes
SELECT
    p.cliente,
    COUNT(*) as total_processos,
    SUM(CASE WHEN d.status_analise = 'Aprovado' THEN 1 ELSE 0 END) as total_aprovados,
    ROUND(SUM(CASE WHEN d.status_analise = 'Aprovado' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as taxa_aprovacao
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
WHERE d.status_analise IS NOT NULL AND p.cliente IS NOT NULL
GROUP BY p.cliente
HAVING COUNT(*) >= 5
ORDER BY total_processos DESC
LIMIT 10;

-- 8. Range de datas
SELECT
    MIN(data_criacao) as data_mais_antiga,
    MAX(data_criacao) as data_mais_recente,
    COUNT(*) as total_registros
FROM FT_PROCESSOS;

-- 9. Valores possíveis de status_analise
SELECT DISTINCT status_analise FROM FT_DEFERIMENTOS WHERE status_analise IS NOT NULL ORDER BY status_analise;

-- 10. Valores possíveis de etapa
SELECT DISTINCT etapa FROM FT_PROCESSOS WHERE etapa IS NOT NULL ORDER BY etapa;

-- 11. Tipos de irregularidade
SELECT DISTINCT nome_tipo_irregularidade FROM FT_PROCESSOS
WHERE nome_tipo_irregularidade IS NOT NULL
ORDER BY nome_tipo_irregularidade;

-- 12. Quantidade de movimentações por processo
SELECT
    COUNT(DISTINCT h.id_historico) as num_movimentacoes,
    COUNT(DISTINCT p.id_processo) as num_processos
FROM FT_PROCESSOS p
LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
GROUP BY num_movimentacoes
ORDER BY num_movimentacoes;

-- 13. Quantidade de anexos por processo
SELECT
    COUNT(DISTINCT a.id_anexo) as num_anexos,
    COUNT(DISTINCT p.id_processo) as num_processos
FROM FT_PROCESSOS p
LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_requisicao
GROUP BY num_anexos
ORDER BY num_anexos;
