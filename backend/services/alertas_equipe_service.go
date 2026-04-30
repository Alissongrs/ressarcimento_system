package services

import (
	"fmt"
	"log"
	"strings"
	"time"

	"ressarcimento-backend/database"
)

func nomeDiaSemana(d time.Weekday) string {
	nomes := [...]string{"Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"}
	return nomes[d]
}

// ChecarAlertasParaTodos envia e-mail para todos os usuários ativos quando
// um alerta marcado como "para_todos" vence no dia de hoje.
// Deve ser chamado uma vez por dia (ex: 08:00) ou manualmente via endpoint.
func ChecarAlertasParaTodos() {
	checarAlertasParaTodosInternal(false)
}

// DispararAlertasParaTodosForce envia TODOS os alertas para_todos pendentes,
// independente da data. Usado para testes manuais via endpoint admin.
func DispararAlertasParaTodosForce() {
	checarAlertasParaTodosInternal(true)
}

func checarAlertasParaTodosInternal(force bool) {
	db := database.DB_App
	if db == nil {
		log.Println("[alertas_equipe] DB_App não disponível")
		return
	}

	// 1. Busca alertas para_todos pendentes (force ignora filtro de data)
	query := `
		SELECT id_alerta, mensagem, data_alerta
		  FROM FT_ALERTAS
		 WHERE para_todos = 1
		   AND email_enviado_em IS NULL`
	if !force {
		query += `
		   AND DATE(data_alerta) = CURDATE()`
	}
	rows, err := db.Query(query)
	if err != nil {
		log.Printf("[alertas_equipe] erro ao buscar alertas: %v", err)
		return
	}
	defer rows.Close()

	type alertaRow struct {
		ID         int
		Mensagem   string
		DataAlerta time.Time
	}
	var alertas []alertaRow
	for rows.Next() {
		var a alertaRow
		if err := rows.Scan(&a.ID, &a.Mensagem, &a.DataAlerta); err == nil {
			alertas = append(alertas, a)
		}
	}
	if len(alertas) == 0 {
		log.Println("[alertas_equipe] nenhum alerta para_todos vence hoje")
		return
	}

	// 2. Busca e-mails da equipe de ressarcimento (lista fixa)
	emailRows, err := db.Query(`
		SELECT email FROM DM_USUARIOS
		WHERE id_usuario IN (1, 1000, 1001, 1003, 1004)
		  AND email IS NOT NULL AND email != '' AND email LIKE '%@%'
	`)
	if err != nil {
		log.Printf("[alertas_equipe] erro ao buscar e-mails: %v", err)
		return
	}
	defer emailRows.Close()

	var emails []string
	for emailRows.Next() {
		var email string
		if err := emailRows.Scan(&email); err == nil && email != "" {
			emails = append(emails, email)
		}
	}
	if len(emails) == 0 {
		log.Println("[alertas_equipe] nenhum e-mail encontrado")
		return
	}

	// 3. Monta e envia e-mail HTML
	dataStr := time.Now().Format("02/01/2006")
	diaSemana := nomeDiaSemana(time.Now().Weekday())
	subject := fmt.Sprintf("[AMEEnergia] Lembretes da equipe · %s", dataStr)

	var itens strings.Builder
	for i, a := range alertas {
		bg := "#ffffff"
		if i%2 == 1 {
			bg = "#f8fafc"
		}
		fmt.Fprintf(&itens, `
		<tr style="background:%s;">
		  <td style="padding:0;width:4px;background:#3b82f6;">&nbsp;</td>
		  <td style="padding:14px 20px;">
		    <p style="margin:0;font-size:14px;color:#1e293b;line-height:1.5;">%s</p>
		    <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;">Vencimento: %s</p>
		  </td>
		</tr>`, bg, a.Mensagem, a.DataAlerta.Format("02/01/2006"))
	}

	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lembretes da equipe</title></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:40px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

  <!-- Topo colorido -->
  <tr>
    <td style="background:linear-gradient(135deg,#1e3a5f 0%%,#2563eb 100%%);padding:36px 40px 28px;">
      <table width="100%%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <p style="margin:0;font-size:10px;color:#93c5fd;letter-spacing:2px;text-transform:uppercase;font-weight:600;">AMEEnergia · Sistema de Ressarcimento</p>
            <h1 style="margin:10px 0 4px;font-size:24px;color:#ffffff;font-weight:700;letter-spacing:-0.5px;">🔔 Lembretes da equipe</h1>
            <p style="margin:0;font-size:13px;color:#bfdbfe;">%s, %s</p>
          </td>
          <td align="right" valign="top">
            <span style="display:inline-block;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);border-radius:20px;padding:6px 14px;font-size:12px;color:#e0f2fe;font-weight:600;">%d lembrete(s)</span>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Corpo -->
  <tr>
    <td style="padding:32px 40px 24px;">
      <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">
        Olá, equipe! Os lembretes abaixo estão marcados para <strong style="color:#1e293b;">hoje</strong>. Verifiquem no sistema e tomem as ações necessárias.
      </p>

      <!-- Tabela de lembretes -->
      <table width="100%%" cellpadding="0" cellspacing="0" style="border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr style="background:#f1f5f9;">
          <td style="padding:0;width:4px;background:#1e3a5f;">&nbsp;</td>
          <td style="padding:10px 20px;font-size:11px;font-weight:700;color:#64748b;letter-spacing:1px;text-transform:uppercase;">Lembrete</td>
        </tr>
        %s
      </table>

      <!-- Botão CTA -->
      <table width="100%%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
        <tr>
          <td align="center">
            <a href="http://sure.app.br" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:0.3px;">
              Acessar o Sistema →
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Divisor -->
  <tr><td style="padding:0 40px;"><div style="height:1px;background:#e2e8f0;"></div></td></tr>

  <!-- Rodapé -->
  <tr>
    <td style="padding:20px 40px 28px;">
      <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.7;text-align:center;">
        Este e-mail foi gerado automaticamente pelo <strong>Sistema de Ressarcimento</strong> · AMEEnergia.<br>
        Caso tenha dúvidas, entre em contato com o time de TI.
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`, diaSemana, dataStr, len(alertas), itens.String())

	toStr := strings.Join(emails, ",")
	if err := SendEmailDetailed(toStr, "", "", subject, htmlBody); err != nil {
		log.Printf("[alertas_equipe] erro ao enviar e-mail: %v", err)
		return
	}

	// 4. Marca como enviado
	for _, a := range alertas {
		_, _ = db.Exec(
			"UPDATE FT_ALERTAS SET email_enviado_em = NOW() WHERE id_alerta = ?",
			a.ID,
		)
	}
	log.Printf("[alertas_equipe] e-mail enviado para %d destinatários — %d alerta(s)", len(emails), len(alertas))
}

// ChecarAlertasPessoaisHoje envia e-mails para alertas pessoais (para_todos=0)
// que vencem hoje e ainda não receberam o e-mail. Chamado pelo cron diário.
func ChecarAlertasPessoaisHoje() {
	db := database.DB_App
	if db == nil {
		return
	}

	rows, err := db.Query(`
		SELECT a.id_alerta, a.id_usuario, a.mensagem, DATE_FORMAT(a.data_alerta,'%Y-%m-%d')
		  FROM FT_ALERTAS a
		 WHERE a.para_todos = 0
		   AND DATE(a.data_alerta) = CURDATE()
		   AND a.email_enviado_em IS NULL
	`)
	if err != nil {
		log.Printf("[alertas_pessoal] erro ao buscar alertas do dia: %v", err)
		return
	}
	defer rows.Close()

	type pendente struct {
		ID         int64
		UserID     int64
		Mensagem   string
		DataAlerta string
	}
	var lista []pendente
	for rows.Next() {
		var p pendente
		if err := rows.Scan(&p.ID, &p.UserID, &p.Mensagem, &p.DataAlerta); err == nil {
			lista = append(lista, p)
		}
	}
	if len(lista) == 0 {
		log.Println("[alertas_pessoal] nenhum alerta pessoal vence hoje")
		return
	}
	for _, p := range lista {
		EnviarAlertaPessoalComID(p.ID, p.UserID, p.Mensagem, p.DataAlerta)
	}
}

// EnviarAlertaPessoal envia um e-mail de lembrete para o criador do alerta (para_todos=false).
// Usado ao criar o alerta — não atualiza email_enviado_em (disparo imediato, sem id conhecido).
func EnviarAlertaPessoal(userID int64, mensagem, dataAlerta string) {
	EnviarAlertaPessoalComID(0, userID, mensagem, dataAlerta)
}

// EnviarAlertaPessoalComID envia o e-mail e, se alertaID > 0, grava email_enviado_em.
func EnviarAlertaPessoalComID(alertaID int64, userID int64, mensagem, dataAlerta string) {
	db := database.DB_App
	if db == nil {
		return
	}

	var email, nome string
	err := db.QueryRow(
		"SELECT COALESCE(email,''), COALESCE(nome,'') FROM DM_USUARIOS WHERE id_usuario = ?",
		userID,
	).Scan(&email, &nome)
	if err != nil || email == "" || !strings.Contains(email, "@") {
		log.Printf("[alertas_pessoal] e-mail não encontrado para usuário %d", userID)
		return
	}

	dataStr := time.Now().Format("02/01/2006")
	diaSemana := nomeDiaSemana(time.Now().Weekday())

	dataAlertaFormatada := ""
	dataVencimentoBloco := ""
	if t, err := time.Parse("2006-01-02", dataAlerta); err == nil {
		dataAlertaFormatada = t.Format("02/01/2006")
		diasRestantes := int(time.Until(t).Hours() / 24)
		urgenciaLabel := ""
		urgenciaCor := "#2563eb"
		switch {
		case diasRestantes < 0:
			urgenciaLabel = "Vencido"
			urgenciaCor = "#dc2626"
		case diasRestantes == 0:
			urgenciaLabel = "Vence hoje"
			urgenciaCor = "#ea580c"
		case diasRestantes == 1:
			urgenciaLabel = "Vence amanhã"
			urgenciaCor = "#d97706"
		default:
			urgenciaLabel = fmt.Sprintf("Vence em %d dias", diasRestantes)
			urgenciaCor = "#2563eb"
		}
		dataVencimentoBloco = fmt.Sprintf(`
		<table cellpadding="0" cellspacing="0" style="margin-top:16px;">
		  <tr>
		    <td bgcolor="#e2e8f0" style="padding:10px 16px;background:#e2e8f0;border-radius:8px;border:1px solid #cbd5e1;">
		      <span style="font-size:12px;color:#1e3a5f;font-weight:600;">📅 Vencimento: </span>
		      <strong style="font-size:13px;color:#0f172a;">%s</strong>
		      &nbsp;&nbsp;
		      <span style="display:inline-block;background:%s;color:#ffffff;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700;">%s</span>
		    </td>
		  </tr>
		</table>`, dataAlertaFormatada, urgenciaCor, urgenciaLabel)
	}

	primeiroNome := strings.Fields(nome)[0]
	subject := fmt.Sprintf("[AMEnergia] Lembrete criado · %s", dataStr)
	// Paleta:
	//   #0f172a  slate-900       (texto principal escuro)
	//   #1e3a5f  azul marinho    (cabeçalho, faixa de mensagem, botão — fonte branca em cima)
	//   #334155  slate-700       (texto secundário)
	//   #64748b  slate-500       (rótulos sutis)
	//   #cbd5e1  slate-300        (bordas)
	//   #e2e8f0  slate-200        (caixas claras, fundo do vencimento)
	//   #f1f5f9  slate-100        (fundo da página externa)
	//   #ffffff  branco           (apenas na fonte sobre fundos escuros)
	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Seu lembrete</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;color:#0f172a;">
<table width="100%%" cellpadding="0" cellspacing="0" bgcolor="#f1f5f9" style="background:#f1f5f9;padding:40px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background:#ffffff;border:1px solid #cbd5e1;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.10);">

  <!-- Topo: azul marinho sólido com fonte branca (alto contraste) -->
  <tr>
    <td bgcolor="#1e3a5f" style="background:#1e3a5f;padding:36px 40px 28px;">
      <p style="margin:0;font-size:10px;color:#cbd5e1;letter-spacing:2px;text-transform:uppercase;font-weight:600;">AM Energia · Sistema de Ressarcimento</p>
      <h1 style="margin:10px 0 4px;font-size:24px;color:#ffffff;font-weight:700;letter-spacing:-0.5px;">🔔 Lembrete registrado</h1>
      <p style="margin:0;font-size:13px;color:#cbd5e1;">%s, %s</p>
    </td>
  </tr>

  <!-- Faixa de saudação: cinza claro com texto escuro -->
  <tr>
    <td bgcolor="#e2e8f0" style="background:#e2e8f0;padding:20px 40px;border-bottom:1px solid #cbd5e1;">
      <p style="margin:0;font-size:15px;color:#0f172a;">
        Olá, <strong style="color:#1e3a5f;">%s</strong>! 👋 Seu lembrete foi registrado com sucesso no sistema.
      </p>
    </td>
  </tr>

  <!-- Corpo -->
  <tr>
    <td bgcolor="#ffffff" style="background:#ffffff;padding:32px 40px 24px;">
      <p style="margin:0 0 12px;font-size:12px;font-weight:700;color:#1e3a5f;letter-spacing:1px;text-transform:uppercase;">Mensagem do lembrete</p>

      <!-- Card do lembrete: azul marinho com texto branco (alto contraste, destaque máximo) -->
      <table width="100%%" cellpadding="0" cellspacing="0" bgcolor="#1e3a5f" style="background:#1e3a5f;border-radius:10px;overflow:hidden;border:1px solid #1e3a5f;">
        <tr>
          <td bgcolor="#3b82f6" style="width:5px;background:#3b82f6;padding:0;">&nbsp;</td>
          <td bgcolor="#1e3a5f" style="padding:20px 22px;background:#1e3a5f;">
            <p style="margin:0;font-size:15px;color:#ffffff;line-height:1.6;font-style:italic;font-weight:500;">&ldquo;%s&rdquo;</p>
          </td>
        </tr>
      </table>

      %s

      <!-- Botão CTA: azul marinho sólido com fonte branca -->
      <table width="100%%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
        <tr>
          <td align="center">
            <a href="http://app.amenergia.com.br" style="display:inline-block;background:#1e3a5f;color:#ffffff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:0.3px;border:1px solid #1e3a5f;">
              Ver meus lembretes →
            </a>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Divisor -->
  <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:0 40px;"><div style="height:1px;background:#cbd5e1;"></div></td></tr>

  <!-- Rodapé -->
  <tr>
    <td bgcolor="#f1f5f9" style="background:#f1f5f9;padding:20px 40px 28px;">
      <p style="margin:0;font-size:11px;color:#475569;line-height:1.7;text-align:center;">
        Este e-mail foi gerado automaticamente pelo <strong style="color:#1e3a5f;">Sistema de Ressarcimento</strong> · AM Energia.<br>
        Caso tenha dúvidas, entre em contato com o time de TI.
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`, diaSemana, dataStr, primeiroNome, mensagem, dataVencimentoBloco)

	if err := SendEmailDetailed(email, "", "", subject, htmlBody); err != nil {
		log.Printf("[alertas_pessoal] erro ao enviar e-mail para %s: %v", email, err)
		return
	}
	log.Printf("[alertas_pessoal] e-mail enviado para %s (usuário %d)", email, userID)

	// Marca como enviado no banco (apenas quando temos o ID do alerta)
	if alertaID > 0 {
		db := database.DB_App
		if db != nil {
			_, _ = db.Exec("UPDATE FT_ALERTAS SET email_enviado_em = NOW() WHERE id_alerta = ?", alertaID)
		}
	}
}
