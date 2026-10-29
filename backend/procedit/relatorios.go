package procedit

// Catálogo de RELATÓRIOS (somente leitura) do mix A+B. Igual aos campos editáveis,
// é uma WHITELIST: só relatórios conhecidos e com consulta parametrizada (sem SQL
// livre). Como é SELECT, não altera dado nenhum — é o tipo de operação mais seguro
// de automatizar. O interpretador casa o texto → chave + params; o executor roda
// via RunRelatorio e grava a tabela no resultado da solicitação (que aparece no
// chat de quem pediu).

import (
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type reportDef struct {
	chave   string
	match   func(n string) bool
	params  func(n string) map[string]string
	preview func(p map[string]string) string
	run     func(db *sql.DB, p map[string]string) (colunas []string, linhas [][]string, resumo string, err error)
	// abas (opcional): relatório com VÁRIAS tabelas — cada uma vira uma aba no Excel.
	// Quando definido, o executor usa RunRelatorioAbas e grava uma tabela por "### Nome".
	abas func(db *sql.DB, p map[string]string) (tabelas []Tabela, resumo string, err error)
}

// Tabela = uma aba do relatório (nome ≤ 31 chars no Excel).
type Tabela struct {
	Nome   string
	Cols   []string
	Linhas [][]string
}

var relatorios = []reportDef{
	{
		chave: "processos_ids",
		// Lista de números de processo colada no pedido ("18396 18397 ... traga esses processos
		// e detalhes em excel"). Vem ANTES dos demais: com 2+ números de processo a pessoa quer
		// ESSES processos, não um filtro por cliente/período. Aceita id (18396) ou código
		// público (PR-2019-018396).
		match: func(n string) bool {
			// verbo de movimentação ("mover processos X e Y para repasse") ou de alteração sem
			// palavra de relatório ("atualizar ... processo 18789 para 40000") é COMANDO.
			if strings.Contains(n, "aneel") || reMovVerbo.MatchString(n) ||
				(reCmdVerbo.MatchString(n) && !rePedidoRelat.MatchString(n)) {
				return false
			}
			return len(idsProcessoDoTexto(n)) >= 2
		},
		params: func(n string) map[string]string {
			p := map[string]string{"ids": strings.Join(idsProcessoDoTexto(n), ",")}
			if strings.Contains(n, "historic") || strings.Contains(n, "movimentac") || strings.Contains(n, "aba") {
				p["historico"] = "1" // aba Resumo + uma aba por processo com o histórico
			}
			return p
		},
		preview: func(p map[string]string) string {
			return fmt.Sprintf("Relatório (somente leitura): %d processo(s) informados — nº, UC, cliente, concessionária, irregularidade, etapa, instância, status, criação, ressarcimento estimado e deferimento (data, valor, repasse).",
				len(strings.Split(p["ids"], ",")))
		},
		run:  runProcessosIds,
		abas: abasProcessosIds,
	},
	{
		chave: "protocolos_aneel",
		// "protocolos na ANEEL" — toda movimentação registrada na instância ANEEL (id=3).
		match: func(n string) bool {
			return strings.Contains(n, "aneel") && (strings.Contains(n, "protocolo") || strings.Contains(n, "relatorio"))
		},
		params: func(n string) map[string]string {
			p := map[string]string{"min": "1"}
			if e := etapaDoTexto(n); e != "" {
				p["etapa"] = e
			}
			if m := reMaisDeN.FindStringSubmatch(n); m != nil {
				p["min"] = numeroPT(m[1])
			}
			if m := reMesAno.FindStringSubmatch(n); m != nil {
				mes := m[1]
				if len(mes) == 1 {
					mes = "0" + mes
				}
				p["desde"] = m[2] + "-" + mes + "-01"
			}
			return p
		},
		preview: func(p map[string]string) string {
			d := ""
			if p["desde"] != "" {
				d = " desde " + brMesAno(p["desde"])
			}
			if p["etapa"] != "" {
				d = " na etapa " + nomeEtapa[p["etapa"]] + d
			}
			return fmt.Sprintf("Relatório (somente leitura): cada protocolo ANEEL (nº e data de registro) dos processos%s com mais de %s protocolo(s) ANEEL.", d, p["min"])
		},
		run: runProtocolosAneel,
	},
	{
		chave: "processos_criados",
		// "processos criados/abertos em <período>" — processos REALMENTE criados em
		// FT_PROCESSOS no intervalo (por data_criacao). Opcional: excluir a VTAL (2025).
		match: func(n string) bool {
			if !strings.Contains(n, "processo") {
				return false
			}
			return strings.Contains(n, "criados") || strings.Contains(n, "abertos") ||
				(strings.Contains(n, "relatorio") && (strings.Contains(n, "criado") || strings.Contains(n, "aberto")))
		},
		params: func(n string) map[string]string {
			ini, fim := periodoDoTextoProc(n)
			p := map[string]string{"ini": ini, "fim": fim}
			if semVtalDoTexto(n) {
				p["sem_vtal"] = "1"
			}
			return p
		},
		preview: func(p map[string]string) string {
			sv := ""
			if p["sem_vtal"] == "1" {
				sv = " (excluindo VTAL)"
			}
			return fmt.Sprintf("Relatório (somente leitura): processos criados de %s a %s%s — nº, UC, cliente, concessionária, data, status e ressarcimento estimado, com total.",
				brMesAno(p["ini"]), fimInclBR(p["fim"]), sv)
		},
		run: runProcessosCriados,
	},
	{
		chave: "processos_cliente",
		// "relatório em excel de todos processos da claro que tiveram deferimento em 2026" —
		// lista de processos de UM cliente (nome cadastrado citado na frase, resolvido no run),
		// opcionalmente só os deferidos e/ou de um ano. Mesma regra do assistente do solicitante.
		match: func(n string) bool {
			if !reProcessosPlural.MatchString(n) || strings.Contains(n, "aneel") {
				return false
			}
			return reListaExcel.MatchString(n)
		},
		params: func(n string) map[string]string {
			p := map[string]string{"frase": n}
			if m := reAno4.FindStringSubmatch(n); m != nil {
				p["ano"] = m[1]
			}
			if reDeferido.MatchString(n) {
				p["deferidos"] = "1"
			}
			if reTratativa.MatchString(n) {
				p["tratativa"] = "1"
			}
			return p
		},
		preview: func(p map[string]string) string {
			f := "todos os processos"
			if p["deferidos"] == "1" {
				f = "processos com deferimento"
				if p["ano"] != "" {
					f += " em " + p["ano"]
				}
			} else if p["ano"] != "" {
				f += " criados em " + p["ano"]
			}
			return "Relatório (somente leitura): " + f + " do cliente citado no pedido — nº, UC, cliente, concessionária, irregularidade, etapa, instância, data e valor do deferimento, com total."
		},
		run: runProcessosCliente,
	},
}

var (
	reProcessosPlural = regexp.MustCompile(`\bprocessos\b`)
	reListaExcel      = regexp.MustCompile(`excel|planilha|\blista\b|listar|relatorio|xlsx`)
	reDeferido        = regexp.MustCompile(`defer|procedente|procedencia`)
	// "em tratativa" = ainda não foi para o financeiro e não encerrou (pedido Alloha 21/10)
	reTratativa = regexp.MustCompile(`tratativa|em andamento|nao (foram )?enviad|sem envio|nao foram para o financeiro|em aberto|abertos|pendentes? de envio`) // reAno4 está mais abaixo
)

// clienteNaFrase: o nome de cliente cadastrado (FT_PROCESSOS/FT_REQUISICOES) que aparece na
// frase como palavra inteira — o mais longo vence. "" se nenhum.
func clienteNaFrase(db *sql.DB, frase string) string {
	nome, _ := clienteChaveNaFrase(db, frase)
	return nome
}

// palavras genéricas de razão social — sozinhas não identificam cliente
var stopCliente = map[string]bool{"grupo": true, "fibra": true, "ltda": true, "eireli": true, "brasil": true,
	"energia": true, "servicos": true, "comercio": true, "industria": true, "telecom": true, "holding": true,
	"participacoes": true, "distribuidora": true, "empresa": true, "nacional": true, "filial": true, "matriz": true,
	"processo": true, "processos": true, "relatorio": true, "cliente": true, "planilha": true, "excel": true}

// clienteChaveNaFrase: nome de cliente cadastrado citado na frase + a chave do LIKE.
// 1º o nome inteiro (o mais longo vence); senão uma palavra característica do nome
// (≥4 letras, não genérica — "alloha" acha "GRUPO ALLOHA FIBRA"), e o LIKE usa essa palavra
// p/ pegar todas as variações de razão social do cliente.
func clienteChaveNaFrase(db *sql.DB, frase string) (string, string) {
	rows, err := db.Query(`
SELECT DISTINCT TRIM(COALESCE(NULLIF(p.cliente,''), r.cliente))
  FROM FT_PROCESSOS p
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
 WHERE COALESCE(NULLIF(p.cliente,''), r.cliente) IS NOT NULL`)
	if err != nil {
		return "", ""
	}
	defer rows.Close()
	limpa := regexp.MustCompile(`[^a-z0-9]+`)
	f := " " + limpa.ReplaceAllString(norm(frase), " ") + " "
	melhor, melhorTok, tokNome := "", "", ""
	for rows.Next() {
		var n sql.NullString
		if rows.Scan(&n) != nil || strings.TrimSpace(n.String) == "" {
			continue
		}
		k := strings.TrimSpace(limpa.ReplaceAllString(norm(n.String), " "))
		if len(k) >= 3 && strings.Contains(f, " "+k+" ") && len(k) > len(melhor) {
			melhor = k
		}
		for _, tk := range strings.Fields(k) {
			if len(tk) >= 4 && !stopCliente[tk] && strings.Contains(f, " "+tk+" ") {
				if len(tk) > len(melhorTok) || (len(tk) == len(melhorTok) && len(n.String) < len(tokNome)) {
					melhorTok, tokNome = tk, strings.TrimSpace(n.String)
				}
			}
		}
	}
	if melhor != "" {
		return strings.ToUpper(melhor), melhor
	}
	if melhorTok != "" {
		return tokNome, melhorTok
	}
	return "", ""
}

// runProcessosCliente — "relatório da Alloha": a visão COMPLETA do cliente, igual à planilha
// do controle (VW_RESUMO_MENSAL — uc, requisição, datas de criação/encerramento/protocolo,
// irregularidade, etapa/instância/status, créditos, prazo/backlog, último comentário,
// devolução e faturamento). Filtros opcionais: só deferidos e/ou ano. Para SOLICITANTE o
// mascararSolicitante tira estimativa/repasse/AMEE/faturamento (regra de valor).
func runProcessosCliente(db *sql.DB, p map[string]string) ([]string, [][]string, string, error) {
	cliente, chave := clienteChaveNaFrase(db, p["frase"])
	if cliente == "" {
		return []string{"Mensagem"}, [][]string{}, "Não identifiquei o cliente no pedido — escreva o nome como está no sistema (ex.: CLARO).", nil
	}
	where := "LOWER(v.cliente) LIKE ?"
	args := []interface{}{"%" + chave + "%"}
	filtro := "todos os processos"
	if p["deferidos"] == "1" {
		filtro = "processos com deferimento"
		sub := "SELECT id_processo FROM FT_DEFERIMENTOS WHERE data_procedencia IS NOT NULL"
		if p["ano"] != "" {
			sub += " AND YEAR(data_procedencia) = ?"
			filtro += " em " + p["ano"]
		}
		where += " AND v.id_requisicao IN (" + sub + ")"
		if p["ano"] != "" {
			args = append(args, p["ano"])
		}
	} else if p["ano"] != "" {
		where += " AND YEAR(v.data_criacao) = ?"
		args = append(args, p["ano"])
		filtro += " criados em " + p["ano"]
	}
	if p["tratativa"] == "1" {
		where += " AND v.data_envio_financeiro IS NULL AND v.data_encerramento IS NULL"
		filtro += " em tratativa (ainda não enviados ao financeiro)"
	}
	rows, err := db.Query("SELECT v.* FROM VW_RESUMO_MENSAL v WHERE "+where+" ORDER BY v.id_requisicao", args...)
	if err != nil {
		return nil, nil, "", err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := [][]string{}
	total := 0.0
	iCred := map[string]int{}
	for i, c := range cols {
		iCred[c] = i
	}
	for rows.Next() {
		raw := make([]sql.RawBytes, len(cols))
		ptr := make([]interface{}, len(cols))
		for i := range raw {
			ptr[i] = &raw[i]
		}
		if err := rows.Scan(ptr...); err != nil {
			return nil, nil, "", err
		}
		l := make([]string, len(cols))
		for i, b := range raw {
			l[i] = celulaBR(string(b))
		}
		if i, ok := iCred["total_cliente"]; ok {
			if v, e := strconv.ParseFloat(string(raw[i]), 64); e == nil {
				total += v
			}
		}
		out = append(out, l)
	}
	resumo := fmt.Sprintf("%s — %s: %d processo(s)", cliente, filtro, len(out))
	if total > 0 {
		resumo += fmt.Sprintf(" — total deferido ao cliente R$ %s", brMoeda(total))
	}
	return cols, out, resumo + ".", nil
}

var reDataISOCel = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$`)

// celulaBR: data ISO → dd/mm/aaaa; quebra de linha/pipe → espaço (cabe numa célula markdown).
func celulaBR(s string) string {
	if m := reDataISOCel.FindStringSubmatch(s); m != nil {
		return m[3] + "/" + m[2] + "/" + m[1]
	}
	s = strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ", "_x000D_", " ", "|", "/").Replace(s)
	return strings.TrimSpace(s)
}

var (
	reCodPublico  = regexp.MustCompile(`\bpr-\d{4}-(\d{4,7})\b`)
	reDigitos     = regexp.MustCompile(`\d+`)
	rePedidoRelat = regexp.MustCompile(`relat|excel|planilha|\blista|traga|tragam|traz|detalh|mostr|consult|levant|xlsx`)
)

// idsProcessoDoTexto: números de processo citados (id_processo), sem repetir, na ordem.
// Ignora anos (1990-2099) e números com cara de valor/data (vizinhos de . , / -).
func idsProcessoDoTexto(n string) []string {
	vistos := map[string]bool{}
	out := []string{}
	add := func(s string) {
		s = strings.TrimLeft(s, "0")
		if s == "" || vistos[s] {
			return
		}
		if v, err := strconv.Atoi(s); err == nil && v >= 1990 && v <= 2099 {
			return
		}
		vistos[s] = true
		out = append(out, s)
	}
	for _, m := range reCodPublico.FindAllStringSubmatch(n, -1) {
		add(m[1])
	}
	limpo := reCodPublico.ReplaceAllString(n, " ")
	for _, ix := range reDigitos.FindAllStringIndex(limpo, -1) {
		a, b := ix[0], ix[1]
		if b-a < 4 || b-a > 7 {
			continue
		}
		// vizinho . , / - = parte de valor, data ou CPF/CNPJ → não é nº de processo
		if (a > 0 && strings.ContainsRune(".,/-", rune(limpo[a-1]))) ||
			(b < len(limpo) && strings.ContainsRune(".,/-", rune(limpo[b]))) {
			continue
		}
		add(limpo[a:b])
	}
	return out
}

func runProcessosIds(db *sql.DB, p map[string]string) ([]string, [][]string, string, error) {
	cols := []string{"Nº do Processo", "ID", "UC", "Cliente", "Concessionária", "Irregularidade", "Etapa atual",
		"Instância atual", "Status", "Criado em", "Ressarcimento estimado (R$)",
		"Data do deferimento", "Valor deferido (R$)", "Repasse (R$)"}
	ids := []interface{}{}
	for _, s := range strings.Split(p["ids"], ",") {
		if s = strings.TrimSpace(s); s != "" {
			ids = append(ids, s)
		}
	}
	if len(ids) == 0 {
		return cols, [][]string{}, "Nenhum número de processo no pedido.", nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := db.Query(`
SELECT COALESCE(NULLIF(p.codigo_publico,''), CAST(p.id_processo AS CHAR)), p.id_processo,
       COALESCE(NULLIF(p.uc_atual,''), p.uc, ''),
       COALESCE(NULLIF(p.cliente,''), r.cliente, ''),
       COALESCE(NULLIF(r.concessionaria,''), p.concessionaria, ''),
       COALESCE(p.nome_tipo_irregularidade, ''),
       COALESCE(e.nome, ''), COALESCE(ia.nome, ''), COALESCE(s.nome, ''),
       p.data_criacao, p.ressarcimento_estimado,
       d.data_procedencia,
       CASE WHEN d.data_procedencia IS NOT NULL THEN COALESCE(d.credito_simples,0) + COALESCE(d.credito_dobro,0) END,
       CASE WHEN d.data_procedencia IS NOT NULL THEN COALESCE(d.repasse_simples,0) + COALESCE(d.repasse_dobro,0) END
  FROM FT_PROCESSOS p
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
  LEFT JOIN (SELECT d1.* FROM FT_DEFERIMENTOS d1
              JOIN (SELECT id_processo, MAX(id_deferimento) mx FROM FT_DEFERIMENTOS GROUP BY id_processo) u
                ON u.mx = d1.id_deferimento) d ON d.id_processo = p.id_processo
  LEFT JOIN DM_ETAPAS e ON e.id_etapa = p.id_etapa_atual
  LEFT JOIN DM_INSTANCIAS ia ON ia.id_instancia = p.id_instancia_atual
  LEFT JOIN DM_STATUS_PROCESSO s ON s.id_status = p.id_status_atual
 WHERE p.id_processo IN (`+ph+`)
 ORDER BY p.id_processo`, ids...)
	if err != nil {
		return nil, nil, "", err
	}
	defer rows.Close()
	out := [][]string{}
	achados := map[string]bool{}
	totDef := 0.0
	brl := func(v sql.NullFloat64) string {
		if v.Valid && v.Float64 != 0 {
			return strconv.FormatFloat(v.Float64, 'f', 2, 64)
		}
		return ""
	}
	dt := func(t sql.NullTime) string {
		if t.Valid {
			return t.Time.Format("02/01/2006")
		}
		return ""
	}
	for rows.Next() {
		var cod, uc, cli, conc, irr, etapa, inst, st string
		var id int64
		var criado, dDef sql.NullTime
		var ress, vDef, rep sql.NullFloat64
		if err := rows.Scan(&cod, &id, &uc, &cli, &conc, &irr, &etapa, &inst, &st, &criado, &ress, &dDef, &vDef, &rep); err != nil {
			return nil, nil, "", err
		}
		achados[strconv.FormatInt(id, 10)] = true
		if vDef.Valid {
			totDef += vDef.Float64
		}
		out = append(out, []string{cod, strconv.FormatInt(id, 10), uc, cli, conc, irr, etapa, inst, st,
			dt(criado), brl(ress), dt(dDef), brl(vDef), brl(rep)})
	}
	faltam := []string{}
	for _, v := range ids {
		if !achados[v.(string)] {
			faltam = append(faltam, v.(string))
		}
	}
	resumo := fmt.Sprintf("%d de %d processo(s) encontrados — valor deferido total R$ %s", len(out), len(ids), brMoeda(totDef))
	if len(faltam) > 0 {
		resumo += " — não encontrados: " + strings.Join(faltam, ", ")
	}
	return cols, out, resumo + ".", nil
}

// brMoeda: 6187930.24 → "6.187.930,24".
func brMoeda(v float64) string {
	s := strconv.FormatFloat(v, 'f', 2, 64)
	inteiro, dec := s[:len(s)-3], s[len(s)-2:]
	var b strings.Builder
	for i, ch := range inteiro {
		if i > 0 && (len(inteiro)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(ch)
	}
	return b.String() + "," + dec
}

func interpretarRelatorio(n string) (string, map[string]string, bool) {
	for _, r := range relatorios {
		if r.match(n) {
			return r.chave, r.params(n), true
		}
	}
	return "", nil, false
}

func relatorioByChave(ch string) *reportDef {
	for i := range relatorios {
		if relatorios[i].chave == ch {
			return &relatorios[i]
		}
	}
	return nil
}

// PreviewRelatorio devolve a descrição legível (p/ o chat confirmar antes).
func PreviewRelatorio(ch string, p map[string]string) string {
	if r := relatorioByChave(ch); r != nil {
		return r.preview(p)
	}
	return "Relatório"
}

// RunRelatorio executa o relatório (somente leitura). Usado pelo executor.
// Devolve colunas + linhas (tudo string) + um resumo de uma linha.
func RunRelatorio(db *sql.DB, ch string, p map[string]string) ([]string, [][]string, string, error) {
	r := relatorioByChave(ch)
	if r == nil {
		return nil, nil, "", fmt.Errorf("relatório desconhecido: %q", ch)
	}
	cols, rows, resumo, err := r.run(db, p)
	if err == nil && p["perfil"] == "solicitante" {
		tabs, res := mascararSolicitante([]Tabela{{Cols: cols, Linhas: rows}}, resumo)
		return tabs[0].Cols, tabs[0].Linhas, res, nil
	}
	return cols, rows, resumo, err
}

// RunRelatorioAbas: como RunRelatorio, mas devolve as abas (1 tabela quando o relatório
// não tem abas, ou quando a aba não se aplica aos params — ex.: processos sem "histórico").
func RunRelatorioAbas(db *sql.DB, ch string, p map[string]string) ([]Tabela, string, error) {
	r := relatorioByChave(ch)
	if r == nil {
		return nil, "", fmt.Errorf("relatório desconhecido: %q", ch)
	}
	if r.abas != nil {
		if tabs, resumo, err := r.abas(db, p); err != nil || tabs != nil {
			if err == nil && p["perfil"] == "solicitante" {
				tabs, resumo = mascararSolicitante(tabs, resumo)
			}
			return tabs, resumo, err
		}
	}
	cols, rows, resumo, err := RunRelatorio(db, ch, p) // já mascara p/ solicitante
	if err != nil {
		return nil, "", err
	}
	return []Tabela{{Nome: "Relatório", Cols: cols, Linhas: rows}}, resumo, nil
}

var (
	reMaisDeN = regexp.MustCompile(`mais de (\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)`)
	reMesAno  = regexp.MustCompile(`(\d{1,2})[/-](\d{4})`)
)

func numeroPT(s string) string {
	m := map[string]string{"um": "1", "uma": "1", "dois": "2", "duas": "2", "tres": "3",
		"quatro": "4", "cinco": "5", "seis": "6", "sete": "7", "oito": "8", "nove": "9", "dez": "10"}
	if v, ok := m[s]; ok {
		return v
	}
	return s
}

func brMesAno(iso string) string { // 2026-06-01 -> 06/2026
	if len(iso) >= 7 {
		return iso[5:7] + "/" + iso[0:4]
	}
	return iso
}

// reProtAneel: número de protocolo da ANEEL como a equipe registra no histórico
// (010.622.04226-00, às vezes sem pontos: 0104991922467). Protocolos de Ouvidoria/
// distribuidora têm outros formatos e NÃO entram.
var reProtAneel = regexp.MustCompile(`(?:^|[^\d.])(010[.\s]?\d{3}[.\s]?\d{5}-?\d{1,2})(?:[^\d]|$)`)

var reNaoDigito = regexp.MustCompile(`\D`)

// etapaDoTexto: "na etapa Contestação" → id da etapa (DM_ETAPAS). 0 = sem filtro.
func etapaDoTexto(n string) string {
	for _, e := range []struct{ k, id string }{{"contestac", "2"}, {"conciliac", "3"}, {"reclamac", "1"},
		{"faturamento", "4"}, {"repasse", "5"}, {"encerramento", "6"}} {
		if strings.Contains(n, "etapa "+e.k) || strings.Contains(n, "etapa de "+e.k) ||
			strings.Contains(n, "etapa da "+e.k) || strings.Contains(n, "em "+e.k) ||
			strings.Contains(n, "na "+e.k) || strings.Contains(n, "de "+e.k) {
			return e.id
		}
	}
	return ""
}

var nomeEtapa = map[string]string{"1": "Reclamação", "2": "Contestação", "3": "Conciliação",
	"4": "Faturamento", "5": "Repasse", "6": "Encerramento"}

// runProtocolosAneel lista CADA protocolo ANEEL (uma linha por protocolo, com a data em
// que foi registrado no SURE) dos processos com mais de `min` protocolos distintos.
// Filtros opcionais: etapa atual do processo e registro a partir de `desde`.
func runProtocolosAneel(db *sql.DB, p map[string]string) ([]string, [][]string, string, error) {
	minN, err := strconv.Atoi(p["min"])
	if err != nil || minN < 0 {
		minN = 1
	}
	desde, etapa := p["desde"], p["etapa"]

	where := "h.comentario REGEXP '010[ .]?[0-9]{3}'"
	args := []interface{}{}
	if etapa != "" {
		where += " AND p.id_etapa_atual = ?"
		args = append(args, etapa)
	}
	q := "SELECT p.id_processo, COALESCE(NULLIF(p.uc_atual,''), p.uc, ''), COALESCE(p.codigo_publico,''), " +
		"COALESCE(p.cliente,''), h.data_movimentacao, h.comentario " +
		"FROM FT_HISTORICO_MOVIMENTACOES h JOIN FT_PROCESSOS p ON p.id_processo = h.id_processo " +
		"WHERE " + where + " ORDER BY p.id_processo, h.data_movimentacao"
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, nil, "", err
	}
	defer rows.Close()

	type prot struct{ num, data string }
	type proc struct {
		id           int
		uc, cod, cli string
		vistos       map[string]bool
		prots        []prot
	}
	ordem := []*proc{}
	por := map[int]*proc{}
	for rows.Next() {
		var id int
		var uc, cod, cli, com string
		var dt sql.NullTime
		if err := rows.Scan(&id, &uc, &cod, &cli, &dt, &com); err != nil {
			return nil, nil, "", err
		}
		for _, m := range reProtAneel.FindAllStringSubmatch(com, -1) {
			num := strings.TrimSpace(m[1])
			chave := reNaoDigito.ReplaceAllString(num, "")
			pr := por[id]
			if pr == nil {
				pr = &proc{id: id, uc: uc, cod: cod, cli: cli, vistos: map[string]bool{}}
				por[id] = pr
				ordem = append(ordem, pr)
			}
			if pr.vistos[chave] {
				continue
			}
			pr.vistos[chave] = true
			data := ""
			if dt.Valid {
				if desde != "" && dt.Time.Format("2006-01-02") < desde {
					continue
				}
				data = dt.Time.Format("02/01/2006")
			}
			pr.prots = append(pr.prots, prot{num, data})
		}
	}
	out := [][]string{}
	nProc := 0
	for _, pr := range ordem {
		if len(pr.prots) <= minN {
			continue
		}
		nProc++
		cod := pr.cod
		if cod == "" {
			cod = strconv.Itoa(pr.id)
		}
		for _, x := range pr.prots {
			out = append(out, []string{pr.uc, cod, pr.cli, x.num, x.data})
		}
	}
	filtro := ""
	if etapa != "" {
		filtro += " na etapa " + nomeEtapa[etapa]
	}
	if desde != "" {
		filtro += " (protocolos desde " + brMesAno(desde) + ")"
	}
	resumo := fmt.Sprintf("%d processo(s)%s com mais de %d protocolo(s) ANEEL — %d protocolos, um por linha. "+
		"Protocolo ANEEL = nº no formato 010.xxx.xxxxx-xx registrado no histórico; Ouvidoria/distribuidora não entram. "+
		"Data = registro no SURE.", nProc, filtro, minN, len(out))
	return []string{"UC", "Nº do Processo", "Cliente", "Protocolo ANEEL", "Data do registro"}, out, resumo, nil
}

// ---------- Relatório: processos criados no período ----------

var (
	reAno4     = regexp.MustCompile(`\b(20\d{2})\b`)
	reMesNome  = regexp.MustCompile(`\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*`)
	reMesBarra = regexp.MustCompile(`\b(\d{1,2})[/-](\d{4})\b`)
)

var mesNumPT = map[string]int{"jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6,
	"jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12}

// semVtalDoTexto: "sem vtal", "tirando vtal", "excluindo vtal", "fora a vtal".
func semVtalDoTexto(n string) bool {
	if !strings.Contains(n, "vtal") {
		return false
	}
	return strings.Contains(n, "sem vtal") || strings.Contains(n, "sem a vtal") ||
		strings.Contains(n, "tirando") || strings.Contains(n, "exclu") || strings.Contains(n, "fora")
}

// periodoDoTextoProc extrai [ini, fim) ISO a partir de nomes de mês e/ou MM/AAAA.
// Sem mês → ano inteiro. Sem ano → ano corrente.
func periodoDoTextoProc(n string) (string, string) {
	ano := time.Now().Year()
	if m := reAno4.FindString(n); m != "" {
		if v, err := strconv.Atoi(m); err == nil {
			ano = v
		}
	}
	meses := map[int]bool{}
	for _, m := range reMesNome.FindAllStringSubmatch(n, -1) {
		if num, ok := mesNumPT[m[1]]; ok {
			meses[num] = true
		}
	}
	for _, m := range reMesBarra.FindAllStringSubmatch(n, -1) {
		if v, err := strconv.Atoi(m[1]); err == nil && v >= 1 && v <= 12 {
			meses[v] = true
			if y, e := strconv.Atoi(m[2]); e == nil {
				ano = y
			}
		}
	}
	if len(meses) == 0 {
		return fmt.Sprintf("%04d-01-01", ano), fmt.Sprintf("%04d-01-01", ano+1)
	}
	mn, mx := 13, 0
	for k := range meses {
		if k < mn {
			mn = k
		}
		if k > mx {
			mx = k
		}
	}
	ini := fmt.Sprintf("%04d-%02d-01", ano, mn)
	fy, fm := ano, mx+1
	if fm > 12 {
		fm = 1
		fy++
	}
	return ini, fmt.Sprintf("%04d-%02d-01", fy, fm)
}

// fimInclBR: fim é exclusivo (dia 01) → mostra o último mês INCLUÍDO em MM/AAAA.
func fimInclBR(fimISO string) string {
	if len(fimISO) >= 7 {
		y, _ := strconv.Atoi(fimISO[0:4])
		m, _ := strconv.Atoi(fimISO[5:7])
		m--
		if m < 1 {
			m = 12
			y--
		}
		return fmt.Sprintf("%02d/%04d", m, y)
	}
	return fimISO
}

// fmtMoneyBR: 1234.5 -> "1.234,50".
func fmtMoneyBR(v float64) string {
	s := strconv.FormatFloat(v, 'f', 2, 64)
	intp, frac := s, "00"
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intp, frac = s[:i], s[i+1:]
	}
	neg := strings.HasPrefix(intp, "-")
	if neg {
		intp = intp[1:]
	}
	var b strings.Builder
	for i, c := range intp {
		if i > 0 && (len(intp)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	res := b.String() + "," + frac
	if neg {
		res = "-" + res
	}
	return res
}

// runProcessosCriados lista os processos criados em [ini, fim), ordenados por valor.
// Filtro opcional sem_vtal exclui cod_empresa=2025.
func runProcessosCriados(db *sql.DB, p map[string]string) ([]string, [][]string, string, error) {
	ini, fim := p["ini"], p["fim"]
	if ini == "" || fim == "" {
		return nil, nil, "", fmt.Errorf("período inválido")
	}
	where := "p.data_criacao >= ? AND p.data_criacao < ?"
	args := []interface{}{ini, fim}
	if p["sem_vtal"] == "1" {
		where += " AND COALESCE(p.cod_empresa,0) <> 2025"
	}
	q := "SELECT COALESCE(NULLIF(p.codigo_publico,''), CAST(p.id_processo AS CHAR)), " +
		"COALESCE(NULLIF(p.uc_atual,''), p.uc, ''), COALESCE(p.cliente,''), COALESCE(p.concessionaria,''), " +
		"DATE_FORMAT(p.data_criacao,'%d/%m/%Y'), COALESCE(s.nome,''), ROUND(COALESCE(p.ressarcimento_estimado,0),2) " +
		"FROM FT_PROCESSOS p LEFT JOIN DM_STATUS_PROCESSO s ON s.id_status = p.id_status_atual " +
		"WHERE " + where + " ORDER BY p.ressarcimento_estimado DESC"
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, nil, "", err
	}
	defer rows.Close()

	out := [][]string{}
	var total float64
	for rows.Next() {
		var cod, uc, cli, conc, dt, st string
		var est float64
		if err := rows.Scan(&cod, &uc, &cli, &conc, &dt, &st, &est); err != nil {
			return nil, nil, "", err
		}
		total += est
		out = append(out, []string{cod, uc, cli, conc, dt, st, fmtMoneyBR(est)})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, "", err
	}
	sv := ""
	if p["sem_vtal"] == "1" {
		sv = " (excluindo VTAL)"
	}
	resumo := fmt.Sprintf("%d processo(s) criado(s) de %s a %s%s — total estimado R$ %s. "+
		"\"Virou processo\" real do período = processos abertos em FT_PROCESSOS por data de criação "+
		"(difere do balde por UC da cohort).", len(out), brMesAno(ini), fimInclBR(fim), sv, fmtMoneyBR(total))
	return []string{"Nº do Processo", "UC", "Cliente", "Concessionária", "Data criação", "Status", "Ressarcimento est. (R$)"},
		out, resumo, nil
}

// ---------- Processos informados + HISTÓRICO (uma aba por processo) ----------

// reProtHist: nº de protocolo citado no comentário do histórico ("Protocolo: 2026001061",
// "Protocolo 20248117056895", ANEEL "010.641.39426-57").
var reProtHist = regexp.MustCompile(`(?i)protocolo[\s:nº°.#-]*([0-9][0-9.\-/]{4,}[0-9])`)

func protocoloDoComentario(com string) string {
	if m := reProtAneel.FindStringSubmatch(com); m != nil {
		return strings.TrimSpace(m[1])
	}
	if m := reProtHist.FindStringSubmatch(com); m != nil {
		return strings.TrimSpace(m[1])
	}
	return ""
}

// abasProcessosIds: com "histórico" no pedido → aba Resumo (1 linha por processo, com data de
// criação e o 1º/último protocolo do histórico) + 1 aba por processo com todas as movimentações.
// Sem "histórico" devolve nil (usa a tabela única de runProcessosIds).
func abasProcessosIds(db *sql.DB, p map[string]string) ([]Tabela, string, error) {
	if p["historico"] != "1" {
		return nil, "", nil
	}
	ids := []interface{}{}
	for _, s := range strings.Split(p["ids"], ",") {
		if s = strings.TrimSpace(s); s != "" {
			ids = append(ids, s)
		}
	}
	if len(ids) == 0 {
		return []Tabela{}, "Nenhum número de processo no pedido.", nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")

	type proc struct {
		cod, uc, cli, conc, etapa, inst, st string
		id                                  int64
		criado                              sql.NullTime
	}
	ordem := []int64{}
	procs := map[int64]*proc{}
	rows, err := db.Query(`
SELECT p.id_processo, COALESCE(NULLIF(p.codigo_publico,''), CAST(p.id_processo AS CHAR)),
       COALESCE(NULLIF(p.uc_atual,''), p.uc, ''), COALESCE(NULLIF(p.cliente,''), r.cliente, ''),
       COALESCE(NULLIF(r.concessionaria,''), p.concessionaria, ''),
       COALESCE(e.nome,''), COALESCE(ia.nome,''), COALESCE(s.nome,''), p.data_criacao
  FROM FT_PROCESSOS p
  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
  LEFT JOIN DM_ETAPAS e ON e.id_etapa = p.id_etapa_atual
  LEFT JOIN DM_INSTANCIAS ia ON ia.id_instancia = p.id_instancia_atual
  LEFT JOIN DM_STATUS_PROCESSO s ON s.id_status = p.id_status_atual
 WHERE p.id_processo IN (`+ph+`) ORDER BY p.id_processo`, ids...)
	if err != nil {
		return nil, "", err
	}
	for rows.Next() {
		pr := &proc{}
		if err := rows.Scan(&pr.id, &pr.cod, &pr.uc, &pr.cli, &pr.conc, &pr.etapa, &pr.inst, &pr.st, &pr.criado); err != nil {
			rows.Close()
			return nil, "", err
		}
		procs[pr.id] = pr
		ordem = append(ordem, pr.id)
	}
	rows.Close()

	hcols := []string{"Data", "Etapa", "Instância", "Status", "Protocolo", "Comentário"}
	hist := map[int64][][]string{}
	type prot struct{ num, data string }
	primeiro, ultimo := map[int64]prot{}, map[int64]prot{}
	nprot := map[int64]int{}
	hr, err := db.Query(`
SELECT h.id_processo, h.data_movimentacao,
       COALESCE(ea.nome,''), COALESCE(en.nome,''), COALESCE(ia.nome,''), COALESCE(inn.nome,''),
       COALESCE(sn.nome,''), COALESCE(h.comentario,'')
  FROM FT_HISTORICO_MOVIMENTACOES h
  LEFT JOIN DM_ETAPAS ea ON ea.id_etapa = h.id_etapa_anterior
  LEFT JOIN DM_ETAPAS en ON en.id_etapa = h.id_etapa_nova
  LEFT JOIN DM_INSTANCIAS ia ON ia.id_instancia = h.id_instancia_anterior
  LEFT JOIN DM_INSTANCIAS inn ON inn.id_instancia = h.id_instancia_nova
  LEFT JOIN DM_STATUS_PROCESSO sn ON sn.id_status = h.id_status_novo
 WHERE h.id_processo IN (`+ph+`)
 ORDER BY h.id_processo, h.data_movimentacao, h.id_historico`, ids...)
	if err != nil {
		return nil, "", err
	}
	for hr.Next() {
		var id int64
		var dt sql.NullTime
		var ea, en, ia, inn, sn, com string
		if err := hr.Scan(&id, &dt, &ea, &en, &ia, &inn, &sn, &com); err != nil {
			hr.Close()
			return nil, "", err
		}
		data := ""
		if dt.Valid {
			data = dt.Time.Format("02/01/2006 15:04")
		}
		etapa := en
		if ea != "" && ea != en {
			etapa = ea + " → " + en
		}
		inst := inn
		if ia != "" && ia != inn {
			inst = ia + " → " + inn
		}
		pn := protocoloDoComentario(com)
		if pn != "" {
			d := ""
			if dt.Valid {
				d = dt.Time.Format("02/01/2006")
			}
			if _, ok := primeiro[id]; !ok {
				primeiro[id] = prot{pn, d}
			}
			ultimo[id] = prot{pn, d}
			nprot[id]++
		}
		com = strings.ReplaceAll(strings.ReplaceAll(com, "\r", " "), "\n", " ")
		hist[id] = append(hist[id], []string{data, etapa, inst, sn, pn, strings.ReplaceAll(com, "|", "/")})
	}
	hr.Close()

	resumoCols := []string{"Nº do Processo", "ID", "UC", "Cliente", "Concessionária", "Criado no SURE",
		"1ª movimentação", "1º protocolo", "Data do 1º protocolo", "Último protocolo", "Data do último protocolo",
		"Qtd. de protocolos", "Etapa atual", "Instância atual", "Status"}
	resumo := Tabela{Nome: "Resumo", Cols: resumoCols}
	abas := []Tabela{}
	for _, id := range ordem {
		pr := procs[id]
		cri := ""
		if pr.criado.Valid {
			cri = pr.criado.Time.Format("02/01/2006")
		}
		pm := ""
		if h := hist[id]; len(h) > 0 {
			pm = strings.SplitN(h[0][0], " ", 2)[0]
		}
		resumo.Linhas = append(resumo.Linhas, []string{pr.cod, strconv.FormatInt(id, 10), pr.uc, pr.cli, pr.conc, cri, pm,
			primeiro[id].num, primeiro[id].data, ultimo[id].num, ultimo[id].data, strconv.Itoa(nprot[id]),
			pr.etapa, pr.inst, pr.st})
		abas = append(abas, Tabela{Nome: pr.cod, Cols: hcols, Linhas: hist[id]})
	}
	faltam := []string{}
	for _, v := range ids {
		if n, _ := strconv.ParseInt(v.(string), 10, 64); procs[n] == nil {
			faltam = append(faltam, v.(string))
		}
	}
	msg := fmt.Sprintf("%d de %d processo(s) — aba Resumo (criação e protocolos do histórico) + 1 aba por processo com o histórico completo", len(ordem), len(ids))
	if len(faltam) > 0 {
		msg += " — não encontrados: " + strings.Join(faltam, ", ")
	}
	return append([]Tabela{resumo}, abas...), msg + ".", nil
}

// FormatarResultado monta o markdown que fica em FT_SOLICITACOES.resultado (aparece no chat
// e é a fonte do Excel). 1 tabela = formato de sempre; várias = cada uma sob "### Nome",
// e o export do Excel cria uma aba por "### Nome". Teto de capN linhas por tabela.
func FormatarResultado(tabs []Tabela, resumo string, capN int) string {
	var b strings.Builder
	b.WriteString("📊 " + resumo + "\n\n")
	for i, t := range tabs {
		if len(tabs) > 1 {
			b.WriteString("### " + strings.ReplaceAll(t.Nome, "\n", " ") + "\n")
		}
		b.WriteString("| " + strings.Join(t.Cols, " | ") + " |\n")
		seps := make([]string, len(t.Cols))
		for j := range seps {
			seps[j] = "---"
		}
		b.WriteString("| " + strings.Join(seps, " | ") + " |\n")
		n := len(t.Linhas)
		if n > capN {
			n = capN
		}
		for j := 0; j < n; j++ {
			b.WriteString("| " + strings.Join(t.Linhas[j], " | ") + " |\n")
		}
		if len(t.Linhas) > capN {
			b.WriteString(fmt.Sprintf("\n_(mostrando %d de %d — refine o período/limite para ver o resto)_\n", capN, len(t.Linhas)))
		}
		if i < len(tabs)-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// ---------- REGRA DE VALOR do perfil SOLICITANTE ----------
// O solicitante repassa informação ao cliente: só pode ver VALOR de processo DEFERIDO (valor
// deferido + data do deferimento — que já saem em branco sem deferimento). Estimativa de
// ressarcimento, repasse, crédito simples/dobro e bases nunca saem para ele. Aplicado aqui (no
// servidor) para todo relatório cujo pedido veio de solicitante (params["perfil"]="solicitante").
var (
	reColProibidaSolic    = regexp.MustCompile(`(?i)ressarc|estimad|repasse|amee|pleite|\bbase\b|valor_fat|faturamento|carteira`) // crédito simples/dobro = valor DEFERIDO: fica
	reResumoProibidoSolic = regexp.MustCompile(`(?i)\s*[—–-]?\s*total estimado\s*R\$\s*[\d.,]+\.?`)
)

func mascararSolicitante(tabs []Tabela, resumo string) ([]Tabela, string) {
	out := make([]Tabela, 0, len(tabs))
	for _, t := range tabs {
		keep := []int{}
		for i, c := range t.Cols {
			if !reColProibidaSolic.MatchString(c) {
				keep = append(keep, i)
			}
		}
		nt := Tabela{Nome: t.Nome}
		for _, i := range keep {
			nt.Cols = append(nt.Cols, t.Cols[i])
		}
		for _, l := range t.Linhas {
			nl := make([]string, 0, len(keep))
			for _, i := range keep {
				if i < len(l) {
					nl = append(nl, l[i])
				}
			}
			nt.Linhas = append(nt.Linhas, nl)
		}
		out = append(out, nt)
	}
	return out, strings.TrimSpace(reResumoProibidoSolic.ReplaceAllString(resumo, ""))
}
