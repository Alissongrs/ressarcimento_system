-- ============================================================================
-- STORED PROCEDURES PARA SINCRONIZAÇÃO BIDIRECIONAL
-- ============================================================================
-- Sincroniza de FT_PROCESSOS, FT_REQUISICOES, FT_DEFERIMENTOS, FT_FLUXO_RESSARCIMENTO
-- para FT_PROCESSO_SNAPSHOT
-- ============================================================================

DELIMITER $$

-- ============================================================================
-- SP: SyncFromOriginalTables
-- Sincroniza um processo das tabelas originais para o snapshot
-- Deve ser chamada quando houver mudanças em FT_PROCESSOS, FT_REQUISICOES, etc.
-- ============================================================================
CREATE PROCEDURE IF NOT EXISTS sp_sync_from_original_tables(
    IN p_id_processo INT,
    IN p_user_id INT
)
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
        VALUES (p_id_processo, 'ERRO_SYNC_REVERSE',
                'Erro ao sincronizar das tabelas originais para snapshot',
                NOW(), p_user_id);
        RESIGNAL;
    END;

    -- Recuperar dados de todas as tabelas originais e atualizar o snapshot
    UPDATE FT_PROCESSO_SNAPSHOT fps
    SET
        -- De FT_REQUISICOES
        fps.uc = (SELECT COALESCE(fr.uc, fps.uc)
                 FROM FT_REQUISICOES fr
                 WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.cliente = (SELECT COALESCE(fr.cliente, fps.cliente)
                      FROM FT_REQUISICOES fr
                      WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.concessionaria = (SELECT COALESCE(fr.concessionaria, fps.concessionaria)
                            FROM FT_REQUISICOES fr
                            WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.razao_social_fatura = (SELECT COALESCE(fr.razao_social_fatura, fps.razao_social_fatura)
                                  FROM FT_REQUISICOES fr
                                  WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.cnpj = (SELECT COALESCE(fr.cnpj, fps.cnpj)
                   FROM FT_REQUISICOES fr
                   WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.numero_protocolo = (SELECT COALESCE(fr.numero_protocolo, fps.numero_protocolo)
                               FROM FT_REQUISICOES fr
                               WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.ressarcimento_estimado = (SELECT COALESCE(fr.ressarcimento_estimado, fps.ressarcimento_estimado)
                                     FROM FT_REQUISICOES fr
                                     WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.descricao_irregularidade = (SELECT COALESCE(fr.descricao_irregularidade, fps.descricao_irregularidade)
                                       FROM FT_REQUISICOES fr
                                       WHERE fr.id_requisicao = fps.id_processo LIMIT 1),
        fps.link_fatura = (SELECT COALESCE(fr.link_fatura, fps.link_fatura)
                          FROM FT_REQUISICOES fr
                          WHERE fr.id_requisicao = fps.id_processo LIMIT 1),

        -- De FT_PROCESSOS
        fps.id_etapa_processo = (SELECT COALESCE(fp.id_etapa_processo, fps.id_etapa_processo)
                                FROM FT_PROCESSOS fp
                                WHERE fp.id_processo = fps.id_processo LIMIT 1),
        fps.id_responsavel = (SELECT COALESCE(fp.id_responsavel, fps.id_responsavel)
                             FROM FT_PROCESSOS fp
                             WHERE fp.id_processo = fps.id_processo LIMIT 1),
        fps.sub_etapa = (SELECT COALESCE(fp.sub_etapa, fps.sub_etapa)
                        FROM FT_PROCESSOS fp
                        WHERE fp.id_processo = fps.id_processo LIMIT 1),
        fps.relevancia = (SELECT COALESCE(fp.relevancia, fps.relevancia)
                         FROM FT_PROCESSOS fp
                         WHERE fp.id_processo = fps.id_processo LIMIT 1),
        fps.data_alerta = (SELECT COALESCE(fp.data_alerta, fps.data_alerta)
                          FROM FT_PROCESSOS fp
                          WHERE fp.id_processo = fps.id_processo LIMIT 1),
        fps.suspenso = (SELECT COALESCE(fp.suspenso, fps.suspenso)
                       FROM FT_PROCESSOS fp
                       WHERE fp.id_processo = fps.id_processo LIMIT 1),
        fps.suspenso_motivo = (SELECT COALESCE(fp.suspenso_motivo, fps.suspenso_motivo)
                              FROM FT_PROCESSOS fp
                              WHERE fp.id_processo = fps.id_processo LIMIT 1),
        fps.suspenso_ate = (SELECT COALESCE(fp.suspenso_ate, fps.suspenso_ate)
                           FROM FT_PROCESSOS fp
                           WHERE fp.id_processo = fps.id_processo LIMIT 1),

        -- De FT_DEFERIMENTOS
        fps.credito_simples = (SELECT COALESCE(fd.credito_simples, fps.credito_simples)
                              FROM FT_DEFERIMENTOS fd
                              WHERE fd.id_processo = fps.id_processo LIMIT 1),
        fps.credito_dobro = (SELECT COALESCE(fd.credito_dobro, fps.credito_dobro)
                            FROM FT_DEFERIMENTOS fd
                            WHERE fd.id_processo = fps.id_processo LIMIT 1),
        fps.data_dobro = (SELECT COALESCE(fd.data_credito_dobro, fps.data_dobro)
                         FROM FT_DEFERIMENTOS fd
                         WHERE fd.id_processo = fps.id_processo LIMIT 1),

        -- De FT_FLUXO_RESSARCIMENTO
        fps.forma_devolucao = (SELECT COALESCE(ffr.forma_devolucao, fps.forma_devolucao)
                              FROM FT_FLUXO_RESSARCIMENTO ffr
                              WHERE ffr.id_processo = fps.id_processo LIMIT 1),
        fps.valor_ressarcimento = (SELECT COALESCE(ffr.valor, fps.valor_ressarcimento)
                                  FROM FT_FLUXO_RESSARCIMENTO ffr
                                  WHERE ffr.id_processo = fps.id_processo LIMIT 1),
        fps.data_devolucao = (SELECT COALESCE(ffr.data_devolucao, fps.data_devolucao)
                             FROM FT_FLUXO_RESSARCIMENTO ffr
                             WHERE ffr.id_processo = fps.id_processo LIMIT 1),
        fps.data_envio_financeiro = (SELECT COALESCE(ffr.data_envio_financeiro, fps.data_envio_financeiro)
                                    FROM FT_FLUXO_RESSARCIMENTO ffr
                                    WHERE ffr.id_processo = fps.id_processo LIMIT 1),

        fps.updated_at = NOW()
    WHERE fps.id_processo = p_id_processo;

    -- Registrar no histórico
    INSERT INTO FT_HISTORICO_MOVIMENTACOES
    (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
    VALUES (p_id_processo, 'SINCRONIZACAO_REVERSA',
            'Dados sincronizados das tabelas originais para snapshot',
            NOW(), p_user_id);

END$$

-- ============================================================================
-- SP: RefreshAllProcessosSnapshot
-- Sincroniza TODOS os processos das tabelas originais para o snapshot
-- Útil para sincronização em lote após migração ou correção de dados
-- ============================================================================
CREATE PROCEDURE IF NOT EXISTS sp_refresh_all_processos_snapshot(
    IN p_user_id INT
)
BEGIN
    DECLARE v_count INT DEFAULT 0;
    DECLARE v_processed INT DEFAULT 0;
    DECLARE v_pid INT;
    DECLARE done INT DEFAULT FALSE;
    DECLARE cursor_procs CURSOR FOR
        SELECT DISTINCT id_processo FROM FT_PROCESSO_SNAPSHOT;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    SELECT COUNT(*) INTO v_count FROM FT_PROCESSO_SNAPSHOT;

    OPEN cursor_procs;
    read_loop: LOOP
        FETCH cursor_procs INTO v_pid;
        IF done THEN
            LEAVE read_loop;
        END IF;

        BEGIN
            DECLARE CONTINUE HANDLER FOR SQLEXCEPTION
            BEGIN
                -- Log de erro mas continua processando
                SELECT 1;
            END;

            CALL sp_sync_from_original_tables(v_pid, p_user_id);
            SET v_processed = v_processed + 1;
        END;
    END LOOP;
    CLOSE cursor_procs;

    -- Log final
    INSERT INTO FT_HISTORICO_MOVIMENTACOES
    (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
    VALUES (0, 'REFRESH_BULK_SNAPSHOT',
            CONCAT('Snapshot atualizado em lote: ', v_processed, '/', v_count, ' processos sincronizados'),
            NOW(), p_user_id);
END$$

-- ============================================================================
-- SP: EnableBidirectionalSync
-- Habilita sincronização bidirecional automática
-- Nota: Isso seria feito via triggers, mas como RDS não permite,
-- você precisará chamar sp_sync_from_original_tables em seus endpoints
-- ============================================================================
CREATE PROCEDURE IF NOT EXISTS sp_enable_bidirectional_sync()
BEGIN
    -- Documentação: Sincronização Bidirecional
    -- Para habilitar sincronização automática, chame sp_sync_from_original_tables(id_processo, user_id)
    -- após qualquer UPDATE em:
    -- - FT_PROCESSOS
    -- - FT_REQUISICOES
    -- - FT_DEFERIMENTOS
    -- - FT_FLUXO_RESSARCIMENTO

    -- Exemplo de integração em endpoint Go:
    -- func UpdateProcessoHandler(c *gin.Context) {
    --     // ... atualizar FT_PROCESSOS ...
    --     // Sincronizar de volta para snapshot
    --     err := syncFromOriginalTables(idProcesso, userID)
    --     if err != nil {
    --         log.Printf("Erro ao sincronizar snapshot: %v", err)
    --     }
    -- }

    SELECT 'Sincronização bidirecional habilitada' AS status;
END$$

DELIMITER ;

-- ============================================================================
-- NOTAS DE IMPLEMENTAÇÃO:
-- ============================================================================
--
-- 1. QUANDO CHAMAR sp_sync_from_original_tables:
--    - Sempre que atualizar FT_PROCESSOS
--    - Sempre que atualizar FT_REQUISICOES
--    - Sempre que atualizar FT_DEFERIMENTOS
--    - Sempre que atualizar FT_FLUXO_RESSARCIMENTO
--
-- 2. INTEGRAÇÃO GO:
--    ```go
--    // Após atualizar qualquer tabela original
--    err := callSyncFromOriginalTables(idProcesso, userID)
--    if err != nil {
--        log.Printf("Erro ao sincronizar snapshot: %v", err)
--        // Retornar erro ou registrar no histórico
--    }
--    ```
--
-- 3. FLUXO BIDIRECIONAL COMPLETO:
--    User altera em AdminEditor (Snapshot)
--       ↓
--    sp_update_processo_snapshot (Snapshot → Originais)
--       ↓
--    Usuarios fazem edições diretas em FT_PROCESSOS, FT_REQUISICOES, etc
--       ↓
--    sp_sync_from_original_tables (Originais → Snapshot)
--       ↓
--    AdminEditor mostra dados atualizados
--
-- 4. PERFORMANCE:
--    - Use sp_refresh_all_processos_snapshot apenas em off-peak
--    - Para sincronização contínua, use sp_sync_from_original_tables no endpoint
--    - Considera adicionar índices se performance piorar
--
-- ============================================================================
