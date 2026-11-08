package handlers

// Regras com os COMPONENTES da tarifa homologada pela ANEEL (05/11/2026): F45 (CDE Covid), F46 (CDE Escassez
// Hídrica) e F56 (TUSD Fio B da GD II), e os limites do Anexo 8.B do PRODIST Módulo 8 para o DMIC (F49).
//
// Fonte dos componentes: dados abertos da ANEEL, conjunto "Componentes Tarifárias" (Tarifa de Aplicação, detalhe
// "Não se aplica"), 2022–2026, reduzido por ferramentas/aneel_componentes/montar.py para
// data/aneel_componentes.json.gz (componentes TE_CDE_COVID, TUSD_CDE_COVID e TUSD_FioB, R$/MWh e R$/kW).
//
// O que os dados mostraram (05/11/2026):
//   - a ANEEL não separa a CDE Escassez Hídrica: ela está dentro do componente "CDE Covid" (Copel 2023: linhas
//     Covid ≈ R$ 12,0 + Escassez ≈ R$ 5,4/MWh com tributos = TE_CDE_COVID R$ 13,5/MWh sem tributos). Por isso as
//     linhas Covid e Escassez da fatura são somadas por posto e comparadas com o componente.
//   - nos processos tarifários de 2025 o componente da TE ficou NEGATIVO (devolução — MP 1.212/2024) em todas as
//     distribuidoras olhadas; só a parcela da TUSD (cliente livre) segue pequena. Linha positiva de Covid/Escassez
//     em cliente cativo nessa vigência não tem amparo.
//   - Energisa MS: "Ajuste GDII - TRF Reduzida (Lei 14.300/22)" sem tributos = 45% (2025) e 60% (2026) do Fio B
//     homologado — a conta da F56 fecha na própria linha.

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed data/aneel_componentes.json.gz
var aneelComponentesGZ []byte

type compANEEL struct {
	C  string   `json:"c"`  // raiz do CNPJ (8 dígitos)
	I  string   `json:"i"`  // início da vigência
	F  string   `json:"f"`  // fim da vigência
	Sg string   `json:"sg"` // subgrupo
	M  string   `json:"m"`  // modalidade
	Cl string   `json:"cl"` // classe ("" = não se aplica)
	Sc string   `json:"sc"` // subclasse
	P  string   `json:"p"`  // posto: P, FP, "" (não se aplica) ou intermediário
	U  string   `json:"u"`  // MWh ou kW
	R  string   `json:"r"`  // resolução homologatória
	TE *float64 `json:"te_cde"`
	TU *float64 `json:"tusd_cde"`
	FB *float64 `json:"fiob"`
}

var (
	compOnce sync.Once
	compIdx  map[string][]compANEEL
)

func componentesANEEL() map[string][]compANEEL {
	compOnce.Do(func() {
		compIdx = map[string][]compANEEL{}
		zr, err := gzip.NewReader(bytes.NewReader(aneelComponentesGZ))
		if err != nil {
			return
		}
		raw, err := io.ReadAll(zr)
		if err != nil {
			return
		}
		var d struct {
			Linhas []compANEEL `json:"linhas"`
		}
		if json.Unmarshal(raw, &d) != nil {
			return
		}
		for _, l := range d.Linhas {
			compIdx[l.C] = append(compIdx[l.C], l)
		}
	})
	return compIdx
}

func fz(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// compVigente — linha de componentes da distribuidora vigente na data (subgrupo, modalidade, posto, unidade);
// prefere classe "não se aplica" e, no grupo B, a classe residencial/sem subclasse
func compVigente(cnpj, sg, mod, posto, unid, data string) (compANEEL, bool) {
	if len(cnpj) < 8 || data == "" {
		return compANEEL{}, false
	}
	sg = strings.ToUpper(strings.TrimSpace(sg))
	var best compANEEL
	nota := -1
	for _, l := range componentesANEEL()[cnpj[:8]] {
		if l.U != unid || !strings.EqualFold(l.Sg, sg) || data < l.I || data > l.F || l.P != posto {
			continue
		}
		if mod != "" && !strings.EqualFold(l.M, mod) {
			continue
		}
		n := 0
		if l.Cl == "" {
			n += 4
		} else if strings.HasPrefix(l.Cl, "Residencial") {
			n += 2
		}
		if l.Sc == "" || strings.Contains(l.Sc, "Residencial") && !strings.Contains(strings.ToUpper(l.Sc), "BAIXA") {
			n++
		}
		if strings.EqualFold(l.M, "Convencional") || strings.EqualFold(l.M, "Verde") {
			n++ // sem modalidade informada: a mais comum
		}
		if n > nota {
			best, nota = l, n
		}
	}
	if nota < 0 {
		return best, false
	}
	// a base da ANEEL tem lacunas (CPFL Santa Cruz 2026: Verde FP sem TE_CDE_COVID, Verde P sem TUSD_CDE_COVID);
	// a CDE é a mesma em todos os postos e modalidades da mesma resolução/subgrupo/classe → completa pelas irmãs.
	// O Fio B varia por posto e modalidade: não é completado.
	if best.TE == nil || best.TU == nil {
		for _, l := range componentesANEEL()[cnpj[:8]] {
			if l.U != "MWh" || l.I != best.I || l.F != best.F || l.Sg != best.Sg || l.Cl != best.Cl || l.Sc != best.Sc {
				continue
			}
			if best.TE == nil && l.TE != nil {
				best.TE = l.TE
			}
			if best.TU == nil && l.TU != nil {
				best.TU = l.TU
			}
		}
	}
	return best, true
}

// dataRef — data de referência do ciclo (leitura atual; sem ela, meio do mês de referência)
func dataRef(f *uFat) string {
	if f.dLatu != "" {
		return f.dLatu
	}
	if len(f.mes) == 7 {
		return f.mes + "-15"
	}
	return ""
}

// postoComp — posto do item no formato dos componentes (grupo B: não se aplica)
func postoComp(f *uFat, it uItem) string {
	if grupoB(f) {
		return ""
	}
	switch it.posto {
	case "PONTA":
		return "P"
	case "FORA_PONTA":
		return "FP"
	}
	d := strings.ToUpper(sem(it.desc))
	if reCompFP.MatchString(d) {
		return "FP"
	}
	if reCompP.MatchString(d) {
		return "P"
	}
	return "FP"
}

var (
	reCDECovid = regexp.MustCompile(`COVID|ESCASS`)
	reGDLei    = regexp.MustCompile(`GD\s*(I{1,3})\b.*14\.?300|14\.?300.*GD\s*(I{1,3})\b`)
	reGDTipo   = regexp.MustCompile(`GD\s*(I{1,3})\b`)
	reCompFP   = regexp.MustCompile(`F\.?\s*PONTA|FORA|\bFP\b|\bHFP\b|F\s*PTA`)
	reCompP    = regexp.MustCompile(`PONTA|\bP\b|\bHP\b|\bPTA\b`)
	reCDEEnc   = regexp.MustCompile(`CDE|ENC|CONTA|CTA`)
	reParteTE  = regexp.MustCompile(`^\[?TE\b|\bTE\b`)
	reLivre    = regexp.MustCompile(`\bACL\b|CCEE|MERCADO LIVRE|\bLIVRE\b`)
)

// pctFioB — fração do Fio B paga pela GD II no ano (Lei 14.300/2022, art. 27)
func pctFioB(ano string) float64 {
	switch {
	case ano <= "2022":
		return 0
	case ano == "2023":
		return 0.15
	case ano == "2024":
		return 0.30
	case ano == "2025":
		return 0.45
	case ano == "2026":
		return 0.60
	case ano == "2027":
		return 0.75
	case ano == "2028":
		return 0.90
	}
	return 1
}

func regrasComponentes(f *uFat, sel map[string]bool) []Achado {
	if !(sel["F45"] || sel["F46"] || sel["F56"]) || len(f.cnpj) < 8 {
		return nil
	}
	data := dataRef(f)
	if data == "" {
		return nil
	}
	var out []Achado
	// cliente livre: sem TE da distribuidora OU com energia do ACL/CCEE na fatura (a extração às vezes rotula a
	// TUSD de consumo como TE — Copel/CPFL Santa Cruz)
	acl, livre := true, false
	for _, it := range f.itens {
		d := strings.ToUpper(sem(it.desc))
		if (it.comp == "TE" && !strings.Contains(d, "TUSD") && !reCDECovid.MatchString(d)) || (it.comp == "CONSUMO" && nv(it.valor) > 0) {
			acl = false
		}
		if reLivre.MatchString(d) {
			livre = true
		}
	}
	acl = acl || livre
	mod := normModalidade(f.modalidade)
	if mod == "" && grupoB(f) {
		mod = "Convencional"
	}

	// F45 / F46 — linhas de CDE Covid e CDE Escassez (somadas por posto) × componente homologado
	// a conta usa só a própria linha (valor ÷ kWh): não depende de os itens fecharem com o total
	if sel["F45"] || sel["F46"] {
		type agg struct {
			v, q  float64
			esc   bool
			descs []string
			parte string // "TE", "TUSD" ou "" (linha única com as duas / sem indicação)
			n     int
		}
		por := map[string]*agg{}
		var ordem []string
		for _, it := range f.itens {
			d := strings.ToUpper(sem(it.desc))
			if !reCDECovid.MatchString(d) || strings.Contains(d, "BAND") || nv(it.valor) <= 0 || nv(it.qtd) <= 0 {
				continue
			}
			// "Escassez" até 04/2022 sem CDE/encargo/conta = bandeira Escassez Hídrica (set/2021–abr/2022)
			if strings.Contains(d, "ESCASS") && data < "2022-06" && !reCDEEnc.MatchString(d) {
				continue
			}
			un := nv(it.valor) / nv(it.qtd) * 1000
			if un > 200 {
				continue // quantidade e tarifa trocadas na extração
			}
			p := postoComp(f, it)
			a := por[p]
			if a == nil {
				a = &agg{}
				por[p] = a
				ordem = append(ordem, p)
			}
			a.v += nv(it.valor)
			a.q = math.Max(a.q, nv(it.qtd))
			a.esc = a.esc || strings.Contains(d, "ESCASS")
			pt := ""
			switch {
			case strings.Contains(d, "TUSD"):
				pt = "TUSD"
			case reParteTE.MatchString(d):
				pt = "TE"
			}
			if a.n == 0 {
				a.parte = pt
			} else if a.parte != pt {
				a.parte = ""
			}
			a.n++
			a.descs = append(a.descs, strings.TrimSpace(it.desc))
		}
		for _, p := range ordem {
			a := por[p]
			c, ok := compVigente(f.cnpj, f.subgrupo, mod, p, "MWh", data)
			if !ok && mod != "" {
				c, ok = compVigente(f.cnpj, f.subgrupo, "", p, "MWh", data)
			}
			if !ok {
				continue
			}
			te, tu := fz(c.TE), fz(c.TU)
			// ciclo que atravessa o processo tarifário: vale o maior dos dois componentes (pró-rata por dias)
			ini := f.dLant
			if ini == "" || f.dias < 10 || f.dias > 45 { // data anterior ausente ou lida errado (Copel 07/2025: = atual)
				if t, err := time.Parse("2006-01-02", data); err == nil {
					ini = t.AddDate(0, 0, -32).Format("2006-01-02")
				}
			}
			if ini != "" && ini < c.I {
				c0, ok0 := compVigente(f.cnpj, f.subgrupo, mod, p, "MWh", ini)
				if !ok0 && mod != "" {
					c0, ok0 = compVigente(f.cnpj, f.subgrupo, "", p, "MWh", ini)
				}
				if ok0 {
					te, tu = math.Max(te, fz(c0.TE)), math.Max(tu, fz(c0.TU))
				}
			}
			h, quem := te+tu, "TE + TUSD"
			switch a.parte {
			case "TE":
				h, quem = te, "a parcela da TE (a linha é da TE)"
			case "TUSD":
				h, quem = tu, "a parcela da TUSD (a linha é da TUSD)"
			}
			if acl {
				// cliente livre: paga a Conta-Covid/Escassez como encargo à parte (quota da ANEEL sobre o consumo, até
				// o processo de 2027), fora do componente da tarifa — o valor bate com TE + TUSD do cativo (2022–2024)
				// e segue depois da devolução da TE. Sem a quota do ACL não há o que comparar.
				continue
			}
			un := a.v / a.q * 1000
			maxUn := math.Max(0, h) * 1.45 // tributos (ICMS + PIS/COFINS) no máximo
			if un <= maxUn*1.03+0.5 {
				continue
			}
			exc := math.Min(a.v, (un-maxUn)*a.q/1000)
			if exc < 1 {
				continue
			}
			cod := "F45"
			if a.esc {
				cod = "F46"
			}
			if !sel[cod] {
				continue
			}
			det := fmt.Sprintf("%s R$ %.2f (%.0f kWh, R$ %.2f/MWh com tributos) — homologado no período (%s, vigência %s a %s): CDE na TE R$ %.2f + na TUSD R$ %.2f/MWh sem tributos; vale %s",
				strings.Join(a.descs, " + "), a.v, a.q, un, c.R, c.I, c.F, te, tu, quem)
			var nivel string
			var val float64
			if h <= 0.5 {
				det += " — o componente foi zerado/virou devolução no processo tarifário (MP 1.212/2024): a cobrança positiva não tem amparo"
				nivel, val, det = nivelBase(f, exc, det)
			} else {
				nivel, val = "ALERTA", 0
				det += fmt.Sprintf(" — a linha passa de R$ %.2f/MWh, que seria o homologado com tributos de até 45%%; confira a alíquota da fatura", maxUn)
			}
			out = append(out, Achado{cod, nivel, det, val, 0})
		}
	}

	// F56 — Fio B da GD II acima do percentual do ano × TUSD Fio B homologada; Fio B cobrado de GD I
	if sel["F56"] { // idem: só a própria linha
		for _, it := range f.itens {
			d := strings.ToUpper(sem(it.desc))
			gl := reGDLei.FindStringSubmatch(d)
			fioB := strings.Contains(d, "FIO B") || strings.Contains(d, "FIOB")
			if (gl == nil && !fioB) || nv(it.valor) <= 0 || nv(it.qtd) <= 0 {
				continue
			}
			tipo := ""
			if m := reGDTipo.FindStringSubmatch(d); m != nil {
				tipo = m[1]
			}
			if tipo == "I" {
				det := fmt.Sprintf("%s R$ %.2f — unidade GD I (protocolada até 07/01/2023) é isenta do Fio B até 2045 (Lei 14.300/2022, art. 26)", it.desc, nv(it.valor))
				nivel, val, det := nivelBase(f, nv(it.valor), det)
				out = append(out, Achado{"F56", nivel, det, val, 0})
				continue
			}
			if tipo != "II" {
				continue // GD III paga Fio B integral + 40% do Fio A + TFSEE + P&D: não conferido aqui
			}
			p := postoComp(f, it)
			ini := f.dLant
			if ini == "" {
				ini = data
			}
			cA, okA := compVigente(f.cnpj, f.subgrupo, mod, p, "MWh", ini)
			cB, okB := compVigente(f.cnpj, f.subgrupo, mod, p, "MWh", data)
			if !okA || !okB || fz(cA.FB) <= 0 || fz(cB.FB) <= 0 {
				continue
			}
			eA, eB := pctFioB(ini[:4])*fz(cA.FB)/1000, pctFioB(data[:4])*fz(cB.FB)/1000 // R$/kWh sem tributos
			teto := math.Max(eA, eB)
			t, comTrib := 0.0, false
			if it.tsem.Valid && it.tsem.Float64 > 0 {
				t = it.tsem.Float64
			} else if it.tarifa.Valid && it.tarifa.Float64 > 0 {
				t, comTrib = it.tarifa.Float64, true
			} else {
				t = nv(it.valor) / nv(it.qtd)
				comTrib = true
			}
			lim := teto * 1.015
			if comTrib {
				lim = teto * 1.45 * 1.015
			}
			if t <= lim+0.0005 {
				continue
			}
			exc := (t - lim) * nv(it.qtd)
			if exc < 1 {
				continue
			}
			det := fmt.Sprintf("%s: R$ %.6f/kWh%s sobre %.0f kWh — GD II paga %.0f%% do Fio B em %s: TUSD Fio B homologada R$ %.2f/MWh (%s) → R$ %.6f/kWh",
				it.desc, t, map[bool]string{true: " (com tributos)", false: " sem tributos"}[comTrib], nv(it.qtd), pctFioB(data[:4])*100, data[:4], fz(cB.FB), cB.R, eB)
			var nivel string
			var val float64
			if comTrib {
				nivel, val, det = "ALERTA", 0, det+" — a fatura não traz a tarifa sem tributos: confira"
			} else {
				nivel, val, det = nivelBase(f, exc, det)
			}
			out = append(out, Achado{"F56", nivel, det, val, 0})
		}
	}
	return out
}

// ---------------------------------------------------------------- limites individuais do PRODIST Módulo 8, Anexo 8.B

// tabelas 2 a 5 (redação da REN 1.137/2025): por faixa do limite anual do conjunto, limites MENSAIS de DIC, FIC e DMIC
type limInd struct{ dic, fic, dmic float64 }

var prodistTabelas = map[string][]limInd{
	"MT urbana":     {{3, 3, 3}, {5, 4, 5}, {7, 5, 6}, {9, 6, 7}, {10, 6, 8}, {12, 7, 8}},
	"MT não urbana": {{8, 4, 6}, {13, 5, 10}, {19, 7, 14}, {24, 8, 18}, {28, 9, 20}, {33, 10, 24}, {37, 11, 24}},
	"BT urbana":     {{4, 3, 3}, {7, 4, 5}, {10, 5, 7}, {12, 6, 9}, {14, 7, 10}, {15, 7, 12}, {18, 8, 12}, {21, 9, 12}},
	"BT não urbana": {{10, 4, 8}, {16, 6, 12}, {20, 7, 15}, {24, 8, 18}, {28, 9, 20}, {33, 10, 24}, {40, 12, 24}},
}

// dmicPeloDIC — limite mensal do DMIC deduzido do limite mensal do DIC impresso (DIC e DMIC seguem a mesma faixa
// do DEC do conjunto). Só devolve quando todas as linhas das tabelas da tensão que têm aquele DIC dão o mesmo DMIC.
func dmicPeloDIC(f *uFat, dic float64) (float64, string, bool) {
	if dic <= 0 {
		return 0, "", false
	}
	tens := []string{"MT urbana", "MT não urbana"}
	if grupoB(f) {
		tens = []string{"BT urbana", "BT não urbana"}
	}
	res, onde := -1.0, ""
	for _, t := range tens {
		for _, l := range prodistTabelas[t] {
			if math.Abs(l.dic-dic) < 0.01 {
				if res >= 0 && math.Abs(res-l.dmic) > 0.01 {
					return 0, "", false
				}
				res, onde = l.dmic, t
			}
		}
	}
	return res, onde, res > 0
}

// ---------------------------------------------------------------- compensação por violação de DIC/FIC/DMIC (F48/F49)
//
// PRODIST Módulo 8, item 225 (REN 956/2021, redação vigente):
//   CompDIC  = DICv × VRC/730 × kei1
//   CompDMIC = DMICv × VRC/730 × kei1
//   CompFIC  = (FICv/FICp) × DICp × VRC/730 × kei1
// VRC = encargo de uso do sistema de distribuição da parcela TUSD Fio B (EUSD-B) do mês de apuração (A1: ECCD-PB);
// kei1 = 34 (BT), 40 (MT), 108 (AT). Item 227: vale o indicador de MAIOR compensação; teto de 18 × VRC; mínimo R$ 0,01.

var reCompCont = regexp.MustCompile(`\b(DIC|FIC|DMIC|DICRI|DISE)\b|CONTINUIDADE|COMPENS\.?\s*IND`)

// keiContinuidade — coeficiente de majoração kei1 pela tensão (subgrupo)
func keiContinuidade(f *uFat) (float64, string) {
	if grupoB(f) {
		return 34, "baixa tensão"
	}
	switch strings.ToUpper(strings.TrimSpace(f.subgrupo)) {
	case "A1", "A2", "A3":
		return 108, "alta tensão"
	}
	return 40, "média tensão"
}

// vrcFioB — EUSD da parcela Fio B da fatura (R$, sem tributos): quantidades faturadas × componente TUSD Fio B homologado.
func vrcFioB(f *uFat) (vrc float64, det string, ok bool) {
	data := dataRef(f)
	if len(f.cnpj) < 8 || data == "" {
		return 0, "", false
	}
	mod := normModalidade(f.modalidade)
	if mod == "" && grupoB(f) {
		mod = "Convencional"
	}
	busca := func(posto, unid string) (compANEEL, bool) {
		for _, p := range []string{posto, ""} {
			for _, m := range []string{mod, ""} {
				if c, ok := compVigente(f.cnpj, f.subgrupo, m, p, unid, data); ok && c.FB != nil && *c.FB > 0 {
					return c, true
				}
			}
		}
		return compANEEL{}, false
	}
	pc := func(p string) string {
		switch p {
		case "PONTA":
			return "P"
		case "FORA_PONTA":
			return "FP"
		}
		return ""
	}
	tot, reh := 0.0, ""
	if grupoB(f) {
		kwh := consumoAtivo(f)
		c, ok := busca("", "MWh")
		if !ok || kwh <= 0 {
			return 0, "", false
		}
		return kwh * *c.FB / 1000, fmt.Sprintf("%.0f kWh × Fio B R$ %.2f/MWh (%s)", kwh, *c.FB, c.R), true
	}
	// grupo A: demanda (R$/kW) + energia da TUSD (R$/MWh), por posto — a maior quantidade de cada (sem duplicar linhas)
	// a maior linha de demanda de cada posto (a de "geração" sem ICMS também entra: a CPFL imprime VRC R$ 20.736,47
	// para 2.486 kW + 13 kW — UC 4003782925, 08/2025 — e a conta com a maior demanda deu R$ 20.680,86)
	dem, ene := map[string]float64{}, map[string]float64{}
	for _, it := range f.itens {
		d := strings.ToUpper(sem(it.desc))
		q := nv(it.qtd)
		if q <= 0 || nv(it.valor) <= 0 || strings.Contains(d, "ULTRAP") || strings.Contains(d, "REAT") {
			continue
		}
		switch it.comp {
		case "DEMANDA":
			dem[pc(it.posto)] = math.Max(dem[pc(it.posto)], q)
		case "TUSD":
			ene[pc(it.posto)] = math.Max(ene[pc(it.posto)], q)
		}
	}
	var partes []string
	for p, q := range dem {
		if c, ok := busca(p, "kW"); ok {
			tot += q * *c.FB
			reh = c.R
			partes = append(partes, fmt.Sprintf("%.0f kW × R$ %.2f", q, *c.FB))
		}
	}
	for p, q := range ene {
		if c, ok := busca(p, "MWh"); ok {
			tot += q * *c.FB / 1000
			reh = c.R
			partes = append(partes, fmt.Sprintf("%.0f kWh × R$ %.2f/MWh", q, *c.FB))
		}
	}
	if tot <= 0 {
		return 0, "", false
	}
	return tot, strings.Join(partes, " + ") + " (Fio B, " + reh + ")", true
}

// periodoMes — "12/2024", "2025-02", "Fev" … → "AAAA-MM" (vazio se não der)
func periodoMes(p string) string {
	p = strings.TrimSpace(p)
	if len(p) >= 7 && p[4] == '-' {
		return p[:7]
	}
	if len(p) == 7 && p[2] == '/' {
		return p[3:] + "-" + p[:2]
	}
	return ""
}

// numVRC — número do "VRC = R$ 13.894,12816" / "Valor EUSD/VRC: 156,13" (notação brasileira)
func numVRC(s string) float64 {
	m := reNumBR.FindString(s)
	if m == "" {
		return 0
	}
	var v float64
	fmt.Sscanf(strings.ReplaceAll(strings.ReplaceAll(m, ".", ""), ",", "."), "%g", &v)
	return v
}

var reNumBR = regexp.MustCompile(`[0-9][0-9.]*,[0-9]+`)

// ---------------------------------------------------------------- F64 — créditos de GD expirando / expirados

// regrasCreditosGD — quadro de créditos da fatura (usinas: FATURA_USINA_GD tipos "a_expirar" e "expirado"):
//   - créditos que expiram em até 2 meses depois do mês da fatura: oportunidade de redistribuir o rateio (ALERTA);
//   - créditos já expirados no mês com consumo cobrado sem compensação na mesma fatura (ALERTA — a distribuidora
//     deveria usar os créditos mais antigos primeiro).
func regrasCreditosGD(f *uFat, sel map[string]bool) []Achado {
	if !sel["F64"] || len(f.gd) == 0 || len(f.mes) != 7 {
		return nil
	}
	limite := mesSeguinte(f.mes, 2)
	aExp := map[string]float64{} // mês de expiração → kWh (somando os postos)
	expirado := 0.0
	for _, g := range f.gd {
		q := nv(g.kwh)
		if q <= 0 {
			continue
		}
		switch g.tipo {
		case "a_expirar":
			if len(g.ref) >= 7 && g.ref[:7] >= f.mes && g.ref[:7] <= limite {
				aExp[g.ref[:7]] += q
			}
		case "expirado":
			expirado += q
		}
	}
	var out []Achado
	if len(aExp) > 0 {
		meses := make([]string, 0, len(aExp))
		for m := range aExp {
			meses = append(meses, m)
		}
		sort.Strings(meses)
		var partes []string
		tot := 0.0
		for _, m := range meses {
			partes = append(partes, fmt.Sprintf("%s kWh em %s", brNum(aExp[m], 0), mesBR(m)))
			tot += aExp[m]
		}
		if tot >= 100 { // abaixo disso o crédito em jogo é irrisório
			out = append(out, Achado{"F64", "ALERTA", fmt.Sprintf("créditos de energia que expiram em até 2 meses: %s — se não forem usados, a energia gerada é perdida; dá para redistribuir o rateio entre as UCs beneficiárias antes da data (prazo de 60 meses, REN 1.000/2021)",
				strings.Join(partes, "; ")), 0, rnd2(tot)})
		}
	}
	if expirado >= 1 {
		naoComp := math.Max(0, consumoAtivo(f)-compensadoGD(f))
		det := fmt.Sprintf("%s kWh de créditos expiraram neste ciclo", brNum(expirado, 0))
		if naoComp > 0 {
			det += fmt.Sprintf(" enquanto a fatura cobrou %s kWh de consumo sem compensação — os créditos mais antigos deveriam ter sido usados antes de expirar", brNum(naoComp, 0))
		} else {
			det += " — confira se as UCs beneficiárias pagaram consumo sem compensação no período (os créditos deveriam ter sido usados)"
		}
		out = append(out, Achado{"F64", "ALERTA", det, 0, rnd2(expirado)})
	}
	return out
}

// compensadoGD — kWh compensados na fatura (quadro de GD; sem ele, as linhas de consumo compensado)
func compensadoGD(f *uFat) float64 {
	s := 0.0
	for _, g := range f.gd {
		if g.tipo == "compensada" {
			s += nv(g.kwh)
		}
	}
	if s > 0 {
		return s
	}
	for _, it := range f.itens {
		if it.comp == "CONSUMO_COMPENSADO" {
			s = math.Max(s, math.Abs(nv(it.qtd)))
		}
	}
	return s
}
