package handlers

// Excel do relatório de priorização no formato da planilha da Luana ("Lista de Priorização de Casos"):
//   - Dashboard: cards, pipeline por instância, SLA, movimentações, finalizações por prioridade,
//     previsão de finalizações semanais do mês (esperado × finalizado) e a lista de vencimentos;
//   - DEFERIDOS: os casos priorizados (P1 com a linha amarela, como na planilha) com as colunas da VW_RESUMO_MENSAL;
//   - Demais deferidos: os sem estrela (entram nos totais de finalização).
// Regras tiradas das fórmulas da planilha (_BASE_DASH):
//   - Finalizado = data de envio ao financeiro (nossa parte encerrada) dentro do período;
//   - Esperado da semana = repasse AMEE dos priorizados cuja data prevista (prazo de retorno) cai na semana;
//   - Semanas de segunda a domingo; os dias soltos antes da primeira segunda entram na 1ª semana.
// GET /api/v1/relatorios/priorizacao/xlsx[?mes=AAAA-MM]

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"
)

type vwResumoPrio struct {
	UC, Cliente, Conc, DataMov, Prazo, StatusPrazo, Comentario, Instancia, Etapa, StatusProc, StatusAprov, EnvioFin string
	RessEst, CredS, CredD, TotCli, RepS, RepD, TotAmee                                                              float64
}

// carregarVWResumoPrio lê da VW_RESUMO_MENSAL (a mesma fonte do PROCV da planilha) os processos pedidos.
func carregarVWResumoPrio(db *sql.DB, ids []int64) (map[int64]*vwResumoPrio, error) {
	out := map[int64]*vwResumoPrio{}
	if len(ids) == 0 {
		return out, nil
	}
	lista := make([]string, len(ids))
	for i, id := range ids {
		lista[i] = strconv.FormatInt(id, 10)
	}
	rows, err := db.Query(`
		SELECT id_requisicao, uc, cliente, concessionaria, ressarcimento_estimado,
		       DATE_FORMAT(data_movimentacao,'%Y-%m-%d'), DATE_FORMAT(prazo,'%Y-%m-%d'), status_prazo, comentario,
		       instancia, etapa, status_processo, status_aprovacao,
		       credito_simples, credito_dobro, total_cliente, repasse_simples, repasse_dobro, total_amee,
		       DATE_FORMAT(data_envio_financeiro,'%Y-%m-%d')
		  FROM VW_RESUMO_MENSAL WHERE id_requisicao IN (` + strings.Join(lista, ",") + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var s [16]sql.NullString
		var f [7]sql.NullFloat64
		if err := rows.Scan(&id, &s[0], &s[1], &s[2], &f[0], &s[3], &s[4], &s[5], &s[6], &s[7], &s[8], &s[9], &s[10],
			&f[1], &f[2], &f[3], &f[4], &f[5], &f[6], &s[11]); err != nil {
			return nil, err
		}
		if out[id] != nil {
			continue
		}
		limpo := func(v sql.NullString) string {
			t := strings.TrimSpace(v.String)
			if t == "0" || strings.HasPrefix(t, "0000-00-00") {
				return ""
			}
			return t
		}
		out[id] = &vwResumoPrio{
			UC: limpo(s[0]), Cliente: limpo(s[1]), Conc: limpo(s[2]), DataMov: limpo(s[3]), Prazo: limpo(s[4]),
			StatusPrazo: limpo(s[5]), Comentario: limpo(s[6]), Instancia: limpo(s[7]), Etapa: limpo(s[8]),
			StatusProc: limpo(s[9]), StatusAprov: limpo(s[10]), EnvioFin: limpo(s[11]),
			RessEst: f[0].Float64, CredS: f[1].Float64, CredD: f[2].Float64, TotCli: f[3].Float64,
			RepS: f[4].Float64, RepD: f[5].Float64, TotAmee: f[6].Float64,
		}
	}
	return out, rows.Err()
}

type prioLinha struct {
	it *priorizacaoItem
	v  *vwResumoPrio
}

func (l prioLinha) amee() float64 {
	if l.v != nil {
		return l.v.TotAmee
	}
	return l.it.TotalAmee
}

// envio(): data de finalização — envio ao financeiro (VW) ou, sem ele, o dossiê "Procedente - Relatórios e Evidências".
func (l prioLinha) envio() time.Time {
	s := l.it.Finalizado
	if l.v != nil && l.v.EnvioFin != "" {
		s = l.v.EnvioFin
	}
	return parseDataSQL(sql.NullString{String: s, Valid: s != ""})
}
func (l prioLinha) str(vw, fallback string) string {
	if l.v != nil && vw != "" {
		return vw
	}
	return fallback
}

type semanaPrio struct{ ini, fim time.Time }

// semanasDoMes: segunda a domingo; se a 1ª semana tiver só 1–2 dias, junta com a seguinte (como na planilha: 01–08/11/2026).
func semanasDoMes(ano int, mes time.Month, loc *time.Location) []semanaPrio {
	primeiro := time.Date(ano, mes, 1, 0, 0, 0, 0, loc)
	ultimo := primeiro.AddDate(0, 1, -1)
	fim := primeiro
	for fim.Weekday() != time.Sunday {
		fim = fim.AddDate(0, 0, 1)
	}
	if fim.Day()-primeiro.Day() < 2 {
		fim = fim.AddDate(0, 0, 7)
	}
	out := []semanaPrio{}
	ini := primeiro
	for !ini.After(ultimo) {
		if fim.After(ultimo) {
			fim = ultimo
		}
		out = append(out, semanaPrio{ini, fim})
		ini = fim.AddDate(0, 0, 1)
		fim = ini.AddDate(0, 0, 6)
	}
	return out
}

func dentro(t, ini, fim time.Time) bool { return !t.IsZero() && !t.Before(ini) && !t.After(fim) }

var mesesPrio = []string{"", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"}

// GetRelatorioPriorizacaoXLSX gera o Excel no formato do dashboard da Luana.
func GetRelatorioPriorizacaoXLSX(c *gin.Context) {
	db, ok := priorizacaoDB()
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return
	}
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		loc = time.Local
	}
	agora := time.Now().In(loc)
	hoje := time.Date(agora.Year(), agora.Month(), agora.Day(), 0, 0, 0, 0, loc)
	ano, mes := hoje.Year(), hoje.Month()
	if m := c.Query("mes"); m != "" {
		t, err := time.Parse("2006-01", m)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "mes no formato AAAA-MM"})
			return
		}
		ano, mes = t.Year(), t.Month()
	}
	mesIni := time.Date(ano, mes, 1, 0, 0, 0, 0, loc)
	mesFim := mesIni.AddDate(0, 1, -1)
	semanas := semanasDoMes(ano, mes, loc)

	dados, err := carregarPriorizacao(db, true)
	if err != nil {
		log.Printf("GetRelatorioPriorizacaoXLSX: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta"})
		return
	}
	ids := make([]int64, 0, len(dados.Itens))
	for _, it := range dados.Itens {
		ids = append(ids, it.IDProcesso)
	}
	vw, err := carregarVWResumoPrio(db, ids)
	if err != nil {
		log.Printf("GetRelatorioPriorizacaoXLSX vw: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta"})
		return
	}
	// datas no fuso de SP para comparar com as semanas
	emLoc := func(t time.Time) time.Time {
		if t.IsZero() {
			return t
		}
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
	}

	var p1, p2, demais []prioLinha
	for _, it := range dados.Itens {
		l := prioLinha{it, vw[it.IDProcesso]}
		switch {
		case it.Estrela == 1:
			p1 = append(p1, l)
		case it.Estrela == 2:
			p2 = append(p2, l)
		case it.Deferido && (it.IDEtapa != 6 || dentro(emLoc(l.envio()), mesIni, mesFim)):
			demais = append(demais, l)
		}
	}
	porData := func(ls []prioLinha) {
		sort.SliceStable(ls, func(a, b int) bool {
			da, dbb := ls[a].it.DataManual, ls[b].it.DataManual
			if (da == "") != (dbb == "") {
				return da != ""
			}
			if da != dbb {
				return da < dbb
			}
			return ls[a].amee() > ls[b].amee()
		})
	}
	porData(p1)
	porData(p2)
	sort.SliceStable(demais, func(a, b int) bool { return demais[a].amee() > demais[b].amee() })
	prior := append(append([]prioLinha{}, p1...), p2...)

	soma := func(ls []prioLinha, filtro func(prioLinha) bool) (int, float64) {
		n, v := 0, 0.0
		for _, l := range ls {
			if filtro == nil || filtro(l) {
				n++
				v += l.amee()
			}
		}
		return n, v
	}
	finalizadoEm := func(ini, fim time.Time) func(prioLinha) bool {
		return func(l prioLinha) bool { return dentro(emLoc(l.envio()), ini, fim) }
	}
	previstoEm := func(ini, fim time.Time) func(prioLinha) bool {
		return func(l prioLinha) bool {
			return dentro(emLoc(parseDataSQL(sql.NullString{String: l.it.DataManual, Valid: l.it.DataManual != ""})), ini, fim)
		}
	}
	todos := append(append([]prioLinha{}, prior...), demais...)

	// semana "atual" do relatório
	semAtual := 0
	switch {
	case hoje.After(mesFim):
		semAtual = len(semanas) - 1
	case hoje.Before(mesIni):
		semAtual = 0
	default:
		for i, s := range semanas {
			if dentro(hoje, s.ini, s.fim) {
				semAtual = i
			}
		}
	}

	f := excelize.NewFile()
	defer f.Close()
	const sh = "Dashboard"
	_ = f.SetSheetName("Sheet1", sh)
	gl := false
	_ = f.SetSheetView(sh, 0, &excelize.ViewOptions{ShowGridLines: &gl})
	for col, w := range map[string]float64{"A": 1.6, "B": 15.4, "C": 13.1, "D": 19.4, "E": 26, "F": 6, "G": 22, "H": 16, "I": 19.7, "J": 15, "K": 4, "L": 19.9, "M": 17, "N": 17} {
		_ = f.SetColWidth(sh, col, col, w)
	}
	borda := []excelize.Border{
		{Type: "left", Color: "D1D5DB", Style: 1}, {Type: "right", Color: "D1D5DB", Style: 1},
		{Type: "top", Color: "D1D5DB", Style: 1}, {Type: "bottom", Color: "D1D5DB", Style: 1},
	}
	estilos := map[string]int{}
	st := func(fill, cor string, bold bool, size float64, numfmt string, comBorda bool) int {
		k := fmt.Sprint(fill, cor, bold, size, numfmt, comBorda)
		if id, ok := estilos[k]; ok {
			return id
		}
		s := &excelize.Style{
			Font:      &excelize.Font{Bold: bold, Size: size, Color: cor, Family: "Calibri"},
			Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center", WrapText: true},
		}
		if fill != "" {
			s.Fill = excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{fill}}
		}
		if numfmt != "" {
			nf := numfmt
			s.CustomNumFmt = &nf
		}
		if comBorda {
			s.Border = borda
		}
		id, _ := f.NewStyle(s)
		estilos[k] = id
		return id
	}
	const (
		azul, verdeTit, cinza, azulClaro = "1F4E78", "0F766E", "F3F4F6", "D9EAF7"
		fmtBRL, fmtInt, fmtPct, fmtData  = `"R$ "#,##0.00`, `#,##0`, `0.0%`, `dd/mm/yyyy`
	)
	put := func(ini, fim string, v interface{}, style int) {
		if fim != "" && fim != ini {
			_ = f.MergeCell(sh, ini, fim)
		} else {
			fim = ini
		}
		_ = f.SetCellValue(sh, ini, v)
		_ = f.SetCellStyle(sh, ini, fim, style)
	}
	cel := func(col string, row int) string { return fmt.Sprintf("%s%d", col, row) }
	data := func(iso string) interface{} {
		t := parseDataSQL(sql.NullString{String: iso, Valid: iso != ""})
		if t.IsZero() {
			return ""
		}
		return t
	}
	dm := func(t time.Time) string { return t.Format("02/01") }

	// título
	put("B2", "M3", "Dashboard Semanal | Priorização de Casos - Deferidos", st(azul, "FFFFFF", true, 16, "", false))
	put("B4", "M4", fmt.Sprintf("Referência: %s/%d · semana atual: %s a %s · gerado em %s",
		mesesPrio[mes], ano, dm(semanas[semAtual].ini), dm(semanas[semAtual].fim), agora.Format("02/01/2006 15:04")),
		st("", "6B7280", false, 9, "", false))

	// cards
	card := func(c1, c2 string, r int, titulo string, valor interface{}, fill, numfmt string) {
		put(cel(c1, r), cel(c2, r+1), titulo, st(fill, "111827", true, 12, "", false))
		put(cel(c1, r+2), cel(c2, r+3), valor, st(fill, "111827", true, 18, numfmt, false))
	}
	nP1, vP1 := soma(p1, nil)
	nP2, vP2 := soma(p2, nil)
	nFin, vFin := soma(todos, finalizadoEm(mesIni, mesFim))
	card("B", "D", 5, "Casos Priorizados", nP1+nP2, "D9EAF7", fmtInt)
	card("E", "G", 5, "Deferidos - Prioridade 1", nP1, "E8F5E9", fmtInt)
	card("H", "J", 5, "Deferidos - Prioridade 2", nP2, "E8F5E9", fmtInt)
	card("K", "M", 5, "Casos Finalizados no mês", nFin, "FFF8DB", fmtInt)
	card("B", "D", 9, "Potencial Repasse AMEE", vP1+vP2, "FFF4E5", fmtBRL)
	card("E", "G", 9, "Potencial Repasse AMEE - Deferidos Prioridade 1", vP1, "FFF4E5", fmtBRL)
	card("H", "J", 9, "Potencial Repasse AMEE - Deferidos Prioridade 2", vP2, "FFF4E5", fmtBRL)
	card("K", "M", 9, "Repasse AMEE Recebido no mês", vFin, "FFF4E5", fmtBRL)
	sA := semanas[semAtual]
	nVenc, vVenc := soma(prior, previstoEm(sA.ini, sA.fim))
	// 27/11 (Luana): sem o card "Comprovante recebido" — parte dos casos é paga por compensação em fatura, sem comprovante
	card("B", "D", 13, "Semana atual", fmt.Sprintf("%s a %s", dm(sA.ini), dm(sA.fim)), "E7E6E6", "")
	card("E", "G", 13, "Previsão Vencimentos da Semana", nVenc, "E7E6E6", fmtInt)
	card("H", "J", 13, "Valor Previsão Vencimentos da Semana", vVenc, "E7E6E6", fmtBRL)

	// pipeline / SLA / movimentações
	put("B18", "C18", "Pipeline Atual dos Priorizados", st(azul, "FFFFFF", true, 11, "", false))
	put("G18", "H18", "SLA dos Priorizados", st(azul, "FFFFFF", true, 11, "", false))
	put("L18", "M18", "Movimentações Priorizados", st(azul, "FFFFFF", true, 11, "", false))
	for _, h := range [][2]string{{"B19", "Instância"}, {"C19", "Casos"}, {"G19", "Status"}, {"H19", "Casos"}, {"L19", "Indicador"}, {"M19", "Valor"}} {
		put(h[0], "", h[1], st(verdeTit, "FFFFFF", true, 11, "", true))
	}
	cont := map[string]int{}
	for _, l := range prior {
		cont[strings.ToUpper(l.str(l.v.instanciaOuVazio(), l.it.Instancia))]++
	}
	inst := [][2]string{{"Distribuidora", "DISTRIBUIDORA"}, {"Ouvidoria", "OUVIDORIA"}, {"ANEEL", "ANEEL"}, {"SMA", "SMA"}}
	noPrazo, vencido, finalizado, semData := 0, 0, 0, 0
	for _, l := range prior {
		switch {
		case !l.envio().IsZero():
			finalizado++
		case l.it.DataManual == "":
			semData++
		case l.it.DataManual >= hoje.Format("2006-01-02"):
			noPrazo++
		default:
			vencido++
		}
	}
	sla := [][2]interface{}{{"No prazo", noPrazo}, {"Vencido", vencido}, {"Finalizado", finalizado}, {"Sem data prevista", semData}}
	movim := 0
	desde := hoje.AddDate(0, 0, -6).Format("2006-01-02")
	for _, l := range prior {
		mov := l.it.UltimaMov
		if l.v != nil && l.v.DataMov > mov {
			mov = l.v.DataMov
		}
		if mov >= desde {
			movim++
		}
	}
	taxa := 0.0
	if len(prior) > 0 {
		taxa = float64(movim) / float64(len(prior))
	}
	for i := 0; i < 4; i++ {
		r := 20 + i
		fill := cinza
		if i%2 == 1 {
			fill = azulClaro
		}
		put(cel("B", r), "", inst[i][0], st(fill, "111827", false, 11, "", true))
		put(cel("C", r), "", cont[inst[i][1]], st(fill, "111827", false, 11, fmtInt, true))
		put(cel("G", r), "", sla[i][0], st(fill, "111827", false, 11, "", true))
		put(cel("H", r), "", sla[i][1], st(fill, "111827", false, 11, fmtInt, true))
	}
	put("L20", "", "Casos movimentados (últimos 7 dias)", st(cinza, "111827", false, 11, "", true))
	put("M20", "", movim, st(cinza, "111827", false, 11, fmtInt, true))
	put("L21", "", "Taxa de movimentação", st(azulClaro, "111827", false, 11, "", true))
	put("M21", "", taxa, st(azulClaro, "111827", false, 11, fmtPct, true))

	// finalizações por prioridade + previsão semanal
	put("B26", "D26", "Finalizações por Prioridade no mês", st(azul, "FFFFFF", true, 11, "", false))
	put("G26", "M26", fmt.Sprintf("Previsão de Finalizações Semanais %s/%d", mesesPrio[mes], ano), st(azul, "FFFFFF", true, 11, "", false))
	for _, h := range [][3]string{{"B27", "", "Prioridade"}, {"C27", "", "Casos"}, {"D27", "", "Valor (R$)"},
		{"G27", "", "Período"}, {"H27", "", "Esperado (R$)"}, {"I27", "", "Finalizado (R$)"}, {"J27", "", "Diferença (R$)"},
		{"K27", "L27", "Atingimento (%)"}, {"M27", "", "Casos (esperado / finalizado)"}} {
		put(h[0], h[1], h[2], st(verdeTit, "FFFFFF", true, 11, "", true))
	}
	grupos := []struct {
		rot string
		ls  []prioLinha
	}{{"1", p1}, {"2", p2}, {"Não Priorizados", demais}}
	for i, g := range grupos {
		r := 28 + i
		fill := cinza
		if i%2 == 1 {
			fill = azulClaro
		}
		n, v := soma(g.ls, finalizadoEm(mesIni, mesFim))
		put(cel("B", r), "", g.rot, st(fill, "111827", false, 11, "", true))
		put(cel("C", r), "", n, st(fill, "111827", false, 11, fmtInt, true))
		put(cel("D", r), "", v, st(fill, "111827", false, 11, fmtBRL, true))
	}
	// 27/11 (Luana): Diferença só nas semanas já encerradas (antes da semana atual); a atual e as futuras ficam em
	// branco. O total da Diferença soma só as semanas encerradas.
	const fmtDif = `"R$ "#,##0.00;[Red]-"R$ "#,##0.00`
	totEsp, totFin, totDif, totNE, totNF := 0.0, 0.0, 0.0, 0, 0
	algumaEncerrada := false
	for i, s := range semanas {
		r := 28 + i
		fill := cinza
		if i%2 == 1 {
			fill = azulClaro
		}
		nE, esp := soma(prior, previstoEm(s.ini, s.fim))
		nF, fin := soma(todos, finalizadoEm(s.ini, s.fim))
		totEsp, totFin, totNE, totNF = totEsp+esp, totFin+fin, totNE+nE, totNF+nF
		rot := fmt.Sprintf("%dª Semana (%s a %s)", i+1, dm(s.ini), dm(s.fim))
		put(cel("G", r), "", rot, st(fill, "111827", false, 10, "", true))
		put(cel("H", r), "", esp, st(fill, "111827", false, 11, fmtBRL, true))
		put(cel("I", r), "", fin, st(fill, "111827", false, 11, fmtBRL, true))
		var dif interface{} = ""
		if s.fim.Before(hoje) {
			dif = fin - esp
			totDif += fin - esp
			algumaEncerrada = true
		}
		put(cel("J", r), "", dif, st(fill, "111827", false, 11, fmtDif, true))
		var ating interface{} = "—"
		if esp > 0 {
			ating = fin / esp
		}
		put(cel("K", r), cel("L", r), ating, st(fill, "000000", false, 11, "0.00%", true))
		put(cel("M", r), "", fmt.Sprintf("%d / %d", nE, nF), st(fill, "111827", false, 11, "", true))
		_ = f.SetRowHeight(sh, r, 28)
	}
	rt := 28 + len(semanas)
	put(cel("G", rt), "", "Total", st(azulClaro, "111827", true, 11, "", true))
	put(cel("H", rt), "", totEsp, st(azulClaro, "111827", true, 11, fmtBRL, true))
	put(cel("I", rt), "", totFin, st(azulClaro, "111827", true, 11, fmtBRL, true))
	var difT interface{} = ""
	if algumaEncerrada {
		difT = totDif
	}
	put(cel("J", rt), "", difT, st(azulClaro, "111827", true, 11, fmtDif, true))
	var atingT interface{} = "—"
	if totEsp > 0 {
		atingT = totFin / totEsp
	}
	put(cel("K", rt), cel("L", rt), atingT, st(azulClaro, "000000", true, 11, "0.00%", true))
	put(cel("M", rt), "", fmt.Sprintf("%d / %d", totNE, totNF), st(azulClaro, "111827", true, 11, "", true))
	_ = f.SetCellValue(sh, cel("G", rt+1), "Esperado = repasse dos priorizados com data prevista na semana · Finalizado = envio ao financeiro na semana (todos os deferidos)")
	_ = f.SetCellStyle(sh, cel("G", rt+1), cel("G", rt+1), st("", "6B7280", false, 8, "", false))

	// vencimentos
	r := 36
	cab := [][3]string{{"B", "", "Vencimentos"}, {"C", "", "UC"}, {"D", "", "Id_requisicao"}, {"E", "", "Cliente"}, {"F", "G", "Concessionaria"},
		{"H", "", "Total_cliente"}, {"I", "", "Repasse_simples"}, {"J", "", "Repasse_dobro"}, {"K", "L", "Total_amee"},
		{"M", "", "Prazo_inicial"}, {"N", "", "Finalizado_em"}}
	for _, h := range cab {
		fim := ""
		if h[1] != "" {
			fim = cel(h[1], r)
		}
		put(cel(h[0], r), fim, h[2], st(azul, "FFFFFF", true, 11, "", true))
	}
	rotSemana := func(l prioLinha) string {
		t := emLoc(parseDataSQL(sql.NullString{String: l.it.DataManual, Valid: l.it.DataManual != ""}))
		if t.IsZero() {
			return "Sem data"
		}
		if t.Before(mesIni) {
			return "Mês anterior"
		}
		if t.After(mesFim) {
			return "Próximo mês"
		}
		for i, s := range semanas {
			if dentro(t, s.ini, s.fim) {
				return fmt.Sprintf("%dª Semana", i+1)
			}
		}
		return ""
	}
	// 27/11 (Luana): toda linha finalizada no mês fica verde (antes só P2 sem data e não priorizados)
	linhaVenc := func(l prioLinha, rot, fill string) {
		r++
		if finalizadoEm(mesIni, mesFim)(l) {
			fill = "92D050"
		}
		cli := l.str(l.vCliente(), l.it.Cliente)
		conc := l.str(l.vConc(), l.it.Concessionaria)
		uc := l.str(l.vUC(), l.it.UC)
		var credT, repS, repD float64
		if l.v != nil {
			credT, repS, repD = l.v.TotCli, l.v.RepS, l.v.RepD
		} else {
			credT, repS = l.it.TotalCliente, l.it.TotalAmee
		}
		put(cel("B", r), "", rot, st(fill, "000000", false, 11, "", true))
		put(cel("C", r), "", uc, st(fill, "000000", false, 11, "", true))
		put(cel("D", r), "", l.it.IDProcesso, st(fill, "000000", false, 11, "0", true))
		put(cel("E", r), "", cli, st(fill, "000000", false, 10, "", true))
		put(cel("F", r), cel("G", r), conc, st(fill, "000000", false, 10, "", true))
		put(cel("H", r), "", credT, st(fill, "000000", false, 11, fmtBRL, true))
		put(cel("I", r), "", repS, st(fill, "000000", false, 11, fmtBRL, true))
		put(cel("J", r), "", repD, st(fill, "000000", false, 11, fmtBRL, true))
		put(cel("K", r), cel("L", r), l.amee(), st(fill, "000000", false, 11, fmtBRL, true))
		put(cel("M", r), "", data(l.it.DataManual), st(fill, "000000", false, 11, fmtData, true))
		var env interface{} = ""
		if e := l.envio(); !e.IsZero() {
			env = e
		}
		put(cel("N", r), "", env, st(fill, "000000", false, 11, fmtData, true))
	}
	for _, l := range p1 {
		linhaVenc(l, rotSemana(l), "")
	}
	for _, l := range p2 {
		if l.it.DataManual != "" {
			linhaVenc(l, "P2 · "+rotSemana(l), "")
		}
	}
	// como na planilha: P2 e não priorizados finalizados no mês aparecem em verde
	for _, l := range p2 {
		if l.it.DataManual == "" && finalizadoEm(mesIni, mesFim)(l) {
			linhaVenc(l, "Prioridade 2", "92D050")
		}
	}
	for _, l := range demais {
		if finalizadoEm(mesIni, mesFim)(l) {
			linhaVenc(l, "Não Priorizado", "92D050")
		}
	}

	// abas de dados
	escreverLista := func(nome string, ls []prioLinha, rotulo func(prioLinha) interface{}, amarelo func(prioLinha) bool) {
		_, _ = f.NewSheet(nome)
		cols := []struct {
			t string
			w float64
		}{{"Prioridade", 13}, {"uc", 16}, {"id_requisicao", 12}, {"cliente", 30}, {"concessionaria", 22}, {"ressarcimento_estimado", 14},
			{"data_movimentacao", 13}, {"prazo", 12}, {"status_prazo", 12}, {"comentario", 50}, {"instancia", 13}, {"etapa", 14},
			{"status_processo", 20}, {"status_aprovacao", 14}, {"credito_simples", 14}, {"credito_dobro", 14}, {"total_cliente", 14},
			{"repasse_simples", 14}, {"repasse_dobro", 14}, {"total_amee", 14}, {"data_envio_financeiro", 14}, {"observação", 45},
			{"prazo_retorno (data prevista)", 14}, {"comprovante_data", 13}, {"comprovante_fonte", 16}, {"dias_ate_comprovante", 12},
			{"data_estimada_sistema", 14}, {"base_estimativa", 20}, {"finalizado_em", 13}, {"fonte_finalizacao", 26}, {"historico (desde a procedência)", 80}, {"repasse_amee", 15}}
		hst := st(azul, "FFFFFF", true, 10, "", true)
		for i, c := range cols {
			nm, _ := excelize.ColumnNumberToName(i + 1)
			_ = f.SetColWidth(nome, nm, nm, c.w)
			_ = f.SetCellValue(nome, nm+"1", c.t)
			_ = f.SetCellStyle(nome, nm+"1", nm+"1", hst)
		}
		_ = f.SetRowHeight(nome, 1, 30)
		_ = f.SetPanes(nome, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})
		for i, l := range ls {
			row := i + 2
			v := l.v
			if v == nil {
				v = &vwResumoPrio{UC: l.it.UC, Cliente: l.it.Cliente, Conc: l.it.Concessionaria, Instancia: l.it.Instancia, Etapa: l.it.Etapa,
					StatusProc: l.it.Status, TotCli: l.it.TotalCliente, TotAmee: l.it.TotalAmee, EnvioFin: l.it.EnvioFinanceiro, DataMov: l.it.UltimaMov}
			}
			var compD, compF, dias, est, base interface{} = "", "", "", "", ""
			if cp := l.it.Comprovante; cp != nil {
				compD, compF = data(cp.Data), map[string]string{"manual": "Manual", "email": "E-mail", "whatsapp": "WhatsApp", "historico": "Histórico"}[cp.Fonte]
			}
			if l.it.DiasComprovante != nil {
				dias = *l.it.DiasComprovante
			}
			if l.it.Comprovante == nil && l.it.DataEstimada != "" {
				est, base = data(l.it.DataEstimada), l.it.BaseEstimativa
			}
			vals := []interface{}{rotulo(l), v.UC, l.it.IDProcesso, v.Cliente, v.Conc, v.RessEst, data(v.DataMov), data(v.Prazo), v.StatusPrazo,
				v.Comentario, v.Instancia, v.Etapa, v.StatusProc, v.StatusAprov, v.CredS, v.CredD, v.TotCli, v.RepS, v.RepD, v.TotAmee,
				data(v.EnvioFin), l.it.Observacao, data(l.it.DataManual), compD, compF, dias, est, base,
				data(l.it.Finalizado), l.it.FonteFinalizacao, textoHistoricoPrio(l.it.Historico), v.TotAmee}
			fill := ""
			if amarelo != nil && amarelo(l) {
				fill = "F9F3A9"
			}
			for j, val := range vals {
				nm, _ := excelize.ColumnNumberToName(j + 1)
				a := fmt.Sprintf("%s%d", nm, row)
				_ = f.SetCellValue(nome, a, val)
				nf := ""
				switch {
				case j == 5 || (j >= 14 && j <= 19) || j == 31:
					nf = fmtBRL
				case j == 6 || j == 7 || j == 20 || j == 22 || j == 23 || j == 26 || j == 28:
					nf = fmtData
				}
				s := &excelize.Style{Font: &excelize.Font{Size: 10, Family: "Calibri"}, Border: borda,
					Alignment: &excelize.Alignment{Vertical: "top", WrapText: j == 9 || j == 21 || j == 30}}
				if fill != "" {
					s.Fill = excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{fill}}
				}
				if nf != "" {
					s.CustomNumFmt = &nf
				}
				k := fmt.Sprint("lista", fill, nf, j == 9 || j == 21 || j == 30)
				id, ok := estilos[k]
				if !ok {
					id, _ = f.NewStyle(s)
					estilos[k] = id
				}
				_ = f.SetCellStyle(nome, a, a, id)
			}
		}
		if len(ls) > 0 {
			ult, _ := excelize.ColumnNumberToName(len(cols))
			_ = f.AutoFilter(nome, fmt.Sprintf("A1:%s%d", ult, len(ls)+1), nil)
		}
	}
	escreverLista("DEFERIDOS", prior, func(l prioLinha) interface{} { return l.it.Estrela },
		func(l prioLinha) bool { return l.it.Estrela == 1 })
	escreverLista("Demais deferidos", demais, func(prioLinha) interface{} { return "Não Priorizado" }, nil)
	f.SetActiveSheet(0)

	buf, err := f.WriteToBuffer()
	if err != nil {
		log.Printf("GetRelatorioPriorizacaoXLSX write: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao gerar o Excel"})
		return
	}
	nomeArq := fmt.Sprintf("Relatorio_Priorizacao_%d-%02d_%s.xlsx", ano, int(mes), agora.Format("2006-01-02"))
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, nomeArq))
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buf.Bytes())
}

// acessores tolerantes a v == nil
func (v *vwResumoPrio) instanciaOuVazio() string {
	if v == nil {
		return ""
	}
	return v.Instancia
}
func (l prioLinha) vCliente() string {
	if l.v == nil {
		return ""
	}
	return l.v.Cliente
}
func (l prioLinha) vConc() string {
	if l.v == nil {
		return ""
	}
	return l.v.Conc
}
func (l prioLinha) vUC() string {
	if l.v == nil {
		return ""
	}
	return l.v.UC
}

// textoHistoricoPrio: uma linha por evento, "dd/mm/aaaa · tipo · texto".
func textoHistoricoPrio(h []priorizacaoEvento) string {
	linhas := make([]string, 0, len(h))
	for _, e := range h {
		d := e.Data
		if len(d) >= 10 {
			d = d[8:10] + "/" + d[5:7] + "/" + d[:4]
		}
		linhas = append(linhas, d+" · "+e.Tipo+" · "+e.Texto)
	}
	return strings.Join(linhas, "\n")
}
