package services

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/models"

	"gopkg.in/gomail.v2"
)

// SendEmail envia um e-mail usando as configuraÃ€Â§Ã€Âµes do .env.
func SendEmail(to, subject, body string) error {
	smtpHost := os.Getenv("SMTP_HOST")
	smtpPortStr := os.Getenv("SMTP_PORT")
	smtpUser := os.Getenv("SMTP_USER")
	smtpPass := os.Getenv("SMTP_PASS")

	if smtpHost == "" || smtpPortStr == "" || smtpUser == "" || smtpPass == "" {
		log.Println("Aviso: ConfiguraÃ€Â§Ã€Âµes de SMTP incompletas. E-mail nÃ£o serÃ¡ enviado.")
		return fmt.Errorf("configuraÃ€Â§Ã€Âµes de SMTP nÃ£o encontradas nas variÃ¡veis de ambiente")
	}

	smtpPort, err := strconv.Atoi(smtpPortStr)
	if err != nil {
		return fmt.Errorf("porta SMTP invÃ¡lida: %v", err)
	}

	m := gomail.NewMessage()
	m.SetHeader("From", smtpUser)
	m.SetHeader("To", to)
	m.SetHeader("Subject", subject)
	m.SetBody("text/html", body)

	d := gomail.NewDialer(smtpHost, smtpPort, smtpUser, smtpPass)

	if err := d.DialAndSend(m); err != nil {
		return err
	}
	return nil
}

// EnviarEmailMovimentacoesDiarias busca as movimentaÃ€Â§Ã€Âµes de processos e envia o relatÃ€Â³rio.
func EnviarEmailMovimentacoesDiarias() {
	log.Println("Executando tarefa: Enviar e-mails de movimentaÃ€Â§Ã£o de processos...")

	// Ã€Å¡Ãšltimas 12h
	periodo := time.Now().Add(-12 * time.Hour)

	query := `
        SELECT
            h.id_movimentacao,
            h.id_requisicao,
            COALESCE(u.nome, 'Sistema') AS nome_usuario,
            COALESCE(h.status_anterior, '') AS status_anterior,
            COALESCE(h.status_novo, '')    AS status_novo,
            COALESCE(h.comentario, '')     AS comentario,
            h.data_movimentacao
        FROM FT_HISTORICO_MOVIMENTACOES h
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        WHERE h.data_movimentacao >= ?
        ORDER BY h.data_movimentacao DESC;
    `

	rows, err := database.DB_App.Query(query, periodo)
	if err != nil {
		log.Printf("Erro ao buscar histÃ€Â³rico de movimentaÃ€Â§Ã€Âµes: %v", err)
		return
	}
	defer rows.Close()

	var movimentacoes []models.HistoricoMovimentacao
	for rows.Next() {
		var hist models.HistoricoMovimentacao
		if err := rows.Scan(
			&hist.ID,
			&hist.RequisicaoID,
			&hist.NomeUsuario,
			&hist.StatusAnterior,
			&hist.StatusNovo,
			&hist.Comentario,
			&hist.DataMovimentacao,
		); err != nil {
			log.Printf("Erro ao escanear movimentaÃ€Â§Ã£o: %v", err)
			continue
		}
		movimentacoes = append(movimentacoes, hist)
	}

	if len(movimentacoes) == 0 {
		log.Println("Nenhuma movimentaÃ€Â§Ã£o de processo nas Ã€ÂºÃšltimas 12 horas.")
		return
	}

	var bodyBuilder strings.Builder
	bodyBuilder.WriteString(`
        <html>
        <body>
            <h1 style="color: #333;">RelatÃ€Â³rio de MovimentaÃ€Â§Ã£o de Processos</h1>
            <p>Resumo das atividades nas Ã€ÂºÃšltimas 12 horas.</p>
            <table style="width: 100%; border-collapse: collapse; font-family: sans-serif;">
                <thead style="background-color: #f2f2f2;">
                    <tr>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Processo ID</th>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Gestor</th>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">MovimentaÃ€Â§Ã£o de Etapa</th>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">ComentÃ¡rio</th>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Data</th>
                    </tr>
                </thead>
                <tbody>`)

	for _, m := range movimentacoes {
		bodyBuilder.WriteString(fmt.Sprintf(
			`<tr>
                <td style="padding: 8px; border: 1px solid #ddd;">%d</td>
                <td style="padding: 8px; border: 1px solid #ddd;">%s</td>
                <td style="padding: 8px; border: 1px solid #ddd;">%s &rarr; %s</td>
                <td style="padding: 8px; border: 1px solid #ddd;">%s</td>
                <td style="padding: 8px; border: 1px solid #ddd;">%s</td>
            </tr>`,
			m.RequisicaoID,
			m.NomeUsuario,
			m.StatusAnterior,
			m.StatusNovo,
			m.Comentario,
			m.DataMovimentacao.Format("02/01/2006 15:04"),
		))
	}

	bodyBuilder.WriteString(`
                </tbody>
            </table>
        </body>
        </html>
    `)

	// Envia para os gestores ativos
	rowsGestores, err := database.DB_App.Query(`
        SELECT email
        FROM DM_USUARIO
        WHERE tipo_conta = 'gestor' AND ativo = 1
    `)
	if err != nil {
		log.Printf("Erro ao buscar e-mails dos gestores: %v", err)
		return
	}
	defer rowsGestores.Close()

	for rowsGestores.Next() {
		var emailGestor string
		if err := rowsGestores.Scan(&emailGestor); err != nil {
			log.Printf("Erro ao escanear e-mail do gestor: %v", err)
			continue
		}
		if emailGestor == "" {
			continue
		}
		if err := SendEmail(emailGestor, "RelatÃ€Â³rio DiÃ¡rio de MovimentaÃ€Â§Ã£o de Processos", bodyBuilder.String()); err != nil {
			log.Printf("Erro ao enviar e-mail para %s: %v", emailGestor, err)
		} else {
			log.Printf("RelatÃ€Â³rio de movimentaÃ€Â§Ã£o enviado para %s", emailGestor)
		}
	}
}

// EnviarInformativoSemanal envia o relatÃ€Â³rio geral da semana (placeholder).
func EnviarInformativoSemanal() {
	log.Println("Executando tarefa: Enviar informativo semanal...")
}

// VerificarPendenciasDeFluxo verifica processos na etapa \"Enviado ao Financeiro\" com dados faltando e cria alertas.
func VerificarPendenciasDeFluxo() {
	log.Println("Executando tarefa: Verificar pendÃ€Âªncias de fluxo...")

	// etapa \"Enviado ao Financeiro\" no seu dicionÃ¡rio de etapas
	var etapaFluxoID int
	err := database.DB_App.QueryRow("SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = 'Enviado ao Financeiro'").Scan(&etapaFluxoID)
	if err != nil {
		log.Printf("Erro ao buscar ID da etapa 'Enviado ao Financeiro': %v", err)
		return
	}

	// Processos nessa etapa que nÃ£o tÃ€Âªm registros em fluxo de ressarcimento ou faturamento
	query := `
        SELECT p.id_processo,\n               p.id_responsavel,\n               TIMESTAMPDIFF(HOUR, NOW(), DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao), INTERVAL COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY)) AS horas_restantes,\n               DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao), INTERVAL COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY) AS deadline_dt\n          FROM FT_PROCESSOS p\n          JOIN DM_ETAPAS_PROCESSO e  ON e.id_etapa_processo = p.id_etapa_processo\n     LEFT JOIN DM_PRAZOS_ETAPA pe    ON pe.id_etapa_processo = e.id_etapa_processo AND pe.sub_etapa IS NULL\n     LEFT JOIN DM_PRAZOS_ETAPA pe_sub ON pe_sub.id_etapa_processo = e.id_etapa_processo AND pe_sub.sub_etapa = p.sub_etapa\n     LEFT JOIN DM_PRAZOS_KANBAN pk   ON pk.id_coluna_kanban = e.id_coluna_kanban\n     LEFT JOIN VW_ULTIMO_HISTORICO vh ON vh.id_requisicao = p.id_processo\n         WHERE COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) IS NOT NULL;
    `
	rows, err := database.DB_App.Query(query)
	if err != nil {
		log.Printf("Erro ao checar prazos de processos: %v", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		var procID int
		var userID sql.NullInt64
		var horas sql.NullInt64
		var deadline sql.NullTime
		if err := rows.Scan(&procID, &userID, &horas, &deadline); err != nil {
			continue
		}
		if !userID.Valid {
			continue
		}
		// SÃ³ alerta se faltar <=24h (0..24) ou jÃ¡ vencido (<0)
		if !horas.Valid {
			continue
		}
		if horas.Int64 > 24 {
			continue
		}

		// Evita duplicar alerta no dia
		var exists int
		_ = database.DB_App.QueryRow(
			"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_processo=? AND DATE(data_criacao)=CURRENT_DATE AND mensagem LIKE ?",
			procID, "%Prazo do processo%",
		).Scan(&exists)
		if exists > 0 {
			continue
		}

		msg := ""
		if horas.Int64 >= 0 {
			msg = fmt.Sprintf("Prazo do processo #%d vence em %d hora(s).", procID, horas.Int64)
		} else {
			msg = fmt.Sprintf("Prazo do processo #%d vencido.", procID)
		}
		if _, err := database.DB_App.Exec(
			"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, ?, ?, 0, 0, NOW(), DATE(?))",
			userID.Int64, procID, msg, deadline.Time,
		); err != nil {
			log.Printf("Erro ao inserir alerta de prazo para processo %d: %v", procID, err)
		}
	}
}

// ChecarPrazosRequisicoes cria alertas quando faltar <= 24h para o prazo de triagem/analise
func ChecarPrazosRequisicoes() {
	log.Println("Executando tarefa: Checar prazos de RequisiÃ§Ãµes (<=24h)...")
	if database.DB_App == nil {
		return
	}
	q := `
        SELECT r.id_requisicao, r.id_usuario,
               TIMESTAMPDIFF(HOUR, NOW(),
                 DATE_ADD(r.data_mudanca_status,
        INTERVAL CASE WHEN s.status = 'Nova RequisiÃ§Ã£o' THEN 5
                                        WHEN s.status IN ('Em AnÃ¡lise','Em Analise') THEN 10
                                        ELSE 0 END DAY)) AS horas_restantes,
               DATE_ADD(r.data_mudanca_status,
        INTERVAL CASE WHEN s.status = 'Nova RequisiÃ§Ã£o' THEN 5
                                        WHEN s.status IN ('Em AnÃ¡lise','Em Analise') THEN 10
                                        ELSE 0 END DAY) AS deadline_dt
          FROM FT_REQUISICOES r
          LEFT JOIN DM_STATUS s ON s.id_status = r.id_status
        WHERE s.status IN ('Nova RequisiÃ§Ã£o','Em AnÃ¡lise','Em Analise')
           AND TIMESTAMPDIFF(HOUR, NOW(),
                 DATE_ADD(r.data_mudanca_status,
        INTERVAL CASE WHEN s.status = 'Nova RequisiÃ§Ã£o' THEN 5
                                        WHEN s.status IN ('Em AnÃ¡lise','Em Analise') THEN 10
                                        ELSE 0 END DAY)) BETWEEN 0 AND 24;
    `
	rows, err := database.DB_App.Query(q)
	if err != nil {
		log.Printf("Erro ao checar prazos de requisiÃ§Ãµes: %v", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var reqID int
		var userID sql.NullInt64
		var horas sql.NullInt64
		var deadline sql.NullTime
		if err := rows.Scan(&reqID, &userID, &horas, &deadline); err != nil {
			continue
		}
		if !userID.Valid || !horas.Valid || !deadline.Valid {
			continue
		}
		var exists int
		_ = database.DB_App.QueryRow(
			"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_processo IS NULL AND id_usuario=? AND DATE(data_criacao)=CURRENT_DATE AND mensagem LIKE ?",
			userID.Int64, fmt.Sprintf("%%Req #%d%%", reqID),
		).Scan(&exists)
		if exists > 0 {
			continue
		}
		msg := fmt.Sprintf("Prazo da triagem/anÃ¡lise da Req #%d vence em %d hora(s).", reqID, horas.Int64)
		if _, err := database.DB_App.Exec(
			"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, NULL, ?, 0, 0, NOW(), DATE(?))",
			userID.Int64, msg, deadline.Time,
		); err != nil {
			log.Printf("Erro ao inserir alerta de prazo para requisição %d: %v", reqID, err)
		}
	}
}

// ChecarPrazosProcessos cria alertas quando faltar <=24h para vencer o prazo do processo
func ChecarPrazosProcessos() {
	log.Println("Executando tarefa: Checar prazos de Processos (<=24h/vencidos)...")
	if database.DB_App == nil {
		return
	}
	query := `
        SELECT p.id_processo,
               p.id_responsavel,
               TIMESTAMPDIFF(HOUR, NOW(), DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao), INTERVAL COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY)) AS horas_restantes,
               DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao), INTERVAL COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY) AS deadline_dt
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e  ON e.id_etapa_processo = p.id_etapa_processo
     LEFT JOIN DM_PRAZOS_ETAPA pe    ON pe.id_etapa_processo = e.id_etapa_processo AND pe.sub_etapa IS NULL
     LEFT JOIN DM_PRAZOS_ETAPA pe_sub ON pe_sub.id_etapa_processo = e.id_etapa_processo AND pe_sub.sub_etapa COLLATE utf8mb4_unicode_ci = p.sub_etapa COLLATE utf8mb4_unicode_ci
     LEFT JOIN DM_PRAZOS_KANBAN pk   ON pk.id_coluna_kanban = e.id_coluna_kanban
     LEFT JOIN VW_ULTIMO_HISTORICO vh ON vh.id_requisicao = p.id_processo
         WHERE COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) IS NOT NULL;
    `
	rows, err := database.DB_App.Query(query)
	if err != nil {
		log.Printf("Erro ao checar prazos de processos: %v", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var procID int
		var userID sql.NullInt64
		var horas sql.NullInt64
		var deadline sql.NullTime
		if err := rows.Scan(&procID, &userID, &horas, &deadline); err != nil {
			continue
		}
		if !userID.Valid || !horas.Valid || !deadline.Valid {
			continue
		}
		if horas.Int64 > 24 {
			continue
		}
		var exists int
		_ = database.DB_App.QueryRow(
			"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_processo=? AND DATE(data_criacao)=CURRENT_DATE AND mensagem LIKE ?",
			procID, "%Prazo do processo%",
		).Scan(&exists)
		if exists > 0 {
			continue
		}
		msg := ""
		if horas.Int64 >= 0 {
			msg = fmt.Sprintf("Prazo do processo #%d vence em %d hora(s).", procID, horas.Int64)
		} else {
			msg = fmt.Sprintf("Prazo do processo #%d vencido.", procID)
		}
		if _, err := database.DB_App.Exec(
			"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, ?, ?, 0, 0, NOW(), DATE(?))",
			userID.Int64, procID, msg, deadline.Time,
		); err != nil {
			log.Printf("Erro ao inserir alerta de prazo para processo %d: %v", procID, err)
		}
	}
}
