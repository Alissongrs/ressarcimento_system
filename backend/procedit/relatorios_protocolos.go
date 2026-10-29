package procedit

// Relatórios da página Protocolos ANEEL (FT_PROTOCOLOS_ANEEL + FT_PROTOCOLO_EVENTOS), pedidos
// pela Luana em 29/10/2026:
//   - protocolos_aneel_lista: a lista da página (todos os protocolos acompanhados, com situação);
//   - conclusoes_aneel: quantos protocolos a ANEEL conclui por dia e o tempo médio até a
//     conclusão, por ano de abertura do processo.
// Entram ANTES do "protocolos_aneel" (processos com mais de N protocolos no histórico), que
// casava qualquer frase com "ANEEL" + "relatório".

import (
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

func init() {
	relatorios = append([]reportDef{
		{
			chave: "conclusoes_aneel",
			// "quantidade concluída na ANEEL por dia e tempo médio para a conclusão dos processos
			// abertos em 2024, 2025 e 2026"
			match: func(n string) bool {
				if !strings.Contains(n, "aneel") || !strings.Contains(n, "conclu") {
					return false
				}
				for _, k := range []string{"por dia", "por mes", "tempo", "media", "medio", "quantidade", "quantos", "quantas", "prazo", "dias"} {
					if strings.Contains(n, k) {
						return true
					}
				}
				return false
			},
			params: func(n string) map[string]string {
				return map[string]string{"anos": strings.Join(anosDoTexto(n), ",")}
			},
			preview: func(p map[string]string) string {
				return "Relatório (somente leitura): protocolos concluídos na ANEEL por dia e por mês, e o tempo médio/típico até a conclusão " +
					"(desde a abertura do protocolo e desde a abertura do processo), " + descAnos(p["anos"]) + " — com o detalhe por protocolo."
			},
			run: func(db *sql.DB, p map[string]string) ([]string, [][]string, string, error) {
				return primeiraAba(abasConclusoesAneel(db, p))
			},
			abas: abasConclusoesAneel,
		},
		{
			chave: "protocolos_aneel_lista",
			// "relatório dos processos que estão em Protocolos ANEEL" / "da página/tela de protocolos"
			// / "todos os protocolos da ANEEL e a situação". Com "mais de N" fica no relatório antigo.
			match: func(n string) bool {
				if !strings.Contains(n, "aneel") || !strings.Contains(n, "protocolo") || reMaisDeN.MatchString(n) {
					return false
				}
				for _, k := range []string{"protocolos aneel", "protocolos da aneel", "protocolo aneel", "pagina", "tela", "aba ",
					"situac", "todos os protocolos", "lista"} {
					if strings.Contains(n, k) {
						return true
					}
				}
				return false
			},
			params: func(n string) map[string]string {
				p := map[string]string{}
				switch {
				case strings.Contains(n, "nao concluid") || strings.Contains(n, "em aberto"):
					p["situacao"] = "abertos"
				case strings.Contains(n, "em analise na aneel"):
					p["situacao"] = "Em análise na ANEEL"
				case strings.Contains(n, "em analise na concessionaria") || strings.Contains(n, "em analise na distribuidora"):
					p["situacao"] = "Em análise na concessionária"
				case strings.Contains(n, "registrad"):
					p["situacao"] = "Registrado na ANEEL"
				case strings.Contains(n, "concluid"):
					p["situacao"] = "Concluída na ANEEL"
				}
				if strings.Contains(n, "sem processo") {
					p["vinculo"] = "sem_processo"
				} else if strings.Contains(n, "a confirmar") {
					p["vinculo"] = "confirmar"
				}
				return p
			},
			preview: func(p map[string]string) string {
				f := "todos os protocolos acompanhados"
				if s := p["situacao"]; s == "abertos" {
					f = "os protocolos ainda não concluídos"
				} else if s != "" {
					f = "os protocolos com situação \"" + s + "\""
				}
				if p["vinculo"] == "sem_processo" {
					f += " sem processo vinculado"
				} else if p["vinculo"] == "confirmar" {
					f += " a confirmar (em mais de um processo)"
				}
				return "Relatório (somente leitura): lista da página Protocolos ANEEL — " + f +
					": protocolo, processo, cliente, concessionária, UC, situação na ANEEL, última mudança, origem, vínculo e responsável, com resumo por situação."
			},
			run: func(db *sql.DB, p map[string]string) ([]string, [][]string, string, error) {
				return primeiraAba(abasProtocolosLista(db, p))
			},
			abas: abasProtocolosLista,
		},
	}, relatorios...)
}

// primeiraAba: o run "de uma tabela" dos relatórios que só têm abas devolve a principal.
func primeiraAba(tabs []Tabela, resumo string, err error) ([]string, [][]string, string, error) {
	if err != nil || len(tabs) == 0 {
		return nil, nil, resumo, err
	}
	t := tabs[len(tabs)-1] // a última aba é a lista/detalhe
	return t.Cols, t.Linhas, resumo, nil
}

// anosDoTexto: anos citados (2024, 2025 e 2026), sem repetir, em ordem. "de 2024 a 2026" → os três.
func anosDoTexto(n string) []string {
	vistos := map[int]bool{}
	anos := []int{}
	for _, m := range reAno4.FindAllStringSubmatch(n, -1) {
		if v, err := strconv.Atoi(m[1]); err == nil && !vistos[v] {
			vistos[v] = true
			anos = append(anos, v)
		}
	}
	sort.Ints(anos)
	if len(anos) == 2 && anos[1]-anos[0] > 1 && (strings.Contains(n, " a ") || strings.Contains(n, " ate ")) {
		for v := anos[0] + 1; v < anos[1]; v++ {
			anos = append(anos, v)
		}
		sort.Ints(anos)
	}
	out := make([]string, len(anos))
	for i, v := range anos {
		out[i] = strconv.Itoa(v)
	}
	return out
}

func descAnos(anos string) string {
	if anos == "" {
		return "processos de qualquer ano"
	}
	l := strings.Split(anos, ",")
	if len(l) == 1 {
		return "processos abertos em " + l[0]
	}
	return "processos abertos em " + strings.Join(l[:len(l)-1], ", ") + " e " + l[len(l)-1]
}

var nomeOrigemProt = map[string]string{"historico": "Histórico do processo", "email": "E-mail da ANEEL", "manual": "Cadastro manual", "site": "Site da ANEEL"}
var nomeVinculoProt = map[string]string{"vinculado": "Vinculado", "confirmar": "A confirmar (em mais de um processo)", "sem_processo": "Sem processo"}

func dataHoraBR(t sql.NullTime) string {
	if !t.Valid {
		return ""
	}
	if t.Time.Hour() == 0 && t.Time.Minute() == 0 && t.Time.Second() == 0 {
		return t.Time.Format("02/01/2006") // vindo do site da ANEEL: só a data
	}
	return t.Time.Format("02/01/2006 15:04")
}

// abasProtocolosLista: a lista da página Protocolos ANEEL (mesmos filtros da tela) + resumo por situação.
func abasProtocolosLista(db *sql.DB, p map[string]string) ([]Tabela, string, error) {
	where := "p.ativo = 1"
	args := []interface{}{}
	switch s := p["situacao"]; s {
	case "":
	case "abertos":
		where += " AND COALESCE(p.situacao,'') <> 'Concluída na ANEEL'"
	default:
		where += " AND p.situacao = ?"
		args = append(args, s)
	}
	if v := p["vinculo"]; v != "" {
		where += " AND p.status_vinculo = ?"
		args = append(args, v)
	}
	rows, err := db.Query(`
SELECT p.protocolo, p.id_processo, COALESCE(NULLIF(pr.codigo_publico,''), ''),
       COALESCE(NULLIF(pr.cliente,''), ''), COALESCE(pr.concessionaria,''), COALESCE(NULLIF(pr.uc_atual,''), pr.uc, ''),
       COALESCE(p.situacao,''), p.ultima_mudanca_em, COALESCE(p.origem,''), COALESCE(p.status_vinculo,''),
       COALESCE(u.nome_usuario,''), p.ultima_verificacao_em
  FROM FT_PROTOCOLOS_ANEEL p
  LEFT JOIN FT_PROCESSOS pr ON pr.id_processo = p.id_processo
  LEFT JOIN DM_USUARIO u ON u.id_usuario = p.id_usuario_responsavel
 WHERE `+where+`
 ORDER BY p.ultima_mudanca_em IS NULL, p.ultima_mudanca_em DESC, p.id DESC`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	lista := Tabela{Nome: "Protocolos ANEEL", Cols: []string{"Protocolo ANEEL", "ID do processo", "Nº do processo", "Cliente",
		"Concessionária", "UC", "Situação na ANEEL", "Última mudança", "Origem", "Vínculo", "Responsável", "Última verificação"}}
	porSit := map[string]int{}
	ordemSit := []string{}
	for rows.Next() {
		var prot, cod, cli, conc, uc, sit, orig, vinc, resp string
		var idp sql.NullInt64
		var mud, verif sql.NullTime
		if err := rows.Scan(&prot, &idp, &cod, &cli, &conc, &uc, &sit, &mud, &orig, &vinc, &resp, &verif); err != nil {
			return nil, "", err
		}
		id := ""
		if idp.Valid {
			id = strconv.FormatInt(idp.Int64, 10)
		}
		if sit == "" {
			sit = "Sem situação"
		}
		if _, ok := porSit[sit]; !ok {
			ordemSit = append(ordemSit, sit)
		}
		porSit[sit]++
		o := nomeOrigemProt[orig]
		if o == "" {
			o = orig
		}
		v := nomeVinculoProt[vinc]
		if v == "" {
			v = vinc
		}
		lista.Linhas = append(lista.Linhas, []string{prot, id, cod, celulaBR(cli), celulaBR(conc), uc, sit,
			dataHoraBR(mud), o, v, resp, dataHoraBR(verif)})
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	sort.SliceStable(ordemSit, func(i, j int) bool { return porSit[ordemSit[i]] > porSit[ordemSit[j]] })
	res := Tabela{Nome: "Resumo por situação", Cols: []string{"Situação na ANEEL", "Protocolos"}}
	for _, s := range ordemSit {
		res.Linhas = append(res.Linhas, []string{s, strconv.Itoa(porSit[s])})
	}
	res.Linhas = append(res.Linhas, []string{"Total", strconv.Itoa(len(lista.Linhas))})
	resumo := fmt.Sprintf("%d protocolo(s) da página Protocolos ANEEL — aba Resumo por situação + aba com a lista completa. "+
		"O andamento completo de cada protocolo está na página (botão Consultar).", len(lista.Linhas))
	return []Tabela{res, lista}, resumo, nil
}

// abasConclusoesAneel: protocolos "Concluída na ANEEL" de processos abertos nos anos pedidos.
// Conclusão = 1º evento "Concluída na ANEEL" (senão a última mudança). Abertura do protocolo =
// e-mail "Registrado na ANEEL"; sem ele (antes de jul/2025), o lançamento no histórico do processo;
// senão o 1º evento. Processo aberto = criação da requisição no SURE.
func abasConclusoesAneel(db *sql.DB, p map[string]string) ([]Tabela, string, error) {
	anos := []int{}
	querAno := map[int]bool{}
	for _, s := range strings.Split(p["anos"], ",") {
		if v, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			anos = append(anos, v)
			querAno[v] = true
		}
	}
	rows, err := db.Query(`
SELECT p.protocolo, p.id_processo, COALESCE(NULLIF(pr.codigo_publico,''), CAST(p.id_processo AS CHAR)),
       COALESCE(NULLIF(pr.cliente,''), ''), COALESCE(pr.concessionaria,''), COALESCE(NULLIF(pr.uc_atual,''), pr.uc, ''),
       COALESCE(r.data_criacao, pr.data_criacao), p.ultima_mudanca_em, h.data_movimentacao,
       ev.reg, ev.primeiro, ev.conc
  FROM FT_PROTOCOLOS_ANEEL p
  JOIN FT_PROCESSOS pr ON pr.id_processo = p.id_processo
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
  LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_historico = p.id_historico_origem
  LEFT JOIN (SELECT protocolo_num,
                    MIN(CASE WHEN situacao_nova = 'Registrado na ANEEL' THEN ocorrido_em END) reg,
                    MIN(ocorrido_em) primeiro,
                    MIN(CASE WHEN situacao_nova = 'Concluída na ANEEL' THEN ocorrido_em END) conc
               FROM FT_PROTOCOLO_EVENTOS GROUP BY protocolo_num) ev ON ev.protocolo_num = p.protocolo_num
 WHERE p.ativo = 1 AND p.situacao = 'Concluída na ANEEL'`)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()

	type item struct {
		prot, id, cod, cli, conc, uc, fonte string
		ano                                 int
		criado, abert, concl                time.Time
		temAbert                            bool
		dProt, dProc                        float64
		okProt, okProc                      bool
	}
	itens := []item{}
	for rows.Next() {
		var it item
		var idp int64
		var criado, mud, hist, reg, prim, conc sql.NullTime
		if err := rows.Scan(&it.prot, &idp, &it.cod, &it.cli, &it.conc, &it.uc, &criado, &mud, &hist, &reg, &prim, &conc); err != nil {
			return nil, "", err
		}
		if !criado.Valid {
			continue
		}
		it.id, it.criado, it.ano = strconv.FormatInt(idp, 10), criado.Time, criado.Time.Year()
		if len(querAno) > 0 && !querAno[it.ano] {
			continue
		}
		switch {
		case conc.Valid:
			it.concl = conc.Time
		case mud.Valid:
			it.concl = mud.Time
		default:
			continue
		}
		switch {
		case reg.Valid:
			it.abert, it.fonte, it.temAbert = reg.Time, "E-mail de registro da ANEEL", true
		case hist.Valid:
			it.abert, it.fonte, it.temAbert = hist.Time, "Histórico do processo", true
		case prim.Valid:
			it.abert, it.fonte, it.temAbert = prim.Time, "Primeiro evento", true
		}
		if it.temAbert && !it.concl.Before(it.abert) {
			it.dProt, it.okProt = it.concl.Sub(it.abert).Hours()/24, true
		}
		if !it.concl.Before(it.criado) {
			it.dProc, it.okProc = it.concl.Sub(it.criado).Hours()/24, true
		}
		itens = append(itens, it)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if len(anos) == 0 {
		vistos := map[int]bool{}
		for _, it := range itens {
			if !vistos[it.ano] {
				vistos[it.ano] = true
				anos = append(anos, it.ano)
			}
		}
		sort.Ints(anos)
	}

	dia := func(t time.Time) string { return t.Format("2006-01-02") }
	um := func(v float64) string { return strings.Replace(strconv.FormatFloat(v, 'f', 1, 64), ".", ",", 1) }
	dois := func(v float64) string { return strings.Replace(strconv.FormatFloat(v, 'f', 2, 64), ".", ",", 1) }
	media := func(v []float64) string {
		if len(v) == 0 {
			return ""
		}
		s := 0.0
		for _, x := range v {
			s += x
		}
		return um(s / float64(len(v)))
	}
	mediana := func(v []float64) string {
		if len(v) == 0 {
			return ""
		}
		c := append([]float64(nil), v...)
		sort.Float64s(c)
		m := len(c) / 2
		if len(c)%2 == 0 {
			return um((c[m-1] + c[m]) / 2)
		}
		return um(c[m])
	}

	// Resumo por ano de abertura do processo (+ total)
	resumo := Tabela{Nome: "Resumo", Cols: []string{"Ano de abertura do processo", "Processos", "Protocolos concluídos na ANEEL",
		"Dias com conclusão", "Média de conclusões por dia (dias com conclusão)", "Média de conclusões por dia útil (da 1ª à última conclusão)",
		"Tempo médio: abertura do protocolo → conclusão (dias)", "Tempo típico (mediana): protocolo → conclusão (dias)",
		"Tempo médio: abertura do processo → conclusão na ANEEL (dias)", "Tempo típico (mediana): processo → conclusão (dias)"}}
	linhaResumo := func(rot string, g []item) []string {
		procs, dias := map[string]bool{}, map[string]bool{}
		var dp, dc []float64
		var ini, fim time.Time
		for _, it := range g {
			procs[it.id] = true
			dias[dia(it.concl)] = true
			if ini.IsZero() || it.concl.Before(ini) {
				ini = it.concl
			}
			if it.concl.After(fim) {
				fim = it.concl
			}
			if it.okProt {
				dp = append(dp, it.dProt)
			}
			if it.okProc {
				dc = append(dc, it.dProc)
			}
		}
		porDia, porUtil := "", ""
		if len(dias) > 0 {
			porDia = dois(float64(len(g)) / float64(len(dias)))
			uteis := 0
			for d := time.Date(ini.Year(), ini.Month(), ini.Day(), 0, 0, 0, 0, time.UTC); !d.After(fim); d = d.AddDate(0, 0, 1) {
				if wd := d.Weekday(); wd != time.Saturday && wd != time.Sunday {
					uteis++
				}
			}
			if uteis > 0 {
				porUtil = dois(float64(len(g)) / float64(uteis))
			}
		}
		return []string{rot, strconv.Itoa(len(procs)), strconv.Itoa(len(g)), strconv.Itoa(len(dias)), porDia, porUtil,
			media(dp), mediana(dp), media(dc), mediana(dc)}
	}
	for _, a := range anos {
		g := []item{}
		for _, it := range itens {
			if it.ano == a {
				g = append(g, it)
			}
		}
		resumo.Linhas = append(resumo.Linhas, linhaResumo(strconv.Itoa(a), g))
	}
	if len(anos) > 1 {
		resumo.Linhas = append(resumo.Linhas, linhaResumo("Total", itens))
	}

	colsAnos := func(base []string) []string {
		for _, a := range anos {
			base = append(base, "Processos de "+strconv.Itoa(a))
		}
		return base
	}
	idxAno := map[int]int{}
	for i, a := range anos {
		idxAno[a] = i
	}

	// Concluídos por dia (mais recente primeiro)
	type cont struct {
		tot    int
		porAno []int
		dp     []float64
	}
	agrupa := func(chave func(time.Time) string) ([]string, map[string]*cont) {
		m := map[string]*cont{}
		for _, it := range itens {
			k := chave(it.concl)
			c := m[k]
			if c == nil {
				c = &cont{porAno: make([]int, len(anos))}
				m[k] = c
			}
			c.tot++
			c.porAno[idxAno[it.ano]]++
			if it.okProt {
				c.dp = append(c.dp, it.dProt)
			}
		}
		ks := make([]string, 0, len(m))
		for k := range m {
			ks = append(ks, k)
		}
		sort.Sort(sort.Reverse(sort.StringSlice(ks)))
		return ks, m
	}
	porDia := Tabela{Nome: "Concluídos por dia", Cols: colsAnos([]string{"Data da conclusão na ANEEL", "Total"})}
	ks, m := agrupa(dia)
	for _, k := range ks {
		l := []string{k[8:10] + "/" + k[5:7] + "/" + k[0:4], strconv.Itoa(m[k].tot)}
		for _, n := range m[k].porAno {
			l = append(l, strconv.Itoa(n))
		}
		porDia.Linhas = append(porDia.Linhas, l)
	}
	porMes := Tabela{Nome: "Concluídos por mês", Cols: append(colsAnos([]string{"Mês da conclusão", "Total"}), "Tempo médio protocolo → conclusão (dias)")}
	ks, m = agrupa(func(t time.Time) string { return t.Format("2006-01") })
	for _, k := range ks {
		l := []string{k[5:7] + "/" + k[0:4], strconv.Itoa(m[k].tot)}
		for _, n := range m[k].porAno {
			l = append(l, strconv.Itoa(n))
		}
		porMes.Linhas = append(porMes.Linhas, append(l, media(m[k].dp)))
	}

	sort.SliceStable(itens, func(i, j int) bool { return itens[i].concl.After(itens[j].concl) })
	det := Tabela{Nome: "Detalhe por protocolo", Cols: []string{"Protocolo ANEEL", "ID do processo", "Nº do processo", "Cliente",
		"Concessionária", "UC", "Processo aberto em", "Ano de abertura", "Protocolo aberto em", "Fonte da abertura",
		"Concluído na ANEEL em", "Dias: protocolo → conclusão", "Dias: processo → conclusão"}}
	for _, it := range itens {
		ab, dp, dc := "", "", ""
		if it.temAbert {
			ab = it.abert.Format("02/01/2006")
		}
		if it.okProt {
			dp = um(it.dProt)
		}
		if it.okProc {
			dc = um(it.dProc)
		}
		det.Linhas = append(det.Linhas, []string{it.prot, it.id, it.cod, celulaBR(it.cli), celulaBR(it.conc), it.uc,
			it.criado.Format("02/01/2006"), strconv.Itoa(it.ano), ab, it.fonte, dataHoraBR(sql.NullTime{Time: it.concl, Valid: true}), dp, dc})
	}

	txt := fmt.Sprintf("%d protocolo(s) concluído(s) na ANEEL — %s. Abas: Resumo (por ano de abertura do processo), "+
		"Concluídos por dia, Concluídos por mês e Detalhe por protocolo. Data da conclusão = 1º aviso \"Concluída\" da ANEEL "+
		"(e-mail ou site; as do site não têm hora). Abertura do protocolo = e-mail \"Registrado na ANEEL\"; nos antigos "+
		"(antes de jul/2025), a data em que o protocolo foi lançado no histórico do processo. Mediana = tempo típico "+
		"(metade levou menos, metade mais).", len(itens), descAnos(p["anos"]))
	return []Tabela{resumo, porDia, porMes, det}, txt, nil
}
