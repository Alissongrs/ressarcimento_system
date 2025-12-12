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

		// Índices em FT_HISTORICO_MOVIMENTACOES
		ensureIndex("FT_HISTORICO_MOVIMENTACOES", "idx_historico_data_movimentacao", "data_movimentacao DESC")
		// ensureIndex("FT_HISTORICO_MOVIMENTACOES", "idx_historico_id_processo", "id_processo") // Coluna id_processo não existe

		// Índices em FT_PROCESSOS
		ensureIndex("FT_PROCESSOS", "idx_processos_etapa", "id_etapa_processo")
		// ensureIndex("FT_PROCESSOS", "idx_processos_data_criacao", "data_criacao DESC") // Coluna data_criacao não existe

		// Índices em FT_REQUISICOES
		ensureIndex("FT_REQUISICOES", "idx_requisicoes_data_criacao", "data_criacao DESC")
		ensureIndex("FT_REQUISICOES", "idx_requisicoes_status", "id_status")
		ensureIndex("FT_REQUISICOES", "idx_requisicoes_usuario", "id_usuario")

		// Índices em DM_ALERTAS (se a tabela existir)
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

	log.Println("✓ Todas as migrações concluídas com sucesso")
	return nil
}
