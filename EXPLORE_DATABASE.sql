-- ============================================================================
-- EXPLORAR BANCO DE DADOS - Entender estrutura para ajustar queries
-- ============================================================================

-- 1. TABELA PRINCIPAL: FT_PROCESSOS
-- ============================================================================
DESCRIBE FT_PROCESSOS;
-- Vamos ver dados de exemplo
SELECT * FROM FT_PROCESSOS LIMIT 1\G

-- 2. TABELA DE DEFERIMENTOS
-- ============================================================================
DESCRIBE FT_DEFERIMENTOS;
SELECT * FROM FT_DEFERIMENTOS LIMIT 1\G

-- 3. HISTÓRICO DE MOVIMENTAÇÕES
-- ============================================================================
DESCRIBE FT_HISTORICO_MOVIMENTACOES;
SELECT * FROM FT_HISTORICO_MOVIMENTACOES LIMIT 1\G

-- 4. ANEXOS
-- ============================================================================
DESCRIBE FT_ANEXOS;
SELECT * FROM FT_ANEXOS LIMIT 1\G

-- 5. UNIDADES CONSUMIDORAS
-- ============================================================================
DESCRIBE FT_UC_SNAPSHOT;
SELECT * FROM FT_UC_SNAPSHOT LIMIT 1\G

-- 6. TIPO DE IRREGULARIDADE
-- ============================================================================
DESCRIBE DM_TIPO_IRREGULARIDADE;
SELECT * FROM DM_TIPO_IRREGULARIDADE LIMIT 5;

-- 7. SUBTIPO DE IRREGULARIDADE
-- ============================================================================
DESCRIBE DM_SUBTIPO_IRREGULARIDADE;
SELECT * FROM DM_SUBTIPO_IRREGULARIDADE LIMIT 5;

-- 8. KANBAN COLUNAS
-- ============================================================================
DESCRIBE DM_KANBAN_COLUNAS;
SELECT * FROM DM_KANBAN_COLUNAS;

-- 9. ETAPAS PROCESSO
-- ============================================================================
DESCRIBE DM_ETAPAS_PROCESSO;
SELECT * FROM DM_ETAPAS_PROCESSO;

-- 10. FLUXO DE RESSARCIMENTO
-- ============================================================================
DESCRIBE FT_FLUXO_RESSARCIMENTO;
SELECT * FROM FT_FLUXO_RESSARCIMENTO LIMIT 1\G

-- 11. FATURAMENTO
-- ============================================================================
DESCRIBE FT_FATURAMENTO;
SELECT * FROM FT_FATURAMENTO LIMIT 1\G

-- 12. REQUISIÇÕES (se houver relação)
-- ============================================================================
DESCRIBE FT_REQUISICOES;
SELECT * FROM FT_REQUISICOES LIMIT 1\G

-- 13. CONTAGENS GERAIS
-- ============================================================================
SELECT 'FT_PROCESSOS' as tabela, COUNT(*) as total FROM FT_PROCESSOS
UNION ALL
SELECT 'FT_DEFERIMENTOS', COUNT(*) FROM FT_DEFERIMENTOS
UNION ALL
SELECT 'FT_HISTORICO_MOVIMENTACOES', COUNT(*) FROM FT_HISTORICO_MOVIMENTACOES
UNION ALL
SELECT 'FT_ANEXOS', COUNT(*) FROM FT_ANEXOS
UNION ALL
SELECT 'FT_FLUXO_RESSARCIMENTO', COUNT(*) FROM FT_FLUXO_RESSARCIMENTO
UNION ALL
SELECT 'FT_FATURAMENTO', COUNT(*) FROM FT_FATURAMENTO;

-- 14. VALORES DE STATUS EM FT_PROCESSOS
-- ============================================================================
SELECT DISTINCT status FROM FT_PROCESSOS;
SELECT DISTINCT status_analise FROM FT_DEFERIMENTOS WHERE status_analise IS NOT NULL;

-- 15. DATAS - Para saber se temos dados históricos
-- ============================================================================
SELECT
    MIN(data_criacao) as data_mais_antiga,
    MAX(data_criacao) as data_mais_recente,
    COUNT(*) as total_registros
FROM FT_PROCESSOS;

-- 16. Ver se há relação entre FT_PROCESSOS e FT_REQUISICOES
-- ============================================================================
SELECT COUNT(DISTINCT p.id) as processos,
       COUNT(DISTINCT r.id) as requisicoes
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES r ON p.id = r.id_processo OR p.id = r.id;
