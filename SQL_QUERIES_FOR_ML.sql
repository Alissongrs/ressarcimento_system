-- ============================================================================
-- SQL QUERIES PARA EXTRAIR DADOS DOS 3 MODELOS DE ML
-- ============================================================================
-- Execute estas queries no seu banco MySQL e salve em CSV
-- Salve em: backend/ia/data/[MODELO]_training_data.csv
-- ============================================================================

-- ============================================================================
-- MODELO 1: PREVISÃO DE STATUS FINAL (APROVADO vs INDEFERIDO)
-- Salve em: backend/ia/data/status_training_data.csv
-- ============================================================================

SELECT
    p.id_processo,
    p.data_criacao,
    COALESCE(DATEDIFF(d.data_deferimento, p.data_criacao), 30) as dias_para_deferimento,
    COALESCE(d.status_analise, 'Desconhecido') as status_analise,
    COALESCE(uc.estado, 'SP') as estado,
    COALESCE(c.concessionaria, 'CEMIG') as concessionaria,
    COALESCE(p.valor_estimado, 0) as valor_estimado,
    COALESCE(COUNT(DISTINCT h.id_movimentacao), 0) as num_movimentacoes,
    COALESCE(COUNT(DISTINCT a.id_anexo), 0) as num_anexos,
    MAX(CASE WHEN h.etapa = 'Análise Técnica' THEN 1 ELSE 0 END) as passou_analise_tecnica,
    COALESCE(p.tipo_irregularidade, 'Desvio KWh') as tipo_irregularidade,
    (
        SELECT COUNT(*)
        FROM FT_PROCESSOS p2
        WHERE p2.id_concessionaria = p.id_concessionaria
        AND p2.data_criacao >= DATE_SUB(p.data_criacao, INTERVAL 30 DAY)
    ) as processos_30d_concessionaria
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
LEFT JOIN DM_UC uc ON p.id_uc = uc.id_uc
LEFT JOIN DM_CONCESSIONARIA c ON p.id_concessionaria = c.id_concessionaria
LEFT JOIN FT_HISTORICO h ON p.id_processo = h.id_processo
LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_processo
WHERE d.status_analise IS NOT NULL
  AND p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR)
GROUP BY p.id_processo
ORDER BY p.data_criacao DESC;

-- ============================================================================
-- MODELO 2: DETECÇÃO DE ANOMALIAS
-- Salve em: backend/ia/data/anomaly_training_data.csv
-- Usa MESMOS DADOS do Modelo 1, mas foca em features diferentes
-- ============================================================================

SELECT
    p.id_processo,
    p.data_criacao,
    COALESCE(p.valor_estimado, 0) as valor_estimado,
    COALESCE(COUNT(DISTINCT h.id_movimentacao), 0) as num_movimentacoes,
    COALESCE(COUNT(DISTINCT a.id_anexo), 0) as num_anexos,
    COALESCE(DATEDIFF(d.data_deferimento, p.data_criacao), 30) as dias_para_deferimento,
    (
        SELECT COUNT(*)
        FROM FT_PROCESSOS p2
        WHERE p2.id_concessionaria = p.id_concessionaria
        AND p2.data_criacao >= DATE_SUB(p.data_criacao, INTERVAL 30 DAY)
    ) as processos_30d_concessionaria,
    COALESCE(d.status_analise, 'Desconhecido') as label_anomalia
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
LEFT JOIN FT_HISTORICO h ON p.id_processo = h.id_processo
LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_processo
WHERE p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR)
GROUP BY p.id_processo
ORDER BY p.data_criacao DESC;

-- ============================================================================
-- MODELO 3: PREVISÃO DE SLA (ATRASO DE PRAZOS)
-- Salve em: backend/ia/data/sla_training_data.csv
-- Extrai apenas processos JÁ FINALIZADOS para treino
-- ============================================================================

SELECT
    p.id_processo,
    COALESCE(MAX(h.etapa), 'Desconhecido') as etapa_final,
    COALESCE(
        DATEDIFF(MAX(h.data_movimentacao), MAX(CASE WHEN h2.etapa = LAG(h2.etapa) OVER (PARTITION BY p.id_processo ORDER BY h2.data_movimentacao) THEN h2.data_movimentacao END)),
        5
    ) as dias_sem_movimento,
    COALESCE(COUNT(DISTINCT h.id_movimentacao), 0) as num_movimentacoes_etapa,
    COALESCE(DATEDIFF(d.data_deferimento, p.data_criacao), 30) as dias_em_processamento,
    CASE
        WHEN MAX(h.etapa) = 'Análise Técnica' THEN 10
        WHEN MAX(h.etapa) = 'Análise de Deferimento' THEN 5
        WHEN MAX(h.etapa) = 'Fluxo de Ressarcimento' THEN 15
        ELSE 20
    END as sla_dias_target,
    (
        SELECT AVG(DATEDIFF(d2.data_deferimento, p2.data_criacao))
        FROM FT_PROCESSOS p2
        LEFT JOIN FT_DEFERIMENTOS d2 ON p2.id_processo = d2.id_processo
        WHERE p2.data_criacao >= DATE_SUB(NOW(), INTERVAL 90 DAY)
        AND d2.data_deferimento IS NOT NULL
    ) as tempo_medio_geral,
    COALESCE(p.prioridade, 'Média') as prioridade,
    COALESCE(DATEDIFF(d.data_deferimento, p.data_criacao), 30) as dias_totais_real
FROM FT_PROCESSOS p
LEFT JOIN FT_HISTORICO h ON p.id_processo = h.id_processo
LEFT JOIN FT_HISTORICO h2 ON p.id_processo = h2.id_processo
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
WHERE p.status = 'Finalizado'
  AND p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR)
GROUP BY p.id_processo
ORDER BY p.data_criacao DESC;

-- ============================================================================
-- ALTERNATIVE SIMPLIFIED QUERY FOR SLA (se a query acima não funcionar)
-- ============================================================================

SELECT
    p.id_processo,
    COALESCE(COUNT(DISTINCT h.id_movimentacao), 0) as num_movimentacoes_etapa,
    COALESCE(DATEDIFF(d.data_deferimento, p.data_criacao), 30) as dias_em_processamento,
    CASE
        WHEN d.status_analise = 'Aprovado' THEN 1
        ELSE 0
    END as sla_cumpriu,
    COALESCE(p.prioridade, 'Média') as prioridade,
    (
        SELECT AVG(DATEDIFF(d2.data_deferimento, p2.data_criacao))
        FROM FT_PROCESSOS p2
        LEFT JOIN FT_DEFERIMENTOS d2 ON p2.id_processo = d2.id_processo
        WHERE p2.data_criacao >= DATE_SUB(NOW(), INTERVAL 90 DAY)
        AND d2.data_deferimento IS NOT NULL
    ) as tempo_medio_geral,
    COALESCE(DATEDIFF(d.data_deferimento, p.data_criacao), 30) as dias_totais
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
LEFT JOIN FT_HISTORICO h ON p.id_processo = h.id_processo
WHERE p.status = 'Finalizado'
  AND p.data_criacao >= DATE_SUB(NOW(), INTERVAL 2 YEAR)
GROUP BY p.id_processo;

-- ============================================================================
-- UTILITÁRIOS / VERIFICAÇÃO
-- ============================================================================

-- Ver quantos processos com deferimento temos
SELECT COUNT(*) as total_processos_com_deferimento
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
WHERE d.status_analise IS NOT NULL;

-- Ver distribuição de status
SELECT
    d.status_analise,
    COUNT(*) as quantidade,
    ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM FT_DEFERIMENTOS), 2) as percentual
FROM FT_DEFERIMENTOS d
GROUP BY d.status_analise
ORDER BY quantidade DESC;

-- Ver estágios dos processos
SELECT
    MAX(h.etapa) as etapa,
    COUNT(DISTINCT p.id_processo) as quantidade
FROM FT_PROCESSOS p
LEFT JOIN FT_HISTORICO h ON p.id_processo = h.id_processo
GROUP BY MAX(h.etapa)
ORDER BY quantidade DESC;

-- Ver distribuição de valores
SELECT
    COUNT(*) as total,
    MIN(valor_estimado) as valor_minimo,
    MAX(valor_estimado) as valor_maximo,
    AVG(valor_estimado) as valor_medio,
    STDDEV(valor_estimado) as valor_desvio_padrao
FROM FT_PROCESSOS;

-- Ver concessionárias com mais processos
SELECT
    c.concessionaria,
    COUNT(*) as total_processos,
    AVG(p.valor_estimado) as valor_medio
FROM FT_PROCESSOS p
LEFT JOIN DM_CONCESSIONARIA c ON p.id_concessionaria = c.id_concessionaria
GROUP BY c.concessionaria
ORDER BY total_processos DESC
LIMIT 10;

-- Ver clientes com mais processos
SELECT
    p.cliente,
    COUNT(*) as total_processos,
    SUM(CASE WHEN d.status_analise = 'Aprovado' THEN 1 ELSE 0 END) as total_aprovados,
    ROUND(SUM(CASE WHEN d.status_analise = 'Aprovado' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as taxa_aprovacao
FROM FT_PROCESSOS p
LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
WHERE d.status_analise IS NOT NULL
GROUP BY p.cliente
HAVING COUNT(*) >= 5
ORDER BY total_processos DESC
LIMIT 10;

-- ============================================================================
-- INSTRUÇÕES DE USO
-- ============================================================================
/*
1. MODELO 1 (STATUS):
   - Execute a primeira query
   - Selecione todos (Ctrl+A)
   - Clique em "Export" no seu cliente MySQL
   - Salve como: backend/ia/data/status_training_data.csv

2. MODELO 2 (ANOMALIA):
   - Execute a segunda query
   - Exporte de forma idêntica
   - Salve como: backend/ia/data/anomaly_training_data.csv

3. MODELO 3 (SLA):
   - Execute a terceira query
   - Exporte de forma idêntica
   - Salve como: backend/ia/data/sla_training_data.csv

IMPORTANTE:
   - Use 2+ ANOS de dados históricos
   - Não deixe valores NULL (use COALESCE)
   - Verifique se tem pelo menos 500 registros por modelo
   - Use as queries de verificação para validar dados
*/

-- ============================================================================
-- Exemplo para exportar via command line (MySQL):
-- ============================================================================
/*
mysql -u seu_usuario -p seu_banco -e "
[COLE A QUERY AQUI]
" > /path/to/file.csv

Ou dentro do MySQL:
SELECT ... INTO OUTFILE '/path/to/file.csv'
FIELDS TERMINATED BY ','
ENCLOSED BY '"'
LINES TERMINATED BY '\n';
*/
