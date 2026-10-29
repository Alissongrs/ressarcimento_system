package v2

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// formatarMesesReferencia converte periodos_irregularidade (JSON) em:
//  - array de strings já formatadas (mai/23, jun/23 ...)
//  - string humana pra exibir na UI (ex.: "mai/23, jun/23" ou "mai/23 até ago/23")
//
// Aceita 2 formatos que existem no banco:
//   [{"raw": "01/05/2023 até 01/07/2023"}]  (legado, texto livre)
//   [{"ano": "2024", "mes": "6"}]           (novo, estruturado)
//
// Se não conseguir parsear nada útil, retorna arr=nil, txt="".
func formatarMesesReferencia(jsonStr string) (arr []string, txt string) {
	jsonStr = strings.TrimSpace(jsonStr)
	if jsonStr == "" || jsonStr == "null" || jsonStr == "[]" {
		return nil, ""
	}

	var itens []map[string]interface{}
	if err := json.Unmarshal([]byte(jsonStr), &itens); err != nil {
		return nil, ""
	}
	if len(itens) == 0 {
		return nil, ""
	}

	labels := make([]string, 0, len(itens))
	// Detecta se tem "até" ou "a atual" no raw pra decidir separador final
	hasRange := false

	for _, it := range itens {
		labels = append(labels, formatarUmPeriodo(it, &hasRange)...)
	}
	if len(labels) == 0 {
		return nil, ""
	}

	// Dedup preservando ordem
	seen := map[string]bool{}
	uniq := labels[:0]
	for _, l := range labels {
		if !seen[l] {
			seen[l] = true
			uniq = append(uniq, l)
		}
	}
	labels = uniq

	// Se hasRange, mantém a formatação original do raw. Se não, ordena cronologicamente.
	if !hasRange && len(labels) > 1 && todasSaoMesAno(labels) {
		sortByMesAno(labels)
	}

	// Colapsa em faixa contígua? Se >= 3 meses consecutivos cronológicos, mostra "X até Y"
	if !hasRange && len(labels) >= 3 && todasSaoMesAno(labels) && ehContiguo(labels) {
		return labels, labels[0] + " até " + labels[len(labels)-1]
	}

	if hasRange || len(labels) == 1 {
		return labels, strings.Join(labels, ", ")
	}
	// 2 itens → "X e Y"; 3+ itens não contíguos → "X, Y, Z"
	if len(labels) == 2 {
		return labels, labels[0] + " e " + labels[1]
	}
	return labels, strings.Join(labels, ", ")
}

func formatarUmPeriodo(it map[string]interface{}, hasRange *bool) []string {
	// Formato estruturado {ano, mes}
	if ano, ok := getIntish(it["ano"]); ok {
		if mes, ok := getIntish(it["mes"]); ok && mes >= 1 && mes <= 12 {
			return []string{mesAnoLabel(mes, ano)}
		}
	}
	// Formato legado {raw: "..."}
	raw, _ := it["raw"].(string)
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "<NA>" {
		return nil
	}
	// Detecta indicadores de faixa/intervalo
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "até") || strings.Contains(lower, "ate") ||
		strings.Contains(lower, " a atual") || strings.Contains(lower, "atual fatura") {
		*hasRange = true
		return []string{normalizarRawRange(raw)}
	}
	// "01/05/2023 e 01/06/2023" ou "01/05/2023, 01/07/2023 e 01/08/2023"
	if strings.Contains(raw, " e ") || strings.Contains(raw, ",") {
		partes := regexp.MustCompile(`\s*(?:,|\se\s)\s*`).Split(raw, -1)
		out := []string{}
		for _, p := range partes {
			if l := parseSingleData(p); l != "" {
				out = append(out, l)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	// Data única (ISO "2023-05-01 00:00:00" ou BR "01/05/2023")
	if l := parseSingleData(raw); l != "" {
		return []string{l}
	}
	// Fallback: devolve o texto literal
	return []string{raw}
}

// parseSingleData tenta reconhecer uma data ISO ou BR e devolve "mmm/aa".
func parseSingleData(s string) string {
	s = strings.TrimSpace(s)
	// ISO YYYY-MM-DD
	if m := regexp.MustCompile(`^(\d{4})-(\d{1,2})-\d{1,2}`).FindStringSubmatch(s); m != nil {
		ano, _ := strconv.Atoi(m[1])
		mes, _ := strconv.Atoi(m[2])
		return mesAnoLabel(mes, ano)
	}
	// BR DD/MM/YYYY
	if m := regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})`).FindStringSubmatch(s); m != nil {
		mes, _ := strconv.Atoi(m[2])
		ano, _ := strconv.Atoi(m[3])
		return mesAnoLabel(mes, ano)
	}
	return ""
}

// normalizarRawRange substitui datas por labels dentro de uma string com "até".
func normalizarRawRange(raw string) string {
	out := raw
	// Substitui ISOs
	out = regexp.MustCompile(`(\d{4})-(\d{1,2})-\d{1,2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?`).ReplaceAllStringFunc(out, func(m string) string {
		if l := parseSingleData(m); l != "" {
			return l
		}
		return m
	})
	// Substitui BR
	out = regexp.MustCompile(`\d{1,2}/\d{1,2}/\d{4}`).ReplaceAllStringFunc(out, func(m string) string {
		if l := parseSingleData(m); l != "" {
			return l
		}
		return m
	})
	// Limpa espaços duplicados
	out = regexp.MustCompile(`\s+`).ReplaceAllString(out, " ")
	return strings.TrimSpace(out)
}

var mesesAbrevPT = [...]string{"", "jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"}

func mesAnoLabel(mes, ano int) string {
	if mes < 1 || mes > 12 {
		return ""
	}
	yy := ano % 100
	return fmt.Sprintf("%s/%02d", mesesAbrevPT[mes], yy)
}

func getIntish(v interface{}) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err != nil {
			return 0, false
		}
		return n, true
	case int:
		return x, true
	}
	return 0, false
}

func todasSaoMesAno(labels []string) bool {
	re := regexp.MustCompile(`^[a-z]{3}/\d{2}$`)
	for _, l := range labels {
		if !re.MatchString(l) {
			return false
		}
	}
	return true
}

func mesAnoParaOrdinal(l string) int {
	// "mai/23" → 23*12 + 5 = 281 (pra ordenar cronologicamente)
	parts := strings.Split(l, "/")
	if len(parts) != 2 {
		return 0
	}
	yy, _ := strconv.Atoi(parts[1])
	m := 0
	for i := 1; i <= 12; i++ {
		if mesesAbrevPT[i] == parts[0] {
			m = i
			break
		}
	}
	if m == 0 {
		return 0
	}
	return yy*12 + m
}

func sortByMesAno(labels []string) {
	sort.Slice(labels, func(i, j int) bool {
		return mesAnoParaOrdinal(labels[i]) < mesAnoParaOrdinal(labels[j])
	})
}

// ehContiguo: labels[0..n-1] são meses consecutivos? (após sort)
func ehContiguo(labels []string) bool {
	for i := 1; i < len(labels); i++ {
		if mesAnoParaOrdinal(labels[i])-mesAnoParaOrdinal(labels[i-1]) != 1 {
			return false
		}
	}
	return true
}
