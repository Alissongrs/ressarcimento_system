-- =============================================================================
-- fichas_anomalias_cache.sql — DDL DEFINITIVO
-- Banco: db_ressarcimento
--
-- Colunas alinhadas com:
--   • motor_regras_f01_f05.sql  (SELECT final)
--   • SalvarResultadoIAFicha    (handler Go — grava colunas ia_*)
--
-- Para criar do zero:  executar o bloco CREATE TABLE abaixo.
-- Para atualizar tabela existente: executar o bloco ALTER TABLE no final.
-- =============================================================================

-- ─── CRIAÇÃO ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fichas_anomalias_cache (

  -- ── Identificação da fatura (PK = id da Faturas_Registradas_Cache)
  id                           BIGINT          NOT NULL,
  UC                           VARCHAR(20)     NOT NULL,
  Cod_Empresa                  INT             NOT NULL,
  Concessionaria               VARCHAR(100)    NOT NULL,
  Mes_Ref                      DATE            NOT NULL,   -- DATE nativo (fonte é DATE)
  Tp_Tensao                    VARCHAR(20)     NULL,
  NroMedidor                   VARCHAR(60)     NULL,
  RAZAO_SOCIAL                 VARCHAR(200)    NULL,
  Link                         VARCHAR(500)    NULL,
  RS_Total_Fatura              DECIMAL(15,2)   NULL,

  -- ── Flags do motor de regras (F01-F05)
  flag_f01                     TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f02                     TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f03                     TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f04                     TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f05                     TINYINT(1)      NOT NULL DEFAULT 0,
  qtd_regras                   TINYINT         NOT NULL DEFAULT 0,

  -- ── Resumo e detalhamento do motor
  fichas_aplicadas             VARCHAR(50)     NULL,    -- ex: 'F01 | F03'
  desvio_pct_max               DECIMAL(10,1)   NULL,    -- desvio % do F02 (maior posto)
  troca_medidor                VARCHAR(130)    NULL,    -- 'medidor_ant | medidor_novo' (F04)
  detalhamento                 TEXT            NULL,    -- texto completo de todas as fichas

  -- ── Resultado da IA (preenchido por SalvarResultadoIAFicha após análise)
  ia_status                    ENUM('PENDENTE','CONFIRMADO','FALSO_POSITIVO','INCONCLUSIVO')
                                               NOT NULL DEFAULT 'PENDENTE',
  ia_fichas_confirmadas        VARCHAR(50)     NULL,    -- subconjunto confirmado ex: 'F02'
  resultado_ia                 TEXT            NULL,    -- parecer completo gerado pela IA
  valor_ressarcimento_estimado DECIMAL(15,2)   NULL,    -- valor estimado em R$
  resultado_salvo_em           DATETIME        NULL,    -- quando a IA gravou

  -- ── Auditoria
  atualizado_em                DATETIME        NOT NULL
                                               DEFAULT CURRENT_TIMESTAMP
                                               ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_uc             (UC),
  INDEX idx_mes_ref        (Mes_Ref),
  INDEX idx_cod_empresa    (Cod_Empresa),
  INDEX idx_concessionaria (Concessionaria),
  INDEX idx_flag_f01       (flag_f01),
  INDEX idx_flag_f02       (flag_f02),
  INDEX idx_flag_f03       (flag_f03),
  INDEX idx_flag_f04       (flag_f04),
  INDEX idx_flag_f05       (flag_f05),
  INDEX idx_qtd_regras     (qtd_regras),
  INDEX idx_ia_status      (ia_status)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =============================================================================
-- ALTER TABLE — use SE a tabela já existir no banco
-- Adiciona/corrige as colunas que podem estar faltando ou divergentes.
-- Seguro rodar mesmo se algumas colunas já existirem (IF NOT EXISTS no MySQL 8+).
-- =============================================================================

/*
ALTER TABLE fichas_anomalias_cache
  -- Adiciona RAZAO_SOCIAL se não existir
  ADD COLUMN IF NOT EXISTS RAZAO_SOCIAL VARCHAR(200) NULL AFTER NroMedidor,

  -- Garante que Mes_Ref é DATE (se ainda for VARCHAR, converter manualmente antes)
  -- MODIFY COLUMN Mes_Ref DATE NOT NULL,

  -- Colunas de IA
  ADD COLUMN IF NOT EXISTS ia_status
    ENUM('PENDENTE','CONFIRMADO','FALSO_POSITIVO','INCONCLUSIVO')
    NOT NULL DEFAULT 'PENDENTE' AFTER detalhamento,

  ADD COLUMN IF NOT EXISTS ia_fichas_confirmadas
    VARCHAR(50) NULL AFTER ia_status,

  ADD COLUMN IF NOT EXISTS resultado_ia
    TEXT NULL AFTER ia_fichas_confirmadas,

  ADD COLUMN IF NOT EXISTS valor_ressarcimento_estimado
    DECIMAL(15,2) NULL AFTER resultado_ia,

  ADD COLUMN IF NOT EXISTS resultado_salvo_em
    DATETIME NULL AFTER valor_ressarcimento_estimado,

  -- Remove colunas duplicadas/antigas se existirem
  DROP COLUMN IF EXISTS ia_parecer,
  DROP COLUMN IF EXISTS ia_processado_em,

  -- Índice de status IA
  ADD INDEX IF NOT EXISTS idx_ia_status (ia_status);
*/
