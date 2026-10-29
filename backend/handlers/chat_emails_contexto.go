package handlers

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
)

// ─── E-mails no chat de perguntas (SURE) ─────────────────────────────────────
// Perguntas como "quantos e-mails chegaram hoje?", "quais os assuntos?", "a CELESC
// respondeu hoje?", "teve resposta da Fulana ontem?". Monta, para o período pedido, a
// contagem e a lista de e-mails RECEBIDOS e ENVIADOS (FT_EMAILS_PROCESSO — espelho da
// caixa de entrada, inclusive os ainda sem processo), com remetente, assunto, hora e o
// processo/concessionária vinculados. A IA filtra por concessionária/pessoa a partir disso.
//
// Horários: data_envio é gravado em UTC → convertemos para o horário de Brasília (-03:00),
// então "hoje" é o dia de Brasília.

var (
	reEmailIntent = regexp.MustCompile(`(?i)\b(e-?mails?|caixa de entrada|inbox|mensage(m|ns)|assuntos?|respond\w*|respost\w*|retorno|chegou|chegaram|recebid\w*|enviad\w*|remetente)\b`)
	reDataBR      = regexp.MustCompile(`\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b`)
	reEmailAddr   = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
)

// periodoEmails interpreta o período da pergunta (padrão: hoje), no horário de Brasília.
func periodoEmails(q string) (ini, fim time.Time, rotulo string) {
	loc := time.FixedZone("BRT", -3*3600)
	agora := time.Now().In(loc)
	hoje := time.Date(agora.Year(), agora.Month(), agora.Day(), 0, 0, 0, 0, loc)
	ql := strings.ToLower(q)
	switch {
	case strings.Contains(ql, "anteontem"):
		return hoje.AddDate(0, 0, -2), hoje.AddDate(0, 0, -1), "anteontem (" + hoje.AddDate(0, 0, -2).Format("02/01/2006") + ")"
	case strings.Contains(ql, "ontem"):
		return hoje.AddDate(0, 0, -1), hoje, "ontem (" + hoje.AddDate(0, 0, -1).Format("02/01/2006") + ")"
	case strings.Contains(ql, "semana"):
		return hoje.AddDate(0, 0, -6), hoje.AddDate(0, 0, 1), "últimos 7 dias"
	case strings.Contains(ql, "mês") || strings.Contains(ql, "mes "):
		return time.Date(agora.Year(), agora.Month(), 1, 0, 0, 0, 0, loc), hoje.AddDate(0, 0, 1), "este mês"
	}
	if m := reDataBR.FindStringSubmatch(q); m != nil {
		d, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		a := agora.Year()
		if m[3] != "" {
			a, _ = strconv.Atoi(m[3])
			if a < 100 {
				a += 2000
			}
		}
		if d >= 1 && d <= 31 && mo >= 1 && mo <= 12 {
			ini = time.Date(a, time.Month(mo), d, 0, 0, 0, 0, loc)
			return ini, ini.AddDate(0, 0, 1), ini.Format("02/01/2006")
		}
	}
	return hoje, hoje.AddDate(0, 0, 1), "hoje (" + hoje.Format("02/01/2006") + ")"
}

func buildEmailsContext(question string) string {
	db := database.DB_App
	if db == nil {
		return ""
	}
	ini, fim, rotulo := periodoEmails(question)
	// limites em UTC (como está gravado)
	iniUTC, fimUTC := ini.UTC().Format("2006-01-02 15:04:05"), fim.UTC().Format("2006-01-02 15:04:05")

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## E-mails — %s (horário de Brasília)\n", rotulo))

	var rec, env, recSemProc int
	_ = db.QueryRow(`SELECT COALESCE(SUM(tipo='recebido'),0), COALESCE(SUM(tipo='enviado'),0),
	  COALESCE(SUM(tipo='recebido' AND id_processo IS NULL),0)
	  FROM FT_EMAILS_PROCESSO WHERE data_envio >= ? AND data_envio < ?`, iniUTC, fimUTC).Scan(&rec, &env, &recSemProc)
	sb.WriteString(fmt.Sprintf("- Recebidos: **%d** (%d ainda sem processo vinculado) · Enviados pelo SURE: **%d**\n", rec, recSemProc, env))

	filtroEmail := ""
	if m := reEmailAddr.FindString(question); m != "" {
		filtroEmail = strings.ToLower(m)
		sb.WriteString(fmt.Sprintf("- Filtro pedido: e-mails de/para %s\n", filtroEmail))
	}

	listar := func(tipo string, limite int) {
		q := `SELECT DATE_FORMAT(CONVERT_TZ(e.data_envio,'+00:00','-03:00'),'%d/%m %H:%i'),
		  COALESCE(e.de_email,''), COALESCE(e.para_email,''), COALESCE(e.assunto,''),
		  COALESCE(p.codigo_publico,''), COALESCE(p.concessionaria,''), COALESCE(p.uc,''),
		  COALESCE(LEFT(REGEXP_REPLACE(e.corpo,'<[^>]+>',' '),160),'')
		  FROM FT_EMAILS_PROCESSO e LEFT JOIN FT_PROCESSOS p ON p.id_processo = e.id_processo
		  WHERE e.tipo = ? AND e.data_envio >= ? AND e.data_envio < ?`
		args := []interface{}{tipo, iniUTC, fimUTC}
		if filtroEmail != "" {
			q += ` AND (LOWER(e.de_email) LIKE ? OR LOWER(e.para_email) LIKE ?)`
			args = append(args, "%"+filtroEmail+"%", "%"+filtroEmail+"%")
		}
		q += fmt.Sprintf(` ORDER BY e.data_envio DESC LIMIT %d`, limite)
		rows, err := db.Query(q, args...)
		if err != nil {
			return
		}
		defer rows.Close()
		n := 0
		for rows.Next() {
			var quando, de, para, assunto, proc, conc, uc, trecho string
			if rows.Scan(&quando, &de, &para, &assunto, &proc, &conc, &uc, &trecho) != nil {
				continue
			}
			if n == 0 {
				if tipo == "recebido" {
					sb.WriteString("\n### Recebidos (mais recentes primeiro)\n| Quando | De | Assunto | Processo | Concessionária | UC |\n|---|---|---|---|---|---|\n")
				} else {
					sb.WriteString("\n### Enviados pelo SURE\n| Quando | Para | Assunto | Processo | Concessionária |\n|---|---|---|---|---|\n")
				}
			}
			limpa := func(s string) string { return strings.ReplaceAll(strings.Join(strings.Fields(s), " "), "|", "/") }
			if proc == "" {
				proc = "— (sem processo)"
			}
			if tipo == "recebido" {
				sb.WriteString(fmt.Sprintf("| %s | %s | %s | %s | %s | %s |\n", quando, limpa(de), limpa(assunto), proc, limpa(conc), uc))
			} else {
				sb.WriteString(fmt.Sprintf("| %s | %s | %s | %s | %s |\n", quando, limpa(para), limpa(assunto), proc, limpa(conc)))
			}
			n++
		}
	}
	listar("recebido", 60)
	listar("enviado", 25)
	sb.WriteString("\nObs.: a concessionária/UC vem do processo vinculado ao e-mail; para e-mails sem processo, identifique a distribuidora/pessoa pelo remetente (domínio/nome) e pelo assunto.\n")
	return sb.String()
}
