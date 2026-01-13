-- ============================================================================
-- STORED PROCEDURES PARA SINCRONIZAÇÃO DE FT_PROCESSO_SNAPSHOT
-- ============================================================================
-- Como não temos permissão SUPER no RDS, usaremos Stored Procedures
-- que serão chamadas pela aplicação Go
-- ============================================================================

DELIMITER $$

-- ============================================================================
-- SP: SyncProcessoSnapshot
-- Sincroniza um processo do FT_PROCESSO_SNAPSHOT para as tabelas originais
-- ============================================================================
CREATE PROCEDURE IF NOT EXISTS sp_sync_processo_snapshot(
    IN p_id_processo INT,
    IN p_user_id INT
)
BEGIN
    DECLARE p_id_requisicao INT;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        -- Log de erro no histórico
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
        VALUES (p_id_processo, 'ERRO_SYNC_SP',
                CONCAT('Erro na sincronização via SP'),
                NOW(), p_user_id);
        RESIGNAL;
    END;

    -- O id_requisicao = id_processo no seu sistema
    SET p_id_requisicao = p_id_processo;

    -- ========================================================================
    -- 1. SINCRONIZAR FT_REQUISICOES
    -- ========================================================================
    UPDATE FT_REQUISICOES fr
    INNER JOIN FT_PROCESSO_SNAPSHOT fps ON fps.id_processo = fr.id_requisicao
    SET
        fr.uc = fps.uc,
        fr.cliente = fps.cliente,
        fr.concessionaria = fps.concessionaria,
        fr.razao_social_fatura = fps.razao_social_fatura,
        fr.cnpj = fps.cnpj,
        fr.endereco_completo = fps.endereco_completo,
        fr.numero_protocolo = fps.numero_protocolo,
        fr.ressarcimento_estimado = fps.ressarcimento_estimado,
        fr.periodos_irregularidade = fps.periodos_irregularidade,
        fr.descricao_irregularidade = fps.descricao_irregularidade,
        fr.link_fatura = fps.link_fatura,
        fr.justificativa_atraso_triagem = fps.justificativa_atraso_triagem,
        fr.id_usuario = COALESCE(fps.id_usuario, fr.id_usuario)
    WHERE fr.id_requisicao = p_id_requisicao;

    -- ========================================================================
    -- 2. SINCRONIZAR FT_PROCESSOS
    -- ========================================================================
    UPDATE FT_PROCESSOS fp
    INNER JOIN FT_PROCESSO_SNAPSHOT fps ON fps.id_processo = fp.id_processo
    SET
        fp.id_etapa_processo = COALESCE(fps.id_etapa_processo, fp.id_etapa_processo),
        fp.id_responsavel = COALESCE(fps.id_responsavel, fp.id_responsavel),
        fp.sub_etapa = fps.sub_etapa,
        fp.relevancia = fps.relevancia,
        fp.data_alerta = fps.data_alerta,
        fp.suspenso = fps.suspenso,
        fp.suspenso_motivo = fps.suspenso_motivo,
        fp.suspenso_ate = fps.suspenso_ate,
        fp.ultima_atualizacao = NOW()
    WHERE fp.id_processo = p_id_processo;

    -- ========================================================================
    -- 3. SINCRONIZAR FT_DEFERIMENTOS (Aprovação)
    -- ========================================================================
    UPDATE FT_DEFERIMENTOS fd
    INNER JOIN FT_PROCESSO_SNAPSHOT fps ON fps.id_processo = fd.id_processo
    SET
        fd.credito_simples = fps.credito_simples,
        fd.credito_dobro = fps.credito_dobro,
        fd.data_credito_dobro = fps.data_dobro
    WHERE fd.id_processo = p_id_processo
    AND fd.id_processo IS NOT NULL;

    -- ========================================================================
    -- 4. SINCRONIZAR FT_FLUXO_RESSARCIMENTO (Fluxo de Pagamento)
    -- ========================================================================
    UPDATE FT_FLUXO_RESSARCIMENTO ffr
    INNER JOIN FT_PROCESSO_SNAPSHOT fps ON fps.id_processo = ffr.id_processo
    SET
        ffr.forma_devolucao = fps.forma_devolucao,
        ffr.valor = fps.valor_ressarcimento,
        ffr.data_devolucao = fps.data_devolucao,
        ffr.data_envio_financeiro = fps.data_envio_financeiro,
        ffr.updated_at = NOW()
    WHERE ffr.id_processo = p_id_processo
    AND ffr.id_processo IS NOT NULL;

    -- ========================================================================
    -- 5. REGISTRAR NO HISTÓRICO (Rastreabilidade)
    -- ========================================================================
    INSERT INTO FT_HISTORICO_MOVIMENTACOES
    (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
    VALUES (p_id_processo, 'SNAPSHOT_SINCRONIZADO',
            'Snapshot sincronizado com tabelas originais',
            NOW(), p_user_id);

END$$

-- ============================================================================
-- SP: SyncAllProcessosSnapshot
-- Sincroniza TODOS os processos
-- ============================================================================
CREATE PROCEDURE IF NOT EXISTS sp_sync_all_processos_snapshot(
    IN p_user_id INT
)
BEGIN
    DECLARE p_id_processo INT;
    DECLARE done INT DEFAULT FALSE;
    DECLARE cursor_processos CURSOR FOR
        SELECT DISTINCT id_processo FROM FT_PROCESSO_SNAPSHOT;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    OPEN cursor_processos;
    read_loop: LOOP
        FETCH cursor_processos INTO p_id_processo;
        IF done THEN
            LEAVE read_loop;
        END IF;

        CALL sp_sync_processo_snapshot(p_id_processo, p_user_id);
    END LOOP;
    CLOSE cursor_processos;

END$$

-- ============================================================================
-- SP: GetProcessoSnapshot
-- Retorna dados completos de um processo para edição
-- ============================================================================
CREATE PROCEDURE IF NOT EXISTS sp_get_processo_snapshot(
    IN p_id_processo INT
)
BEGIN
    SELECT * FROM FT_PROCESSO_SNAPSHOT
    WHERE id_processo = p_id_processo;
END$$

-- ============================================================================
-- SP: UpdateProcessoSnapshot
-- Atualiza um processo no snapshot
-- ============================================================================
CREATE PROCEDURE IF NOT EXISTS sp_update_processo_snapshot(
    IN p_id_processo INT,
    IN p_uc VARCHAR(100),
    IN p_cliente VARCHAR(255),
    IN p_concessionaria VARCHAR(255),
    IN p_status_class VARCHAR(50),
    IN p_sub_etapa VARCHAR(50),
    IN p_suspensao TINYINT,
    IN p_suspensao_motivo VARCHAR(255),
    IN p_credito_simples DECIMAL(15,2),
    IN p_credito_dobro DECIMAL(15,2),
    IN p_usuario_id INT
)
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
        VALUES (p_id_processo, 'ERRO_UPDATE_SP',
                'Erro ao atualizar processo via SP',
                NOW(), p_usuario_id);
        RESIGNAL;
    END;

    -- Update snapshot
    UPDATE FT_PROCESSO_SNAPSHOT
    SET
        uc = COALESCE(p_uc, uc),
        cliente = COALESCE(p_cliente, cliente),
        concessionaria = COALESCE(p_concessionaria, concessionaria),
        status_class = COALESCE(p_status_class, status_class),
        sub_etapa = COALESCE(p_sub_etapa, sub_etapa),
        suspenso = COALESCE(p_suspensao, suspenso),
        suspenso_motivo = IF(p_suspensao = 1, p_suspensao_motivo, NULL),
        credito_simples = COALESCE(p_credito_simples, credito_simples),
        credito_dobro = COALESCE(p_credito_dobro, credito_dobro),
        updated_at = NOW()
    WHERE id_processo = p_id_processo;

    -- Sync to original tables
    CALL sp_sync_processo_snapshot(p_id_processo, p_usuario_id);

END$$

DELIMITER ;

-- ============================================================================
-- NOTAS DE USO:
-- ============================================================================
--
-- 1. SINCRONIZAR UM PROCESSO:
--    CALL sp_sync_processo_snapshot(123, 1);  -- ID processo 123, user ID 1
--
-- 2. SINCRONIZAR TODOS:
--    CALL sp_sync_all_processos_snapshot(1);
--
-- 3. ATUALIZAR E SINCRONIZAR:
--    CALL sp_update_processo_snapshot(
--        123,                     -- id_processo
--        '123456789',            -- uc
--        'Cliente XYZ',          -- cliente
--        'ENEL',                 -- concessionaria
--        'Em Andamento',         -- status_class
--        'Análise',              -- sub_etapa
--        0,                      -- suspenso (0=não, 1=sim)
--        NULL,                   -- suspensao_motivo
--        1000.00,                -- credito_simples
--        2000.00,                -- credito_dobro
--        1                       -- usuario_id
--    );
--
-- ============================================================================
