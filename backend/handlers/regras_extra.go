package handlers

// Regras do catálogo ligadas em 05/11/2026 com os dados que as bases JÁ têm (Usinas, Energia, Acer) — o que
// ainda depende de parâmetro de fora fica em regrasPrecisa (usinas_regras.go) e na lista da tela.
//
//   só com a fatura: F16 F18 F20 F23 F29 F38 F39 F44 F46
//   com o histórico da UC: F10 F11 F19 F21 F24 F26 F48 F49
//   com a tarifa/bandeira homologada da ANEEL: F31 F32 F43
//
// Critérios e tolerâncias: os do texto de cada regra no catálogo (DM_FICHAS_REGRAS / fichas_seed.json). Na base
// extraída automaticamente (Energia/Acer: f.extraida) a leitura dos campos pode errar — o que seria ERRO vira
// ALERTA para conferência na fatura, como nas demais regras.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// tributo do quadro da fatura (base, alíquota em %, valor)
type uTrib struct {
	nome              string
	base, aliq, valor float64
	retido            bool
}

// indicador de continuidade (DIC, FIC, DMIC, DICRI) do quadro de qualidade
type uQual struct {
	ind, periodo string
	apur, lim    float64
}

// precisaAneel — alguma regra selecionada usa a base da ANEEL
func precisaAneel(sel map[string]bool) bool {
	for _, c := range []string{"F28", "F41", "F42", "F58", "F31", "F32", "F43"} {
		if sel[c] {
			return true
		}
	}
	return false
}

// nivelBase — ERRO na base conferida; ALERTA (sem valor) na extraída automaticamente
func nivelBase(f *uFat, valor float64, extra string) (string, float64, string) {
	if f.extraida {
		return "ALERTA", 0, extra + " — confira na fatura (base extraída automaticamente)"
	}
	return "ERRO", rnd2(valor), extra
}

var (
	reReatMed   = regexp.MustCompile(`REAT|KVAR|\bER\b|ENRG\s*REA`)
	reNaoReat   = regexp.MustCompile(`EXCE|UFER|UFDR|DMCR|DEMANDA|\bDEM\b|\bKW\b`)
	reUFDR      = regexp.MustCompile(`DMCR|UFDR|DEMANDA\s*REAT|DEM\.?\s*REAT|REAT.*\bKW\b`)
	reAtivaMed  = regexp.MustCompile(`ATIV|CONSUMO|KWH|ENRG\s*ATV|ENERGIA\s*KWH`)
	reGeraMed   = regexp.MustCompile(`INJ|GERA|GER\b`)
	reDemMed    = regexp.MustCompile(`DEMANDA|\bDEM\b|\bDN\b|\bKW\b`)
	reNaoTribut = regexp.MustCompile(`MULTA|JUROS|MORA|CORRE[CÇ][AÃ]O|ATUALIZ|ATUALIZA[CÇ][AÃ]O\s*MONET`)
)

// ---------------------------------------------------------------- leitura dos registradores

// reativoMedido — kvarh medido no ciclo (soma dos registradores de energia reativa, fora excedente/demanda)
func reativoMedido(f *uFat) (float64, bool) {
	s, ok := 0.0, false
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza)) + " " + strings.ToUpper(m.unid)
		if !reReatMed.MatchString(g) || reNaoReat.MatchString(g) || strings.EqualFold(m.unid, "kW") {
			continue
		}
		v := 0.0
		switch {
		case m.cons.Valid && m.cons.Float64 >= 0:
			v = m.cons.Float64
		case m.lant.Valid && m.latu.Valid && m.latu.Float64 >= m.lant.Float64:
			k := 1.0
			if m.k.Valid && m.k.Float64 > 0 {
				k = m.k.Float64
			}
			v = (m.latu.Float64 - m.lant.Float64) * k
		default:
			continue
		}
		s += v
		ok = true
	}
	return s, ok
}

// excedenteMedido — kvarh do registrador de energia reativa EXCEDENTE do medidor (EN.EXCE, UFER), quando há
func excedenteMedido(f *uFat) (float64, bool) {
	s, ok, _ := excedenteMedidoResol(f)
	return s, ok
}

// excedenteMedidoResol — idem + se o registrador tem resolução (≥ 20 unidades de leitura; 0 → 1 × 21 = 21 kvarh
// não diz quanto foi de fato — Cosern 12/2025)
func excedenteMedidoResol(f *uFat) (float64, bool, bool) {
	s, ok, resol := 0.0, false, true
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza))
		if !(strings.Contains(g, "EXCE") || strings.Contains(g, "UFER")) || strings.Contains(g, "DEMANDA") || strings.Contains(g, "DMCR") ||
			strings.EqualFold(m.unid, "kW") || !m.cons.Valid || m.cons.Float64 < 0 {
			continue
		}
		if m.lant.Valid && m.latu.Valid && m.latu.Float64-m.lant.Float64 < 20 && m.cons.Float64 > 0 {
			resol = false
		}
		s += m.cons.Float64
		ok = true
	}
	return s, ok, resol
}

// reativoMedidoResol — reativo medido e se os registradores têm resolução (≥ 100 unidades de diferença de leitura)
func reativoMedidoResol(f *uFat) (float64, bool, bool) {
	med, ok := reativoMedido(f)
	resol := ok
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza)) + " " + strings.ToUpper(m.unid)
		if !reReatMed.MatchString(g) || reNaoReat.MatchString(g) || strings.EqualFold(m.unid, "kW") {
			continue
		}
		if !m.lant.Valid || !m.latu.Valid || m.latu.Float64-m.lant.Float64 < 100 {
			resol = false
		}
	}
	return med, ok, resol
}

// temRegistroReativo — há QUALQUER registro reativo (energia, demanda, excedente)
func temRegistroReativo(f *uFat) bool {
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza)) + " " + strings.ToUpper(m.unid)
		if reReatMed.MatchString(g) || strings.Contains(g, "DMCR") || strings.Contains(g, "UFER") || strings.Contains(g, "UFDR") {
			return true
		}
	}
	return false
}

func temRegistroAtivo(f *uFat) bool {
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza))
		if reAtivaMed.MatchString(g) && !reGeraMed.MatchString(g) && !reReatMed.MatchString(g) && !reDemMed.MatchString(g) {
			return true
		}
	}
	return false
}

// itens de reativo excedente: energia (UFER, kvarh) e demanda (UFDR/DMCR, kvar)
func itensReativo(f *uFat) (uferQ, uferV, ufdrV float64) {
	for _, it := range f.itens {
		if it.comp != "REATIVO_EXCEDENTE" || nv(it.valor) <= 0 {
			continue
		}
		d := strings.ToUpper(sem(it.desc)) + " " + strings.ToUpper(it.unid)
		if reUFDR.MatchString(d) || strings.EqualFold(it.unid, "kW") || strings.EqualFold(it.unid, "kvar") {
			ufdrV += nv(it.valor)
			continue
		}
		uferQ += math.Abs(nv(it.qtd))
		uferV += nv(it.valor)
	}
	return
}

// demanda medida por posto (maior registro de demanda de consumo)
func demandaMedida(f *uFat) map[string]float64 {
	out := map[string]float64{}
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza))
		if !reDemMed.MatchString(g) || reGeraMed.MatchString(g) || reReatMed.MatchString(g) || strings.Contains(g, "DMCR") ||
			strings.Contains(g, "CONTRAT") || !m.cons.Valid || m.cons.Float64 <= 0 {
			continue
		}
		p := m.posto
		if p == "" || p == "TODOS" {
			p = "UNICO"
		}
		if m.cons.Float64 > out[p] {
			out[p] = m.cons.Float64
		}
	}
	return out
}

// contratada/medida do posto do item (Verde: valor único)
func doPosto(mp map[string]float64, posto string) (float64, bool) {
	if posto == "" || posto == "TODOS" {
		posto = "UNICO"
	}
	if v, ok := mp[posto]; ok && v > 0 {
		return v, true
	}
	if posto != "PONTA" {
		for _, k := range []string{"FORA_PONTA", "UNICO"} {
			if v, ok := mp[k]; ok && v > 0 {
				return v, true
			}
		}
	}
	if len(mp) == 1 {
		for _, v := range mp {
			return v, v > 0
		}
	}
	return 0, false
}

// ---------------------------------------------------------------- regras só com a fatura

func regrasExtraFatura(f *uFat, sel map[string]bool) []Achado {
	var out []Achado
	valorOK := !f.extraida || f.itensOK
	acl := true // cliente livre: sem TE cobrada pela distribuidora
	for _, it := range f.itens {
		if it.comp == "TE" || (it.comp == "CONSUMO" && nv(it.valor) > 0) {
			acl = false
		}
	}

	// F16 — kvarh excedente faturado acima do medido (+1,5%). Prova forte: o registrador de EXCEDENTE do medidor
	// (EN.EXCE/UFER — o próprio medidor apura o excedente). Sem ele, o reativo total medido é só indício: a UFER
	// também nasce do capacitivo e o registrador costuma ser de baixa resolução (ALERTA).
	if sel["F16"] && valorOK {
		if q, v, _ := itensReativo(f); q > 0 && v > 0 {
			if exc, ok, resol := excedenteMedidoResol(f); ok && exc > 0 {
				if q > exc*1.03+2 {
					dif := q - exc*1.015
					nivel, val, det := nivelBase(f, dif*(v/q), "")
					if !resol {
						nivel, val, det = "ALERTA", 0, " — o registrador de excedente tem poucos dígitos (cada unidade vale a constante): confira na fatura"
					}
					out = append(out, Achado{"F16", nivel, fmt.Sprintf("reativo excedente faturado %.0f kvarh × excedente registrado pelo medidor %.0f kvarh (UFER R$ %.2f)%s", q, exc, v, det), val, 0})
				}
			} else if med, ok, resol := reativoMedidoResol(f); ok && resol && med > 0 && q > med*1.015+1 {
				out = append(out, Achado{"F16", "ALERTA", fmt.Sprintf("reativo excedente faturado %.0f kvarh acima do reativo indutivo medido %.0f kvarh (UFER R$ %.2f) — sem o registrador de excedente/capacitivo não dá para fechar a conta; confira na fatura", q, med, v), 0, 0})
			}
		}
	}

	// F18 — demanda reativa excedente (UFDR/DMCR) cobrada sem nenhum registro reativo
	if sel["F18"] && valorOK && !f.extraida {
		if _, _, ud := itensReativo(f); ud > 0 && temRegistroAtivo(f) && !temRegistroReativo(f) {
			out = append(out, Achado{"F18", "ERRO", fmt.Sprintf("demanda reativa excedente cobrada R$ %.2f sem nenhum registro reativo (kvar/kvarh) no quadro de medição", ud), rnd2(ud), 0})
		}
	}

	// F20 — constante implícita (consumo ÷ diferença de leituras) × constante impressa
	if sel["F20"] && !f.justLeitura {
		piorR, piorDet, piorExc := 0.0, "", 0.0
		for _, m := range f.meds {
			g := strings.ToUpper(sem(m.grandeza))
			if !reAtivaMed.MatchString(g) || reGeraMed.MatchString(g) || reReatMed.MatchString(g) || reDemMed.MatchString(g) ||
				strings.Contains(g, "EXCE") || strings.Contains(g, "INDUT") || strings.Contains(g, "CAPAC") ||
				m.arred || !m.lant.Valid || !m.latu.Valid || !m.k.Valid || !m.cons.Valid || m.k.Float64 <= 0 || m.cons.Float64 < 100 {
				continue
			}
			dl := m.latu.Float64 - m.lant.Float64
			if dl < 20 { // registrador de poucos dígitos: o arredondamento da leitura domina a conta
				continue
			}
			calc := dl * m.k.Float64
			r := m.cons.Float64 / calc
			if potencia10(m.cons.Float64, calc) || (f.extraida && (r > 3 || r < 0.33)) {
				continue // casa decimal / coluna trocada na leitura
			}
			if math.Abs(r-1) > math.Abs(piorR-1) {
				piorR = r
				piorExc = m.cons.Float64 - calc
				piorDet = fmt.Sprintf("%s %s: consumo %.0f kWh ÷ (%.0f − %.0f) = constante %.4f × impressa %.4f",
					m.grandeza, m.posto, m.cons.Float64, m.latu.Float64, m.lant.Float64, m.cons.Float64/dl, m.k.Float64)
			}
		}
		totalFecha := false // registrador do total (TP/todos os postos) que fecha com a constante: o do posto é só exibição
		for _, m := range f.meds {
			g := strings.ToUpper(sem(m.grandeza))
			if (m.posto == "" || m.posto == "TODOS" || m.posto == "TP") && reAtivaMed.MatchString(g) && !reGeraMed.MatchString(g) &&
				m.lant.Valid && m.latu.Valid && m.k.Valid && m.cons.Valid && m.latu.Float64 > m.lant.Float64 && m.k.Float64 > 0 &&
				math.Abs(m.cons.Float64/((m.latu.Float64-m.lant.Float64)*m.k.Float64)-1) <= 0.015 {
				totalFecha = true
			}
		}
		switch {
		case totalFecha && piorR != 0:
		case piorR > 1.5:
			out = append(out, Achado{"F20", "ALERTA", piorDet + " — diferença grande demais para constante errada: confira as leituras e a constante na fatura", 0, 0})
		case piorR > 1.04:
			nivel, val, det := nivelBase(f, piorExc*precoEnergia(f), "")
			out = append(out, Achado{"F20", nivel, piorDet + det, val, rnd2(piorExc)})
		case piorR > 1.015:
			out = append(out, Achado{"F20", "ALERTA", piorDet + " — diferença de até 4%: pode ser perda de transformação (2,5%) se a fatura indicar", 0, 0})
		case piorR > 0 && piorR < 0.985:
			out = append(out, Achado{"F20", "ALERTA", piorDet + " — consumo faturado abaixo do medido (a favor do cliente)", 0, 0})
		}
	}

	// F23 — ultrapassagem cobrada sem a medida passar de contratada × 1,05, ou kW acima do excesso
	if sel["F23"] && valorOK && !grupoB(f) && len(f.contr) > 0 {
		med := demandaMedida(f)
		for _, it := range f.itens {
			if it.comp != "DEMANDA_ULTRAPASSAGEM" || nv(it.valor) <= 0 || nv(it.qtd) <= 0 || reGeraMed.MatchString(strings.ToUpper(sem(it.desc))) {
				continue // ultrapassagem da demanda de GERAÇÃO (TUSDg) não se compara com a demanda de consumo
			}
			c, okC := doPosto(f.contr, it.posto)
			m, okM := doPosto(med, it.posto)
			if !okC || !okM {
				continue
			}
			q := nv(it.qtd)
			switch {
			case m <= c*1.05:
				nivel, val, det := nivelBase(f, nv(it.valor), "")
				out = append(out, Achado{"F23", nivel, fmt.Sprintf("%s: ultrapassagem de %.2f kW cobrada (R$ %.2f) com demanda medida %.2f kW ≤ contratada %.2f kW + 5%%%s",
					it.desc, q, nv(it.valor), m, c, det), val, 0})
			case q > (m-c)+0.5:
				exc := q - (m - c)
				nivel, val, det := nivelBase(f, exc*nv(it.valor)/q, "")
				out = append(out, Achado{"F23", nivel, fmt.Sprintf("%s: %.2f kW cobrados de ultrapassagem, mas medida %.2f − contratada %.2f = %.2f kW%s",
					it.desc, q, m, c, m-c, det), val, 0})
			}
		}
	}

	// F29 — estrutura dos itens incoerente com a modalidade impressa (Verde com demanda de ponta)
	// base extraída: posto/modalidade lidos errado geram milhares de falsos (2.135 na Energia em 05/11) — só na conferida
	if sel["F29"] && !f.extraida && !grupoB(f) && normModalidade(f.modalidade) == "Verde" {
		for _, it := range f.itens {
			if it.comp == "DEMANDA" && it.posto == "PONTA" && nv(it.valor) > 0 {
				out = append(out, Achado{"F29", "ALERTA", fmt.Sprintf("modalidade Verde com demanda de ponta cobrada (%s, R$ %.2f) — a Verde tem uma demanda única; confira a modalidade contratada", it.desc, nv(it.valor)), 0, 0})
				break
			}
		}
		if v, ok := f.contr["PONTA"]; ok && v > 0 && len(out) == 0 {
			if fp, ok2 := f.contr["FORA_PONTA"]; ok2 && fp > 0 && fp != v {
				out = append(out, Achado{"F29", "ALERTA", fmt.Sprintf("modalidade Verde com duas demandas contratadas (ponta %.0f kW, fora ponta %.0f kW) — estrutura de Azul", v, fp), 0, 0})
			}
		}
	}

	// F38 — base do ICMS inclui multa/juros/correção (base impressa = itens + não tributáveis)
	if sel["F38"] && valorOK {
		for _, t := range f.tribs {
			if !strings.HasPrefix(strings.ToUpper(t.nome), "ICMS") || t.base <= 0 || t.retido {
				continue
			}
			nt, todos := 0.0, 0.0
			for _, it := range f.itens {
				v := nv(it.valor)
				if it.comp == "ILUMINACAO_PUBLICA" || it.comp == "TRIBUTO" || it.comp == "INFO" {
					continue
				}
				if it.comp == "MULTA" || it.comp == "JUROS" || it.comp == "ATUALIZACAO_MONETARIA" || reNaoTribut.MatchString(strings.ToUpper(sem(it.desc))) {
					if v > 0 {
						nt += v
					}
				}
				todos += v
			}
			if nt > 0.10 && math.Abs(t.base-todos) <= 0.10 && math.Abs(t.base-(todos-nt)) > 0.10 {
				nivel, val, det := nivelBase(f, nt*t.aliq/100, "")
				out = append(out, Achado{"F38", nivel, fmt.Sprintf("base do ICMS R$ %.2f = soma dos itens com multa/juros/correção (R$ %.2f não tributáveis) — ICMS de %.2f%% sobre eles%s", t.base, nt, t.aliq, det), val, 0})
			}
			break
		}
	}

	// F39 — valor do tributo ≠ base × alíquota (> R$ 0,10); PIS/COFINS acima do teto do regime
	if sel["F39"] {
		pior, det, soPisCofins := 0.0, "", true
		for _, t := range f.tribs {
			if t.retido || t.base <= 0 || t.aliq <= 0 || t.valor <= 0 || t.aliq >= 40 {
				continue
			}
			calc := t.base * t.aliq / 100
			if f.extraida && (t.valor > 1.5*calc || t.valor < calc/1.5) {
				continue // base de outro tributo / colunas trocadas na extração
			}
			if d := t.valor - calc; d > 0.10 && d > 0.002*t.valor && !potencia10(t.valor, calc) && d > pior {
				pior = d
				soPisCofins = strings.HasPrefix(t.nome, "PIS") || strings.HasPrefix(t.nome, "COFINS")
				det = fmt.Sprintf("%s: valor R$ %.2f × base R$ %.2f × %.4f%% = R$ %.2f", t.nome, t.valor, t.base, t.aliq, calc)
			}
		}
		if pior > 0 {
			nivel, val, ex := nivelBase(f, pior, "")
			if soPisCofins { // a alíquota de PIS/COFINS impressa é a efetiva do mês, arredondada — a conta não fecha exata
				nivel, val, ex = "ALERTA", 0, " — PIS/COFINS: a alíquota impressa é a efetiva do mês (arredondada); confira o cálculo por item"
			}
			out = append(out, Achado{"F39", nivel, det + ex, val, 0})
		}
		for _, t := range f.tribs {
			n := strings.ToUpper(t.nome)
			if (strings.HasPrefix(n, "PIS") && t.aliq > 1.65) || (strings.HasPrefix(n, "COFINS") && t.aliq > 7.6) {
				out = append(out, Achado{"F39", "ALERTA", fmt.Sprintf("%s com alíquota %.4f%% — acima do teto do regime não cumulativo (PIS 1,65%%, COFINS 7,6%%)", t.nome, t.aliq), 0, 0})
				break
			}
		}
	}

	// F44 — GD: bandeira cobrada sobre o consumo bruto, e não sobre o líquido (consumo − compensado)
	if sel["F44"] && valorOK && !acl {
		comp := 0.0
		for _, it := range f.itens {
			if it.comp == "CONSUMO_COMPENSADO" && it.qtd.Valid {
				comp = math.Max(comp, math.Abs(it.qtd.Float64))
			}
		}
		if c2, ok := somaGD(f, "compensada"); ok && c2 > comp {
			comp = c2
		}
		bruto := consumoAtivo(f)
		bandNeg := false
		for _, it := range f.itens {
			if it.comp == "BANDEIRA" && nv(it.valor) < 0 {
				bandNeg = true // a bandeira da energia compensada já volta como crédito
			}
		}
		if comp > 1 && bruto > comp && !bandNeg {
			for _, it := range f.itens {
				if it.comp != "BANDEIRA" || nv(it.valor) <= 0 || nv(it.qtd) <= 0 {
					continue
				}
				if cor := corBandeira(it.desc); cor == "VERDE" {
					continue
				}
				if math.Abs(nv(it.qtd)-bruto) <= 1 {
					tar := nv(it.valor) / nv(it.qtd)
					nivel, val, det := nivelBase(f, comp*tar, "")
					out = append(out, Achado{"F44", nivel, fmt.Sprintf("%s sobre %.0f kWh (consumo bruto), com %.0f kWh compensados — a base seria %.0f kWh%s",
						it.desc, nv(it.qtd), comp, bruto-comp, det), val, 0})
					break
				}
			}
		}
	}

	// F46 (CDE Escassez) e F45 (CDE Covid) — regras_componentes.go, com o componente homologado da ANEEL
	return out
}

// ---------------------------------------------------------------- regras com o histórico da UC

func mesSeguinte(m string, n int) string {
	t, err := time.Parse("2006-01", m)
	if err != nil {
		return ""
	}
	return t.AddDate(0, n, 0).Format("2006-01")
}

// semLeitura — o mês foi faturado sem leitura real (média, estimativa ou impedimento) e a base não diz o contrário
func semLeitura(f *uFat) bool { return f.justLeitura && !f.leituraReal }

// consumo do mês para comparação histórica (o da fatura; sem itens, o total da base)
func consumoHist(f *uFat) float64 {
	if c := consumoAtivo(f); c > 0 {
		return c
	}
	return f.kwhRef
}

func regrasExtraHistorico(fats map[string]*uFat, sel map[string]bool) map[string][]Achado {
	out := map[string][]Achado{}
	if !(sel["F10"] || sel["F11"] || sel["F19"] || sel["F21"] || sel["F24"] || sel["F26"] || sel["F48"] || sel["F49"]) {
		return out
	}
	porUC := map[string][]*uFat{}
	for _, f := range fats {
		porUC[f.chave] = append(porUC[f.chave], f)
	}
	for _, lst := range porUC {
		sort.Slice(lst, func(i, j int) bool { return lst[i].mes < lst[j].mes })
		// um registro por mês (a 1ª fatura do mês; refaturamentos ficam fora da série)
		var serie []*uFat
		for _, f := range lst {
			if len(serie) == 0 || serie[len(serie)-1].mes != f.mes {
				serie = append(serie, f)
			}
		}
		media := func(i int, excluirJust bool) (float64, int) {
			s, n := 0.0, 0
			for j := i - 1; j >= 0 && n < 12; j-- {
				if excluirJust && serie[j].justLeitura {
					continue
				}
				if c := consumoHist(serie[j]); c > 0 {
					s += c
					n++
				}
			}
			if n == 0 {
				return 0, 0
			}
			return s / float64(n), n
		}
		evento := func(i int) bool { // troca de medidor: indicada na fatura ou número do medidor mudou
			f := serie[i]
			if f.trocaMed {
				return true
			}
			// número do medidor mudou e ficou: igual nos 2 meses antes e no mês seguinte (a extração às vezes lê
			// o número de outro registrador e "troca" o medidor todo mês)
			if i < 2 || i+1 >= len(serie) || serie[i-1].medidor == "" || f.medidor == "" {
				return false
			}
			return !mesmoMedidor(serie[i-1].medidor, f.medidor) && mesmoMedidor(serie[i-2].medidor, serie[i-1].medidor) &&
				mesmoMedidor(serie[i+1].medidor, f.medidor)
		}
		run := 0
		for i, f := range serie {
			// F10 — mês faturado pela média com valor acima da média dos 12 ciclos com leitura real
			if sel["F10"] && semLeitura(f) {
				if m, n := media(i, true); n >= 3 && m > 0 {
					c := consumoHist(f)
					d := c/m - 1
					switch {
					case d > 0.10 && n >= 12:
						nivel, val, det := nivelBase(f, (c-m)*precoEnergia(f), "")
						out[f.id] = append(out[f.id], Achado{"F10", nivel, fmt.Sprintf("mês faturado pela média/estimativa com %.0f kWh, %.0f%% acima da média de %d ciclos com leitura (%.0f kWh)%s", c, d*100, n, m, det), val, rnd2(c - m)})
					case d > 0.05:
						out[f.id] = append(out[f.id], Achado{"F10", "ALERTA", fmt.Sprintf("mês faturado pela média/estimativa com %.0f kWh, %.0f%% acima da média de %d ciclos com leitura (%.0f kWh)%s", c, d*100, n, m,
							map[bool]string{true: " — histórico com menos de 12 ciclos", false: ""}[n < 12]), 0, 0})
					}
				}
			}
			// F11 — 3 ou mais ciclos consecutivos sem leitura real
			switch {
			case !semLeitura(f):
				run = 0
			case i > 0 && semLeitura(serie[i-1]) && mesSeguinte(serie[i-1].mes, 1) == f.mes:
				run++
			default:
				run = 1
			}
			if sel["F11"] && run == 3 { // um apontamento por sequência, no 3º ciclo, dizendo até onde ela vai
				fim := i
				for fim+1 < len(serie) && semLeitura(serie[fim+1]) && mesSeguinte(serie[fim].mes, 1) == serie[fim+1].mes {
					fim++
				}
				nivel := "ERRO"
				det := ""
				if f.extraida {
					nivel, det = "ALERTA", " — confira as marcas de leitura nas faturas"
				}
				out[f.id] = append(out[f.id], Achado{"F11", nivel, fmt.Sprintf("%d ciclos consecutivos sem leitura real (média/estimativa/impedimento) de %s a %s%s", fim-i+3, serie[i-2].mes, serie[fim].mes, det), 0, 0})
			}
			// F19 — reativo cobrado nos 3 ciclos seguintes à troca de medidor (período de teste do reativo)
			if sel["F19"] && evento(i) && !grupoB(f) {
				for j := i + 1; j < len(serie) && j <= i+3; j++ {
					if serie[j].mes > mesSeguinte(f.mes, 3) {
						break
					}
					q, v, ud := itensReativo(serie[j])
					if v+ud >= 10 { // centavos de reativo não justificam a conferência
						out[serie[j].id] = append(out[serie[j].id], Achado{"F19", "ALERTA", fmt.Sprintf("reativo excedente cobrado R$ %.2f (%.0f kvarh) no %dº ciclo depois da troca de medidor de %s — nos 3 primeiros ciclos o reativo só pode ser informado (REN 1000 art. 316); confira a data da troca na fatura",
							v+ud, q, j-i, f.mes), 0, 0})
					}
				}
			}
			// F21 — depois da troca de medidor o consumo passa a desviar mais de 50% da média e se mantém
			if sel["F21"] && evento(i) && i+2 < len(serie) {
				if m, n := media(i, true); n >= 3 && m > 0 {
					a, b := consumoHist(serie[i+1]), consumoHist(serie[i+2])
					da, db := a/m-1, b/m-1
					if a > 0 && b > 0 && math.Abs(da) > 0.5 && math.Abs(db) > 0.5 && (da > 0) == (db > 0) {
						out[serie[i+1].id] = append(out[serie[i+1].id], Achado{"F21", "ALERTA", fmt.Sprintf("depois da troca de medidor de %s o consumo foi %.0f e %.0f kWh × média anterior de %.0f kWh (%+.0f%% e %+.0f%%) — confira a constante (K.E) do medidor novo",
							f.mes, a, b, m, da*100, db*100), 0, 0})
					}
				}
			}
			// F24 — demanda contratada mudou sem padrão (fora da sazonalidade do mesmo mês do ano anterior)
			if sel["F24"] && !f.extraida && i >= 2 && !grupoB(f) {
				a, b, c := serie[i-2], serie[i-1], f
				for _, p := range []string{"PONTA", "FORA_PONTA", "UNICO"} {
					va, vb, vc := a.contr[p], b.contr[p], c.contr[p]
					if va <= 0 || vb <= 0 || vc <= 0 || va != vb || vc == vb || vc > 2*vb || vc < vb/2 {
						continue // 1000 → 30 kW não é aditivo: é outra grandeza lida como contratada
					}
					saz := false
					for j := i - 1; j >= 0; j-- {
						if serie[j].mes == mesSeguinte(c.mes, -12) && serie[j].contr[p] == vc {
							saz = true
						}
					}
					if !saz {
						out[c.id] = append(out[c.id], Achado{"F24", "ALERTA", fmt.Sprintf("demanda contratada %s mudou de %.0f para %.0f kW em %s (estável antes) — confira o aditivo do contrato",
							strings.ToLower(strings.ReplaceAll(p, "_", " ")), vb, vc, c.mes), 0, 0})
					}
				}
			}
			// F26 — contratada aumentou > 5% e há ultrapassagem nos 3 ciclos seguintes abaixo do limite do período de teste
			if sel["F26"] && i >= 1 && !grupoB(f) && !strings.Contains(strings.ToUpper(sem(f.classe)), "RURAL") {
				for _, p := range []string{"PONTA", "FORA_PONTA", "UNICO"} {
					ant, nova := serie[i-1].contr[p], f.contr[p]
					if ant <= 0 || nova <= ant*1.05 {
						continue
					}
					lim := nova + 0.05*ant + 0.30*(nova-ant)
					for j := i; j < len(serie) && j <= i+2; j++ {
						g := serie[j]
						med := demandaMedida(g)
						for _, it := range g.itens {
							if it.comp != "DEMANDA_ULTRAPASSAGEM" || nv(it.valor) <= 0 {
								continue
							}
							pp := it.posto
							if pp == "" || pp == "TODOS" {
								pp = "UNICO"
							}
							if pp != p && !(p == "UNICO" || pp == "UNICO") {
								continue
							}
							if m, ok := doPosto(med, it.posto); ok && m <= lim {
								out[g.id] = append(out[g.id], Achado{"F26", "ALERTA", fmt.Sprintf("ultrapassagem cobrada R$ %.2f no %dº ciclo depois do aumento da contratada (%.0f → %.0f kW em %s), com medida %.0f kW ≤ limite do período de teste %.0f kW — confira a data do aditivo",
									nv(it.valor), j-i+1, ant, nova, f.mes, m, lim), 0, 0})
							}
							break
						}
					}
				}
			}
			// F48 / F49 — DIC/FIC/DMIC acima do limite e nenhuma compensação na própria fatura e nas 2 seguintes
			if (sel["F48"] || sel["F49"]) && len(f.qual) > 0 {
				var viol []string
				dmic := false
				dicLim := map[string]float64{}
				for _, q := range f.qual {
					if strings.EqualFold(q.ind, "DIC") && q.lim > 0 {
						dicLim[q.periodo] = q.lim
					}
				}
				for _, q := range f.qual {
					fonteLim := ""
					if strings.EqualFold(q.ind, "DMIC") && q.lim <= 0 && q.apur > 0 {
						// limite do DMIC não impresso: o da mesma faixa do DIC impresso (PRODIST Módulo 8, Anexo 8.B)
						if l, tab, ok := dmicPeloDIC(f, dicLim[q.periodo]); ok {
							q.lim, fonteLim = l, " pelo Anexo 8.B do PRODIST ("+tab+", mesma faixa do DIC impresso)"
						}
					}
					if q.lim > 0 && q.apur > q.lim {
						ind := strings.ToUpper(q.ind)
						if ind == "DMIC" {
							dmic = true
						}
						if (ind == "DMIC" && sel["F49"]) || ((ind == "DIC" || ind == "FIC") && sel["F48"]) {
							viol = append(viol, fmt.Sprintf("%s %.2f > limite %.2f%s (%s)", ind, q.apur, q.lim, fonteLim, q.periodo))
						}
					}
				}
				if len(viol) > 0 {
					// período apurado (o quadro sai 1–2 meses depois) e o crédito: até 2 meses após a apuração
					per := ""
					for _, q := range f.qual {
						if pm := periodoMes(q.periodo); pm != "" {
							per = pm
							break
						}
					}
					if per == "" {
						per = mesSeguinte(f.mes, -2)
					}
					credito, n, achouComp := 0.0, 0, false
					var linhasComp []string
					for j := 0; j < len(serie); j++ {
						if serie[j].mes <= per || serie[j].mes > mesSeguinte(per, 3) {
							continue
						}
						n++
						for _, it := range serie[j].itens {
							d := strings.ToUpper(sem(it.desc))
							if strings.Contains(d, "BAND") || !(it.comp == "COMPENSACAO_CONTINUIDADE" || reCompCont.MatchString(d)) {
								continue
							}
							achouComp = true
							credito += math.Abs(nv(it.valor))
							linhasComp = append(linhasComp, fmt.Sprintf("%s R$ %.2f (%s)", strings.TrimSpace(it.desc), math.Abs(nv(it.valor)), serie[j].mes))
						}
					}
					// compensação devida (PRODIST Módulo 8, item 225) com o VRC da fatura do mês apurado
					fv := f
					for j := 0; j < len(serie); j++ {
						if serie[j].mes == per {
							fv = serie[j]
						}
					}
					// VRC: o impresso no quadro (do mês apurado) ou o calculado com o Fio B homologado da fatura daquele mês
					vrc, vrcDet, okVRC := f.vrcImpr, "impresso na fatura (Valor EUSD/VRC)", f.vrcImpr > 0
					if !okVRC {
						vrc, vrcDet, okVRC = vrcFioB(fv)
						vrcDet = "calculado: " + vrcDet
					}
					kei, tens := keiContinuidade(f)
					devida, qual := 0.0, ""
					if okVRC {
						dicP := dicLim[""]
						for _, q := range f.qual {
							if strings.EqualFold(q.ind, "DIC") && q.lim > 0 {
								dicP = q.lim
							}
						}
						for _, q := range f.qual {
							ind := strings.ToUpper(q.ind)
							lim := q.lim
							if ind == "DMIC" && lim <= 0 {
								lim, _, _ = dmicPeloDIC(f, dicP)
							}
							if lim <= 0 || q.apur <= lim {
								continue
							}
							c := 0.0
							switch ind {
							case "DIC", "DMIC":
								c = q.apur * vrc / 730 * kei
							case "FIC":
								if dicP > 0 {
									c = q.apur / lim * dicP * vrc / 730 * kei
								}
							}
							if c > devida {
								devida, qual = c, ind
							}
						}
						devida = math.Min(devida, 18*vrc)
					}
					cod := "F48"
					if dmic && !sel["F48"] || qual == "DMIC" && sel["F49"] {
						cod = "F49"
					}
					obs := ""
					if n < 3 {
						obs = fmt.Sprintf(" — a base tem só %d das 3 faturas dos meses seguintes à apuração: o crédito pode estar na que falta", n)
					}
					base := "indicador de continuidade acima do limite: " + strings.Join(viol, "; ")
					switch {
					case devida > 0 && !achouComp:
						det := fmt.Sprintf("%s — nenhuma compensação nas faturas até 2 meses após a apuração (%s); devida R$ %.2f pelo %s = %s × VRC R$ %.2f / 730 × kei %.0f (%s) — VRC %s (PRODIST Módulo 8, item 225)%s",
							base, per, devida, qual, qual+" apurado", vrc, kei, tens, vrcDet, obs)
						nivel, val, det := nivelBase(f, devida, det)
						if n < 3 {
							nivel, val = "ALERTA", 0
						}
						out[f.id] = append(out[f.id], Achado{cod, nivel, det, val, 0})
					// com crédito lançado não se acusa diferença: o VRC da distribuidora é o do ciclo que ela adota (item 227) —
					// a CPFL 4002914653 creditou R$ 176,90 = 15,82 × VRC impresso R$ 204,07 / 730 × 40, exato
					case devida == 0 && !achouComp:
						out[f.id] = append(out[f.id], Achado{cod, "ALERTA", fmt.Sprintf("%s — nenhuma compensação nas faturas até 2 meses após a apuração (%s)%s; sem o Fio B homologado da fatura não deu para calcular o valor",
							base, per, obs), 0, 0})
					}
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- regras com a tarifa/bandeira da ANEEL

// homLinha — tarifa homologada (R$/kWh, sem tributos) da linha TE/TUSD numa data; ok=false se não há
func homLinha(b *aneelBase, f *uFat, it uItem, mod, data string) (float64, string, string, bool) {
	if (it.comp != "TE" && it.comp != "TUSD") || !it.tsem.Valid || it.tsem.Float64 <= 0 || nv(it.qtd) <= 0 {
		return 0, "", "", false
	}
	d := strings.ToUpper(it.desc)
	if strings.Contains(d, "INJ") || strings.Contains(d, "COMP") || strings.Contains(d, "SCEE") {
		return 0, "", "", false
	}
	cands := b.tarifasVigentes(f.cnpj, f.subgrupo, mod, postoANEEL(it.posto), "MWh", "Não se aplica", data)
	if len(cands) == 0 && it.posto == "" {
		cands = b.tarifasVigentes(f.cnpj, f.subgrupo, mod, "", "MWh", "Não se aplica", data)
	}
	if len(cands) == 0 {
		return 0, "", "", false
	}
	soTUSD := strings.Contains(d, "TUSD") || strings.Contains(d, "USD")
	soTE := regexp.MustCompile(`(^|[^A-Z])TE([^A-Z]|$)`).MatchString(d)
	if soTE == soTUSD && it.comp == "TE" {
		soTE, soTUSD = true, false
	} else if soTE == soTUSD && it.comp == "TUSD" {
		soTE, soTUSD = false, true
	}
	h := 0.0
	for _, c := range cands {
		v := c.TE + c.TUSD
		if soTUSD && !soTE {
			v = c.TUSD
		} else if soTE && !soTUSD {
			v = c.TE
		}
		if v > h {
			h = v
		}
	}
	return h / 1000, cands[0].REH, cands[0].Inicio, h > 0
}

// perto — a tarifa cobrada bate com a homologada (como impressa: sem tributos, ou só sem ICMS), ±0,5%
func perto(t, hom, pisCofins float64) bool {
	if hom <= 0 {
		return false
	}
	for _, h := range []float64{hom, hom / (1 - math.Max(pisCofins, 0))} {
		if math.Abs(t-h) <= 0.005*h {
			return true
		}
	}
	return false
}

func diasData(a, b string) int {
	ta, e1 := time.Parse("2006-01-02", a)
	tb, e2 := time.Parse("2006-01-02", b)
	if e1 != nil || e2 != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

func regrasExtraAneel(f *uFat, b *aneelBase, sel map[string]bool) []Achado {
	var out []Achado
	if len(f.cnpj) != 14 || f.dLant == "" || f.dLatu == "" || f.dias < 10 || f.dias > 45 {
		return nil // só com as duas datas de leitura reais da fatura
	}
	mod := normModalidade(f.modalidade)
	if mod == "" && grupoB(f) {
		mod = "Convencional"
	}
	// F31 / F32 — ciclo atravessa um reajuste: tarifa deve ser a média ponderada por dias (REN 1000, Anexo I 3.4.1)
	if (sel["F31"] || sel["F32"]) && mod != "" && f.subgrupo != "" && b.rehMudou(f.cnpj, f.subgrupo, mod, f.dLant, f.dLatu) {
		n31, n32, tot31 := 0, 0, 0.0
		ex31, ex32 := "", ""
		porDesc := map[string]int{}
		compPosto := map[string]float64{} // kWh compensados (GD) por posto: a tarifa nova vale também no crédito
		for _, it := range f.itens {
			porDesc[it.comp+"|"+it.posto]++
			if (it.comp == "CONSUMO_COMPENSADO" || it.comp == "GD_INJETADA") && it.qtd.Valid {
				compPosto[it.posto] = math.Max(compPosto[it.posto], math.Abs(it.qtd.Float64))
			}
		}
		nComp := 0
		for _, it := range f.itens {
			if porDesc[it.comp+"|"+it.posto] > 1 {
				continue // a distribuidora já separou o ciclo em duas linhas (antes/depois do reajuste)
			}
			hAnt, _, _, ok1 := homLinha(b, f, it, mod, f.dLant)
			hNova, reh, ini, ok2 := homLinha(b, f, it, mod, f.dLatu)
			if !ok1 || !ok2 || math.Abs(hNova-hAnt) <= 0.0001 || ini <= f.dLant || ini > f.dLatu {
				continue
			}
			d1, d2 := diasData(f.dLant, ini), diasData(ini, f.dLatu)
			if d1 <= 0 || d2 <= 0 {
				continue
			}
			pond := (hAnt*float64(d1) + hNova*float64(d2)) / float64(d1+d2)
			t := it.tsem.Float64
			q := nv(it.qtd)
			if perto(t, pond, f.pisCofins) {
				continue
			}
			qLiq := math.Max(0, q-compPosto[it.posto])
			if perto(t, hNova, f.pisCofins) && hNova > hAnt && t > pond/(1-math.Max(f.pisCofins, 0))*1.005 && (hNova-pond)*qLiq <= 0.10 && (hNova-pond)*q > 0.10 {
				nComp++ // compensado pela GD com a mesma tarifa: o efeito líquido some
				if ex31 == "" {
					ex31 = fmt.Sprintf("%s: R$ %.6f/kWh = tarifa nova integral (%s, vigente de %s) num ciclo %s–%s; a ponderada por dias (%d antes, %d depois) seria R$ %.6f",
						it.desc, t, reh, ini, f.dLant, f.dLatu, d1, d2, pond)
				}
				continue
			}
			q = qLiq
			if perto(t, hNova, f.pisCofins) && hNova > hAnt && t > pond/(1-math.Max(f.pisCofins, 0))*1.005 && (hNova-pond)*q > 0.10 {
				n31++
				tot31 += (t - t*pond/hNova) * q
				if ex31 == "" {
					ex31 = fmt.Sprintf("%s: R$ %.6f/kWh = tarifa nova integral (%s, vigente de %s) num ciclo %s–%s; a ponderada por dias (%d antes, %d depois) seria R$ %.6f",
						it.desc, t, reh, ini, f.dLant, f.dLatu, d1, d2, pond)
				}
			} else if !perto(t, hAnt, f.pisCofins) && !perto(t, hNova, f.pisCofins) && t > pond/(1-pisCofinsMax)*1.005 && t < hNova/(1-pisCofinsMax)*1.25 {
				// acima da ponderada mesmo com o maior PIS/COFINS possível (sem ser a tarifa nova — F31 — nem erro de leitura)
				n32++
				if ex32 == "" {
					ex32 = fmt.Sprintf("%s: R$ %.6f/kWh × ponderada R$ %.6f (antiga R$ %.6f, nova R$ %.6f de %s; %d+%d dias)",
						it.desc, t, pond, hAnt, hNova, ini, d1, d2)
				}
			}
		}
		if sel["F31"] && n31 > 0 {
			nivel, val, det := nivelBase(f, tot31, "")
			out = append(out, Achado{"F31", nivel, fmt.Sprintf("%d item(ns) com o reajuste aplicado no ciclo inteiro (valor sobre os kWh não compensados pela GD). Ex.: %s%s", n31, ex31, det), val, 0})
		} else if sel["F31"] && nComp > 0 {
			out = append(out, Achado{"F31", "ALERTA", fmt.Sprintf("%d item(ns) com o reajuste aplicado no ciclo inteiro, mas o consumo foi todo compensado pela GD com a mesma tarifa (efeito líquido ≈ 0; pesa só se sobrar consumo). Ex.: %s", nComp, ex31), 0, 0})
		}
		if sel["F32"] && n32 > 0 {
			out = append(out, Achado{"F32", "ALERTA", fmt.Sprintf("%d item(ns) com tarifa diferente da média ponderada do ciclo que atravessa o reajuste. Ex.: %s — a fatura não detalha a proporcionalização", n32, ex32), 0, 0})
		}
	}
	// F43 — ciclo com meses de bandeiras diferentes e uma só linha de bandeira sobre todo o consumo
	if sel["F43"] {
		// dias de cada mês civil no ciclo
		ta, e1 := time.Parse("2006-01-02", f.dLant)
		tb, e2 := time.Parse("2006-01-02", f.dLatu)
		if e1 == nil && e2 == nil && tb.After(ta) {
			dias := map[string]int{}
			for d := ta.AddDate(0, 0, 1); !d.After(tb); d = d.AddDate(0, 0, 1) {
				dias[d.Format("2006-01")]++
			}
			cores := map[string]bool{}
			conhecidos := true
			adic := 0.0 // adicional esperado por kWh (R$/kWh) ponderado pelos dias
			tot := 0
			for m, n := range dias {
				bd, ok := b.bandeiras[m]
				if !ok {
					conhecidos = false
					break
				}
				cores[bd.Cor] = true
				adic += bd.Valor / 1000 * float64(n)
				tot += n
			}
			if conhecidos && len(cores) > 1 && tot > 0 {
				adic /= float64(tot)
				var linhas []uItem
				for _, it := range f.itens {
					if it.comp == "BANDEIRA" && nv(it.valor) > 0 && nv(it.qtd) > 0 {
						linhas = append(linhas, it)
					}
				}
				cons := consumoAtivo(f)
				compBand := false
				for _, it := range f.itens {
					if it.comp == "BANDEIRA" && nv(it.valor) < 0 {
						compBand = true
					}
				}
				if len(linhas) == 1 && cons > 0 && math.Abs(nv(linhas[0].qtd)-cons) <= math.Max(1, 0.02*cons) {
					it := linhas[0]
					cobrado := nv(it.valor)
					if !it.tarifa.Valid || it.tarifa.Float64 <= 0 || !it.tsem.Valid || it.tsem.Float64 <= 0 {
						return out // sem as duas tarifas da linha não dá para pôr o esperado com os mesmos tributos
					}
					esperado := adic * cons * it.tarifa.Float64 / it.tsem.Float64 // mesmos tributos da linha
					cs := make([]string, 0, len(dias))
					for m, n := range dias {
						cs = append(cs, fmt.Sprintf("%s %s (%d dias)", m, strings.ToLower(b.bandeiras[m].Cor), n))
					}
					sort.Strings(cs)
					if d := cobrado - esperado; d > 0.10 && d > 0.10*cobrado { // cobrança cheia × proporcional: ≥ 10% com 3+ dias de outra bandeira
						nivel, val, det := nivelBase(f, d, "")
						if compBand {
							nivel, val, det = "ALERTA", 0, " — a bandeira da energia compensada volta como crédito com a mesma tarifa; o efeito líquido pode ser menor"
						}
						out = append(out, Achado{"F43", nivel, fmt.Sprintf("uma linha de bandeira (%s, R$ %.2f) sobre todo o consumo de %.0f kWh num ciclo com %s — proporcional aos dias seria ≈ R$ %.2f%s",
							it.desc, cobrado, cons, strings.Join(cs, ", "), esperado, det), val, 0})
					}
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- dados extras de cada base

// lerExtrasUsina — Usinas (dados_json da extração visual): tributos com base/valor, demanda contratada, continuidade
func lerExtrasUsina(f *uFat, trib, dem, qual string) {
	var ts []struct {
		Tributo  string   `json:"tributo"`
		Base     *float64 `json:"base"`
		Aliquota *float64 `json:"aliquota"`
		Valor    *float64 `json:"valor"`
		Retido   bool     `json:"retido"`
	}
	if json.Unmarshal([]byte(trib), &ts) == nil {
		for _, t := range ts {
			if t.Base == nil || t.Aliquota == nil || t.Valor == nil {
				continue
			}
			f.tribs = append(f.tribs, uTrib{nome: strings.ToUpper(strings.TrimSpace(t.Tributo)), base: *t.Base, aliq: *t.Aliquota, valor: *t.Valor, retido: t.Retido})
		}
	}
	var ds []struct {
		Tipo   string   `json:"tipo"`
		Posto  *string  `json:"posto"`
		Contr  *float64 `json:"contratada_kw"`
		Rotulo string   `json:"rotulo"`
	}
	if json.Unmarshal([]byte(dem), &ds) == nil {
		for _, d := range ds {
			if d.Contr == nil || *d.Contr <= 0 || !strings.EqualFold(d.Tipo, "consumo") {
				continue
			}
			p := "UNICO"
			if d.Posto != nil {
				switch strings.ToUpper(sem(*d.Posto)) {
				case "PONTA":
					p = "PONTA"
				case "FORA_PONTA", "FORA PONTA", "FP":
					p = "FORA_PONTA"
				}
			}
			if f.contr == nil {
				f.contr = map[string]float64{}
			}
			if *d.Contr > f.contr[p] {
				f.contr[p] = *d.Contr
			}
		}
	}
	var qs []struct {
		Ind     string   `json:"indicador"`
		Periodo string   `json:"periodo_apuracao"`
		LimM    *float64 `json:"limite_mensal"`
		ApurM   *float64 `json:"apurado_mensal"`
		LimT    *float64 `json:"limite_trimestral"`
		ApurT   *float64 `json:"apurado_trimestral"`
		LimA    *float64 `json:"limite_anual"`
		ApurA   *float64 `json:"apurado_anual"`
	}
	if json.Unmarshal([]byte(qual), &qs) == nil {
		for _, q := range qs {
			for _, par := range [][2]*float64{{q.ApurM, q.LimM}, {q.ApurT, q.LimT}, {q.ApurA, q.LimA}} {
				if par[0] != nil && par[1] != nil && *par[1] > 0 {
					f.qual = append(f.qual, uQual{ind: strings.ToUpper(strings.TrimSpace(q.Ind)), periodo: q.Periodo, apur: *par[0], lim: *par[1]})
				}
			}
		}
	}
}

// lerTributosAcer — tabela de alíquotas da extração da Acer (descricao, base_calculo, aliquota, valor)
func lerTributosAcer(f *uFat, j map[string]any) {
	tb, ok := j["tbl_aliquotas|tabela"].(map[string]any)
	if !ok {
		return
	}
	ks := make([]string, 0, len(tb))
	for k := range tb {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	vistos := map[string]bool{}
	for _, k := range ks {
		t, _ := tb[k].(map[string]any)
		if t == nil {
			continue
		}
		n := strings.ToUpper(strings.ReplaceAll(fmt.Sprint(t["descricao"]), " ", ""))
		switch {
		case strings.HasPrefix(n, "ICMS"):
			n = "ICMS"
		case strings.HasPrefix(n, "PIS"):
			n = "PIS"
		case strings.HasPrefix(n, "COFINS"):
			n = "COFINS"
		default:
			continue
		}
		b, a, v := numJSON(t["base_calculo"]), numJSON(t["aliquota"]), numJSON(t["valor"])
		if vistos[n] || !b.Valid || !a.Valid || !v.Valid {
			continue
		}
		vistos[n] = true
		f.tribs = append(f.tribs, uTrib{nome: n, base: b.Float64, aliq: a.Float64, valor: v.Float64})
	}
}

// ativoNasLeituras — algum registrador de energia ATIVA (não injetada/gerada, não demanda) andou no ciclo:
// (leitura atual − anterior) × constante > 0
func ativoNasLeituras(f *uFat) bool {
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza))
		if !strings.Contains(g, "ATIV") || reGeraMed.MatchString(g) || strings.Contains(g, "DEMANDA") || strings.EqualFold(m.unid, "kW") {
			continue
		}
		if m.lant.Valid && m.latu.Valid && m.latu.Float64 > m.lant.Float64 {
			return true
		}
	}
	return false
}

// injetaGD — a UC injetou energia no ciclo (geração própria): o consumo pode vir abatido na fatura
func injetaGD(f *uFat) bool {
	for _, g := range f.gd {
		if strings.Contains(strings.ToLower(g.tipo), "injet") && nv(g.kwh) > 0 {
			return true
		}
	}
	for _, it := range f.itens {
		if it.comp == "GD_INJETADA" || it.comp == "DEMANDA_GERACAO" {
			return true
		}
	}
	return false
}
