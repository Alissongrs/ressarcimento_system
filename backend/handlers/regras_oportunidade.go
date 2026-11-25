package handlers

// Regras de OPORTUNIDADE (redução de custo) das usinas — 25/11/2026, a pedido da equipe (planilha da 1ª onda).
// Não são erro da distribuidora: a cobrança é devida, mas dá para deixar de pagar. Ficam com nível "OPORTUNIDADE",
// fora do valor dos erros e fora dos alertas (usinas_handler.go), para não virarem pedido de ressarcimento.
//   F65 reativo excedente cobrado        → banco de capacitores / ajuste do fator de potência do inversor
//   F66 multas, juros e atualização       → pagar em dia (o limite de 2% da multa não é julgado: a multa de uma
//                                            fatura pode somar mais de uma conta em atraso)
//   F67 ultrapassagem real de demanda     → readequar a demanda contratada (a ultrapassagem com a medida dentro da
//                                            contratada + 5% é cobrança indevida e fica na F23)

import (
	"database/sql"
	"fmt"
	"slices"
	"strings"
)

// linha do quadro de demanda (FATURA_USINA_DEMANDA): tipo consumo | geracao | injecao
type uDem struct {
	tipo, posto string
	ctr, med    sql.NullFloat64
}

const nivelOportunidade = "OPORTUNIDADE"

func brl2(v float64) string { return "R$ " + brNum(v, 2) }

func kwBR(v float64) string {
	return strings.Replace(strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", v), "0"), "."), ".", ",", 1)
}

func regrasOportunidade(f *uFat, sel map[string]bool) []Achado {
	var out []Achado
	itensDe := func(comps ...string) (lst []uItem, soma float64) {
		for _, it := range f.itens {
			if !it.valor.Valid || it.valor.Float64 <= 0 {
				continue
			}
			if slices.Contains(comps, it.comp) {
				lst = append(lst, it)
				soma += it.valor.Float64
			}
		}
		return
	}
	desc := func(lst []uItem) string {
		var p []string
		for _, it := range lst {
			p = append(p, fmt.Sprintf("%s %s", strings.TrimSpace(it.desc), brl2(it.valor.Float64)))
		}
		t := strings.Join(p, "; ")
		if len(t) > 300 {
			t = t[:300] + "…"
		}
		return t
	}
	if sel["F65"] {
		if lst, v := itensDe("REATIVO_EXCEDENTE", "REATIVO"); len(lst) > 0 {
			out = append(out, Achado{"F65", nivelOportunidade, "reativo excedente cobrado: " + desc(lst) +
				" — custo evitável com banco de capacitores ou ajuste do fator de potência do inversor", rnd2(v), 0})
		}
	}
	if sel["F66"] {
		if lst, v := itensDe("MULTA", "JUROS", "ATUALIZACAO_MONETARIA"); len(lst) > 0 {
			out = append(out, Achado{"F66", nivelOportunidade, "acréscimos por atraso no pagamento: " + desc(lst) +
				" — custo evitável pagando as faturas até o vencimento", rnd2(v), 0})
		}
	}
	if sel["F67"] && len(f.dems) > 0 {
		for _, it := range f.itens {
			if !it.valor.Valid || it.valor.Float64 <= 0 || (it.comp != "DEMANDA_ULTRAPASSAGEM" && it.comp != "DEMANDA_GERACAO_ULTRAPASSAGEM") {
				continue
			}
			tipo := "consumo"
			if strings.Contains(it.comp, "GERACAO") {
				tipo = "geracao"
			}
			var acima []string
			for _, d := range f.dems {
				if d.tipo == tipo && d.ctr.Valid && d.ctr.Float64 > 0 && d.med.Valid && d.med.Float64 > d.ctr.Float64*1.05+0.01 {
					acima = append(acima, fmt.Sprintf("medida %s kW × contratada %s kW", kwBR(d.med.Float64), kwBR(d.ctr.Float64)))
				}
			}
			if len(acima) == 0 {
				continue
			}
			out = append(out, Achado{"F67", nivelOportunidade, fmt.Sprintf("ultrapassagem de demanda de %s cobrada (%s %s) com a demanda medida acima da contratada + 5%% (%s) — avaliar aumentar a demanda contratada",
				map[string]string{"consumo": "consumo", "geracao": "geração/injeção"}[tipo], strings.TrimSpace(it.desc), brl2(it.valor.Float64),
				strings.Join(acima, "; ")), rnd2(it.valor.Float64), 0})
		}
	}
	return out
}

// carregarDemandaUsinas — quadro de demanda (FATURA_USINA_DEMANDA) das faturas carregadas; só quando a F67 está marcada
func carregarDemandaUsinas(db *sql.DB, fats map[string]*uFat) error {
	rows, err := db.Query(`SELECT id_fatura, COALESCE(tipo,''), COALESCE(posto,''), contratada_kw, medida_kw FROM FATURA_USINA_DEMANDA`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var d uDem
		if rows.Scan(&id, &d.tipo, &d.posto, &d.ctr, &d.med) == nil && fats[id] != nil {
			fats[id].dems = append(fats[id].dems, d)
		}
	}
	return rows.Err()
}
