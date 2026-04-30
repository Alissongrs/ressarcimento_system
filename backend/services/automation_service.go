package services

import (
	"bytes"
	"database/sql"
	"fmt"
	"io"
	"log"
	"os"
	"ressarcimento-backend/models"
	"strconv"
	"strings"
	"time"

	"gopkg.in/gomail.v2"
)

// SendEmail envia um e-mail com destinatário simples.
func SendEmail(to, subject, body string) error {
	return SendEmailDetailed(to, "", "", subject, body)
}

// SendEmailDetailed envia e-mail com To/CC/BCC.
func SendEmailDetailed(to, cc, bcc, subject, body string) error {
	return SendEmailDetailedWithAttachments(to, cc, bcc, subject, body, nil)
}

// EmailAttachment representa um anexo (memória).
type EmailAttachment struct {
	Name        string
	ContentType string
	Data        []byte
}

// SendEmailDetailedWithAttachments envia e-mail com anexos.
func SendEmailDetailedWithAttachments(to, cc, bcc, subject, body string, attachments []EmailAttachment) error {
	// Preferir Microsoft Graph se estiver configurado
	if graphEnabled() {
		return sendEmailGraph(to, cc, bcc, subject, body, attachments)
	}
	return sendEmailSMTP(to, cc, bcc, subject, body, attachments)
}

func sendEmailSMTP(to, cc, bcc, subject, body string, attachments []EmailAttachment) error {
	smtpHost := os.Getenv("SMTP_HOST")
	smtpPortStr := os.Getenv("SMTP_PORT")
	smtpUser := os.Getenv("SMTP_USER")
	smtpPass := os.Getenv("SMTP_PASS")

	if smtpHost == "" || smtpPortStr == "" || smtpUser == "" || smtpPass == "" {
		log.Println("Aviso: ConfiguraÃ§ões de SMTP incompletas. E-mail não será enviado.")
		return fmt.Errorf("configuraÃ§ões de SMTP não encontradas nas variáveis de ambiente")
	}

	smtpPort, err := strconv.Atoi(smtpPortStr)
	if err != nil {
		return fmt.Errorf("porta SMTP inválida: %v", err)
	}

	m := gomail.NewMessage()
	m.SetHeader("From", smtpUser)
	m.SetHeader("To", splitEmails(to)...)
	if strings.TrimSpace(cc) != "" {
		m.SetHeader("Cc", splitEmails(cc)...)
	}
	if strings.TrimSpace(bcc) != "" {
		m.SetHeader("Bcc", splitEmails(bcc)...)
	}
	m.SetHeader("Subject", subject)
	m.SetBody("text/html", body)

	for _, a := range attachments {
		if len(a.Data) == 0 || strings.TrimSpace(a.Name) == "" {
			continue
		}
		m.Attach(a.Name, gomail.SetHeader(map[string][]string{
			"Content-Type":              {a.ContentType},
			"Content-Disposition":       {fmt.Sprintf(`attachment; filename="%s"`, a.Name)},
			"Content-Transfer-Encoding": {"base64"},
		}), gomail.SetCopyFunc(func(w io.Writer) error {
			_, err := io.Copy(w, bytes.NewReader(a.Data))
			return err
		}))
	}

	d := gomail.NewDialer(smtpHost, smtpPort, smtpUser, smtpPass)
	return d.DialAndSend(m)
}

func splitEmails(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';'
	})
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		s := strings.TrimSpace(p)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// EnviarEmailMovimentacoesDiarias busca as movimentaÃ§ões de processos e envia o relatório.
func EnviarEmailMovimentacoesDiarias() {
	log.Println("Executando tarefa: Enviar e-mails de movimentaÃ§ão de processos...")

	// Últimas 12h
	periodo := time.Now().Add(-12 * time.Hour)

	query := `
        SELECT
            h.id_historico,
            h.id_requisicao,
            COALESCE(u.nome_usuario, 'Sistema') AS nome_usuario,
            COALESCE(h.status_anterior, '') AS status_anterior,
            COALESCE(h.status_novo, '')    AS status_novo,
            COALESCE(h.comentario, '')     AS comentario,
            h.data_movimentacao
        FROM FT_HISTORICO_MOVIMENTACOES h
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        WHERE h.data_movimentacao >= ?
        ORDER BY h.data_movimentacao DESC;
    `

	rows, err := getAppDB().Query(query, periodo)
	if err != nil {
		log.Printf("Erro ao buscar histórico de movimentaÃ§ões: %v", err)
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
			log.Printf("Erro ao escanear movimentaÃ§ão: %v", err)
			continue
		}
		movimentacoes = append(movimentacoes, hist)
	}

	if len(movimentacoes) == 0 {
		log.Println("Nenhuma movimentaÃ§ão de processo nas últimas 12 horas.")
		return
	}

	var bodyBuilder strings.Builder
	bodyBuilder.WriteString(`
        <html>
        <body>
            <h1 style="color: #333;">Relatório de MovimentaÃ§ão de Processos</h1>
            <p>Resumo das atividades nas últimas 12 horas.</p>
            <table style="width: 100%; border-collapse: collapse; font-family: sans-serif;">
                <thead style="background-color: #f2f2f2;">
                    <tr>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Processo ID</th>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Gestor</th>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">MovimentaÃ§ão de Etapa</th>
                        <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Comentário</th>
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
	rowsGestores, err := getAppDB().Query(`
        SELECT email
        FROM DM_USUARIO
        WHERE perfil = 'gestor' AND ativo = 1
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
		if err := SendEmail(emailGestor, "Relatório Diário de MovimentaÃ§ão de Processos", bodyBuilder.String()); err != nil {
			log.Printf("Erro ao enviar e-mail para %s: %v", emailGestor, err)
		} else {
			log.Printf("Relatório de movimentaÃ§ão enviado para %s", emailGestor)
		}
	}
}

// EnviarInformativoSemanal envia o resumo semanal de processos para todos os gestores ativos.
func EnviarInformativoSemanal() {
	log.Println("Executando tarefa: Enviar informativo semanal...")
	db := getAppDB()
	if db == nil {
		return
	}

	type semanalRow struct {
		Label string
		Valor string
	}
	var metricas []semanalRow

	// Movimentações na semana
	var movSemana int
	_ = db.QueryRow(`SELECT COUNT(1) FROM FT_HISTORICO_MOVIMENTACOES WHERE data_movimentacao >= DATE_SUB(NOW(), INTERVAL 7 DAY)`).Scan(&movSemana)
	metricas = append(metricas, semanalRow{"Movimentações (7 dias)", fmt.Sprintf("%d", movSemana)})

	// Processos deferidos na semana
	var deferidos int
	_ = db.QueryRow(`
		SELECT COUNT(DISTINCT h.id_requisicao)
		  FROM FT_HISTORICO_MOVIMENTACOES h
		 WHERE h.data_movimentacao >= DATE_SUB(NOW(), INTERVAL 7 DAY)
		   AND (LOWER(h.etapa_nova) LIKE '%deferido%' OR LOWER(h.status_novo) LIKE '%deferido%')`).Scan(&deferidos)
	metricas = append(metricas, semanalRow{"Deferidos (7 dias)", fmt.Sprintf("%d", deferidos)})

	// Processos em backlog (sem movimentação há mais de 30 dias)
	var backlog30 int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		  FROM FT_PROCESSOS p
		  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		  LEFT JOIN VW_ULTIMO_HISTORICO vh ON vh.id_requisicao = p.id_processo
		 WHERE p.suspenso = 0
		   AND LOWER(e.etapa) NOT IN ('concluídos','concluidos','indeferidos','rejeitados','suspensos')
		   AND COALESCE(vh.data_movimentacao, p.ultima_atualizacao) < DATE_SUB(NOW(), INTERVAL 30 DAY)`).Scan(&backlog30)
	metricas = append(metricas, semanalRow{"Sem movimentação > 30 dias", fmt.Sprintf("%d", backlog30)})

	// Total de processos ativos
	var ativos int
	_ = db.QueryRow(`
		SELECT COUNT(1)
		  FROM FT_PROCESSOS p
		  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		 WHERE p.suspenso = 0
		   AND LOWER(e.etapa) NOT IN ('concluídos','concluidos','indeferidos','rejeitados','suspensos')`).Scan(&ativos)
	metricas = append(metricas, semanalRow{"Processos ativos", fmt.Sprintf("%d", ativos)})

	// Top-3 distribuidoras por volume de movimentação na semana
	type distribRow struct {
		Nome  string
		Total int
	}
	var distrib []distribRow
	rows, err := db.Query(`
		SELECT COALESCE(r.distribuidora, r.empresa, 'N/A') AS distribuidora, COUNT(*) AS total
		  FROM FT_HISTORICO_MOVIMENTACOES h
		  JOIN FT_REQUISICOES r ON r.id_requisicao = h.id_requisicao
		 WHERE h.data_movimentacao >= DATE_SUB(NOW(), INTERVAL 7 DAY)
		 GROUP BY distribuidora
		 ORDER BY total DESC
		 LIMIT 3`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var d distribRow
			if rows.Scan(&d.Nome, &d.Total) == nil {
				distrib = append(distrib, d)
			}
		}
	}

	// Monta HTML
	dataHoje := time.Now().In(time.FixedZone("BRT", -3*3600)).Format("02/01/2006")
	var b strings.Builder
	b.WriteString(fmt.Sprintf(`<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);">
  <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:28px 32px;">
    <h1 style="margin:0;color:#fff;font-size:22px;">📊 Informativo Semanal SURE</h1>
    <p style="margin:6px 0 0;color:#bfdbfe;font-size:13px;">Semana encerrada em %s</p>
  </div>
  <div style="padding:28px 32px;">
    <h2 style="margin:0 0 16px;color:#1e3a5f;font-size:16px;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">Métricas da Semana</h2>
    <table style="width:100%%;border-collapse:collapse;">`, dataHoje))

	for i, m := range metricas {
		bg := "#fff"
		if i%2 == 0 {
			bg = "#f8fafc"
		}
		b.WriteString(fmt.Sprintf(`
      <tr style="background:%s;">
        <td style="padding:10px 12px;color:#475569;font-size:14px;">%s</td>
        <td style="padding:10px 12px;color:#1e3a5f;font-size:18px;font-weight:700;text-align:right;">%s</td>
      </tr>`, bg, m.Label, m.Valor))
	}

	b.WriteString(`</table>`)

	if len(distrib) > 0 {
		b.WriteString(`<h2 style="margin:24px 0 12px;color:#1e3a5f;font-size:16px;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">Top Distribuidoras (movimentações)</h2>
    <table style="width:100%%;border-collapse:collapse;">`)
		medals := []string{"🥇", "🥈", "🥉"}
		for i, d := range distrib {
			medal := ""
			if i < len(medals) {
				medal = medals[i]
			}
			bg := "#fff"
			if i%2 == 0 {
				bg = "#f8fafc"
			}
			b.WriteString(fmt.Sprintf(`
      <tr style="background:%s;">
        <td style="padding:10px 12px;color:#475569;font-size:14px;">%s %s</td>
        <td style="padding:10px 12px;color:#1e3a5f;font-size:18px;font-weight:700;text-align:right;">%d</td>
      </tr>`, bg, medal, d.Nome, d.Total))
		}
		b.WriteString(`</table>`)
	}

	appURL := strings.TrimSpace(os.Getenv("APP_URL"))
	if appURL == "" {
		appURL = "http://sure.app.br"
	}
	b.WriteString(fmt.Sprintf(`
    <div style="margin-top:28px;text-align:center;">
      <a href="%s" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:700;font-size:14px;">Abrir Sistema SURE</a>
    </div>
  </div>
  <div style="padding:16px 32px;background:#f8fafc;text-align:center;color:#94a3b8;font-size:11px;">
    Este e-mail foi gerado automaticamente pelo sistema SURE.
  </div>
</div></body></html>`, appURL))

	// Envia para todos os gestores ativos
	rowsG, err := db.Query(`SELECT email FROM DM_USUARIO WHERE perfil = 'gestor' AND ativo = 1 AND email IS NOT NULL AND email != ''`)
	if err != nil {
		log.Printf("[InformativoSemanal] erro ao buscar gestores: %v", err)
		return
	}
	defer rowsG.Close()
	assunto := fmt.Sprintf("📊 Informativo Semanal SURE — %s", dataHoje)
	body := b.String()
	for rowsG.Next() {
		var emailGestor string
		if rowsG.Scan(&emailGestor) != nil || emailGestor == "" {
			continue
		}
		if err := SendEmail(emailGestor, assunto, body); err != nil {
			log.Printf("[InformativoSemanal] erro ao enviar para %s: %v", emailGestor, err)
		} else {
			log.Printf("[InformativoSemanal] enviado para %s", emailGestor)
		}
	}
}

// VerificarPendenciasDeFluxo verifica processos na etapa \"Enviado ao Financeiro\" com dados faltando e cria alertas.
func VerificarPendenciasDeFluxo() {
	log.Println("Executando tarefa: Verificar pendências de fluxo...")

	// etapa \"Enviado ao Financeiro\" no seu dicionário de etapas
	var etapaFluxoID int
	err := getAppDB().QueryRow("SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = 'Enviado ao Financeiro'").Scan(&etapaFluxoID)
	if err != nil {
		log.Printf("Erro ao buscar ID da etapa 'Enviado ao Financeiro': %v", err)
		return
	}

	// Processos nessa etapa que não têm registros em fluxo de ressarcimento ou faturamento
	query := `
        SELECT p.id_processo,
               p.id_responsavel,
               TIMESTAMPDIFF(HOUR, NOW(), DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao), INTERVAL COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY)) AS horas_restantes,
               DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao), INTERVAL COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY) AS deadline_dt
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e  ON e.id_etapa_processo = p.id_etapa_processo
     LEFT JOIN DM_PRAZOS_ETAPA pe    ON pe.id_etapa_processo = e.id_etapa_processo AND pe.sub_etapa IS NULL
     LEFT JOIN DM_PRAZOS_ETAPA pe_sub ON pe_sub.id_etapa_processo = e.id_etapa_processo AND pe_sub.sub_etapa = p.sub_etapa
     LEFT JOIN DM_PRAZOS_KANBAN pk   ON pk.id_coluna_kanban = e.id_coluna_kanban
     LEFT JOIN VW_ULTIMO_HISTORICO vh ON vh.id_requisicao = p.id_processo
         WHERE COALESCE(pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) IS NOT NULL;
    `
	rows, err := getAppDB().Query(query)
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
		// Só alerta se faltar <=24h (0..24) ou já vencido (<0)
		if !horas.Valid {
			continue
		}
		if horas.Int64 > 24 {
			continue
		}

		// Não duplica enquanto houver alerta não lido para o mesmo processo
		var exists int
		_ = getAppDB().QueryRow(
			"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_processo=? AND lido=0 AND mensagem LIKE ?",
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
		if _, err := getAppDB().Exec(
			"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, ?, ?, 0, 0, NOW(), DATE(?))",
			userID.Int64, procID, msg, deadline.Time,
		); err != nil {
			log.Printf("Erro ao inserir alerta de prazo para processo %d: %v", procID, err)
		}
	}
}

// ChecarPrazosRequisicoes cria alertas quando faltar <= 24h para o prazo de triagem/analise
func ChecarPrazosRequisicoes() {
	log.Println("Executando tarefa: Checar prazos de Requisições (<=24h)...")
	if getAppDB() == nil {
		return
	}
	q := `
        SELECT r.id_requisicao, r.id_usuario,
               TIMESTAMPDIFF(HOUR, NOW(),
                 DATE_ADD(r.data_mudanca_status,
        INTERVAL CASE WHEN s.status = 'Nova RequisiÃ§ão' THEN 5
                                        WHEN s.status IN ('Em Análise','Em Analise') THEN 10
                                        ELSE 0 END DAY)) AS horas_restantes,
               DATE_ADD(r.data_mudanca_status,
        INTERVAL CASE WHEN s.status = 'Nova RequisiÃ§ão' THEN 5
                                        WHEN s.status IN ('Em Análise','Em Analise') THEN 10
                                        ELSE 0 END DAY) AS deadline_dt
          FROM FT_REQUISICOES r
          LEFT JOIN DM_STATUS s ON s.id_status = r.id_status
        WHERE s.status IN ('Nova RequisiÃ§ão','Em Análise','Em Analise')
           AND TIMESTAMPDIFF(HOUR, NOW(),
                 DATE_ADD(r.data_mudanca_status,
        INTERVAL CASE WHEN s.status = 'Nova RequisiÃ§ão' THEN 5
                                        WHEN s.status IN ('Em Análise','Em Analise') THEN 10
                                        ELSE 0 END DAY)) BETWEEN 0 AND 24;
    `
	rows, err := getAppDB().Query(q)
	if err != nil {
		log.Printf("Erro ao checar prazos de requisiÃ§ões: %v", err)
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
		_ = getAppDB().QueryRow(
			"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_processo IS NULL AND id_usuario=? AND DATE(data_criacao)=CURRENT_DATE AND mensagem LIKE ?",
			userID.Int64, fmt.Sprintf("%%Req #%d%%", reqID),
		).Scan(&exists)
		if exists > 0 {
			continue
		}
		msg := fmt.Sprintf("Prazo da triagem/análise da Req #%d vence em %d hora(s).", reqID, horas.Int64)
		if _, err := getAppDB().Exec(
			"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, NULL, ?, 0, 0, NOW(), DATE(?))",
			userID.Int64, msg, deadline.Time,
		); err != nil {
			log.Printf("Erro ao inserir alerta de prazo para requisiÃ§ão %d: %v", reqID, err)
		}
	}
}

// ChecarPrazosProcessos cria alertas quando faltar <=24h para vencer o prazo do processo
func ChecarPrazosProcessos() {
	log.Println("Executando tarefa: Checar prazos de Processos (<=24h/vencidos)...")
	if getAppDB() == nil {
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
	rows, err := getAppDB().Query(query)
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
		_ = getAppDB().QueryRow(
			"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_processo=? AND lido=0 AND mensagem LIKE ?",
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
		if _, err := getAppDB().Exec(
			"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, ?, ?, 0, 0, NOW(), DATE(?))",
			userID.Int64, procID, msg, deadline.Time,
		); err != nil {
			log.Printf("Erro ao inserir alerta de prazo para processo %d: %v", procID, err)
		}
	}
}
