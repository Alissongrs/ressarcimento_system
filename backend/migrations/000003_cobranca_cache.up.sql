CREATE TABLE IF NOT EXISTS PROCESSO_COBRANCA_CACHE (
  id_processo       INT NOT NULL,
  email_thread_hash VARCHAR(64) NOT NULL DEFAULT '',
  sem_retorno       TINYINT(1) NOT NULL DEFAULT 0,
  tem_email_enviado TINYINT(1) NOT NULL DEFAULT 0,
  dias_sem_retorno  INT NOT NULL DEFAULT 0,
  subject           VARCHAR(255) DEFAULT NULL,
  opcao1            MEDIUMTEXT,
  opcao2            MEDIUMTEXT,
  modelo            VARCHAR(40) DEFAULT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'ready',  -- ready | error
  erro              TEXT,
  atualizado_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_processo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Cache de sugestao de cobranca/SR por processo. Atualizado por cron horario quando o thread de e-mail muda (hash) e sob demanda pelo botao Gerar novamente.';
