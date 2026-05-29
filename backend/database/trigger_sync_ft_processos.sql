-- ============================================================================
-- TRIGGER: trg_hist_sync_ft_processos
-- ============================================================================
-- Objetivo: manter FT_PROCESSOS (estado atual exibido na lista/Kanban) sempre
-- sincronizado com a ULTIMA movimentacao do FT_HISTORICO_MOVIMENTACOES.
--
-- Regra de negocio (definida 26/05/2026): o historico de movimentacoes e a
-- FONTE DE VERDADE. Toda movimentacao com etapa valida e mais recente propaga
-- automaticamente para FT_PROCESSOS — independente de qual handler/codigo/
-- importacao fez o INSERT.
--
-- Protecoes:
--   1. So sincroniza se NEW.etapa_nova existe em DM_ETAPAS_PROCESSO (etapa valida).
--      Movimentacoes "Historico", "Suspenso", NULL, "" sao ignoradas.
--   2. So sincroniza se NEW.data_movimentacao > FT_PROCESSOS.data_movimentacao
--      (nunca regride para movimentacao antiga / retroativa).
--   3. NAO toca processos suspensos (suspenso=1).
--   4. sub_etapa do historico so sobrescreve se nao for vazia/NULL.
--   5. CONTINUE HANDLER: nunca quebra o INSERT do historico (se a sync falhar,
--      o historico e gravado mesmo assim — sync e best-effort).
--
-- Mapeia id_coluna/nome_coluna via DM_ETAPAS_PROCESSO.id_coluna_kanban +
-- DM_KANBAN_COLUNAS, mantendo o Kanban coerente.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_hist_sync_ft_processos;

CREATE TRIGGER trg_hist_sync_ft_processos
AFTER INSERT ON FT_HISTORICO_MOVIMENTACOES
FOR EACH ROW
BEGIN
    DECLARE v_id_etapa   INT DEFAULT NULL;
    DECLARE v_id_coluna  INT DEFAULT NULL;
    DECLARE v_nome_col   VARCHAR(100) DEFAULT NULL;

    -- Best-effort: qualquer erro na sync e silenciado para nao reverter o INSERT.
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
    DECLARE CONTINUE HANDLER FOR SQLWARNING BEGIN END;

    -- Resolve etapa valida -> id_etapa_processo + id_coluna_kanban
    SELECT d.id_etapa_processo, d.id_coluna_kanban
      INTO v_id_etapa, v_id_coluna
      FROM DM_ETAPAS_PROCESSO d
     WHERE TRIM(LOWER(d.etapa)) = TRIM(LOWER(NEW.etapa_nova))
     LIMIT 1;

    IF v_id_etapa IS NOT NULL THEN
        SELECT nome_coluna INTO v_nome_col
          FROM DM_KANBAN_COLUNAS
         WHERE id_coluna = v_id_coluna
         LIMIT 1;

        UPDATE FT_PROCESSOS
           SET etapa              = NEW.etapa_nova,
               id_etapa_processo  = v_id_etapa,
               sub_etapa          = COALESCE(NULLIF(TRIM(NEW.sub_etapa), ''), sub_etapa),
               id_coluna          = v_id_coluna,
               nome_coluna        = COALESCE(v_nome_col, nome_coluna),
               data_movimentacao  = NEW.data_movimentacao,
               ultima_atualizacao = NOW()
         WHERE id_processo = NEW.id_requisicao
           AND COALESCE(suspenso, 0) = 0
           AND (data_movimentacao IS NULL OR NEW.data_movimentacao > data_movimentacao);
    END IF;
END;
