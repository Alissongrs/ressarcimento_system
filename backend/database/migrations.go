package database

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
)

// RunMigrations executa migrações essenciais no banco principal (DB_App).
// Idempotente: pode rodar a cada inicialização sem causar erro.
func RunMigrations() error {
	if DB_App == nil {
		return fmt.Errorf("DB_App não inicializado")
	}
	return runMigrations(DB_App)
}

// runMigrations garante colunas/índices mínimos necessários ao backend.
func runMigrations(db *sql.DB) error {
	// 1) Coluna 'suspenso' em FT_PROCESSOS
	var colCount int
	err := db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = 'FT_PROCESSOS'
		  AND COLUMN_NAME = 'suspenso'`,
	).Scan(&colCount)
	if err != nil {
		return fmt.Errorf("verificando coluna suspenso: %w", err)
	}
	if colCount == 0 {
		log.Println("[migrate] Adicionando coluna FT_PROCESSOS.suspenso ...")
		if _, err := db.Exec(`ALTER TABLE FT_PROCESSOS ADD COLUMN suspenso TINYINT(1) NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("criando coluna suspenso: %w", err)
		}
	}

	// 2) Índice idx_proc_suspenso
	var idxCount int
	if err := db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='FT_PROCESSOS'
		  AND INDEX_NAME='idx_proc_suspenso'`,
	).Scan(&idxCount); err != nil {
		return fmt.Errorf("verificando índice: %w", err)
	}
	if idxCount == 0 {
		log.Println("[migrate] Criando índice idx_proc_suspenso ...")
		if _, err := db.Exec(`CREATE INDEX idx_proc_suspenso ON FT_PROCESSOS (suspenso)`); err != nil {
			if !strings.Contains(strings.ToLower(err.Error()), "exists") {
				return fmt.Errorf("criando índice idx_proc_suspenso: %w", err)
			}
		}
	}

	// 3) Backfill por sub_etapa
	log.Println("[migrate] Backfill de suspenso por sub_etapa='Suspenso' ...")
	if _, err := db.Exec(`UPDATE FT_PROCESSOS SET suspenso = 1 WHERE LOWER(COALESCE(sub_etapa,'')) = 'suspenso'`); err != nil {
		return fmt.Errorf("backfill por sub_etapa: %w", err)
	}

	// 4) Backfill opcional por tag 'Suspenso'
	var hasPT, hasTags int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='FT_PROCESSO_TAGS'`,
	).Scan(&hasPT)
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='DM_TAGS'`,
	).Scan(&hasTags)

	if hasPT > 0 && hasTags > 0 {
		log.Println("[migrate] Backfill de suspenso por tag 'Suspenso' ...")
		if _, err := db.Exec(`
			UPDATE FT_PROCESSOS p
			JOIN FT_PROCESSO_TAGS pt ON pt.id_processo = p.id_processo
			JOIN DM_TAGS t ON t.id_tag = pt.id_tag
			SET p.suspenso = 1
			WHERE LOWER(t.nome) = 'suspenso'`,
		); err != nil {
			return fmt.Errorf("backfill por tag: %w", err)
		}
	}

	// 5) Log de verificação
	var total, suspensos sql.NullInt64
	_ = db.QueryRow(`SELECT COUNT(*), SUM(suspenso) FROM FT_PROCESSOS`).Scan(&total, &suspensos)
	log.Printf("[migrate] FT_PROCESSOS: total=%d, suspensos=%d", total.Int64, suspensos.Int64)

	// 6) Tabela de feedbacks dos usuários (se não existir)
	var hasFb int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='FEEDBACKS'`,
	).Scan(&hasFb)

	if hasFb == 0 {
		log.Println("[migrate] Criando tabela FEEDBACKS ...")
		if _, err := db.Exec(`
			CREATE TABLE FEEDBACKS (
			  id_feedback INT AUTO_INCREMENT PRIMARY KEY,
			  id_usuario INT NOT NULL,
			  mensagem TEXT NOT NULL,
			  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  INDEX idx_feedback_usuario (id_usuario),
			  CONSTRAINT fk_feedback_usuario FOREIGN KEY (id_usuario) REFERENCES DM_USUARIO(id_usuario)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando FEEDBACKS: %w", err)
		}
	}

	// 6b) Tabela de feedbacks de resumo IA (se não existir)
	var hasAIResumo int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='ai_resumo_feedback'`,
	).Scan(&hasAIResumo)

	if hasAIResumo == 0 {
		log.Println("[migrate] Criando tabela ai_resumo_feedback ...")
		if _, err := db.Exec(`
			CREATE TABLE ai_resumo_feedback (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  processo_id BIGINT UNSIGNED NOT NULL,
			  model VARCHAR(100) NOT NULL,
			  prompt_version VARCHAR(50) NOT NULL,
			  input_hash CHAR(64) NOT NULL,
			  input_payload JSON NOT NULL,
			  output_text LONGTEXT NOT NULL,
			  label ENUM('aceitar','parcial','nada_a_ver') NOT NULL,
			  comentario TEXT NULL,
			  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  created_by BIGINT UNSIGNED NULL,
			  PRIMARY KEY (id),
			  KEY idx_processo (processo_id),
			  KEY idx_label (label),
			  KEY idx_created_at (created_at),
			  UNIQUE KEY uq_input_hash (input_hash)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando ai_resumo_feedback: %w", err)
		}
	}

	// 6c) Tabela de feedbacks do chat IA (RAG)
	var hasChatFeedback int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='AI_CHAT_FEEDBACK'`,
	).Scan(&hasChatFeedback)

	if hasChatFeedback == 0 {
		log.Println("[migrate] Criando tabela AI_CHAT_FEEDBACK ...")
		if _, err := db.Exec(`
			CREATE TABLE AI_CHAT_FEEDBACK (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  user_id INT NOT NULL,
			  question TEXT NOT NULL,
			  answer LONGTEXT NOT NULL,
			  rating TINYINT NOT NULL,
			  comment TEXT NULL,
			  sources JSON NULL,
			  model VARCHAR(100) NULL,
			  prompt_version VARCHAR(50) NULL,
			  doc_text LONGTEXT NULL,
			  embedding JSON NULL,
			  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (id),
			  KEY idx_chat_feedback_user (user_id),
			  KEY idx_chat_feedback_rating (rating),
			  KEY idx_chat_feedback_created (created_at),
			  CONSTRAINT fk_chat_feedback_user FOREIGN KEY (user_id) REFERENCES DM_USUARIO(id_usuario)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando AI_CHAT_FEEDBACK: %w", err)
		}
	}

	// 6d) Tabela de log do chat IA (RAG)
	var hasChatLog int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='AI_CHAT_LOG'`,
	).Scan(&hasChatLog)

	if hasChatLog == 0 {
		log.Println("[migrate] Criando tabela AI_CHAT_LOG ...")
		if _, err := db.Exec(`
			CREATE TABLE AI_CHAT_LOG (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  user_id INT NOT NULL,
			  question TEXT NOT NULL,
			  answer LONGTEXT NOT NULL,
			  sources JSON NULL,
			  model VARCHAR(100) NULL,
			  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (id),
			  KEY idx_chat_log_user (user_id),
			  KEY idx_chat_log_created (created_at),
			  CONSTRAINT fk_chat_log_user FOREIGN KEY (user_id) REFERENCES DM_USUARIO(id_usuario)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando AI_CHAT_LOG: %w", err)
		}
	}

	// 6e) Tabela de sessoes do chat IA
	var hasChatSessions int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='AI_CHAT_SESSIONS'`,
	).Scan(&hasChatSessions)

	if hasChatSessions == 0 {
		log.Println("[migrate] Criando tabela AI_CHAT_SESSIONS ...")
		if _, err := db.Exec(`
			CREATE TABLE AI_CHAT_SESSIONS (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  user_id INT NOT NULL,
			  title VARCHAR(200) NULL,
			  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  deleted_at TIMESTAMP NULL,
			  PRIMARY KEY (id),
			  KEY idx_chat_sessions_user (user_id),
			  KEY idx_chat_sessions_created (created_at),
			  CONSTRAINT fk_chat_sessions_user FOREIGN KEY (user_id) REFERENCES DM_USUARIO(id_usuario)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando AI_CHAT_SESSIONS: %w", err)
		}
	}

	// 6f) Tabela de mensagens do chat IA
	var hasChatMessages int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='AI_CHAT_MESSAGES'`,
	).Scan(&hasChatMessages)

	if hasChatMessages == 0 {
		log.Println("[migrate] Criando tabela AI_CHAT_MESSAGES ...")
		if _, err := db.Exec(`
			CREATE TABLE AI_CHAT_MESSAGES (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  session_id BIGINT UNSIGNED NOT NULL,
			  role ENUM('user','assistant') NOT NULL,
			  content LONGTEXT NOT NULL,
			  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (id),
			  KEY idx_chat_messages_session (session_id),
			  KEY idx_chat_messages_created (created_at),
			  CONSTRAINT fk_chat_messages_session FOREIGN KEY (session_id) REFERENCES AI_CHAT_SESSIONS(id)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando AI_CHAT_MESSAGES: %w", err)
		}
	}

	// 7) Tabela de prazos por coluna do Kanban (admin configura)
	var hasPrazosKanban int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='DM_PRAZOS_KANBAN'`,
	).Scan(&hasPrazosKanban)

	if hasPrazosKanban == 0 {
		log.Println("[migrate] Criando tabela DM_PRAZOS_KANBAN ...")
		if _, err := db.Exec(`
			CREATE TABLE DM_PRAZOS_KANBAN (
			  id INT AUTO_INCREMENT PRIMARY KEY,
			  id_coluna_kanban INT NOT NULL UNIQUE,
			  prazo_dias INT NULL,
			  CONSTRAINT fk_prazo_coluna FOREIGN KEY (id_coluna_kanban) REFERENCES DM_KANBAN_COLUNAS(id_coluna)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando DM_PRAZOS_KANBAN: %w", err)
		}
	}

	// 8) Tabela de prazos por etapa/sub-etapa (admin configura)
	var hasPrazosEtapa int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='DM_PRAZOS_ETAPA'`,
	).Scan(&hasPrazosEtapa)

	if hasPrazosEtapa == 0 {
		log.Println("[migrate] Criando tabela DM_PRAZOS_ETAPA ...")
		if _, err := db.Exec(`
			CREATE TABLE DM_PRAZOS_ETAPA (
			  id INT AUTO_INCREMENT PRIMARY KEY,
			  id_etapa_processo INT NOT NULL,
			  sub_etapa VARCHAR(50) NULL,
			  prazo_dias INT NOT NULL,
			  UNIQUE KEY uq_etapa_sub (id_etapa_processo, sub_etapa),
			  CONSTRAINT fk_prazo_etapa FOREIGN KEY (id_etapa_processo) REFERENCES DM_ETAPAS_PROCESSO(id_etapa_processo)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando DM_PRAZOS_ETAPA: %w", err)
		}
	}

	// 9) Tabela de alarmes personalizados (admin configura)
	var hasAlarmes int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='DM_ALARMES'`,
	).Scan(&hasAlarmes)

	if hasAlarmes == 0 {
		log.Println("[migrate] Criando tabela DM_ALARMES ...")
		if _, err := db.Exec(`
			CREATE TABLE DM_ALARMES (
			  id INT AUTO_INCREMENT PRIMARY KEY,
			  nome VARCHAR(100) NOT NULL,
			  ativo TINYINT(1) NOT NULL DEFAULT 1,
			  tipo ENUM('coluna','etapa','etapa_sub') NOT NULL,
			  id_coluna_kanban INT NULL,
			  id_etapa_processo INT NULL,
			  sub_etapa VARCHAR(50) NULL,
			  prazo_dias INT NOT NULL,
			  severity ENUM('info','warn','crit') NOT NULL DEFAULT 'warn',
			  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  UNIQUE KEY uq_alarme_scope (tipo, id_coluna_kanban, id_etapa_processo, sub_etapa),
			  CONSTRAINT fk_alarm_col FOREIGN KEY (id_coluna_kanban) REFERENCES DM_KANBAN_COLUNAS(id_coluna)
			    ON DELETE SET NULL ON UPDATE CASCADE,
			  CONSTRAINT fk_alarm_etapa FOREIGN KEY (id_etapa_processo) REFERENCES DM_ETAPAS_PROCESSO(id_etapa_processo)
			    ON DELETE SET NULL ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
		); err != nil {
			return fmt.Errorf("criando DM_ALARMES: %w", err)
		}
	}

	// 10) Seed de canais de comunicação (para histórico via canais)
	var hasCanais int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='DM_CANAIS_COMUNICACAO'`,
	).Scan(&hasCanais)

	if hasCanais > 0 {
		log.Println("[migrate] Garantindo canais de comunicação padrão (whatsapp, ligacao, email, sms, site, pessoal) ...")
		ensure := func(nome string) {
			if _, err := db.Exec(`
				INSERT INTO DM_CANAIS_COMUNICACAO (nome)
				SELECT ? FROM DUAL
				WHERE NOT EXISTS (SELECT 1 FROM DM_CANAIS_COMUNICACAO WHERE nome = ?);`,
				nome, nome,
			); err != nil {
				log.Printf("[migrate] aviso: falha ao garantir canal '%s': %v", nome, err)
			}
		}
		for _, n := range []string{"whatsapp", "ligacao", "email", "sms", "site", "pessoal"} {
			ensure(n)
		}
	}

	// 11) Garantir etapas do processo conforme dicionário atual
	{
		log.Println("[migrate] Garantindo etapas DM_ETAPAS_PROCESSO (ids fixos e colunas de kanban) ...")

		// Garante que a coluna etapa_descricao exista (sem cedilha)
		var hasEtapasTbl int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='DM_ETAPAS_PROCESSO'`,
		).Scan(&hasEtapasTbl)

		if hasEtapasTbl > 0 {
			var hasEtapaDesc int
			_ = db.QueryRow(`
				SELECT COUNT(1)
				FROM INFORMATION_SCHEMA.COLUMNS
				WHERE TABLE_SCHEMA = DATABASE()
				  AND TABLE_NAME='DM_ETAPAS_PROCESSO'
				  AND COLUMN_NAME='etapa_descricao'`,
			).Scan(&hasEtapaDesc)

			if hasEtapaDesc == 0 {
				log.Println("[migrate] Adicionando coluna DM_ETAPAS_PROCESSO.etapa_descricao ...")
				if _, err := db.Exec(`ALTER TABLE DM_ETAPAS_PROCESSO ADD COLUMN etapa_descricao VARCHAR(255) NULL`); err != nil {
					log.Printf("[migrate] aviso: falha ao criar coluna etapa_descricao: %v", err)
				}
			}
		}

		// id_etapa_processo, etapa, descricao, id_coluna_kanban
		type etapaRow struct {
			id   int
			nome string
			desc string
			col  int
		}
		rows := []etapaRow{
			{1, "Distribuidora", "Processo em tratativa com a Distribuidora.", 1},
			{2, "Ouvidoria", "Processo escalado para a Ouvidoria.", 1},
			{3, "ANEEL", "Processo escalado para a ANEEL.", 1},
			{4, "SMA", "Processo em análise no SMA.", 1},
			{5, "Pendente", "Deferido, aguardando início da conciliação.", 2},
			{6, "Em Conciliação", "Valores do deferimento sendo conciliados.", 2},
			{7, "Em Contestação", "Valores do deferimento em contestação.", 2},
			{9, "Repasse Amee", "NF emitido, aguardando pagamento do cliente (repasse Amee).", 4},
			{10, "Concluído", "Processo finalizado e pago.", 5},
			{11, "Indeferido", "Processo indeferido.", 6},
			{12, "Rejeitado", "Processo descartado ou rejeitado.", 6},
			{14, "Enviado ao Financeiro", "Processo enviado ao financeiro/gestão, pendente de faturamento (emissão de NF).", 3},
		}

		for _, r := range rows {
			if _, err := db.Exec(`
				INSERT INTO DM_ETAPAS_PROCESSO (id_etapa_processo, etapa, etapa_descricao, id_coluna_kanban)
				VALUES (?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					etapa = VALUES(etapa),
					etapa_descricao = VALUES(etapa_descricao),
					id_coluna_kanban = VALUES(id_coluna_kanban);`,
				r.id, r.nome, r.desc, r.col,
			); err != nil {
				log.Printf("[migrate] aviso: falha ao garantir etapa id=%d nome='%s': %v", r.id, r.nome, err)
			}
		}
	}

	// 12) Tabela de faturas selecionadas por requisição (vínculo inicial)
	{
		var has int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_REQUISICOES_FATURAS'`,
		).Scan(&has)

		if has == 0 {
			log.Println("[migrate] Criando tabela FT_REQUISICOES_FATURAS ...")
			if _, err := db.Exec(`
				CREATE TABLE FT_REQUISICOES_FATURAS (
				  id INT AUTO_INCREMENT PRIMARY KEY,
				  id_requisicao INT NOT NULL,
				  link VARCHAR(1024) NOT NULL,
				  mes_ref VARCHAR(10) NULL,
				  dt_vencimento VARCHAR(32) NULL,
				  valor_total DECIMAL(12,2) NULL,
				  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				  INDEX idx_req (id_requisicao),
				  CONSTRAINT fk_req_fat_req FOREIGN KEY (id_requisicao) REFERENCES FT_REQUISICOES(id_requisicao)
				    ON DELETE CASCADE ON UPDATE CASCADE
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
			`); err != nil {
				return fmt.Errorf("criando FT_REQUISICOES_FATURAS: %w", err)
			}
		}
	}

	// 13) Índices adicionais de performance
	{
		log.Println("[migrate] Criando índices de performance (se não existirem) ...")

		// Helper para criar índice se não existir
		ensureIndex := func(table, indexName, indexDef string) {
			// Evita erro 1072: checa se todas as colunas existem
			cols := strings.Split(indexDef, ",")
			for _, raw := range cols {
				part := strings.TrimSpace(raw)
				if part == "" {
					continue
				}
				fields := strings.Fields(part)
				col := strings.Trim(fields[0], "`")
				var colExists int
				_ = db.QueryRow(`
					SELECT COUNT(1)
					FROM INFORMATION_SCHEMA.COLUMNS
					WHERE TABLE_SCHEMA = DATABASE()
					  AND TABLE_NAME = ?
					  AND COLUMN_NAME = ?`,
					table, col,
				).Scan(&colExists)
				if colExists == 0 {
					log.Printf("[migrate] aviso: pulando índice %s em %s (coluna %s não existe)", indexName, table, col)
					return
				}
			}

			var has int
			_ = db.QueryRow(`
				SELECT COUNT(1)
				FROM INFORMATION_SCHEMA.STATISTICS
				WHERE TABLE_SCHEMA = DATABASE()
				  AND TABLE_NAME = ?
				  AND INDEX_NAME = ?`,
				table, indexName,
			).Scan(&has)

			if has == 0 {
				log.Printf("[migrate] Criando índice %s em %s...", indexName, table)
				query := fmt.Sprintf("CREATE INDEX %s ON %s (%s)", indexName, table, indexDef)
				if _, err := db.Exec(query); err != nil {
					if !strings.Contains(strings.ToLower(err.Error()), "exists") &&
						!strings.Contains(strings.ToLower(err.Error()), "duplicate") {
						log.Printf("[migrate] aviso: falha ao criar índice %s: %v", indexName, err)
					}
				}
			}
		}

		ensureView := func(viewName, viewSQL string) {
			var has int
			_ = db.QueryRow(`
				SELECT COUNT(1)
				FROM INFORMATION_SCHEMA.VIEWS
				WHERE TABLE_SCHEMA = DATABASE()
				  AND TABLE_NAME = ?`,
				viewName,
			).Scan(&has)
			if has > 0 {
				return
			}
			log.Printf("[migrate] Criando view %s...", viewName)
			if _, err := db.Exec(viewSQL); err != nil {
				log.Printf("[migrate] aviso: falha ao criar view %s: %v", viewName, err)
			}
		}

		// Índices em FT_HISTORICO_MOVIMENTACOES
		ensureIndex("FT_HISTORICO_MOVIMENTACOES", "idx_historico_data_movimentacao", "data_movimentacao DESC")
		ensureIndex("FT_HISTORICO_MOVIMENTACOES", "idx_historico_req_data", "id_requisicao, data_movimentacao DESC, id_historico DESC")
		// ensureIndex("FT_HISTORICO_MOVIMENTACOES", "idx_historico_id_processo", "id_processo") // Coluna id_processo não existe

		// Índices em FT_HISTORICO_CANAIS — sem índice causa full scan no JOIN por id_historico
		ensureIndex("FT_HISTORICO_CANAIS", "idx_historico_canais_hist", "id_historico")

		// Índices em FT_PROCESSOS
		ensureIndex("FT_PROCESSOS", "idx_processos_etapa", "id_etapa_processo")
		// ensureIndex("FT_PROCESSOS", "idx_processos_data_criacao", "data_criacao DESC") // Coluna data_criacao não existe

		// Índices em FT_REQUISICOES
		ensureIndex("FT_REQUISICOES", "idx_requisicoes_data_criacao", "data_criacao DESC")
		ensureIndex("FT_REQUISICOES", "idx_requisicoes_status", "id_status")
		ensureIndex("FT_REQUISICOES", "idx_requisicoes_usuario", "id_usuario")

		// View compatível com consultas legadas (mail/processes/search)
		ensureView("VW_POWERBI_PROCESSOS", `
CREATE VIEW VW_POWERBI_PROCESSOS AS
SELECT
  p.id_processo                          AS id_processo,
  COALESCE(r.cliente,'')                 AS Cliente,
  COALESCE(r.uc,'')                      AS UC,
  COALESCE(r.cnpj,'')                    AS CNPJ,
  COALESCE(r.concessionaria,'')          AS Concessionaria,
  COALESCE(e.etapa,'')                   AS `+"`Etapa Atual`"+`,
  COALESCE(kc.nome_coluna,'')            AS `+"`Coluna Kanban Atual`"+`,
  COALESCE(h.etapa_nova,'')              AS `+"`Ultima Etapa`"+`,
  COALESCE(h.sub_etapa,'')               AS `+"`Ultima Sub Etapa`"+`,
  ''                                     AS `+"`Status Analise`"+`,
  COALESCE(DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s'), '') AS `+"`Data Ultima Movimentacao`"+`,
  ''                                     AS Prioridade,
  COALESCE(p.suspenso,0)                 AS `+"`Suspenso`"+`
FROM FT_PROCESSOS p
JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
LEFT JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban
LEFT JOIN (
  SELECT h1.id_requisicao, h1.etapa_nova, h1.sub_etapa, h1.data_movimentacao
  FROM FT_HISTORICO_MOVIMENTACOES h1
  JOIN (
    SELECT id_requisicao, MAX(id_historico) AS max_id
    FROM FT_HISTORICO_MOVIMENTACOES
    GROUP BY id_requisicao
  ) h2 ON h2.id_requisicao = h1.id_requisicao AND h2.max_id = h1.id_historico
) h ON h.id_requisicao = p.id_processo
`)

		// View para treino do Score de Progressão
		ensureView("vw_score_progressao", `
CREATE VIEW vw_score_progressao AS
SELECT
    p.id_requisicao,
    COALESCE(p.ressarcimento_estimado, 0)                                              AS valor_estimado,
    COALESCE(DATEDIFF(NOW(), p.data_criacao), 0)                                       AS dias_em_processamento,
    COALESCE(pr.id_tipo_irregularidade, 0)                                             AS id_tipo_irregularidade,
    COALESCE(pr.id_subtipo_irregularidade, 0)                                          AS id_subtipo_irregularidade,
    CASE WHEN COALESCE(p.descricao_irregularidade, '') != '' THEN 1 ELSE 0 END         AS tem_descricao,
    CASE WHEN COALESCE(p.link_fatura, '') != '' THEN 1 ELSE 0 END                      AS tem_link_fatura,
    CASE WHEN pr.id_coluna IN (
        SELECT id_coluna FROM DM_KANBAN_COLUNAS
        WHERE nome_coluna IN ('Fluxo de Ressarcimento', 'Faturamento', 'Concluidos')
    ) THEN 1 ELSE 0 END                                                                AS avancou
FROM FT_REQUISICOES p
LEFT JOIN FT_PROCESSOS pr ON p.id_requisicao = pr.id_processo
WHERE pr.id_coluna IS NOT NULL
  AND pr.id_coluna != 1`)

		// Tabela de alertas manuais por processo/usuário
		if _, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS FT_ALERTAS (
				id_alerta      BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
				id_usuario     BIGINT       NOT NULL,
				id_processo    BIGINT       NULL,
				mensagem       TEXT         NOT NULL,
				lido           TINYINT(1)   NOT NULL DEFAULT 0,
				acknowledged   TINYINT(1)   NOT NULL DEFAULT 0,
				data_criacao   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
				data_alerta    DATE         NULL,
				INDEX idx_ft_alertas_usuario_lido (id_usuario, lido, data_criacao DESC),
				INDEX idx_ft_alertas_processo (id_processo),
				INDEX idx_ft_alertas_data (data_alerta)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
			log.Printf("[migrate] WARN FT_ALERTAS: %v", err)
		}

		// Índices em DM_ALERTAS (legado, se a tabela existir)
		var hasAlertas int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='DM_ALERTAS'`,
		).Scan(&hasAlertas)

		if hasAlertas > 0 {
			ensureIndex("DM_ALERTAS", "idx_alertas_usuario_lido", "id_usuario, lido, data_criacao DESC")
		}

		// Índices em FT_DEFERIMENTOS
		var hasDeferimentos int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_DEFERIMENTOS'`,
		).Scan(&hasDeferimentos)

		if hasDeferimentos > 0 {
			ensureIndex("FT_DEFERIMENTOS", "idx_deferimento_processo", "id_processo")
		}

		// Índices em FT_FLUXO_RESSARCIMENTO
		var hasFluxo int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_FLUXO_RESSARCIMENTO'`,
		).Scan(&hasFluxo)

		if hasFluxo > 0 {
			ensureIndex("FT_FLUXO_RESSARCIMENTO", "idx_fluxo_processo", "id_processo")
		}

		// Índices em FT_FATURAMENTO
		var hasFaturamento int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_FATURAMENTO'`,
		).Scan(&hasFaturamento)

		if hasFaturamento > 0 {
			ensureIndex("FT_FATURAMENTO", "idx_faturamento_processo", "id_processo")
		}
	}

	// 14) Colunas de repasse no deferimento (se não existirem)
	{
		var hasDef int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_DEFERIMENTOS'`,
		).Scan(&hasDef)
		if hasDef > 0 {
			ensureColumn := func(name, colType string) {
				var colCount int
				_ = db.QueryRow(`
					SELECT COUNT(1)
					FROM INFORMATION_SCHEMA.COLUMNS
					WHERE TABLE_SCHEMA = DATABASE()
					  AND TABLE_NAME='FT_DEFERIMENTOS'
					  AND COLUMN_NAME=?`, name,
				).Scan(&colCount)
				if colCount == 0 {
					log.Printf("[migrate] Adicionando coluna FT_DEFERIMENTOS.%s ...", name)
					_, _ = db.Exec(fmt.Sprintf("ALTER TABLE FT_DEFERIMENTOS ADD COLUMN %s %s NULL", name, colType))
				}
			}
			ensureColumn("repasse_simples", "DECIMAL(12,2)")
			ensureColumn("repasse_dobro", "DECIMAL(12,2)")
		}
	}

	// 14b) Colunas para anexos em banco (MEDIUMBLOB)
	{
		var hasAnexos int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_ANEXOS'`,
		).Scan(&hasAnexos)
		if hasAnexos > 0 {
			ensureColumn := func(name, colType string) {
				var colCount int
				_ = db.QueryRow(`
					SELECT COUNT(1)
					FROM INFORMATION_SCHEMA.COLUMNS
					WHERE TABLE_SCHEMA = DATABASE()
					  AND TABLE_NAME='FT_ANEXOS'
					  AND COLUMN_NAME=?`, name,
				).Scan(&colCount)
				if colCount == 0 {
					log.Printf("[migrate] Adicionando coluna FT_ANEXOS.%s ...", name)
					_, _ = db.Exec(fmt.Sprintf("ALTER TABLE FT_ANEXOS ADD COLUMN %s %s NULL", name, colType))
				}
			}
			ensureColumn("data_upload", "DATETIME")
			ensureColumn("mime_type", "VARCHAR(120)")
			ensureColumn("tamanho_bytes", "BIGINT")
			ensureColumn("arquivo_blob", "MEDIUMBLOB")
		}
	}

	// 15) Trigger para garantir defaults na criação de FT_PROCESSOS
	{
		var triggerCount int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TRIGGERS
			WHERE TRIGGER_SCHEMA = DATABASE()
			  AND TRIGGER_NAME = 'trg_ft_processos_before_insert_defaults'`,
		).Scan(&triggerCount)

		if triggerCount == 0 {
			triggerSQL := `
CREATE TRIGGER trg_ft_processos_before_insert_defaults
BEFORE INSERT ON FT_PROCESSOS
FOR EACH ROW
BEGIN
  SET NEW.id_etapa_processo = 1;
  SET NEW.sub_etapa = 'Primeira reclamação da etapa - Em elaboração';
  SET NEW.id_sub_etapa_processo = (
    SELECT id_subetapa
    FROM DM_SUBETAPA_PROCESSOS
    WHERE nome_subetapa = 'Primeira reclamação da etapa - Em elaboração'
    LIMIT 1
  );
END`
			log.Println("[migrate] Criando trigger trg_ft_processos_before_insert_defaults ...")
			if _, err := db.Exec(triggerSQL); err != nil {
				log.Printf("[migrate] Aviso: falha ao criar trigger defaults FT_PROCESSOS (ignorado): %v", err)
			}
		}
	}

	// 16) Trigger para sincronizar FT_PROCESSO_SNAPSHOT após INSERT em FT_PROCESSOS (se SP existir)
	{
		var hasSyncSP int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.ROUTINES
			WHERE ROUTINE_SCHEMA = DATABASE()
			  AND ROUTINE_NAME = 'sp_sync_from_original_tables'
			  AND ROUTINE_TYPE = 'PROCEDURE'`,
		).Scan(&hasSyncSP)

		if hasSyncSP > 0 {
			var triggerCount int
			_ = db.QueryRow(`
				SELECT COUNT(1)
				FROM INFORMATION_SCHEMA.TRIGGERS
				WHERE TRIGGER_SCHEMA = DATABASE()
				  AND TRIGGER_NAME = 'trg_ft_processos_after_insert_snapshot'`,
			).Scan(&triggerCount)

			if triggerCount == 0 {
				hasCreatedAt := 0
				hasUpdatedAt := 0
				_ = db.QueryRow(`
					SELECT COUNT(1)
					FROM INFORMATION_SCHEMA.COLUMNS
					WHERE TABLE_SCHEMA = DATABASE()
					  AND TABLE_NAME = 'FT_PROCESSO_SNAPSHOT'
					  AND COLUMN_NAME = 'created_at'`,
				).Scan(&hasCreatedAt)
				_ = db.QueryRow(`
					SELECT COUNT(1)
					FROM INFORMATION_SCHEMA.COLUMNS
					WHERE TABLE_SCHEMA = DATABASE()
					  AND TABLE_NAME = 'FT_PROCESSO_SNAPSHOT'
					  AND COLUMN_NAME = 'updated_at'`,
				).Scan(&hasUpdatedAt)

				insertCols := []string{"id_processo"}
				insertVals := []string{"NEW.id_processo"}
				if hasCreatedAt > 0 {
					insertCols = append(insertCols, "created_at")
					insertVals = append(insertVals, "NOW()")
				}
				if hasUpdatedAt > 0 {
					insertCols = append(insertCols, "updated_at")
					insertVals = append(insertVals, "NOW()")
				}

				triggerSQL := fmt.Sprintf(`
CREATE TRIGGER trg_ft_processos_after_insert_snapshot
AFTER INSERT ON FT_PROCESSOS
FOR EACH ROW
BEGIN
  INSERT IGNORE INTO FT_PROCESSO_SNAPSHOT (%s) VALUES (%s);
  CALL sp_sync_from_original_tables(NEW.id_processo, 0);
END`, strings.Join(insertCols, ", "), strings.Join(insertVals, ", "))

				log.Println("[migrate] Criando trigger trg_ft_processos_after_insert_snapshot ...")
				if _, err := db.Exec(triggerSQL); err != nil {
					log.Printf("[migrate] Aviso: falha ao criar trigger snapshot (ignorado): %v", err)
				}
			}
		}
	}

    log.Println("-----------------------------------------------")
	// 7) Mailbox: mail_messages
	var hasMailMessages int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='mail_messages'`,
	).Scan(&hasMailMessages)
	if hasMailMessages == 0 {
		log.Println("[migrate] Criando tabela mail_messages ...")
		if _, err := db.Exec(`
			CREATE TABLE mail_messages (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  graph_message_id VARCHAR(200) NOT NULL,
			  internet_message_id VARCHAR(255) NULL,
			  subject TEXT NULL,
			  from_email VARCHAR(255) NULL,
			  from_name VARCHAR(255) NULL,
			  to_json JSON NULL,
			  cc_json JSON NULL,
			  received_at DATETIME NULL,
			  snippet TEXT NULL,
			  has_attachments TINYINT(1) NOT NULL DEFAULT 0,
			  thread_id VARCHAR(255) NULL,
			  folder_id VARCHAR(200) NULL,
			  raw_meta_json JSON NULL,
			  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			  PRIMARY KEY (id),
			  UNIQUE KEY uq_mail_graph_id (graph_message_id),
			  KEY idx_mail_received (received_at),
			  KEY idx_mail_folder (folder_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`); err != nil {
			return fmt.Errorf("criando mail_messages: %w", err)
		}
	}

	// 8) Mailbox: mail_message_attachments
	var hasMailAtt int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='mail_message_attachments'`,
	).Scan(&hasMailAtt)
	if hasMailAtt == 0 {
		log.Println("[migrate] Criando tabela mail_message_attachments ...")
		if _, err := db.Exec(`
			CREATE TABLE mail_message_attachments (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  mail_message_id BIGINT UNSIGNED NOT NULL,
			  graph_attachment_id VARCHAR(200) NULL,
			  filename VARCHAR(255) NULL,
			  content_type VARCHAR(255) NULL,
			  size BIGINT NULL,
			  storage_key VARCHAR(512) NULL,
			  sha256 CHAR(64) NULL,
			  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (id),
			  UNIQUE KEY uq_mail_attach_sha (mail_message_id, sha256),
			  KEY idx_mail_attach_msg (mail_message_id),
			  CONSTRAINT fk_mail_attach_message FOREIGN KEY (mail_message_id) REFERENCES mail_messages(id)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`); err != nil {
			return fmt.Errorf("criando mail_message_attachments: %w", err)
		}
	}

	// 9) Mailbox: process_mail_links
	var hasProcessMail int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='process_mail_links'`,
	).Scan(&hasProcessMail)
	if hasProcessMail == 0 {
		log.Println("[migrate] Criando tabela process_mail_links ...")
		if _, err := db.Exec(`
			CREATE TABLE process_mail_links (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  processo_id BIGINT UNSIGNED NOT NULL,
			  mail_message_id BIGINT UNSIGNED NOT NULL,
			  created_by BIGINT UNSIGNED NULL,
			  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  note TEXT NULL,
			  PRIMARY KEY (id),
			  UNIQUE KEY uq_process_mail (processo_id, mail_message_id),
			  KEY idx_pml_processo (processo_id),
			  KEY idx_pml_msg (mail_message_id),
			  CONSTRAINT fk_pml_mail_message FOREIGN KEY (mail_message_id) REFERENCES mail_messages(id)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`); err != nil {
			return fmt.Errorf("criando process_mail_links: %w", err)
		}
	}
	{
		var hasMailGraphMessageID int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME = 'FT_HISTORICO_MOVIMENTACOES'
			  AND COLUMN_NAME = 'mail_graph_message_id'`,
		).Scan(&hasMailGraphMessageID)
		if hasMailGraphMessageID == 0 {
			log.Println("[migrate] Adicionando coluna mail_graph_message_id em FT_HISTORICO_MOVIMENTACOES ...")
			if _, err := db.Exec(`
				ALTER TABLE FT_HISTORICO_MOVIMENTACOES
				ADD COLUMN mail_graph_message_id VARCHAR(200) NULL
			`); err != nil {
				return fmt.Errorf("criando coluna mail_graph_message_id: %w", err)
			}
		}
	}
	{
		var idxCount int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.STATISTICS
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME = 'FT_HISTORICO_MOVIMENTACOES'
			  AND INDEX_NAME = 'idx_historico_mail_graph_message'`,
		).Scan(&idxCount)
		if idxCount == 0 {
			log.Println("[migrate] Criando índice idx_historico_mail_graph_message ...")
			if _, err := db.Exec(`
				CREATE INDEX idx_historico_mail_graph_message
				ON FT_HISTORICO_MOVIMENTACOES (mail_graph_message_id)
			`); err != nil {
				return fmt.Errorf("criando índice idx_historico_mail_graph_message: %w", err)
			}
		}
	}
	// 10) Flags para vw_processos_desvio_media_kwh_fponta (tabela)
	var hasDesvioTable int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='vw_processos_desvio_media_kwh_fponta'`,
	).Scan(&hasDesvioTable)
	if hasDesvioTable > 0 {
		type colDef struct {
			Name string
			DDL  string
		}
		cols := []colDef{
			{"verificado", "ALTER TABLE vw_processos_desvio_media_kwh_fponta ADD COLUMN verificado TINYINT(1) NOT NULL DEFAULT 0"},
			{"processo_criado", "ALTER TABLE vw_processos_desvio_media_kwh_fponta ADD COLUMN processo_criado TINYINT(1) NOT NULL DEFAULT 0"},
			{"analise", "ALTER TABLE vw_processos_desvio_media_kwh_fponta ADD COLUMN analise TINYINT(1) NOT NULL DEFAULT 0"},
			{"descartar", "ALTER TABLE vw_processos_desvio_media_kwh_fponta ADD COLUMN descartar TINYINT(1) NOT NULL DEFAULT 0"},
			{"processo_id", "ALTER TABLE vw_processos_desvio_media_kwh_fponta ADD COLUMN processo_id INT NULL"},
			{"updated_at", "ALTER TABLE vw_processos_desvio_media_kwh_fponta ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"},
		}
		for _, col := range cols {
			var colCount int
			_ = db.QueryRow(`
				SELECT COUNT(1)
				FROM INFORMATION_SCHEMA.COLUMNS
				WHERE TABLE_SCHEMA = DATABASE()
				  AND TABLE_NAME = 'vw_processos_desvio_media_kwh_fponta'
				  AND COLUMN_NAME = ?`, col.Name).Scan(&colCount)
			if colCount == 0 {
				log.Printf("[migrate] Adicionando coluna %s em vw_processos_desvio_media_kwh_fponta ...", col.Name)
				if _, err := db.Exec(col.DDL); err != nil {
					return fmt.Errorf("criando coluna %s: %w", col.Name, err)
				}
			}
		}

		type idxDef struct {
			Name string
			DDL  string
		}
		indexes := []idxDef{
			{"idx_desvio_status", "CREATE INDEX idx_desvio_status ON vw_processos_desvio_media_kwh_fponta (status_desvio)"},
			{"idx_desvio_uc", "CREATE INDEX idx_desvio_uc ON vw_processos_desvio_media_kwh_fponta (UC)"},
			{"idx_desvio_concessionaria", "CREATE INDEX idx_desvio_concessionaria ON vw_processos_desvio_media_kwh_fponta (Concessionaria)"},
			{"idx_desvio_mes_ref", "CREATE INDEX idx_desvio_mes_ref ON vw_processos_desvio_media_kwh_fponta (Mes_Ref)"},
			{"idx_desvio_flags", "CREATE INDEX idx_desvio_flags ON vw_processos_desvio_media_kwh_fponta (verificado, analise, descartar, processo_criado)"},
			{"idx_desvio_processo_id", "CREATE INDEX idx_desvio_processo_id ON vw_processos_desvio_media_kwh_fponta (processo_id)"},
			{"idx_desvio_updated_at", "CREATE INDEX idx_desvio_updated_at ON vw_processos_desvio_media_kwh_fponta (updated_at)"},
			{"idx_desvio_uc_conc_mes", "CREATE INDEX idx_desvio_uc_conc_mes ON vw_processos_desvio_media_kwh_fponta (UC, Concessionaria, Mes_Ref)"},
		}
		for _, idx := range indexes {
			var idxCount int
			_ = db.QueryRow(`
				SELECT COUNT(1)
				FROM INFORMATION_SCHEMA.STATISTICS
				WHERE TABLE_SCHEMA = DATABASE()
				  AND TABLE_NAME='vw_processos_desvio_media_kwh_fponta'
				  AND INDEX_NAME=?`, idx.Name).Scan(&idxCount)
			if idxCount == 0 {
				log.Printf("[migrate] Criando indice %s ...", idx.Name)
				if _, err := db.Exec(idx.DDL); err != nil {
					if !strings.Contains(strings.ToLower(err.Error()), "exists") {
						return fmt.Errorf("criando indice %s: %w", idx.Name, err)
					}
				}
			}
		}
	}

	// 6e) Leitura de e-mails por usuário (FT_EMAILS_PROCESSO)
	var hasEmailReads int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='FT_EMAILS_LEITURAS'`,
	).Scan(&hasEmailReads)

	if hasEmailReads == 0 {
		log.Println("[migrate] Criando tabela FT_EMAILS_LEITURAS ...")
		if _, err := db.Exec(`
			CREATE TABLE FT_EMAILS_LEITURAS (
			  id_email INT NOT NULL,
			  id_usuario INT NOT NULL,
			  data_leitura DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (id_email, id_usuario),
			  KEY idx_email_leitura (id_email),
			  KEY idx_usuario_leitura (id_usuario),
			  CONSTRAINT fk_email_leitura_email FOREIGN KEY (id_email) REFERENCES FT_EMAILS_PROCESSO(id_email)
			    ON DELETE CASCADE ON UPDATE CASCADE,
			  CONSTRAINT fk_email_leitura_usuario FOREIGN KEY (id_usuario) REFERENCES DM_USUARIO(id_usuario)
			    ON DELETE CASCADE ON UPDATE CASCADE
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`); err != nil {
			return fmt.Errorf("criando FT_EMAILS_LEITURAS: %w", err)
		}
	}

	// 9.1) Mailbox: mail_message_reads (read per user)
	var hasMailReads int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME='mail_message_reads'`,
	).Scan(&hasMailReads)
	if hasMailReads == 0 {
		log.Println("[migrate] Criando tabela mail_message_reads ...")
		if _, err := db.Exec(`
			CREATE TABLE mail_message_reads (
			  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  user_id BIGINT UNSIGNED NOT NULL,
			  graph_message_id VARCHAR(200) NOT NULL,
			  read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (id),
			  UNIQUE KEY uq_mail_read_user_msg (user_id, graph_message_id),
			  KEY idx_mail_read_msg (graph_message_id),
			  KEY idx_mail_read_user (user_id)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`); err != nil {
			return fmt.Errorf("criando mail_message_reads: %w", err)
		}
	}

	// 17) Score de Progressão — cache por processo
	{
		var hasScore int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_SCORE_PROGRESSAO'`,
		).Scan(&hasScore)

		if hasScore == 0 {
			log.Println("[migrate] Criando tabela FT_SCORE_PROGRESSAO ...")
			if _, err := db.Exec(`
				CREATE TABLE FT_SCORE_PROGRESSAO (
				  id_requisicao  BIGINT NOT NULL,
				  score          FLOAT  NOT NULL,
				  label          VARCHAR(10) NOT NULL,
				  percentual     FLOAT  NOT NULL,
				  calculado_em   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				  modelo_versao  VARCHAR(20) NOT NULL DEFAULT '1.0',
				  PRIMARY KEY (id_requisicao)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`); err != nil {
				return fmt.Errorf("criando FT_SCORE_PROGRESSAO: %w", err)
			}
		}
	}

	// 17b) Score de Progressão — log de treino (resultado real ao sair de Ativos)
	{
		var hasTrainLog int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_SCORE_TRAINING_LOG'`,
		).Scan(&hasTrainLog)

		if hasTrainLog == 0 {
			log.Println("[migrate] Criando tabela FT_SCORE_TRAINING_LOG ...")
			if _, err := db.Exec(`
				CREATE TABLE FT_SCORE_TRAINING_LOG (
				  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				  id_requisicao  BIGINT NOT NULL,
				  avancou        TINYINT(1) NOT NULL,
				  features_json  JSON NOT NULL,
				  criado_em      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				  PRIMARY KEY (id),
				  UNIQUE KEY uq_score_log_req (id_requisicao),
				  KEY idx_score_log_avancou (avancou)
				) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`); err != nil {
				return fmt.Errorf("criando FT_SCORE_TRAINING_LOG: %w", err)
			}
		}
	}

	// 17c) Coluna score_percentual em FT_PROCESSOS (denormalização para queries diretas)
	{
		var hasScoreCol int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_PROCESSOS'
			  AND COLUMN_NAME='score_percentual'`,
		).Scan(&hasScoreCol)

		if hasScoreCol == 0 {
			log.Println("[migrate] Adicionando coluna FT_PROCESSOS.score_percentual ...")
			if _, err := db.Exec(`ALTER TABLE FT_PROCESSOS ADD COLUMN score_percentual FLOAT NULL`); err != nil {
				log.Printf("[migrate] aviso: falha ao adicionar score_percentual (ignorado): %v", err)
			}
		}
	}

	// 18) Colunas para_todos e email_enviado_em em FT_ALERTAS
	{
		var hasParaTodos int
		_ = db.QueryRow(`
			SELECT COUNT(1) FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME = 'FT_ALERTAS'
			  AND COLUMN_NAME = 'para_todos'`,
		).Scan(&hasParaTodos)
		if hasParaTodos == 0 {
			log.Println("[migrate] Adicionando coluna FT_ALERTAS.para_todos ...")
			if _, err := db.Exec(`ALTER TABLE FT_ALERTAS ADD COLUMN para_todos TINYINT(1) NOT NULL DEFAULT 0`); err != nil {
				log.Printf("[migrate] aviso: falha ao adicionar para_todos: %v", err)
			}
		}

		var hasEmailEnviadoEm int
		_ = db.QueryRow(`
			SELECT COUNT(1) FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME = 'FT_ALERTAS'
			  AND COLUMN_NAME = 'email_enviado_em'`,
		).Scan(&hasEmailEnviadoEm)
		if hasEmailEnviadoEm == 0 {
			log.Println("[migrate] Adicionando coluna FT_ALERTAS.email_enviado_em ...")
			if _, err := db.Exec(`ALTER TABLE FT_ALERTAS ADD COLUMN email_enviado_em DATETIME NULL`); err != nil {
				log.Printf("[migrate] aviso: falha ao adicionar email_enviado_em: %v", err)
			}
		}
	}

	// ─────────────────────────────────────────────────────────────
	// Cleanup: DM_USUARIO tinha colunas duplicadas do refactor que
	// nunca foram migradas. As colunas-alvo (`is_admin`, `role`,
	// `ativo`, `created_at`, `updated_at`) não são lidas pelo código —
	// o sistema usa `perfil`, `usuario_ativo` e `data_criacao` (originais).
	// Drop ordenado: is_admin é GENERATED de role, então sai primeiro.
	// ─────────────────────────────────────────────────────────────
	dropDMUsuarioCol := func(col string) {
		var n int
		if err := db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME = 'DM_USUARIO'
			  AND COLUMN_NAME = ?`, col).Scan(&n); err != nil {
			log.Printf("[migrate] aviso: falha ao verificar DM_USUARIO.%s: %v", col, err)
			return
		}
		if n == 0 {
			return
		}
		log.Printf("[migrate] Removendo coluna obsoleta DM_USUARIO.%s ...", col)
		if _, err := db.Exec(fmt.Sprintf("ALTER TABLE DM_USUARIO DROP COLUMN `%s`", col)); err != nil {
			log.Printf("[migrate] aviso: falha ao remover DM_USUARIO.%s: %v", col, err)
		}
	}
	dropDMUsuarioCol("is_admin")    // STORED GENERATED de (role = 'admin')
	dropDMUsuarioCol("role")
	dropDMUsuarioCol("ativo")
	dropDMUsuarioCol("created_at")
	dropDMUsuarioCol("updated_at")

	log.Println("✅ Todas as migrações concluídas com sucesso")
	return nil
}
