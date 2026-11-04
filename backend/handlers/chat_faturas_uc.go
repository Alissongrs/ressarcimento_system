package handlers

// Chat da SURE (/chat/processos) — faturas de uma UC no contexto da IA.
// Antes o chat só via PROCESSOS da UC: "preciso das faturas da UC X de agosto e setembro" virava
// "não encontrei faturas" mesmo com as faturas na base. Agora, quando a pergunta cita uma UC (ou
// instalação), entram as faturas de ENERGIA (FATURA_DADOS_EXTRAIDOS, por codigo_uc ou nº de instalação)
// e de ÁGUA (FATURA_AGUA_DADOS) com mês, consumo, total, vencimento e o link do PDF. Só leitura.

import (
	"fmt"
	"regexp"
	"strings"

	"ressarcimento-backend/database"
)

var (
	reInstalacaoNum = regexp.MustCompile(`(?i)instala[cç][aã]o\s*(?:n[ºo°.]*\s*)?(\d{5,12})\b`)
	reFaturaIntent  = regexp.MustCompile(`(?i)\bfatura|\bconta(s)?\s+de\s+(luz|energia|[aá]gua)|\bsegunda\s+via|\b2[ªa]\s+via|\bpdf\b`)
	reNumeroSolto   = regexp.MustCompile(`\b(\d{6,12})\b`)
)

// ucsDaPergunta — UCs/instalações citadas. "UC 123" e "instalação 123" sempre; número solto (6–12
// dígitos) só quando a pergunta fala de fatura (ex.: "fatura 62053589 de agosto").
func ucsDaPergunta(q string) []string {
	vistos := map[string]bool{}
	var out []string
	add := func(s string) {
		if s != "" && !vistos[s] && len(out) < 3 {
			vistos[s] = true
			out = append(out, s)
		}
	}
	for _, m := range reUCNum.FindAllStringSubmatch(strings.ToUpper(q), -1) {
		add(m[1])
	}
	for _, m := range reInstalacaoNum.FindAllStringSubmatch(q, -1) {
		add(m[1])
	}
	if len(out) == 0 && reFaturaIntent.MatchString(q) {
		for _, m := range reNumeroSolto.FindAllStringSubmatch(q, -1) {
			add(m[1])
		}
	}
	return out
}

// fetchFaturasByUC — bloco de contexto com as faturas (energia e água) da UC, mais recentes primeiro.
func fetchFaturasByUC(uc string) string {
	db := database.DB_App
	if db == nil {
		return ""
	}
	var sb strings.Builder

	// energia: o índice (numero_instalacao, codigo_uc) cobre o filtro → pega os ids e depois as linhas
	rows, err := db.Query(`
		SELECT f.id, COALESCE(DATE_FORMAT(f.mes_referencia,'%m/%Y'),''), COALESCE(f.numero_instalacao,''),
		       COALESCE(f.codigo_uc,''), COALESCE(f.distribuidora,''), COALESCE(f.kwh_total,0),
		       COALESCE(f.valor_total_fatura,0), COALESCE(DATE_FORMAT(f.data_vencimento,'%d/%m/%Y'),''),
		       COALESCE(f.link_fatura,'')
		FROM FATURA_DADOS_EXTRAIDOS f
		JOIN (SELECT id FROM FATURA_DADOS_EXTRAIDOS WHERE codigo_uc = ? OR numero_instalacao = ?) x ON x.id = f.id
		ORDER BY f.mes_referencia DESC, f.id DESC
		LIMIT 36`, uc, uc)
	if err == nil {
		n := 0
		for rows.Next() {
			var id int64
			var mes, inst, cuc, dist, venc, link string
			var kwh, total float64
			if rows.Scan(&id, &mes, &inst, &cuc, &dist, &kwh, &total, &venc, &link) != nil {
				continue
			}
			if n == 0 {
				sb.WriteString(fmt.Sprintf("## Faturas de ENERGIA da UC %s (na base do sistema, mais recentes primeiro)\n", uc))
				sb.WriteString("| Mês ref. | Instalação | UC | Distribuidora | Consumo kWh | Total a pagar | Vencimento | Fatura (PDF) |\n|---|---|---|---|---|---|---|---|\n")
			}
			pdf := "sem link"
			if strings.HasPrefix(link, "http") {
				pdf = "[abrir a fatura](" + link + ")"
			}
			sb.WriteString(fmt.Sprintf("| %s | %s | %s | %s | %s | R$ %s | %s | %s |\n",
				mes, inst, cuc, dist, chatFmtNum(kwh), chatFmtBRL(total), venc, pdf))
			n++
		}
		rows.Close()
		if n > 0 {
			sb.WriteString("(Total a pagar R$ 0,00 costuma ser fatura zerada por crédito/compensação — o valor faturado está no PDF.)\n")
		}
	}

	// água: cod_uc (id da UC na origem, indexado) ou o número impresso
	var codUC any = nil
	if len(uc) <= 18 {
		codUC = uc
	}
	rows, err = db.Query(`
		SELECT COALESCE(DATE_FORMAT(mes_referencia,'%m/%Y'),''), COALESCE(uc,''), COALESCE(concessionaria,''),
		       COALESCE(consumo_m3,0), COALESCE(NULLIF(valor_total,0), rs_total_fat, 0), COALESCE(link_fatura,'')
		FROM FATURA_AGUA_DADOS
		WHERE cod_uc = ? OR uc = ?
		ORDER BY mes_referencia DESC
		LIMIT 36`, codUC, uc)
	if err == nil {
		n := 0
		for rows.Next() {
			var mes, nuc, conc, link string
			var m3, total float64
			if rows.Scan(&mes, &nuc, &conc, &m3, &total, &link) != nil {
				continue
			}
			if n == 0 {
				sb.WriteString(fmt.Sprintf("\n## Faturas de ÁGUA da UC %s\n", uc))
				sb.WriteString("| Mês ref. | UC | Concessionária | Consumo m³ | Total | Fatura (PDF) |\n|---|---|---|---|---|---|\n")
			}
			pdf := "sem link"
			if strings.HasPrefix(link, "http") {
				pdf = "[abrir a fatura](" + link + ")"
			}
			sb.WriteString(fmt.Sprintf("| %s | %s | %s | %s | R$ %s | %s |\n", mes, nuc, conc, chatFmtNum(m3), chatFmtBRL(total), pdf))
			n++
		}
		rows.Close()
	}

	if sb.Len() == 0 {
		return fmt.Sprintf("## Faturas da UC %s\nNenhuma fatura desta UC/instalação na base do sistema (energia e água).\n", uc)
	}
	return sb.String()
}

// chatFmtNum — número inteiro com separador de milhar (5590 → 5.590); decimais só se houver.
func chatFmtNum(v float64) string {
	s := chatFmtBRL(v)
	return strings.TrimSuffix(s, ",00")
}
