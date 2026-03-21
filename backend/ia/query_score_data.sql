-- ============================================================================
-- SURE - Sistema Unificado de Ressarcimento
-- Score de Progressão — Índices + View
-- Execute no MySQL Workbench conectado ao RDS
-- ============================================================================


-- ============================================================================
-- PASSO 1: ÍNDICES
-- Procedure helper para criar índice somente se não existir (MySQL não tem IF NOT EXISTS)
-- ============================================================================

DROP PROCEDURE IF EXISTS sure_create_index;

DELIMITER //
CREATE PROCEDURE sure_create_index(
    IN p_table  VARCHAR(128),
    IN p_index  VARCHAR(128),
    IN p_def    TEXT
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name   = p_table
          AND index_name   = p_index
    ) THEN
        SET @sql = CONCAT('CREATE INDEX `', p_index, '` ON `', p_table, '` ', p_def);
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END //
DELIMITER ;

-- FT_HISTORICO_MOVIMENTACOES
CALL sure_create_index('FT_HISTORICO_MOVIMENTACOES', 'idx_hm_id_requisicao', '(id_requisicao)');
CALL sure_create_index('FT_HISTORICO_MOVIMENTACOES', 'idx_hm_etapas',        '(etapa_nova, etapa_anterior)');

-- FT_PROCESSOS
CALL sure_create_index('FT_PROCESSOS', 'idx_pr_id_coluna',    '(id_coluna)');
CALL sure_create_index('FT_PROCESSOS', 'idx_pr_tipo_subtipo', '(id_tipo_irregularidade, id_subtipo_irregularidade)');

-- FT_ANEXOS
CALL sure_create_index('FT_ANEXOS', 'idx_anx_id_requisicao', '(id_requisicao)');

-- FT_REQUISICOES
CALL sure_create_index('FT_REQUISICOES', 'idx_req_data_criacao', '(data_criacao)');

DROP PROCEDURE IF EXISTS sure_create_index;


-- ============================================================================
-- PASSO 2: VIEW
-- GROUP BY apenas por id_requisicao garante uma linha por processo
-- ============================================================================

CREATE OR REPLACE VIEW vw_score_progressao AS
SELECT
    p.id_requisicao,

    -- Feature 1: Numero de movimentacoes
    COALESCE(COUNT(DISTINCT hm.id_historico), 0)
        AS num_movimentacoes,

    -- Feature 2: Numero de anexos
    COALESCE((
        SELECT COUNT(DISTINCT id_anexo)
        FROM FT_ANEXOS
        WHERE id_requisicao = p.id_requisicao
    ), 0)
        AS num_anexos,

    -- Feature 3: Valor estimado
    COALESCE(p.ressarcimento_estimado, 0)
        AS valor_estimado,

    -- Feature 4: Dias em processamento
    COALESCE(DATEDIFF(NOW(), p.data_criacao), 0)
        AS dias_em_processamento,

    -- Feature 5: Passou na distribuidora
    CASE
        WHEN MAX(hm.etapa_nova)     = 'Distribuidora'
          OR MAX(hm.etapa_anterior) = 'Distribuidora'
        THEN 1 ELSE 0
    END AS passou_distribuidora,

    -- Feature 6: Tipo de irregularidade
    COALESCE(pr.id_tipo_irregularidade, 0)
        AS id_tipo_irregularidade,

    -- Feature 7: Subtipo de irregularidade
    COALESCE(pr.id_subtipo_irregularidade, 0)
        AS id_subtipo_irregularidade,

    -- Feature 8: Tem descricao
    CASE WHEN COALESCE(p.descricao_irregularidade, '') != '' THEN 1 ELSE 0 END
        AS tem_descricao,

    -- Feature 9: Tem link de fatura
    CASE WHEN COALESCE(p.link_fatura, '') != '' THEN 1 ELSE 0 END
        AS tem_link_fatura,

    -- Feature 10: Tem periodos
    CASE WHEN COALESCE(p.periodos_irregularidade, '') != '' THEN 1 ELSE 0 END
        AS tem_periodos,

    -- Label: 1 se avancou para etapas alem de Ativos
    CASE WHEN pr.id_coluna IN (3, 4, 5) THEN 1 ELSE 0 END
        AS avancou

FROM FT_REQUISICOES p
LEFT JOIN FT_PROCESSOS pr
    ON p.id_requisicao = pr.id_processo
LEFT JOIN FT_HISTORICO_MOVIMENTACOES hm
    ON p.id_requisicao = hm.id_requisicao
WHERE pr.id_coluna IS NOT NULL
  AND pr.id_coluna != 1
GROUP BY p.id_requisicao;


-- ============================================================================
-- PASSO 3: VALIDAÇÃO
-- Execute após criar a view para confirmar que está funcionando
-- ============================================================================

-- Contar registros
SELECT COUNT(*) AS total FROM vw_score_progressao;

-- Ver distribuição de classes
SELECT avancou, COUNT(*) AS qtd FROM vw_score_progressao GROUP BY avancou;

-- Ver amostra
SELECT * FROM vw_score_progressao LIMIT 10;
