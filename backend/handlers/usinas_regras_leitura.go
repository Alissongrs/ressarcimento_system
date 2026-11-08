package handlers

// Regras de ciclo e de leitura do medidor (F06 F07 F08 F33 F34) e a cobrança dupla disponibilidade + Fio B (F57).
// Valem para as três bases (usinas, energia, acer) — chamadas por aplicarRegrasComuns.
//
// Base extraída (Energia/Acer): data, número do medidor e leitura às vezes vêm lidos errado; por isso
//   - F33/F34 só usam o ciclo quando as datas batem com os "dias faturados" impressos ou com a leitura da
//     fatura anterior (as duas fontes concordam);
//   - F06/F07/F08 viram ALERTA ("confira na fatura");
//   - F57 vale como ERRO quando vem da nota fiscal (NF3e) na SEFAZ, que é a fonte de verdade dos itens.

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// diasEntre — dias entre duas datas "AAAA-MM-DD" (0 = sem as duas ou fora de ordem)
func diasEntre(a, b string) int {
	if a == "" || b == "" {
		return 0
	}
	ta, e1 := time.Parse("2006-01-02", a)
	tb, e2 := time.Parse("2006-01-02", b)
	if e1 != nil || e2 != nil || !tb.After(ta) {
		return 0
	}
	return int(math.Round(tb.Sub(ta).Hours() / 24))
}

var (
	reNaoAlnum   = regexp.MustCompile(`[^0-9A-Z]`)
	reSoDigito   = regexp.MustCompile(`[0-9]`)
	reNaoDigito2 = regexp.MustCompile(`[^0-9]`)
	reNumInicio  = regexp.MustCompile(`^[A-Z]{0,4}[0-9]{4,}`)
)

// normNumMedidor — número do medidor só com letras/dígitos, sem zeros à esquerda ("" = não serve para comparar).
// Texto colado depois do número ("400680327ENERGIAATIVAKWH…", extração da Acer) é cortado.
func normNumMedidor(s string) string {
	s = strings.TrimLeft(reNaoAlnum.ReplaceAllString(strings.ToUpper(strings.TrimSpace(s)), ""), "0")
	if m := reNumInicio.FindString(s); m != "" && len(s) > len(m)+3 {
		s = m
	}
	if len(reSoDigito.FindAllString(s, -1)) < 4 {
		return "" // sem 4 dígitos não é número de medidor ("ENERGIAKWH", "NIL"…)
	}
	return s
}

// mesmoMedidor — os dígitos são os mesmos, ou um termina com o outro (prefixo "PRD", dígito a mais lido na frente)
func mesmoMedidor(a, b string) bool {
	da, db := strings.TrimLeft(reNaoDigito2.ReplaceAllString(a, ""), "0"), strings.TrimLeft(reNaoDigito2.ReplaceAllString(b, ""), "0")
	return da == db || (len(da) >= 4 && len(db) >= 4 && (strings.HasSuffix(da, db) || strings.HasSuffix(db, da)))
}

var reNaoConsumo = regexp.MustCompile(`INJ|GERA|EXCE|EXC\b|REAT|RTV|KVA|UFER|UFDR|DEMANDA|\bDEM\b|\bDN\b|DMCR|DRE|ERE\b|\bKW\b|DATA|ADIMENS|HORA|FATOR`)

// registroAtivo — registrador acumulativo de energia ATIVA consumida (não injeção, reativo nem demanda)
func registroAtivo(m uMed) bool {
	g := strings.ToUpper(sem(m.grandeza))
	if m.unid != "" && !strings.EqualFold(m.unid, "kWh") && !strings.Contains(g, "KWH") {
		return false // (Light: "Energia Ativa-Kwh" com unidade gravada "kW" é registro de energia — 06/11/2026)
	}
	g = strings.ReplaceAll(g, "KWH", "")
	return !reNaoConsumo.MatchString(g)
}

func medidorAtivo(f *uFat) string {
	for _, m := range f.meds {
		if registroAtivo(m) {
			if n := normNumMedidor(m.medidor); n != "" {
				return n
			}
		}
	}
	return ""
}

// consumoFaturado — kWh de energia ativa cobrados (total da base ou soma dos itens)
func consumoFaturado(f *uFat) float64 {
	if f.kwhRef > 0 {
		return f.kwhRef
	}
	return consumoAtivo(f)
}

// consumoPosto — maior quantidade de TUSD/TE/CONSUMO do posto (FORA_PONTA inclui o posto único)
func consumoPosto(f *uFat, posto string) float64 {
	if posto == "" || posto == "UNICO" || posto == "TODOS" {
		posto = "FORA_PONTA"
	}
	v := 0.0
	for _, it := range f.itens {
		p := it.posto
		if p == "" || p == "UNICO" || p == "TODOS" {
			p = "FORA_PONTA"
		}
		if p == posto && (it.comp == "TUSD" || it.comp == "TE" || it.comp == "CONSUMO") && nv(it.qtd) > v {
			v = nv(it.qtd)
		}
	}
	return v
}

func kMed(m uMed) float64 {
	if k := nv(m.k); k > 0 {
		return k
	}
	return 1
}

func temLeituraAtiva(f *uFat) bool {
	for _, m := range f.meds {
		if registroAtivo(m) && ((m.lant.Valid && m.lant.Float64 > 0) || (m.latu.Valid && m.latu.Float64 > 0)) {
			return true
		}
	}
	return false
}

func nivelExtraida(f *uFat) string {
	if f.extraida {
		return "ALERTA"
	}
	return "ERRO"
}

var (
	reDisponib = regexp.MustCompile(`(?i)DISPONIB`)
	reMinimo   = regexp.MustCompile(`(?i)CONSUMO\s*M[IÍ]NIMO|COMPLEMENTO`)
	reFioB     = regexp.MustCompile(`(?i)FIO\s*-?\s*B\b`)
	// linha de bandeira ("Adicional Bandeira Vermelha", "Adic. B. Amarela"…)
	reBandeiraItem = regexp.MustCompile(`(?i)BANDEIRA|ADIC\.?\s*B\.?\s*(AMAR|VERM|ESCASS)|\bB\.?\s*(AMARELA|VERMELHA)`)
)

// regrasLeitura — F06 F07 F08 F33 F34 F57 (as que precisam do histórico olham as faturas vizinhas da UC)
func regrasLeitura(fats map[string]*uFat, sel map[string]bool) map[string][]Achado {
	out := map[string][]Achado{}
	if !(sel["F06"] || sel["F07"] || sel["F08"] || sel["F33"] || sel["F34"] || sel["F57"]) {
		return out
	}
	porUC := map[string][]*uFat{}
	for _, f := range fats {
		if sel["F07"] {
			if a, ok := regraF07(f); ok {
				out[f.id] = append(out[f.id], a)
			}
		}
		if sel["F57"] {
			if a, ok := regraF57(f); ok {
				out[f.id] = append(out[f.id], a)
			}
		}
		porUC[f.chave] = append(porUC[f.chave], f)
	}
	for _, lst := range porUC {
		sort.Slice(lst, func(i, j int) bool {
			if lst[i].mes != lst[j].mes {
				return lst[i].mes < lst[j].mes
			}
			return lst[i].latu < lst[j].latu
		})
		comLeitura := 0
		for _, f := range lst {
			if temLeituraAtiva(f) {
				comLeitura++
			}
		}
		for i, f := range lst {
			// fatura anterior / seguinte de OUTRO mês (refaturamento do mesmo mês não conta)
			var ant, prox *uFat
			for j := i - 1; j >= 0; j-- {
				if lst[j].mes < f.mes {
					ant = lst[j]
					break
				}
			}
			for j := i + 1; j < len(lst); j++ {
				if lst[j].mes > f.mes {
					prox = lst[j]
					break
				}
			}
			if sel["F06"] {
				if a, ok := regraF06(f, ant, prox, comLeitura); ok {
					out[f.id] = append(out[f.id], a)
				}
			}
			if sel["F08"] {
				if a, ok := regraF08(f, ant, prox); ok {
					out[f.id] = append(out[f.id], a)
				}
			}
			if sel["F33"] || sel["F34"] {
				if a, ok := regraCiclo(f, ant, prox, sel); ok {
					out[f.id] = append(out[f.id], a)
				}
			}
		}
	}
	return out
}

// F06 — sem leitura de energia ativa na fatura, consumo cobrado acima do mínimo e nenhuma justificativa
// (média/estimativa/impedimento). Só quando outras faturas da UC trazem a leitura (o layout tem o quadro).
func regraF06(f, ant, prox *uFat, comLeitura int) (Achado, bool) {
	if f.justLeitura || temLeituraAtiva(f) || comLeitura < 2 {
		return Achado{}, false
	}
	// base extraída: a fatura do mês anterior e a do seguinte trazem a leitura, do mesmo medidor
	// (a falta é só neste mês — senão é o layout que o extrator não lê)
	if f.extraida && (ant == nil || prox == nil || !temLeituraAtiva(ant) || !temLeituraAtiva(prox) ||
		ant.medidor == "" || !mesmoMedidor(ant.medidor, prox.medidor)) {
		return Achado{}, false
	}
	cons := consumoFaturado(f)
	minimo := minimoFaturavel(f) // Grupo A: 0
	if cons <= minimo+1 {
		return Achado{}, false
	}
	exc := cons - minimo
	// sempre ALERTA: a leitura pode estar na fatura e só não ter sido extraída (vale também para as usinas,
	// cuja extração também é automática) — a conferência visual decide
	return Achado{"F06", "ALERTA", fmt.Sprintf("fatura sem leitura do medidor e %.0f kWh cobrados (mínimo %.0f), sem indicação de média/estimativa — %d outras faturas da UC trazem a leitura; confira se o quadro de leituras está na fatura (se não estiver, %.0f kWh sem lastro)", cons, minimo, comLeitura, exc), 0, rnd2(exc)}, true
}

// F07 — virada do mostrador: leitura anterior perto do máximo (9.999 / 99.999 / 999.999…), atual perto de zero,
// e o faturado diferente do consumo da virada em mais de 1,5%
func regraF07(f *uFat) (Achado, bool) {
	if f.trocaMed {
		return Achado{}, false // troca de medidor é o F08
	}
	ativos := 0
	for _, m := range f.meds {
		if registroAtivo(m) {
			ativos++
		}
	}
	for _, m := range f.meds {
		if !registroAtivo(m) || m.arred || !m.lant.Valid || !m.latu.Valid {
			continue
		}
		la, lb := m.lant.Float64, m.latu.Float64
		if la < 1000 || lb >= la {
			continue
		}
		max := math.Pow(10, math.Floor(math.Log10(la))+1)
		if la < 0.9*max || lb >= 0.1*max {
			continue // queda sem virada é o F14
		}
		k := kMed(m)
		correto := (max - la + lb) * k
		fat := nv(m.cons)
		if !m.cons.Valid || fat == 0 {
			if ativos == 1 {
				fat = consumoFaturado(f)
			} else {
				fat = consumoPosto(f, m.posto)
			}
		}
		det := fmt.Sprintf("%s %s: leitura anterior %.0f → atual %.0f (virada do mostrador de %.0f): consumo correto (%.0f − %.0f + %.0f) × %.4g = %.0f kWh",
			m.grandeza, m.posto, la, lb, max-1, max, la, lb, k, correto)
		if fat <= 0 {
			return Achado{"F07", "ALERTA", det + " — não achei o kWh faturado para comparar", 0, 0}, true
		}
		d := fat - correto
		if math.Abs(d) <= 0.015*correto {
			return Achado{}, false // virada tratada
		}
		nivel, val, obs := nivelExtraida(f), 0.0, ""
		if f.extraida {
			obs = " — confira as leituras e a constante na fatura"
		} else if d < 0 {
			nivel, obs = "ALERTA", " — cobrado abaixo do consumo da virada"
		} else {
			val = rnd2(d * precoEnergia(f))
		}
		return Achado{"F07", nivel, fmt.Sprintf("%s; faturado %.0f kWh (diferença %+.0f kWh)%s", det, fat, d, obs), val, rnd2(math.Abs(d))}, true
	}
	return Achado{}, false
}

// F08 — troca de medidor: consumo negativo no medidor novo, ou o faturado diferente da soma dos trechos
// (dois medidores na fatura) / da diferença das leituras do novo em mais de 1,5%
func regraF08(f, ant, prox *uFat) (Achado, bool) {
	// dois medidores no mesmo posto dentro da fatura: os dois trechos estão impressos
	type trecho struct {
		med  string
		calc float64
	}
	porPosto := map[string][]trecho{}
	for _, m := range f.meds {
		if registroAtivo(m) && m.lant.Valid && m.latu.Valid && normNumMedidor(m.medidor) != "" {
			porPosto[m.posto] = append(porPosto[m.posto], trecho{normNumMedidor(m.medidor), (m.latu.Float64 - m.lant.Float64) * kMed(m)})
		}
	}
	for posto, ts := range porPosto {
		var meds []string // medidores distintos (o mesmo número com prefixo/dígito a mais conta uma vez)
		soma := 0.0
		for _, t := range ts {
			novo := true
			for _, x := range meds {
				if mesmoMedidor(x, t.med) {
					novo = false
				}
			}
			if novo {
				meds = append(meds, t.med)
			}
			soma += t.calc
		}
		if len(meds) < 2 {
			continue
		}
		fat := consumoPosto(f, posto)
		if len(porPosto) == 1 {
			fat = consumoFaturado(f)
		}
		if fat <= 0 || soma <= 0 || math.Abs(fat-soma) <= 0.015*soma {
			continue
		}
		nivel, val, obs := nivelExtraida(f), 0.0, ""
		if fat < soma {
			nivel, obs = "ALERTA", " — cobrado abaixo da soma dos trechos"
		} else if !f.extraida {
			val = rnd2((fat - soma) * precoEnergia(f))
		}
		return Achado{"F08", nivel, fmt.Sprintf("troca de medidor no ciclo (posto %s): soma dos trechos dos %d medidores = %.0f kWh × faturado %.0f kWh%s", sem(posto), len(meds), soma, fat, obs), val, rnd2(math.Abs(fat - soma))}, true
	}

	// troca entre a fatura anterior e esta: o novo número tem de continuar na fatura seguinte (senão é leitura errada)
	troca := f.trocaMed
	de := ""
	if !troca && ant != nil && f.medidor != "" && ant.medidor != "" && !mesmoMedidor(f.medidor, ant.medidor) &&
		(prox == nil || prox.medidor == "" || mesmoMedidor(prox.medidor, f.medidor)) {
		troca, de = true, ant.medidor
	}
	if !troca {
		return Achado{}, false
	}
	desc := "troca de medidor"
	if de != "" {
		desc = fmt.Sprintf("troca de medidor (%s → %s)", de, f.medidor)
	}
	ativos := 0
	for _, m := range f.meds {
		if registroAtivo(m) && m.lant.Valid && m.latu.Valid {
			ativos++
		}
	}
	for _, m := range f.meds {
		if !registroAtivo(m) || !m.lant.Valid || !m.latu.Valid {
			continue
		}
		la, lb := m.lant.Float64, m.latu.Float64
		if lb < la {
			return Achado{"F08", nivelExtraida(f), fmt.Sprintf("%s: %s %s com consumo negativo (leitura atual %.0f < anterior %.0f) — o medidor novo não foi zerado/ajustado", desc, m.grandeza, m.posto, lb, la), 0, 0}, true
		}
		calc := (lb - la) * kMed(m)
		fat := nv(m.cons)
		if !m.cons.Valid || fat == 0 {
			if ativos == 1 {
				fat = consumoFaturado(f)
			} else {
				fat = consumoPosto(f, m.posto)
			}
		}
		// + 1 unidade do mostrador (arredondamento); razão 10/100/1000 = casa decimal ou constante lida errado
		if fat > 0 && calc > 0 && math.Abs(fat-calc) > 0.015*calc+kMed(m) && !(f.extraida && potencia10(fat, calc)) {
			return Achado{"F08", "ALERTA", fmt.Sprintf("%s: a fatura só mostra as leituras do novo (%.6g → %.6g = %.0f kWh) e cobra %.0f kWh — confira se o trecho do medidor antigo foi somado certo", desc, la, lb, calc, fat), 0, rnd2(math.Abs(fat - calc))}, true
		}
	}
	return Achado{}, false
}

// F33 / F34 — ciclo de leitura abaixo de 15 dias ou acima de 33 (Grupo B) / 47 dias (qualquer grupo), sem exceção
// (ligação nova, encerramento, troca de medidor, mudança de grupo) — REN 1000, Arts. 260 e 261
func regraCiclo(f, ant, prox *uFat, sel map[string]bool) (Achado, bool) {
	d := f.dias
	// 34 dias pelas datas = 33 contando de outro jeito (inclui ou não o dia da leitura): tolerância de 1 dia
	if d <= 0 || (d >= 15 && d <= 34) {
		return Achado{}, false
	}
	// 1ª fatura da UC (ligação nova) ou a última da base (encerramento, ou o ciclo seguinte ainda não chegou): exceção
	if ant == nil || prox == nil {
		return Achado{}, false
	}
	curto := d < 15
	if (curto && !sel["F33"]) || (!curto && !sel["F34"]) {
		return Achado{}, false
	}
	if !curto && grupoB(f) == false && !f.grupoInferido && d <= 45 {
		return Achado{}, false // Grupo A: só o limite absoluto (46–47 alerta, > 47 erro)
	}
	cod := "F34"
	if curto {
		cod = "F33"
	}
	// as datas da base batem com outra fonte? (dias impressos ±1 ou a leitura atual da fatura anterior)
	confImpr := f.diasImpr > 0 && absInt(f.diasImpr-d) <= 1
	// continuidade: a leitura anterior desta é a atual da fatura anterior (datas da base, não as deduzidas)
	continuidade := ant.dLatu != "" && f.dLant != "" && (ant.dLatu == f.dLant || diasEntre(ant.dLatu, f.dLant) == 1)
	// troca de titular: o mês é partido em duas faturas (encerramento + ligação) — Cosern Senador I → ACER,
	// Enel RJ Goytacazes (06/11/2026)
	if outroTitular(f, ant) || outroTitular(f, prox) {
		return Achado{}, false
	}
	if f.diasImpr > 0 && absInt(f.diasImpr-d) >= 2 {
		if curto && f.diasImpr >= 15 && f.diasImpr <= 34 {
			return Achado{}, false // faturou o ciclo normal impresso; a "leitura anterior" é outra data (Equatorial GO: movimentação do medidor)
		}
		if f.extraida {
			return Achado{}, false // datas e dias impressos não batem: data lida errado
		}
		return Achado{cod, "ALERTA", fmt.Sprintf("ciclo de %d dias pelas datas (%s a %s) × %d dias impressos — confira as datas de leitura", d, br(f.dLant), br(f.dLatu), f.diasImpr), 0, 0}, true
	}
	if f.extraida && !confImpr && !continuidade {
		return Achado{}, false
	}
	// exceções que afastam o erro
	if f.trocaMed || (ant.medidor != "" && f.medidor != "" && !mesmoMedidor(ant.medidor, f.medidor)) {
		return Achado{}, false
	}
	if !ant.grupoInferido && !f.grupoInferido && ant.grupo != "" && f.grupo != "" && ant.grupo != f.grupo {
		return Achado{}, false
	}
	nivel, obs := "ERRO", ""
	switch {
	case !curto && (ant.justLeitura || f.justLeitura):
		nivel, obs = "ALERTA", " — leitura por média/estimativa no ciclo: a leitura real pode juntar meses"
	case f.extraida && !(confImpr && continuidade):
		nivel, obs = "ALERTA", " — confira as datas de leitura na fatura"
	}
	periodo := fmt.Sprintf("%s a %s", br(f.dLant), br(f.dLatu))
	if curto {
		val, kwh := 0.0, 0.0
		// cobrado só o mínimo (custo de disponibilidade) cheio num ciclo curto: devido o proporcional aos dias
		if minimo := minimoFaturavel(f); minimo > 0 && nivel == "ERRO" {
			if cons := consumoFaturado(f); cons > 0 && cons <= minimo+1 {
				kwh = minimo * (1 - float64(d)/30)
				if !f.extraida || f.itensOK {
					val = rnd2(kwh * precoEnergia(f))
				}
			}
		}
		return Achado{"F33", nivel, fmt.Sprintf("ciclo de %d dias (%s), abaixo do mínimo de 15 dias%s", d, periodo, obs), val, rnd2(kwh)}, true
	}
	lim := 47
	if grupoB(f) || f.grupoInferido {
		lim = 33
	}
	if d <= 47 && (!grupoB(f) || f.grupoInferido) {
		// Grupo A com 46–47 dias, ou grupo deduzido da classe: alerta
		if nivel == "ERRO" {
			nivel = "ALERTA"
		}
		if f.grupoInferido && obs == "" {
			obs = " — confira o grupo tarifário (Grupo B: máximo 33 dias)"
		}
	}
	exc := 0.0
	if cons := consumoFaturado(f); cons > 0 && d > lim {
		exc = cons * float64(d-lim) / float64(d)
	}
	return Achado{"F34", nivel, fmt.Sprintf("ciclo de %d dias (%s), acima do máximo de %d dias%s — o excesso de dias pode ter mudado faixa/bandeira; confira o valor", d, periodo, lim, obs), 0, rnd2(exc)}, true
}

// F57 — fatura de GD do Grupo B com custo de disponibilidade E Fio B cobrados
func regraF57(f *uFat) (Achado, bool) {
	if !grupoB(f) && !f.grupoInferido {
		return Achado{}, false
	}
	disp, fioB, minimo := 0.0, 0.0, false
	fonte := "itens da fatura"
	for _, it := range f.itens {
		v := nv(it.valor)
		if v <= 0 {
			continue
		}
		switch {
		case reFioB.MatchString(it.desc):
			fioB += v
		case reDisponib.MatchString(it.desc):
			disp += v
		case reMinimo.MatchString(it.desc):
			disp += v
			minimo = true
		}
	}
	sefaz := false
	if (disp <= 0 || fioB <= 0) && f.fioBSefaz > 0 && f.dispSefaz > 0 {
		// O "Fio B" da SEFAZ às vezes é outra coisa: na Energisa MT era a SOMA DAS BANDEIRAS (amarela 1,17 +
		// vermelha 3,42 = 4,59), conferido no dossiê da fatura 64239 em 03/11/2026. Não vale quando os itens
		// impressos fecham com o total e nenhum é Fio B, nem quando o valor bate com as linhas de bandeira.
		band := 0.0
		for _, it := range f.itens {
			if reBandeiraItem.MatchString(it.desc) && nv(it.valor) > 0 {
				band += nv(it.valor)
			}
		}
		if f.itensOK || (band > 0 && math.Abs(band-f.fioBSefaz) <= 0.02) {
			return Achado{}, false
		}
		disp, fioB, minimo, sefaz, fonte = f.dispSefaz, f.fioBSefaz, false, true, "nota fiscal (NF3e) na SEFAZ"
	}
	if disp <= 0 || fioB <= 0 {
		return Achado{}, false
	}
	// Soma = consumo não compensado × tarifa + Fio B; menor que a disponibilidade → só a disponibilidade era devida
	cons := consumoFaturado(f)
	comp, _ := somaGD(f, "compensada")
	soma := math.Max(0, cons-comp)*precoEnergia(f) + fioB
	indevido, qual := fioB, "o Fio B é indevido"
	if soma >= disp {
		indevido, qual = disp, "a disponibilidade é indevida"
	}
	det := fmt.Sprintf("custo de disponibilidade R$ %.2f e Fio B R$ %.2f na mesma fatura (%s) — cobra-se só o maior entre a disponibilidade e consumo + Fio B (R$ %.2f): %s", disp, fioB, fonte, soma, qual)
	nivel := "ERRO"
	if minimo {
		nivel, det = "ALERTA", det+" — a linha de \"consumo mínimo\" pode ser só o complemento até o mínimo"
	} else if sefaz {
		nivel, det = "ALERTA", det+" — a fatura impressa não discrimina o Fio B: confira na fatura se há essa linha"
	} else if f.extraida {
		nivel, det = "ALERTA", det+" — confira as duas linhas na fatura"
	}
	if nivel == "ALERTA" {
		indevido = 0
	}
	return Achado{"F57", nivel, det, rnd2(indevido), 0}, true
}

func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// br — "AAAA-MM-DD" → "DD/MM/AAAA"
func br(s string) string {
	if len(s) == 10 {
		return s[8:] + "/" + s[5:7] + "/" + s[:4]
	}
	return s
}

// outroTitular — a fatura vizinha é de outro titular (CPF/CNPJ diferente)
func outroTitular(f, g *uFat) bool {
	if g == nil {
		return false
	}
	a, b := soDigitos(f.titCNPJ), soDigitos(g.titCNPJ)
	return a != "" && b != "" && a != b
}
