package database

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
)

// RunMigrations é o entrypoint chamado no boot do backend.
//
// Por padrão, ele SÓ faz verificação de versão via CheckSchemaVersion (não roda
// nenhum DDL). Isso mata o auto-migrate destrutivo que rodava a cada startup
// (o bloco no final desta arquivo chega a fazer DROP COLUMN em DM_USUARIO — em
// produção isso é uma bomba armada).
//
// Fluxo esperado em produção:
//  1. Ops roda `migrate up` (golang-migrate) como passo explícito do deploy,
//     com advisory lock protegendo contra dois deploys concorrentes.
//  2. Backend sobe e apenas verifica que schema_migrations não está dirty.
//
// Escape hatch pra desenvolvimento local: setar SURE_LEGACY_AUTO_MIGRATE=true
// no .env re-habilita o comportamento antigo (runLegacyMigrationsUnsafe),
// protegido por advisory lock. Não use isso em prod.
func RunMigrations() error {
	if DB_App == nil {
		return fmt.Errorf("DB_App não inicializado")
	}

	// Sempre: version check (nunca faz DDL).
	if err := CheckSchemaVersion(DB_App); err != nil {
		return err
	}

	// Sempre (inclusive prod): auto-migrate ADITIVO e idempotente — DDL só
	// não-destrutivo (CREATE IF NOT EXISTS / ADD COLUMN se faltar). É o que faz
	// mudanças de schema aditivas entrarem no deploy sem ninguém rodar o
	// golang-migrate à mão. Ver migrations_additive.go. Nunca bloqueia o boot.
	if err := runAdditiveMigrations(DB_App); err != nil {
		log.Printf("[migrate] aviso: auto-migrate aditivo: %v", err)
	}

	if !LegacyAutoMigrateEnabled() {
		log.Println("[migrate] auto-migrate desligado (SURE_LEGACY_AUTO_MIGRATE!=true). Use golang-migrate como passo explícito do deploy.")
		return nil
	}

	log.Println("[migrate] ⚠️  SURE_LEGACY_AUTO_MIGRATE=true — rodando bloco legado. NÃO use isso em produção.")
	release, err := acquireMigrateLock(DB_App, 30)
	if err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	defer release()
	return runLegacyMigrationsUnsafe(DB_App)
}

// runLegacyMigrationsUnsafe é o bloco antigo de auto-migrate — CRIA/ALTERA/DROP
// tabelas idempotentemente. Ficou aqui só como escape hatch pra devs locais
// (SURE_LEGACY_AUTO_MIGRATE=true). Não deve ser chamado em produção.
//
// TODO: substituir todo esse blob por arquivos .sql versionados em migrations/
// consumidos por golang-migrate. Este arquivo pode então ser deletado.
func runLegacyMigrationsUnsafe(db *sql.DB) error {
	_ = strings.ToLower // mantém import strings vivo (era usado nas migrações 1-5 desligadas)
	log.Println("[migrate] V2: migrações de schema legado (suspenso/sub_etapa) desabilitadas — schema PROD já em V2")

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

	// 6c) AI_CHAT_FEEDBACK removida (feature de feedback do chat descontinuada).

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

	// 7-9) DM_PRAZOS_KANBAN, DM_PRAZOS_ETAPA e DM_ALARMES removidas
	// (features de prazos configuráveis e alarmes descontinuadas).

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

	// TODO V2: bloco 11 desabilitado — DM_ETAPAS_PROCESSO renomeada pra DM_ETAPAS e
	// já foi seedeada na migração V2 (etapas 1..6: Reclamação/Contestação/Conciliação/Faturamento/Repasse/Encerramento).
	if false {
		log.Println("[migrate] TODO V2: bloco DM_ETAPAS_PROCESSO desabilitado")

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
			ensureColumn("observacao", "TEXT")
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

	// 14c) Coluna 'referencia' nos itens de devolução do faturamento (Simples/Dobro/Simples e Dobro)
	{
		var hasFatItem int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_FATURAMENTO_ITEM'`,
		).Scan(&hasFatItem)
		if hasFatItem > 0 {
			var colCount int
			_ = db.QueryRow(`
				SELECT COUNT(1)
				FROM INFORMATION_SCHEMA.COLUMNS
				WHERE TABLE_SCHEMA = DATABASE()
				  AND TABLE_NAME='FT_FATURAMENTO_ITEM'
				  AND COLUMN_NAME='referencia'`,
			).Scan(&colCount)
			if colCount == 0 {
				log.Printf("[migrate] Adicionando coluna FT_FATURAMENTO_ITEM.referencia ...")
				_, _ = db.Exec("ALTER TABLE FT_FATURAMENTO_ITEM ADD COLUMN referencia VARCHAR(30) NULL")
			}
		}
	}

	// 14d) Auditoria de edições manuais (ex.: comentário de movimentação editado no histórico)
	{
		_, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS FT_AUDIT_EDICAO (
			  id_audit       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			  entidade       VARCHAR(40)  NOT NULL,
			  id_entidade    INT          NOT NULL,
			  campo          VARCHAR(60)  NOT NULL,
			  valor_anterior TEXT         NULL,
			  valor_novo     TEXT         NULL,
			  observacao     TEXT         NULL,
			  id_usuario     INT          NULL,
			  data_edicao    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
			  PRIMARY KEY (id_audit),
			  KEY idx_audit_entidade (entidade, id_entidade)
			)`)
		if err != nil {
			log.Printf("[migrate] FT_AUDIT_EDICAO: %v", err)
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
			  graph_message_id VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, -- id do Graph diferencia maiúsculas
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

	// 6e) FT_EMAILS_LEITURAS removida (rastreio de leitura de e-mail por usuário descontinuado).
	// 9.1) mail_message_reads (minúscula) removida — leitura de e-mail usa MAIL_MESSAGE_READS.

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

	// 17b) FT_SCORE_TRAINING_LOG removida (log de treino do score descontinuado).

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

	// 17.1) Coluna percentual_repasse em FT_PROCESSOS — percentual MANUAL por processo.
	// Override do percentual da empresa (DM_EMPRESA_PERCENTUAL): quando preenchido, manda
	// no cálculo do repasse SÓ deste processo e NÃO altera o percentual geral da empresa.
	{
		var hasPctCol int
		_ = db.QueryRow(`
			SELECT COUNT(1)
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
			  AND TABLE_NAME='FT_PROCESSOS'
			  AND COLUMN_NAME='percentual_repasse'`,
		).Scan(&hasPctCol)

		if hasPctCol == 0 {
			log.Println("[migrate] Adicionando coluna FT_PROCESSOS.percentual_repasse ...")
			if _, err := db.Exec(`ALTER TABLE FT_PROCESSOS ADD COLUMN percentual_repasse DECIMAL(5,2) NULL`); err != nil {
				log.Printf("[migrate] aviso: falha ao adicionar percentual_repasse (ignorado): %v", err)
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

	// Login (Microsoft + link mágico): colunas DM_USUARIO.ms_oid/ms_email,
	// tabela FT_MAGIC_LINKS e índice único foram MOVIDOS para o auto-migrate
	// aditivo (migrations_additive.go → runAdditiveMigrations), que roda no boot
	// inclusive em produção. Não duplicar aqui.

	log.Println("✅ Todas as migrações concluídas com sucesso")
	return nil
}
