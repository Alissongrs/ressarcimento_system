package handlers

// F63 — Enquadramento GD I / II / III (Lei 14.300/2022) — aba Usinas.
//
// A classe da GD é fixada pela data do pedido de acesso: até 07/01/2023 = GD I (sem Fio B até 2045); depois,
// GD II (Fio B escalonado: 15% 2023 … 90% 2028) ou GD III (minigeração > 500 kW em autoconsumo remoto ou
// compartilhada com um titular de 25% ou mais dos créditos: Fio B integral + 40% de outros componentes).
// A classe não muda com o tempo. Duas conferências:
//  1. mudança de classe na mesma UC — a fatura imprime uma classe e as seguintes outra (ALERTA, com o valor do
//     "Ajuste GD" cobrado depois da troca);
//  2. lista de GD da ANEEL (data/aneel_gd_usinas.json.gz, ferramentas/aneel_gd/montar.py): a lista não tem o
//     nº da UC — a usina casa com o empreendimento só quando município (do nome da usina) + raiz do CNPJ do
//     titular + potência (±10%) apontam UM empreendimento. Cadastro na ANEEL até 07/01/2023 e fatura como
//     GD II/III ou cobrando "Ajuste GD" → ERRO. (A data da ANEEL é a de atualização cadastral: data antiga prova
//     que a usina já existia; data recente não prova nada.)
//
// Conferido em 06/11/2026 (PDF): UC 686.062.017-87 (FIT Associação, Energisa MT) "Injetada GDI" em 07/2026 e
// "Injetada GDIII" + "Ajuste GDIII – TRF Reduzida (Lei 14.300/22)" R$ 627,68 em 08/2026.

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
	"unicode"

	"golang.org/x/text/unicode/norm"
)

//go:embed data/aneel_gd_usinas.json.gz
var aneelGDGZ []byte

type gdANEEL struct {
	C   string  `json:"c"`  // CodEmpreendimento
	A   string  `json:"a"`  // distribuidora (sigla ANEEL)
	UF  string  `json:"uf"` // UF
	M   string  `json:"m"`  // município (maiúsculas, sem acento)
	D   string  `json:"d"`  // CPF/CNPJ do titular (só dígitos)
	T   string  `json:"t"`  // DthAtualizaCadastralEmpreend (AAAA-MM-DD)
	Mo  string  `json:"mo"` // modalidade (Geração na própria UC, Autoconsumo remoto, Compartilhada…)
	Q   int     `json:"q"`  // UCs que recebem crédito
	P   float64 `json:"p"`  // potência instalada (kW)
	N   string  `json:"n"`  // titular
	Ref string  `json:"ref"`
}

var (
	gdOnce sync.Once
	gdIdx  map[string][]gdANEEL // município → empreendimentos
)

func gdPorMunicipio() map[string][]gdANEEL {
	gdOnce.Do(func() {
		gdIdx = map[string][]gdANEEL{}
		zr, err := gzip.NewReader(bytes.NewReader(aneelGDGZ))
		if err != nil {
			return
		}
		raw, err := io.ReadAll(zr)
		if err != nil {
			return
		}
		var l []gdANEEL
		if json.Unmarshal(raw, &l) != nil {
			return
		}
		for _, g := range l {
			gdIdx[g.M] = append(gdIdx[g.M], g)
		}
	})
	return gdIdx
}

var reUsinaMun = regexp.MustCompile(`^(?:UFV|CGH|PCH|UTE|EOL|BIO\w*)\s+(.+?)\s+\d+(?:\.\d+)?$`)

// municipioUsina — "UFV Diamantino 1.2" → "DIAMANTINO" (mesma regra de ferramentas/aneel_gd/montar.py)
func municipioUsina(p string) string {
	m := reUsinaMun.FindStringSubmatch(strings.TrimSpace(p))
	if m == nil {
		return ""
	}
	t := norm.NFKD.String(m[1])
	var b strings.Builder
	for _, r := range t {
		if r < 128 && !unicode.Is(unicode.Mn, r) {
			b.WriteRune(unicode.ToUpper(r))
		}
	}
	return strings.TrimSpace(b.String())
}

var (
	reClasseGD  = regexp.MustCompile(`(?i)GD[_ ]?(III|II|I)\b`)
	reInjetGD   = regexp.MustCompile(`(?i)INJETADA\s+GD\s?(III|II|I)\b`)
	reAjusteGD  = regexp.MustCompile(`(?i)AJUSTE\s+GD|LEI\s+14\.?300`)
	reCompGDDoc = regexp.MustCompile(`(?i)COMPENSA|INJETADA|SCEE`)
)

// classeGD — classe impressa: o campo "modalidade" da fatura; sem ele, o nome da linha da energia injetada
// ("Energia Atv Injetada GDIII - Ponta"). As linhas "Ajuste GDII" não definem a classe (aparecem em fatura GD III).
func classeGD(f *uFat) string {
	if m := reClasseGD.FindStringSubmatch(f.modGD); m != nil {
		return strings.ToUpper(m[1])
	}
	for _, it := range f.itens {
		if m := reInjetGD.FindStringSubmatch(it.desc); m != nil {
			return strings.ToUpper(m[1])
		}
	}
	return ""
}

// ajusteGD — R$ das linhas de Fio B da GD ("Ajuste GDIII – TRF Reduzida (Lei 14.300/22)")
func ajusteGD(f *uFat) float64 {
	s := 0.0
	for _, it := range f.itens {
		if reAjusteGD.MatchString(it.desc) && !reCompGDDoc.MatchString(it.desc) {
			if v := nv(it.valor); v > 0 {
				s += v
			}
		}
	}
	return s
}

func gdNum(c string) int { return map[string]int{"I": 1, "II": 2, "III": 3}[c] }

func regrasEnquadramento(fats map[string]*uFat, sel map[string]bool) map[string][]Achado {
	out := map[string][]Achado{}
	if !sel["F63"] {
		return out
	}
	// ---- 1. casamento usina × ANEEL (por usina = pasta)
	type usina struct {
		raizes map[string]bool
		pot    float64
	}
	us := map[string]*usina{}
	for _, f := range fats {
		if f.usina == "" {
			continue
		}
		u := us[f.usina]
		if u == nil {
			u = &usina{raizes: map[string]bool{}}
			us[f.usina] = u
		}
		if d := soDigitos(f.titCNPJ); len(d) == 14 {
			u.raizes[d[:8]] = true
		}
		u.pot = math.Max(u.pot, f.potGer)
	}
	casado := map[string]*gdANEEL{}
	idx := gdPorMunicipio()
	for nome, u := range us {
		if u.pot <= 0 || len(u.raizes) == 0 {
			continue
		}
		var achou []gdANEEL
		for _, g := range idx[municipioUsina(nome)] {
			if len(g.D) == 14 && u.raizes[g.D[:8]] && math.Abs(g.P-u.pot) <= 0.1*u.pot {
				achou = append(achou, g)
			}
		}
		if len(achou) == 1 {
			g := achou[0]
			casado[nome] = &g
		}
	}
	for _, f := range fats {
		g := casado[f.usina]
		if g == nil || g.T == "" || g.T > "2023-01-07" {
			continue
		}
		cl, aj := classeGD(f), ajusteGD(f)
		if cl != "II" && cl != "III" && aj == 0 {
			continue
		}
		det := fmt.Sprintf("a usina está na lista de GD da ANEEL (%s, %s, %s kW, titular %s) com cadastro de %s — antes de 07/01/2023, portanto GD I (isenta do Fio B até 2045)",
			g.C, g.Mo, brNum(g.P, 0), g.N, br(g.T))
		if cl != "" {
			det += fmt.Sprintf(", mas a fatura a trata como GD %s", cl)
		}
		if aj > 0 {
			det += fmt.Sprintf(" e cobra R$ %s de Ajuste GD (Fio B)", brNum(aj, 2))
		}
		nivel, v, d := nivelBase(f, aj, det)
		out[f.id] = append(out[f.id], Achado{Codigo: "F63", Nivel: nivel, Detalhe: d, Valor: v})
	}

	// ---- 2. classe impressa mudou na mesma UC
	porUC := map[string][]*uFat{}
	for _, f := range fats {
		if classeGD(f) != "" {
			porUC[f.chave] = append(porUC[f.chave], f)
		}
	}
	for _, lst := range porUC {
		sort.Slice(lst, func(i, j int) bool {
			return lst[i].mes < lst[j].mes || (lst[i].mes == lst[j].mes && lst[i].id < lst[j].id)
		})
		for i := 1; i < len(lst); i++ {
			ant, nova := classeGD(lst[i-1]), classeGD(lst[i])
			if ant == nova || lst[i-1].mes == lst[i].mes {
				continue
			}
			// a classe nova se mantém na fatura seguinte (ou esta é a última) — evita leitura errada de um mês
			if i+1 < len(lst) && classeGD(lst[i+1]) != nova {
				continue
			}
			f := lst[i]
			det := fmt.Sprintf("a fatura de %s enquadra a UC como GD %s e a de %s como GD %s — pela Lei 14.300 a classe é fixada pela data do pedido de acesso e não muda",
				mesBR(lst[i-1].mes), ant, mesBR(f.mes), nova)
			if gdNum(nova) > gdNum(ant) {
				det += "; a troca deixou o faturamento mais caro"
				if aj := ajusteGD(f); aj > 0 {
					det += fmt.Sprintf(" (R$ %s de Ajuste GD / Fio B neste mês", brNum(aj, 2))
					if a0 := ajusteGD(lst[i-1]); a0 > 0 {
						det += fmt.Sprintf(", contra R$ %s antes", brNum(a0, 2))
					}
					det += ")"
				}
			} else {
				det += "; a troca reduziu o faturamento (a classe anterior pode ter sido cobrada a mais)"
			}
			if nova == "III" {
				det += ". GD III só vale para minigeração acima de 500 kW em autoconsumo remoto ou compartilhada com um titular de 25% ou mais dos créditos"
			}
			if g := casado[f.usina]; g != nil {
				det += fmt.Sprintf(". Na ANEEL: %s, %s, %s kW, %d UC(s) recebendo crédito, cadastro de %s", g.C, g.Mo, brNum(g.P, 0), g.Q, br(g.T))
			}
			out[f.id] = append(out[f.id], Achado{Codigo: "F63", Nivel: "ALERTA", Detalhe: det + " — confira o parecer de acesso (data do protocolo) e o rateio"})
		}
	}
	return out
}

func soDigitos(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
