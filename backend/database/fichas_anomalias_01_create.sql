-- =============================================================================
-- fichas_anomalias_01_create.sql
--
-- EXECUTAR COMO: super_user_ressarcimento  (ou qualquer user com CREATE em db_ressarcimento)
-- BANCO DESTINO: db_ressarcimento
--
-- Apenas cria a tabela de cache. Não acessa sgeeasy_clientes_novo.
-- =============================================================================

CREATE TABLE IF NOT EXISTS fichas_anomalias_cache (
  id               BIGINT          NOT NULL,
  UC               VARCHAR(50)     NOT NULL,
  Cod_Empresa      INT             NOT NULL,
  Concessionaria   VARCHAR(100)    NOT NULL,
  Mes_Ref          VARCHAR(10)     NOT NULL,        -- formato 'YYYY-MM-DD'
  Tp_Tensao        VARCHAR(20)     NULL,
  NroMedidor       VARCHAR(60)     NULL,
  RAZAO_SOCIAL     VARCHAR(200)    NULL,
  Link             VARCHAR(500)    NULL,
  RS_Total_Fatura  DECIMAL(15,2)   NULL,
  flag_f01         TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f02         TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f03         TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f04         TINYINT(1)      NOT NULL DEFAULT 0,
  flag_f05         TINYINT(1)      NOT NULL DEFAULT 0,
  qtd_regras       TINYINT         NOT NULL DEFAULT 0,
  segmentos        VARCHAR(20)     NULL,             -- ex: 'P | FP'
  fichas_aplicadas VARCHAR(50)     NULL,
  desvio_pct_max   DECIMAL(10,1)   NULL,
  troca_medidor    VARCHAR(130)    NULL,
  detalhamento     TEXT            NULL,
  atualizado_em    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

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
  INDEX idx_qtd_regras     (qtd_regras)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'Tabela fichas_anomalias_cache criada com sucesso.' AS status;
