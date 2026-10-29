package database

import (
	"database/sql"
	"fmt"
	"log"
)

// runAdditiveMigrations aplica, NO BOOT (inclusive em produção), apenas DDL
// ADITIVO e idempotente: CREATE TABLE IF NOT EXISTS, ADD COLUMN (se faltar) e
// CREATE INDEX (se faltar). NUNCA faz DROP / ALTER destrutivo — por isso é
// seguro rodar a cada startup.
//
// Motivo: o deploy não roda `migrate up` automaticamente e o bloco legado fica
// desligado em prod (SURE_LEGACY_AUTO_MIGRATE). Sem isto, toda mudança de schema
// dependeria de alguém rodar o golang-migrate à mão — e não roda. Então as
// mudanças ADITIVAS entram aqui e se aplicam sozinhas no deploy.
//
// COMO ADICIONAR uma mudança futura: acrescente UMA linha abaixo usando os
// helpers (addColumnIfMissing / createTableIfNotExists / createIndexIfMissing).
// Regra de ouro: só ADITIVO. Remoção de coluna/tabela ou mudança de tipo NÃO
// entram aqui — isso vai como migração versionada (golang-migrate) revisada.
func runAdditiveMigrations(db *sql.DB) error {
	if db == nil {
		return fmt.Errorf("db nil")
	}
	// Advisory lock: evita duas instâncias aplicando DDL ao mesmo tempo. Se não
	// conseguir, só pula (não bloqueia o boot) — outra instância está cuidando.
	release, err := acquireMigrateLock(db, 30)
	if err != nil {
		log.Printf("[migrate-aditivo] pulando (lock indisponível): %v", err)
		return nil
	}
	defer release()

	// ── Login: "Entrar com Microsoft" (Entra ID) + link mágico ───────────────
	addColumnIfMissing(db, "DM_USUARIO", "ms_oid", "VARCHAR(64)")
	addColumnIfMissing(db, "DM_USUARIO", "ms_email", "VARCHAR(255)")
	// perfil de quem pediu (o worker aplica a regra de valor do solicitante) — 21/10/2026
	addColumnIfMissing(db, "FT_SOLICITACOES", "perfil_solicitante", "VARCHAR(20)")
	// resultado era TEXT (64 KB): a lista da página Protocolos ANEEL (1.200+ linhas) não cabia.
	// Só alarga (TEXT → MEDIUMTEXT), não mexe em dado; roda uma vez (depois o tipo já é mediumtext).
	var tipoResultado string
	db.QueryRow(`SELECT DATA_TYPE FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'FT_SOLICITACOES' AND COLUMN_NAME = 'resultado'`).Scan(&tipoResultado)
	if tipoResultado == "text" {
		if _, err := db.Exec("ALTER TABLE FT_SOLICITACOES MODIFY resultado MEDIUMTEXT NULL"); err != nil {
			log.Printf("[migrate-aditivo] resultado MEDIUMTEXT: %v", err)
		}
	}
	// Quem entra por link/Microsoft não tem senha: o INSERT grava senha_hash NULL. Em PROD a
	// coluna era NOT NULL → todo usuário NOVO caía em "Erro interno ao entrar" (15/10/2026).
	// MODIFY para NULL é idempotente e não altera dado nenhum.
	if _, err := db.Exec("ALTER TABLE DM_USUARIO MODIFY senha_hash VARCHAR(255) NULL"); err != nil {
		log.Printf("[migrate-aditivo] senha_hash NULL: %v", err)
	}
	createTableIfNotExists(db, "FT_MAGIC_LINKS", `
		CREATE TABLE IF NOT EXISTS FT_MAGIC_LINKS (
		  jti         VARCHAR(64)  NOT NULL,
		  email       VARCHAR(255) NOT NULL,
		  expires_at  DATETIME     NOT NULL,
		  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (jti),
		  KEY idx_magic_expires (expires_at)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	createIndexIfMissing(db, "DM_USUARIO", "uq_dm_usuario_ms_oid",
		"CREATE UNIQUE INDEX uq_dm_usuario_ms_oid ON DM_USUARIO (ms_oid)")

	// ── Conferência visual das faturas de água (PDF × banco) — 26/10/2026 ───
	// Uma linha por apontamento conferido (id = FATURA_APONTAMENTOS_AGUA_AUDITADOS.id).
	createTableIfNotExists(db, "FATURA_AGUA_CONFERENCIA", `
		CREATE TABLE IF NOT EXISTS FATURA_AGUA_CONFERENCIA (
		  id            BIGINT      NOT NULL,
		  veredito      VARCHAR(20) NOT NULL,
		  observacao    TEXT        NULL,
		  consumo_pdf   DECIMAL(14,2) NULL,
		  conferido_por VARCHAR(100) NULL,
		  conferido_em  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	// causa do pico (erro da concessionária, vazamento, troca de hidrômetro, consumo alto medido) e se o valor
	// precisa ser refeito com o m³ da fatura
	addColumnIfMissing(db, "FATURA_AGUA_CONFERENCIA", "causa", "VARCHAR(30) NULL")
	addColumnIfMissing(db, "FATURA_AGUA_CONFERENCIA", "recalcular", "TINYINT(1) NULL")
	// o que a fatura diz sobre vazamento (constatado / alerta do mês / aviso genérico / sem aviso) e o trecho
	addColumnIfMissing(db, "FATURA_AGUA_CONFERENCIA", "evidencia", "VARCHAR(30) NULL")
	addColumnIfMissing(db, "FATURA_AGUA_CONFERENCIA", "texto_aviso", "VARCHAR(255) NULL")

	// ── Rotinas (#rotina no chat) + lembretes com hora — 21/10/2026 ─────────
	// Rotina nasce aguardando aprovação do admin; usuário desligado → desativada (nunca apagada).
	createTableIfNotExists(db, "FT_ROTINAS", `
		CREATE TABLE IF NOT EXISTS FT_ROTINAS (
		  id_rotina       INT          NOT NULL AUTO_INCREMENT,
		  id_usuario      INT          NOT NULL,
		  nome_usuario    VARCHAR(255) NULL,
		  texto_original  TEXT         NULL,
		  op              VARCHAR(40)  NOT NULL,
		  params_json     TEXT         NULL,
		  tipo            VARCHAR(12)  NOT NULL DEFAULT 'recorrente',
		  horarios        VARCHAR(255) NULL,
		  dias            VARCHAR(40)  NULL,
		  resumo          TEXT         NULL,
		  status          VARCHAR(30)  NOT NULL DEFAULT 'aguardando_aprovacao',
		  aprovado_por    INT          NULL,
		  aprovado_em     DATETIME     NULL,
		  desativado_por  INT          NULL,
		  desativado_em   DATETIME     NULL,
		  motivo_status   VARCHAR(255) NULL,
		  ultima_execucao DATETIME     NULL,
		  criado_em       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (id_rotina),
		  KEY idx_rotinas_status (status),
		  KEY idx_rotinas_usuario (id_usuario)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	createTableIfNotExists(db, "FT_ROTINA_EXECUCOES", `
		CREATE TABLE IF NOT EXISTS FT_ROTINA_EXECUCOES (
		  id_execucao   INT          NOT NULL AUTO_INCREMENT,
		  id_rotina     INT          NOT NULL,
		  slot          DATETIME     NOT NULL,
		  iniciado_em   DATETIME     NULL,
		  terminado_em  DATETIME     NULL,
		  status        VARCHAR(20)  NOT NULL DEFAULT 'rodando',
		  resumo        VARCHAR(500) NULL,
		  detalhe_json  MEDIUMTEXT   NULL,
		  desfeito_por  INT          NULL,
		  desfeito_em   DATETIME     NULL,
		  PRIMARY KEY (id_execucao),
		  UNIQUE KEY uq_rotina_slot (id_rotina, slot)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	createTableIfNotExists(db, "FT_ROTINA_EVENTOS", `
		CREATE TABLE IF NOT EXISTS FT_ROTINA_EVENTOS (
		  id               INT          NOT NULL AUTO_INCREMENT,
		  id_rotina        INT          NULL,
		  id_usuario_dono  INT          NOT NULL,
		  id_usuario_ator  INT          NULL,
		  nome_ator        VARCHAR(255) NULL,
		  evento           VARCHAR(30)  NOT NULL,
		  detalhe          VARCHAR(500) NULL,
		  criado_em        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (id),
		  KEY idx_rot_ev_dono (id_usuario_dono),
		  KEY idx_rot_ev_ator (id_usuario_ator)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	// lembrete com hora: o e-mail sai na hora marcada (rotinas.DespacharLembretes), não às 08:05
	addColumnIfMissing(db, "FT_ALERTAS", "hora_alerta", "VARCHAR(5)")
	addColumnIfMissing(db, "FT_ALERTAS", "criado_por", "INT")
	// sininho: o aviso só para de alertar quando a pessoa aperta "Ciente" (quando ela confirmou) — 28/10/2026
	addColumnIfMissing(db, "FT_ALERTAS", "ciente_em", "DATETIME")

	// ── Protocolos ANEEL: acompanhamento a cada 1h + tarefas — 25/10/2026 ───
	// Protocolo citado em mais de um processo fica status_vinculo='confirmar' (admin decide).
	createTableIfNotExists(db, "FT_PROTOCOLOS_ANEEL", `
		CREATE TABLE IF NOT EXISTS FT_PROTOCOLOS_ANEEL (
		  id                     INT          NOT NULL AUTO_INCREMENT,
		  protocolo              VARCHAR(20)  NOT NULL,
		  protocolo_num          VARCHAR(13)  NOT NULL,
		  id_processo            INT          NULL,
		  status_vinculo         VARCHAR(20)  NOT NULL DEFAULT 'vinculado',
		  origem                 VARCHAR(20)  NOT NULL,
		  id_historico_origem    INT          NULL,
		  id_usuario_responsavel INT          NULL,
		  situacao               VARCHAR(255) NULL,
		  ultimo_andamento       TEXT         NULL,
		  ultima_mudanca_em      DATETIME     NULL,
		  ultima_verificacao_em  DATETIME     NULL,
		  ultima_fonte           VARCHAR(20)  NULL,
		  conteudo_hash          VARCHAR(64)  NULL,
		  ativo                  TINYINT      NOT NULL DEFAULT 1,
		  criado_por             INT          NULL,
		  criado_em              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (id),
		  UNIQUE KEY uq_prot_proc (protocolo_num, id_processo),
		  KEY idx_prot_processo (id_processo),
		  KEY idx_prot_ativo (ativo, ultima_verificacao_em)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	createTableIfNotExists(db, "FT_PROTOCOLO_EVENTOS", `
		CREATE TABLE IF NOT EXISTS FT_PROTOCOLO_EVENTOS (
		  id                 INT          NOT NULL AUTO_INCREMENT,
		  protocolo_num      VARCHAR(13)  NOT NULL,
		  fonte              VARCHAR(20)  NOT NULL,
		  situacao_anterior  VARCHAR(255) NULL,
		  situacao_nova      VARCHAR(255) NULL,
		  andamento          TEXT         NULL,
		  id_mail_message    BIGINT       NULL,
		  ocorrido_em        DATETIME     NULL,
		  detectado_em       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (id),
		  KEY idx_prot_ev_num (protocolo_num, detectado_em),
		  UNIQUE KEY uq_prot_ev_mail (protocolo_num, id_mail_message)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	createTableIfNotExists(db, "FT_TAREFAS", `
		CREATE TABLE IF NOT EXISTS FT_TAREFAS (
		  id_tarefa              INT          NOT NULL AUTO_INCREMENT,
		  tipo                   VARCHAR(40)  NOT NULL,
		  titulo                 VARCHAR(255) NOT NULL,
		  descricao              TEXT         NULL,
		  id_processo            INT          NULL,
		  protocolo_num          VARCHAR(13)  NULL,
		  id_evento              INT          NULL,
		  id_usuario_responsavel INT          NULL,
		  direcionado_por        INT          NULL,
		  direcionado_em         DATETIME     NULL,
		  status                 VARCHAR(20)  NOT NULL DEFAULT 'aberta',
		  concluida_em           DATETIME     NULL,
		  comentario_conclusao   TEXT         NULL,
		  criado_em              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (id_tarefa),
		  KEY idx_tarefas_status (status, id_usuario_responsavel),
		  KEY idx_tarefas_processo (id_processo)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	// "Ciente" de quem recebeu a tarefa, dado no Histórico de protocolos do sininho — 29/10/2026
	addColumnIfMissing(db, "FT_TAREFAS", "ciente_em", "DATETIME")

	// regra automática: tipo de mudança do protocolo ANEEL → analista que recebe a tarefa
	createTableIfNotExists(db, "FT_TAREFAS_REGRAS", `
		CREATE TABLE IF NOT EXISTS FT_TAREFAS_REGRAS (
		  chave                  VARCHAR(40) NOT NULL,
		  id_usuario_responsavel INT         NULL,
		  atualizado_por         INT         NULL,
		  atualizado_em          DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		  PRIMARY KEY (chave)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

	// WhatsApp do departamento (QR code): mensagens monitoradas no sistema + grupo que recebe os avisos
	createTableIfNotExists(db, "FT_WHATSAPP_CONFIG", `
		CREATE TABLE IF NOT EXISTS FT_WHATSAPP_CONFIG (
		  chave          VARCHAR(40)  NOT NULL,
		  valor          VARCHAR(255) NULL,
		  atualizado_por INT          NULL,
		  atualizado_em  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		  PRIMARY KEY (chave)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	createTableIfNotExists(db, "FT_WHATSAPP_MENSAGENS", `
		CREATE TABLE IF NOT EXISTS FT_WHATSAPP_MENSAGENS (
		  id                 BIGINT       NOT NULL AUTO_INCREMENT,
		  wa_id              VARCHAR(80)  NULL,
		  chat               VARCHAR(80)  NOT NULL,
		  chat_nome          VARCHAR(255) NULL,
		  grupo              TINYINT(1)   NOT NULL DEFAULT 0,
		  remetente          VARCHAR(40)  NULL,
		  remetente_nome     VARCHAR(255) NULL,
		  de_mim             TINYINT(1)   NOT NULL DEFAULT 0,
		  origem             VARCHAR(20)  NOT NULL DEFAULT 'whatsapp',
		  tipo               VARCHAR(20)  NOT NULL DEFAULT 'texto',
		  texto              TEXT         NULL,
		  enviada_em         DATETIME     NOT NULL,
		  id_usuario_destino INT          NULL,
		  enviado_por        INT          NULL,
		  status_envio       VARCHAR(10)  NOT NULL DEFAULT 'ok',
		  erro               VARCHAR(500) NULL,
		  criado_em          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  PRIMARY KEY (id),
		  UNIQUE KEY uq_wa_id (wa_id),
		  KEY idx_wa_chat (chat, enviada_em),
		  KEY idx_wa_data (enviada_em)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

	// ↑ Próximas mudanças ADITIVAS entram acima desta linha.
	log.Println("[migrate-aditivo] concluído")
	return nil
}

// indexExists diz se um índice nomeado já existe na tabela (schema atual).
// Em caso de erro ao checar, retorna true (não tenta recriar).
func indexExists(db *sql.DB, table, index string) bool {
	var n int
	if err := db.QueryRow(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = ?
		  AND INDEX_NAME = ?`, table, index).Scan(&n); err != nil {
		log.Printf("[migrate-aditivo] aviso: checar índice %s.%s: %v", table, index, err)
		return true
	}
	return n > 0
}

// addColumnIfMissing adiciona uma coluna NULL se ela ainda não existir.
// (reusa columnExists, definido em snapshot.go)
func addColumnIfMissing(db *sql.DB, table, col, colType string) {
	if columnExists(db, table, col) {
		return
	}
	log.Printf("[migrate-aditivo] ADD COLUMN %s.%s %s", table, col, colType)
	if _, err := db.Exec(fmt.Sprintf("ALTER TABLE `%s` ADD COLUMN `%s` %s NULL", table, col, colType)); err != nil {
		log.Printf("[migrate-aditivo] aviso: falha ao adicionar %s.%s: %v", table, col, err)
	}
}

// createTableIfNotExists executa um CREATE TABLE IF NOT EXISTS (idempotente).
func createTableIfNotExists(db *sql.DB, name, ddl string) {
	if _, err := db.Exec(ddl); err != nil {
		log.Printf("[migrate-aditivo] aviso: falha ao criar %s: %v", name, err)
	}
}

// createIndexIfMissing cria um índice só se ele ainda não existir.
func createIndexIfMissing(db *sql.DB, table, index, ddl string) {
	if indexExists(db, table, index) {
		return
	}
	log.Printf("[migrate-aditivo] CREATE INDEX %s ON %s", index, table)
	if _, err := db.Exec(ddl); err != nil {
		log.Printf("[migrate-aditivo] aviso: índice %s não criado: %v", index, err)
	}
}
