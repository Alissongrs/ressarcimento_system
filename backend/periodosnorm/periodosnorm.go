// Package periodosnorm normaliza o campo periodos_irregularidade para o formato
// canônico [{"ano":Y,"mes":M},...]. Intervalos ("até"/"a") são expandidos em todos
// os meses; aberto ("a atual fatura") vira [{"raw":"MM/AAAA em diante"}]; lixo ou
// texto inparseável é mantido como veio (não destrói dado). É idempotente.
//
// Pacote leaf (não importa handlers/v2) para ser usado por ambos sem ciclo.
package periodosnorm

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var reIso = regexp.MustCompile(`(\d{4})-(\d{1,2})(?:-\d{1,2})?`)
var reBr = regexp.MustCompile(`(\d{1,2})/(\d{1,2})/(\d{4})`)
var reMa = regexp.MustCompile(`(\d{1,2})/(\d{4})`)
var reRange = regexp.MustCompile(`(?i)^(.+?)\s+(?:at[eé]|a)\s+(.+)$`)
var reList = regexp.MustCompile(`(?i)\s+e\s+|,`)

type ym struct{ A, M int }

func intish(v interface{}) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}

func parseYM(t string) (ym, bool) {
	s := strings.TrimSpace(t)
	if m := reBr.FindStringSubmatch(s); m != nil {
		mo, _ := strconv.Atoi(m[2])
		a, _ := strconv.Atoi(m[3])
		return ym{a, mo}, true
	}
	if m := reIso.FindStringSubmatch(s); m != nil {
		a, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		return ym{a, mo}, true
	}
	if m := reMa.FindStringSubmatch(s); m != nil {
		mo, _ := strconv.Atoi(m[1])
		a, _ := strconv.Atoi(m[2])
		return ym{a, mo}, true
	}
	return ym{}, false
}

func mesesEntre(ini, fim ym) []ym {
	if fim.A < ini.A || (fim.A == ini.A && fim.M < ini.M) {
		return []ym{ini}
	}
	out := []ym{}
	a, mo, g := ini.A, ini.M, 0
	for (a < fim.A || (a == fim.A && mo <= fim.M)) && g < 360 {
		out = append(out, ym{a, mo})
		mo++
		g++
		if mo > 12 {
			mo = 1
			a++
		}
	}
	return out
}

// Normalizar recebe o valor cru de periodos_irregularidade (texto solto, [{"raw":...}]
// ou [{"ano","mes"}]) e devolve o JSON canônico. Preserva a entrada quando não há nada
// aproveitável (lixo/vazio).
func Normalizar(input string) string {
	in := strings.TrimSpace(input)
	if in == "" {
		return input
	}
	var texts []string
	pairs := map[ym]bool{}
	var itens []map[string]interface{}
	if err := json.Unmarshal([]byte(in), &itens); err == nil {
		for _, o := range itens {
			if raw, ok := o["raw"]; ok && raw != nil {
				texts = append(texts, fmt.Sprintf("%v", raw))
			} else if a, ok := intish(o["ano"]); ok {
				if m, ok := intish(o["mes"]); ok && m >= 1 && m <= 12 {
					pairs[ym{a, m}] = true
				}
			}
		}
	} else {
		texts = append(texts, in) // texto solto (form)
	}

	var aberto *ym
	txt := strings.TrimSpace(strings.Join(texts, " ; "))
	low := strings.ToLower(txt)
	if txt != "" && txt != "-" && low != "<na>" {
		for _, seg0 := range strings.Split(txt, ";") {
			seg := strings.TrimSpace(seg0)
			if seg == "" {
				continue
			}
			done := false
			if m := reRange.FindStringSubmatch(seg); m != nil {
				ini, iok := parseYM(m[1])
				fim, fok := parseYM(m[2])
				if iok && fok {
					for _, x := range mesesEntre(ini, fim) {
						pairs[x] = true
					}
					done = true
				} else if iok && strings.Contains(strings.ToLower(m[2]), "atual") {
					a := ini
					aberto = &a
					done = true
				}
			}
			if !done && (strings.Contains(strings.ToLower(seg), "atual") || strings.Contains(strings.ToLower(seg), "em diante")) {
				if d, ok := parseYM(seg); ok {
					a := d
					aberto = &a
					done = true
				}
			}
			if !done {
				for _, tok := range reList.Split(seg, -1) {
					if d, ok := parseYM(tok); ok {
						pairs[d] = true
					}
				}
			}
		}
	}

	if len(pairs) > 0 {
		list := make([]ym, 0, len(pairs))
		for k := range pairs {
			list = append(list, k)
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].A != list[j].A {
				return list[i].A < list[j].A
			}
			return list[i].M < list[j].M
		})
		out := make([]map[string]int, len(list))
		for i, k := range list {
			out[i] = map[string]int{"ano": k.A, "mes": k.M}
		}
		b, _ := json.Marshal(out)
		return string(b)
	}
	if aberto != nil {
		b, _ := json.Marshal([]map[string]string{{"raw": fmt.Sprintf("%02d/%d em diante", aberto.M, aberto.A)}})
		return string(b)
	}
	return input // lixo/vazio: preserva o original
}
