-- ============================================================================
-- TRIGGERS PARA SINCRONIZAÇÃO DE FT_PROCESSO_SNAPSHOT COM TABELAS ORIGINAIS
-- ============================================================================
-- Quando você altera FT_PROCESSO_SNAPSHOT, as mudanças são propagadas para:
-- - FT_REQUISICOES
-- - FT_PROCESSOS
-- - FT_DEFERIMENTOS
-- - FT_FLUXO_RESSARCIMENTO
-- ============================================================================

-- Desabilitar o trigger de log para evitar loops
SET @DISABLE_TRIGGER_LOGS = 1;

DELIMITER $$

-- ============================================================================
-- TRIGGER: AFTER UPDATE em FT_PROCESSO_SNAPSHOT
-- Sincroniza mudanças com as tabelas originais
-- ============================================================================
CREATE TRIGGER trg_ft_processo_snapshot_after_update
AFTER UPDATE ON FT_PROCESSO_SNAPSHOT
FOR EACH ROW
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        -- Log do erro (opcional)
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
        VALUES (NEW.id_processo, 'ERRO_SYNC',
                CONCAT('Erro ao sincronizar snapshot com tabelas originais'),
                NOW(), NEW.id_usuario);
    END;

    -- ========================================================================
    -- 1. SINCRONIZAR FT_REQUISICOES (Requisição)
    -- ========================================================================
    UPDATE FT_REQUISICOES
    SET
        uc = COALESCE(NEW.uc, uc),
        cliente = COALESCE(NEW.cliente, cliente),
        concessionaria = COALESCE(NEW.concessionaria, concessionaria),
        razao_social_fatura = COALESCE(NEW.razao_social_fatura, razao_social_fatura),
        cnpj = COALESCE(NEW.cnpj, cnpj),
        endereco_completo = COALESCE(NEW.endereco_completo, endereco_completo),
        numero_protocolo = COALESCE(NEW.numero_protocolo, numero_protocolo),
        ressarcimento_estimado = COALESCE(NEW.ressarcimento_estimado, ressarcimento_estimado),
        periodos_irregularidade = COALESCE(NEW.periodos_irregularidade, periodos_irregularidade),
        descricao_irregularidade = COALESCE(NEW.descricao_irregularidade, descricao_irregularidade),
        link_fatura = COALESCE(NEW.link_fatura, link_fatura),
        justificativa_atraso_triagem = COALESCE(NEW.justificativa_atraso_triagem, justificativa_atraso_triagem),
        id_usuario = COALESCE(NEW.id_usuario, id_usuario)
    WHERE id_requisicao = NEW.id_processo;

    -- ========================================================================
    -- 2. SINCRONIZAR FT_PROCESSOS (Processo)
    -- ========================================================================
    UPDATE FT_PROCESSOS
    SET
        id_etapa_processo = COALESCE(NEW.id_etapa_processo, id_etapa_processo),
        id_responsavel = COALESCE(NEW.id_responsavel, id_responsavel),
        sub_etapa = COALESCE(NEW.sub_etapa, sub_etapa),
        relevancia = COALESCE(NEW.relevancia, relevancia),
        data_alerta = COALESCE(NEW.data_alerta, data_alerta),
        suspenso = COALESCE(NEW.suspenso, suspenso),
        suspenso_motivo = COALESCE(NEW.suspenso_motivo, suspenso_motivo),
        suspenso_ate = COALESCE(NEW.suspenso_ate, suspenso_ate),
        ultima_atualizacao = NOW()
    WHERE id_processo = NEW.id_processo;

    -- ========================================================================
    -- 3. SINCRONIZAR FT_DEFERIMENTOS (Aprovação/Análise)
    -- ========================================================================
    UPDATE FT_DEFERIMENTOS
    SET
        credito_simples = COALESCE(NEW.credito_simples, credito_simples),
        credito_dobro = COALESCE(NEW.credito_dobro, credito_dobro),
        data_credito_dobro = COALESCE(NEW.data_dobro, data_credito_dobro)
    WHERE id_processo = NEW.id_processo;

    -- ========================================================================
    -- 4. SINCRONIZAR FT_FLUXO_RESSARCIMENTO (Fluxo de Pagamento)
    -- ========================================================================
    UPDATE FT_FLUXO_RESSARCIMENTO
    SET
        forma_devolucao = COALESCE(NEW.forma_devolucao, forma_devolucao),
        valor = COALESCE(NEW.valor_ressarcimento, valor),
        data_devolucao = COALESCE(NEW.data_devolucao, data_devolucao),
        data_envio_financeiro = COALESCE(NEW.data_envio_financeiro, data_envio_financeiro),
        updated_at = NOW()
    WHERE id_processo = NEW.id_processo;

    -- ========================================================================
    -- 5. REGISTRAR NO HISTÓRICO (Rastreabilidade)
    -- ========================================================================
    -- Detectar quais campos foram alterados e registrar no histórico
    IF OLD.sub_etapa IS DISTINCT FROM NEW.sub_etapa THEN
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
        VALUES (NEW.id_processo, 'SUB_ETAPA_ALTERADA',
                CONCAT('Sub-etapa alterada de "', OLD.sub_etapa, '" para "', NEW.sub_etapa, '"'),
                NOW(), NEW.id_usuario);
    END IF;

    IF OLD.suspenso IS DISTINCT FROM NEW.suspenso THEN
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
        VALUES (NEW.id_processo, CASE WHEN NEW.suspenso = 1 THEN 'PROCESSO_SUSPENSO' ELSE 'PROCESSO_REATIVADO' END,
                CONCAT('Motivo: ', COALESCE(NEW.suspenso_motivo, 'Não informado')),
                NOW(), NEW.id_usuario);
    END IF;

    IF OLD.credito_simples IS DISTINCT FROM NEW.credito_simples THEN
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_processo, tipo_movimento, descricao, data_movimentacao, criado_por)
        VALUES (NEW.id_processo, 'CREDITO_ALTERADO',
                CONCAT('Crédito simples: R$ ', COALESCE(OLD.credito_simples, 0), ' -> R$ ', NEW.credito_simples),
                NOW(), NEW.id_usuario);
    END IF;

END$$

-- ============================================================================
-- TRIGGER: BEFORE UPDATE para validações
-- ============================================================================
CREATE TRIGGER trg_ft_processo_snapshot_before_update
BEFORE UPDATE ON FT_PROCESSO_SNAPSHOT
FOR EACH ROW
BEGIN
    -- Atualizar o timestamp
    SET NEW.updated_at = NOW();

    -- Validações (opcional)
    -- Se suspenso = 1, suspenso_motivo deve estar preenchido
    IF NEW.suspenso = 1 AND (NEW.suspenso_motivo IS NULL OR NEW.suspenso_motivo = '') THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Motivo de suspensão é obrigatório quando suspenso = 1';
    END IF;

    -- Se suspensão está sendo reativada, suspenso_ate pode ser NULL
    -- Se suspenso = 0, limpar dados de suspensão
    IF NEW.suspenso = 0 THEN
        SET NEW.suspenso_motivo = NULL;
        SET NEW.suspenso_ate = NULL;
    END IF;
END$$

DELIMITER ;

-- ============================================================================
-- NOTAS IMPORTANTES:
-- ============================================================================
--
-- 1. COALESCE(NEW.valor, OLD.valor):
--    - Se NEW.valor é NULL, mantém o valor antigo
--    - Isso evita sobrescrever com NULL
--
-- 2. HISTÓRICO:
--    - Mudanças importantes são registradas em FT_HISTORICO_MOVIMENTACOES
--    - Permite rastreabilidade das alterações
--
-- 3. PERFORMANCE:
--    - Os UPDATEs têm cláusula WHERE para não afetarem toda a tabela
--    - Índices em id_processo ajudam a performance
--
-- 4. ERROS:
--    - Se algo der errado, um registro é adicionado ao histórico
--    - Não causa erro silencioso
--
-- 5. BIDIRECIONAL:
--    - Este trigger funciona em uma direção (Snapshot -> Original)
--    - Se quiser sincronizar em ambas as direções, precisa de mais triggers
--
-- ============================================================================
