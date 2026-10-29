CREATE TABLE IF NOT EXISTS AGENTE_RECEPCAO_LOG (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  canal                  VARCHAR(20)     NOT NULL,             -- hoje só 'email'
  origem_ref             VARCHAR(255)    DEFAULT NULL,          -- id do e-mail + assunto, para rastreio
  dedup_key              VARCHAR(64)     NOT NULL,              -- sha256(canal|texto) — evita reprocessar o mesmo e-mail
  texto_recebido         MEDIUMTEXT      DEFAULT NULL,          -- assunto+corpo, preservado mesmo sem vínculo
  decisao                VARCHAR(30)     NOT NULL,              -- SUGERIU_VINCULO | PRECISA_REVISAO
  id_processo_sugerido   BIGINT          DEFAULT NULL,
  confianca              TINYINT UNSIGNED DEFAULT NULL,
  justificativa          TEXT            DEFAULT NULL,
  modelo                 VARCHAR(40)     DEFAULT 'gpt-4o-mini',
  resposta_crua          LONGTEXT        DEFAULT NULL,
  criado_em              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_agente_recepcao_dedup (dedup_key),
  KEY idx_agente_recepcao_canal (canal),
  KEY idx_agente_recepcao_decisao (decisao),
  KEY idx_agente_recepcao_criado (criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Log/auditoria de decisoes do Agente de Recepcao (nunca cria requisicao, so sugere vinculo ou sinaliza revisao)';
