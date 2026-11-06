package handlers

// F22 — Divergência no RTC/RTP (medição indireta com transformadores de corrente e de potencial).
//
// Na medição indireta o medidor registra só uma fração da energia; a constante de faturamento é
// RTC × RTP × K do medidor. Duas conferências:
//  1. na fatura: a constante de energia ativa impressa tem de ser RTC × RTP × K (CEMIG imprime o K "Medidor 1,0" →
//     ERRO acima de 1,5%). Sem o K impresso (Copel), o K implícito (constante ÷ RTC × RTP) tem de ser o mesmo
//     das outras faturas da UC (ALERTA quando muda);
//  2. no histórico: a constante mudou de uma fatura para a seguinte (troca de TC/TP ou de medidor) e o consumo
//     do mês da troca e do seguinte desvia mais de 50% da média dos meses anteriores, no mesmo sentido, e o degrau
//     acompanha a mudança da constante (entre metade e o dobro dela) → ALERTA.
//
// Medição de 06/11/2026: 527 faturas das usinas com RTC/RTP (Copel 522, CEMIG 5) e 909 da CEMIG na Energia
// fecham a conta; a única troca de TC/TP (UC 702028901824, 360 → 140 em 09/2025) manteve o consumo no
// histórico, ou seja, a nova relação foi refletida na constante.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// lerTecnicoUsina — RTC, RTP e o K do medidor do quadro técnico da fatura (dados_json.unidade_consumidora.tecnico)
func lerTecnicoUsina(f *uFat, raw string) {
	if raw == "" || raw == "null" {
		return
	}
	var t struct {
		RTC        any `json:"rtc"`
		RTP        any `json:"rtp"`
		Constantes []struct {
			Valor    *float64 `json:"valor"`
			Grandeza string   `json:"grandeza"`
		} `json:"constantes"`
	}
	if json.Unmarshal([]byte(raw), &t) != nil {
		return
	}
	f.rtc, f.rtp = relacaoTrafo(t.RTC), relacaoTrafo(t.RTP)
	for _, c := range t.Constantes {
		g := strings.ToUpper(strings.TrimSpace(c.Grandeza))
		if c.Valor == nil || *c.Valor <= 0 {
			continue
		}
		switch g {
		case "MEDIDOR": // CEMIG: "Medidor 1,0" (o "Const Medidor" da DANF3E é a constante inteira, não o K)
			f.kMedidor = *c.Valor
		case "KWH":
			f.kTecKWh = *c.Valor
		}
	}
}

// relacaoTrafo — "15/5" → 3; "20125/115" → 175; 20 → 20
func relacaoTrafo(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		s := strings.ReplaceAll(strings.TrimSpace(x), " ", "")
		num := func(t string) float64 {
			if strings.Contains(t, ",") {
				t = strings.ReplaceAll(strings.ReplaceAll(t, ".", ""), ",", ".")
			}
			n, err := strconv.ParseFloat(t, 64)
			if err != nil {
				return 0
			}
			return n
		}
		if a, b, ok := strings.Cut(s, "/"); ok {
			if d := num(b); d > 0 {
				return num(a) / d
			}
			return 0
		}
		return num(s)
	}
	return 0
}

// constAtiva — constante de faturamento da energia ativa usada nos registradores (a das leituras)
func constAtiva(f *uFat) float64 {
	for _, m := range f.meds {
		g := strings.ToUpper(sem(m.grandeza))
		if reGeraMed.MatchString(g) || reDemMed.MatchString(g) || strings.EqualFold(m.unid, "kW") || reReatMed.MatchString(g) {
			continue
		}
		if reAtivaMed.MatchString(g) && m.k.Valid && m.k.Float64 > 0 {
			return m.k.Float64
		}
	}
	return f.kTecKWh
}

// valorMedido — R$ dos itens de consumo e demanda (o que a constante multiplica)
func valorMedido(f *uFat) float64 {
	s := 0.0
	for _, it := range f.itens {
		switch it.comp {
		case "TE", "TUSD", "CONSUMO", "DEMANDA":
			if v := nv(it.valor); v > 0 {
				s += v
			}
		}
	}
	return s
}

func difRel(a, b float64) float64 {
	if b == 0 {
		return math.Inf(1)
	}
	return math.Abs(a-b) / b
}

func regrasTransformacao(fats map[string]*uFat, sel map[string]bool) map[string][]Achado {
	out := map[string][]Achado{}
	if !sel["F22"] {
		return out
	}
	porUC := map[string][]*uFat{}
	for _, f := range fats {
		porUC[f.chave] = append(porUC[f.chave], f)
	}
	for _, lst := range porUC {
		sort.Slice(lst, func(i, j int) bool {
			return lst[i].mes < lst[j].mes || (lst[i].mes == lst[j].mes && lst[i].id < lst[j].id)
		})

		// 1. constante × RTC × RTP na própria fatura
		kImpl := map[float64]int{} // K implícito (arredondado) → nº de faturas da UC
		for _, f := range lst {
			if k := constAtiva(f); k > 0 && f.rtc > 0 && f.rtp > 0 {
				kImpl[math.Round(k/(f.rtc*f.rtp)*1e6)/1e6]++
			}
		}
		kModa, nModa := 0.0, 0
		for k, n := range kImpl {
			if n > nModa || (n == nModa && k < kModa) {
				kModa, nModa = k, n
			}
		}
		for _, f := range lst {
			k := constAtiva(f)
			if k <= 0 || f.rtc <= 0 || f.rtp <= 0 {
				continue
			}
			rel := f.rtc * f.rtp
			if f.kMedidor > 0 {
				esp := rel * f.kMedidor
				if difRel(k, esp) <= 0.015 {
					continue
				}
				valor := 0.0
				if k > esp {
					valor = valorMedido(f) * (1 - esp/k)
				}
				det := fmt.Sprintf("constante de energia ativa usada nas leituras %s, mas RTC %s × RTP %s × K do medidor %s = %s (diferença de %s%%)",
					brNum(k, 4), brNum(f.rtc, 2), brNum(f.rtp, 2), brNum(f.kMedidor, 4), brNum(esp, 4), brNum(difRel(k, esp)*100, 1))
				if k > esp {
					det += fmt.Sprintf(" — consumo e demanda faturados %s%% acima do medido", brNum((k/esp-1)*100, 1))
				} else {
					det += " — a distribuidora faturou a menos e pode cobrar retroativo"
				}
				nivel, v, d := nivelBase(f, valor, det)
				out[f.id] = append(out[f.id], Achado{Codigo: "F22", Nivel: nivel, Detalhe: d, Valor: v})
				continue
			}
			// sem o K impresso: o K implícito tem de ser o da UC nas outras faturas
			ki := k / rel
			if nModa >= 2 && kImpl[math.Round(ki*1e6)/1e6] < nModa && difRel(ki, kModa) > 0.015 {
				det := fmt.Sprintf("constante %s ÷ (RTC %s × RTP %s) = %s, mas nas outras %d faturas da UC essa razão é %s — a constante não acompanha os transformadores impressos",
					brNum(k, 4), brNum(f.rtc, 2), brNum(f.rtp, 2), brNum(ki, 6), nModa, brNum(kModa, 6))
				out[f.id] = append(out[f.id], Achado{Codigo: "F22", Nivel: "ALERTA", Detalhe: det + " — confira o quadro técnico na fatura"})
			}
		}

		// 2. troca de constante com degrau de consumo
		var serie []*uFat
		for _, f := range lst {
			if len(serie) == 0 || serie[len(serie)-1].mes != f.mes {
				serie = append(serie, f)
			}
		}
		for i := 1; i+1 < len(serie); i++ {
			kAnt, kNov := constAtiva(serie[i-1]), constAtiva(serie[i])
			if kAnt <= 0 || kNov <= 0 || difRel(kNov, kAnt) <= 0.015 || difRel(constAtiva(serie[i+1]), kNov) > 0.015 {
				continue // sem troca, ou a constante "nova" não se manteve no mês seguinte (leitura errada da extração)
			}
			s, n := 0.0, 0
			for j := i - 1; j >= 0 && n < 6; j-- {
				if semLeitura(serie[j]) {
					continue
				}
				if c := consumoHist(serie[j]); c > 0 {
					s += c
					n++
				}
			}
			if n < 3 {
				continue
			}
			media := s / float64(n)
			f0 := serie[i]
			c0, c1 := consumoHist(f0), consumoHist(serie[i+1])
			if c0 <= 0 || c1 <= 0 || semLeitura(serie[i]) {
				continue
			}
			d0, d1 := (c0-media)/media, (c1-media)/media
			if math.Abs(d0) <= 0.5 || math.Abs(d1) <= 0.5 || (d0 > 0) != (d1 > 0) {
				continue
			}
			// sazonalidade: com o mesmo mês do ano anterior na base, o desvio também tem de aparecer contra ele
			// (CPFL Santa Cruz 3095800807, 06/2023: média puxada pelo verão; contra 06/2022 o consumo era o mesmo)
			mesAno := mesSeguinte(f0.mes, -12)
			for j := i - 1; j >= 0; j-- {
				if serie[j].mes == mesAno {
					if ca := consumoHist(serie[j]); ca > 0 && !semLeitura(serie[j]) {
						if da := (c0 - ca) / ca; math.Abs(da) <= 0.5 || (da > 0) != (d0 > 0) {
							c0 = -1
						}
					}
					break
				}
			}
			if c0 < 0 {
				continue
			}
			// erro de TC/TP: o consumo anda junto com a constante (degrau entre metade e o dobro da mudança dela).
			// Degrau fora disso = constante mal lida pela extração (medido 06/11/2026: 1 → 210 com consumo −96%)
			if r := (c0 / media) / (kNov / kAnt); r < 0.5 || r > 2 {
				continue
			}
			f := serie[i]
			det := fmt.Sprintf("a constante mudou de %s para %s (× %s) e o consumo foi a %s kWh neste mês e %s kWh no seguinte, contra média de %s kWh em %d meses antes (%+.0f%% e %+.0f%%) — sem mudança de carga, a relação de TC/TP nova pode estar errada",
				brNum(kAnt, 4), brNum(kNov, 4), brNum(kNov/kAnt, 3), brNum(c0, 0), brNum(c1, 0), brNum(media, 0), n, d0*100, d1*100)
			det += fmt.Sprintf("; o degrau do consumo (× %s) acompanha a mudança da constante", brNum(c0/media, 2))
			for _, g := range []*uFat{f, serie[i+1]} { // recuperação de receita lançada junto (RGE 3095125563, 09/2023: "Parcela Art. 113 01/04")
				if v, d := retroativo(g); v > 0 {
					det += fmt.Sprintf("; a fatura de %s cobra retroativo (%s, R$ %s)", mesBR(g.mes), d, brNum(v, 2))
					break
				}
			}
			out[f.id] = append(out[f.id], Achado{Codigo: "F22", Nivel: "ALERTA", Detalhe: det + " — peça o laudo de inspeção da medição (TC/TP instalados) e confira a relação nova"})
		}
	}
	return out
}

var reRecupReceita = regexp.MustCompile(`(?i)ART\.?\s*113|RECUPERA[CÇ][AÃ]O\s+DE\s+(RECEITA|CONSUMO)|CONSUMO\s+N[AÃ]O\s+FATURADO|DIFEREN[CÇ]A\s+DE\s+(CONSUMO|FATURAMENTO)|RETROATIV`)

// retroativo — item de recuperação de receita (cobrança retroativa por faturamento a menos) na fatura
func retroativo(f *uFat) (float64, string) {
	for _, it := range f.itens {
		if reRecupReceita.MatchString(it.desc) && nv(it.valor) > 0 {
			return nv(it.valor), strings.TrimSpace(it.desc)
		}
	}
	return 0, ""
}
