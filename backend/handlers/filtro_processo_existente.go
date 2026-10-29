package handlers

// filtro_processo_existente.go — helpers para excluir da Auditoria de Faturas
// os apontamentos cujo (UC, mês_referencia) já corresponde a algum
// FT_PROCESSOS/FT_REQUISICOES existente. A regra é POR MÊS: se o processo
// cobre outubro/2023 e a fatura apontada é setembro/2023, MANTÉM (mês
// diferente = período distinto, deve virar apontamento novo).

import (
	"database/sql"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// carregarProcessosCobertos lê FT_PROCESSOS + FT_REQUISICOES e devolve
// um mapa { uc_normalizado: set{"YYYY-MM"} } cobrindo TODOS os processos
// ativos ou já concluídos (basta existir um processo pra excluir do apontador).
//
// Cobre BOTH p.uc (UC quando o processo foi aberto) E p.uc_atual (UC atual
// depois de eventual troca de instalação) — precisa dos dois porque o
// FATURA_DADOS_EXTRAIDOS usa a UC atual e alguns processos foram criados
// com a UC antiga (ex: PR-2025-018170 uc="14017792", uc_atual="125641401993").
func carregarProcessosCobertos(sqlDB *sql.DB) (map[string]map[string]bool, error) {
	out := map[string]map[string]bool{}

	rows, err := sqlDB.Query(`
		SELECT p.uc, p.uc_atual, r.uc,
		       COALESCE(p.periodos_irregularidade, r.periodos_irregularidade) AS periodos
		  FROM FT_PROCESSOS p
		  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		 WHERE p.uc IS NOT NULL OR p.uc_atual IS NOT NULL OR r.uc IS NOT NULL
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var pUC, pUCAtual, rUC sql.NullString
		var periodos sql.NullString
		if err := rows.Scan(&pUC, &pUCAtual, &rUC, &periodos); err != nil {
			continue
		}
		meses := extrairMesesYYYYMM(periodos.String)
		// Regra atual (UC independente do mês): registra a UC mesmo sem períodos.
		// Basta a UC ter QUALQUER processo pra ser excluída do apontador — não
		// dependemos mais do mês. O set de meses é mantido só para telemetria/legado.
		// Adiciona a MESMA cobertura sob cada uma das UCs conhecidas do processo
		// (uc original, uc_atual, uc da requisição). Assim uma fatura da FDE que
		// tem numero_instalacao == qualquer uma dessas variações é filtrada.
		for _, uc := range []sql.NullString{pUC, pUCAtual, rUC} {
			if !uc.Valid {
				continue
			}
			ucNorm := normalizarUC(uc.String)
			if ucNorm == "" {
				continue
			}
			if _, ok := out[ucNorm]; !ok {
				out[ucNorm] = map[string]bool{}
			}
			for _, mes := range meses {
				out[ucNorm][mes] = true
			}
		}
	}
	return out, nil
}

// normalizarUC tira pontuação e separadores (mesma UC pode aparecer como
// "015.139.018-09" ou "701513901809" — se algum dígito bater, considera igual).
// Estratégia: só dígitos.
func normalizarUC(s string) string {
	var b strings.Builder
	for _, ch := range s {
		if ch >= '0' && ch <= '9' {
			b.WriteRune(ch)
		}
	}
	return b.String()
}

// mesRefParaYYYYMM aceita formatos de mes_referencia comuns:
//   "2024-06-01" / "2024-06-01T00:00:00" / "06/2024" / "6/2024" / "202406"
// e devolve "YYYY-MM" ("2024-06") ou "" se não reconhecer.
func mesRefParaYYYYMM(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// YYYY-MM ou YYYY-MM-DD ou YYYY-MM-DDTHH:MM:SS
	if m := reISOData.FindStringSubmatch(s); m != nil {
		yy, _ := strconv.Atoi(m[1])
		mm, _ := strconv.Atoi(m[2])
		if yy > 0 && mm >= 1 && mm <= 12 {
			return normMes(yy, mm)
		}
	}
	// MM/YYYY
	if m := reBRMesAno.FindStringSubmatch(s); m != nil {
		mm, _ := strconv.Atoi(m[1])
		yy, _ := strconv.Atoi(m[2])
		if yy > 0 && mm >= 1 && mm <= 12 {
			return normMes(yy, mm)
		}
	}
	// DD/MM/YYYY (ignora dia)
	if m := reBRDataCompleta.FindStringSubmatch(s); m != nil {
		mm, _ := strconv.Atoi(m[2])
		yy, _ := strconv.Atoi(m[3])
		if yy > 0 && mm >= 1 && mm <= 12 {
			return normMes(yy, mm)
		}
	}
	// YYYYMM
	if m := reYYYYMM.FindStringSubmatch(s); m != nil {
		yy, _ := strconv.Atoi(m[1])
		mm, _ := strconv.Atoi(m[2])
		if yy > 0 && mm >= 1 && mm <= 12 {
			return normMes(yy, mm)
		}
	}
	return ""
}

func normMes(yy, mm int) string { return strconv.Itoa(yy) + "-" + fmt02(mm) }
func fmt02(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

var (
	reISOData        = regexp.MustCompile(`^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?`)
	reBRMesAno       = regexp.MustCompile(`^(\d{1,2})/(\d{4})$`)
	reBRDataCompleta = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})`)
	reYYYYMM         = regexp.MustCompile(`^(\d{4})(\d{2})$`)
)

var mesesPtBr = map[string]int{
	"jan": 1, "fev": 2, "mar": 3, "abr": 4, "mai": 5, "jun": 6,
	"jul": 7, "ago": 8, "set": 9, "out": 10, "nov": 11, "dez": 12,
}

// extrairMesesYYYYMM parseia o JSON de periodos_irregularidade e devolve
// lista de meses no formato "YYYY-MM". Aceita as duas convenções:
//   [{"raw": "2023-05-01 00:00:00"}]
//   [{"ano": "2024", "mes": "6"}]
//   [{"raw": "01/05/2023 e 01/06/2023"}]
//   [{"raw": "01/05/2023 até 01/07/2023"}]  → expande pra 05, 06, 07 do ano
func extrairMesesYYYYMM(jsonStr string) []string {
	jsonStr = strings.TrimSpace(jsonStr)
	if jsonStr == "" || jsonStr == "null" || jsonStr == "[]" {
		return nil
	}
	var itens []map[string]interface{}
	if err := json.Unmarshal([]byte(jsonStr), &itens); err != nil {
		return nil
	}
	var meses []string
	seen := map[string]bool{}
	add := func(mes string) {
		if mes == "" || seen[mes] {
			return
		}
		seen[mes] = true
		meses = append(meses, mes)
	}

	for _, it := range itens {
		// Formato estruturado {ano, mes}
		if ano, mes, ok := extrairAnoMes(it); ok {
			add(normMes(ano, mes))
			continue
		}
		// Formato legado {raw: "..."}
		raw, _ := it["raw"].(string)
		raw = strings.TrimSpace(raw)
		if raw == "" || raw == "<NA>" {
			continue
		}
		lower := strings.ToLower(raw)

		// Range "de X até Y" — expande todos os meses entre eles
		if strings.Contains(lower, "até") || strings.Contains(lower, "ate") {
			datas := reBRDataCompleta.FindAllStringSubmatch(raw, -1)
			isoDatas := reISOData.FindAllStringSubmatch(raw, -1)
			pontos := []struct{ y, m int }{}
			for _, d := range datas {
				mm, _ := strconv.Atoi(d[2])
				yy, _ := strconv.Atoi(d[3])
				pontos = append(pontos, struct{ y, m int }{yy, mm})
			}
			for _, d := range isoDatas {
				yy, _ := strconv.Atoi(d[1])
				mm, _ := strconv.Atoi(d[2])
				pontos = append(pontos, struct{ y, m int }{yy, mm})
			}
			if len(pontos) >= 2 {
				expandirRangeMeses(pontos[0].y, pontos[0].m, pontos[len(pontos)-1].y, pontos[len(pontos)-1].m, add)
				continue
			}
		}

		// Múltiplas datas separadas por "e" ou vírgula
		if strings.Contains(raw, " e ") || strings.Contains(raw, ",") {
			partes := regexp.MustCompile(`\s*(?:,|\se\s)\s*`).Split(raw, -1)
			for _, p := range partes {
				if m := mesRefParaYYYYMM(p); m != "" {
					add(m)
				}
			}
			continue
		}

		// Data única
		if m := mesRefParaYYYYMM(raw); m != "" {
			add(m)
		}
	}
	return meses
}

func extrairAnoMes(it map[string]interface{}) (int, int, bool) {
	ano, aok := getIntFromAny(it["ano"])
	mes, mok := getIntFromAny(it["mes"])
	if !aok || !mok {
		return 0, 0, false
	}
	if mes < 1 || mes > 12 || ano < 1900 {
		return 0, 0, false
	}
	return ano, mes, true
}

func getIntFromAny(v interface{}) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err != nil {
			// tenta mês por nome em PT
			if m, ok := mesesPtBr[strings.ToLower(strings.TrimSpace(x))]; ok {
				return m, true
			}
			return 0, false
		}
		return n, true
	case int:
		return x, true
	}
	return 0, false
}

func expandirRangeMeses(y1, m1, y2, m2 int, add func(string)) {
	if y1 == 0 || y2 == 0 || m1 == 0 || m2 == 0 {
		return
	}
	a, ma := y1, m1
	b, mb := y2, m2
	if a > b || (a == b && ma > mb) {
		a, ma, b, mb = y2, m2, y1, m1
	}
	limite := 60 // sanidade: no máximo 5 anos de expansão
	for a < b || (a == b && ma <= mb) {
		add(normMes(a, ma))
		ma++
		if ma > 12 {
			ma = 1
			a++
		}
		limite--
		if limite == 0 {
			break
		}
	}
}

// ucTemProcesso: retorna true quando a UC (qualquer mês) já tem processo/requisição.
// Regra vigente: dedup POR UC, independente do mês de referência.
func ucTemProcesso(cobertura map[string]map[string]bool, uc string) bool {
	if cobertura == nil {
		return false
	}
	ucNorm := normalizarUC(uc)
	if ucNorm == "" {
		return false
	}
	_, ok := cobertura[ucNorm]
	return ok
}

// jaExisteProcesso: retorna true quando (uc, mes) já tem processo cadastrado.
// (legado — mantido para referência; o filtro agora usa ucTemProcesso.)
func jaExisteProcesso(cobertura map[string]map[string]bool, uc string, mesRef string) bool {
	if cobertura == nil {
		return false
	}
	ucNorm := normalizarUC(uc)
	mes := mesRefParaYYYYMM(mesRef)
	if ucNorm == "" || mes == "" {
		return false
	}
	set := cobertura[ucNorm]
	return set != nil && set[mes]
}

// filtrarPorProcessosExistentes remove apontamentos do motor cuja UC já
// coincide com algum processo/requisição cadastrado (qualquer estado),
// INDEPENDENTE do mês de referência. Ou seja: se a UC já virou processo,
// nenhum mês dela aparece mais na Auditoria de Faturas.
func filtrarPorProcessosExistentes(sqlDB *sql.DB, res map[int64]ResultadoDesvio) map[int64]ResultadoDesvio {
	if len(res) == 0 {
		return res
	}
	cobertura, err := carregarProcessosCobertos(sqlDB)
	if err != nil || len(cobertura) == 0 {
		return res
	}

	// Puxa (numero_instalacao, codigo_uc, mes_ref) — testa AMBAS as UCs contra
	// a cobertura porque a fatura na FDE pode carregar a UC "atual" e o processo
	// pode ter sido criado com a UC "antiga" (ou vice-versa).
	ids := make([]string, 0, len(res))
	for id := range res {
		ids = append(ids, strconv.FormatInt(id, 10))
	}
	q := "SELECT id, COALESCE(numero_instalacao,''), COALESCE(codigo_uc,'') " +
		"FROM FATURA_DADOS_EXTRAIDOS WHERE id IN (" + strings.Join(ids, ",") + ")"
	rows, err := sqlDB.Query(q)
	if err != nil {
		return res
	}
	defer rows.Close()

	out := make(map[int64]ResultadoDesvio, len(res))
	for rows.Next() {
		var id int64
		var numInst, codUC string
		if err := rows.Scan(&id, &numInst, &codUC); err != nil {
			continue
		}
		// Regra vigente: dedup POR UC (qualquer mês). Basta a UC (instalação OU
		// codigo_uc) já ter um processo pra excluir o apontamento — independente
		// do mês de referência.
		if ucTemProcesso(cobertura, numInst) || ucTemProcesso(cobertura, codUC) {
			continue // pula — UC já é processo
		}
		if r, ok := res[id]; ok {
			out[id] = r
		}
	}
	return out
}
