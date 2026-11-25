package handlers

// F68 — energia injetada não compensada (usinas). Regra R05 da planilha da 1ª onda, no texto da analista
// (pedido #60 do chat, 25/11/2026): a fatura da geradora registra energia injetada acima de zero e há consumo de
// energia ativa passível de compensação, mas nenhum kWh foi compensado na própria fatura no ciclo. Fatura cobrada só
// por demanda contratada (consumo e/ou geração) e/ou custo de disponibilidade, sem consumo ativo compensável, não
// aponta. Transferência / rateio para outras UCs não conta como compensação. Nível ALERTA, sem valor em R$.

import (
	"database/sql"
	"fmt"
	"math"
	"regexp"
	"strings"
)

var reDisponibilidade = regexp.MustCompile(`(?i)DISPONIB|M[IÍ]NIMO`)

// bandeira: "ADIC. BAND. AMARELA" e também a Copel "ENERGIA CONS. B.AMARELA" (conferência visual 25/11/2026)
var reBandeiraDesc = regexp.MustCompile(`(?i)\bBAND|\bB\.\s*(AMAR|VERM|VERD)`)

// compensação impressa só em R$ (Elektro "DEV. CONSUMO MICRO/MINI −575,13", sem kWh — conferência visual 25/11/2026)
var reCompensacaoReais = regexp.MustCompile(`(?i)MICRO|MINI|COMPENS|INJET|\bINJ\b|\bGD\b|SCEE`)
var reGrandezaInj = regexp.MustCompile(`(?i)inj|gera`)
var reGrandezaNaoKWh = regexp.MustCompile(`(?i)dem|kw\b|- kw|reat|kvar`)

// kwhItem — item em kWh (ou sem unidade impressa)
func kwhItem(it uItem) bool {
	u := strings.ToUpper(strings.ReplaceAll(it.unid, " ", ""))
	return u == "" || strings.HasPrefix(u, "KWH")
}

// consumoPassivelCompensacao — kWh de energia ativa faturados que a GD poderia abater: TE/TUSD/CONSUMO em kWh,
// sem bandeira e sem custo de disponibilidade (item com esse nome ou, no grupo B, consumo igual ao mínimo de
// 30/50/100 kWh). Por posto, o maior entre TE/TUSD/CONSUMO (a mesma energia aparece nas linhas TE e TUSD).
func consumoPassivelCompensacao(f *uFat) float64 {
	soma := map[string]map[string]float64{}
	for _, it := range f.itens {
		if it.comp != "TE" && it.comp != "TUSD" && it.comp != "CONSUMO" {
			continue
		}
		if nv(it.qtd) <= 0 || !kwhItem(it) || reBandeiraDesc.MatchString(it.desc) || reDisponibilidade.MatchString(it.desc) {
			continue
		}
		p := it.posto
		if p == "" || p == "UNICO" || p == "TODOS" {
			p = "FORA_PONTA"
		}
		if soma[p] == nil {
			soma[p] = map[string]float64{}
		}
		soma[p][it.comp] += nv(it.qtd)
	}
	tot := 0.0
	for _, m := range soma {
		mx := 0.0
		for _, v := range m {
			mx = math.Max(mx, v)
		}
		tot += mx
	}
	if grupoB(f) {
		switch math.Round(tot) {
		case 30, 50, 100:
			return 0
		}
	}
	return tot
}

// injetadaFatura — kWh injetados no ciclo: o total impresso na fatura; sem ele, as linhas de medição de
// injeção/geração em kWh (sem demanda e sem reativo). ok=false quando a fatura não traz nenhum dos dois.
func injetadaFatura(f *uFat) (float64, bool) {
	if f.injImpr.Valid {
		return f.injImpr.Float64, true
	}
	s, ok := 0.0, false
	for _, m := range f.meds {
		if reGrandezaInj.MatchString(m.grandeza) && !reGrandezaNaoKWh.MatchString(m.grandeza) && m.cons.Valid {
			s += m.cons.Float64
			ok = true
		}
	}
	return s, ok
}

// compensadoPropriaFatura — kWh compensados na própria UC: linhas de compensação dos itens (sem bandeira) e a
// linha "compensada" do quadro de GD do mês da fatura. Transferida, rateio e excedente não contam.
func compensadoPropriaFatura(f *uFat) float64 {
	tot, _ := compensadoItens(f)
	for _, it := range f.itens { // linha de compensação só em R$ (sem kWh): conta como compensada
		if it.comp != "BANDEIRA" && !reBandeiraDesc.MatchString(it.desc) && nv(it.valor) < 0 && !it.qtd.Valid &&
			(it.comp == "CONSUMO" || it.comp == "TE" || it.comp == "TUSD" || it.comp == "CONSUMO_COMPENSADO" || it.comp == "GD_INJETADA") &&
			reCompensacaoReais.MatchString(it.desc) {
			tot++
		}
	}
	for _, g := range gdDoMes(f.gd, f.mes) {
		if g.tipo == "compensada" {
			tot += math.Abs(nv(g.kwh))
		}
	}
	return tot
}

func regraInjetadaNaoCompensada(f *uFat, sel map[string]bool) []Achado {
	if !sel["F68"] {
		return nil
	}
	inj, ok := injetadaFatura(f)
	if !ok || inj <= 0 {
		return nil
	}
	cp := consumoPassivelCompensacao(f)
	if cp <= 0 || compensadoPropriaFatura(f) > 0 {
		return nil
	}
	return []Achado{{"F68", "ALERTA", fmt.Sprintf("injetada %s kWh; consumo ativo faturado %s kWh; nenhum kWh compensado na própria UC",
		brNum(inj, 0), brNum(cp, 0)), 0, 0}}
}

// carregarInjetadaUsinas — kWh injetados impressos (FATURA_USINA.kwh_injetada_total); só quando a F68 está marcada
func carregarInjetadaUsinas(db *sql.DB, fats map[string]*uFat) error {
	rows, err := db.Query(`SELECT id_fatura, kwh_injetada_total FROM FATURA_USINA WHERE kwh_injetada_total IS NOT NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var v sql.NullFloat64
		if rows.Scan(&id, &v) == nil && fats[id] != nil {
			fats[id].injImpr = v
		}
	}
	return rows.Err()
}
