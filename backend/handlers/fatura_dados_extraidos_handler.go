package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// colunas MEDIUMTEXT grandes — excluídas da listagem para não explodir o payload
var fdeSkipCols = map[string]bool{
	"texto_plumber":           true,
	"texto_markdown":          true,
	"texto_ocr":               true,
	"analise_ia":              true,
	"resultado_analises_final": true,
}

// fdeListCols constrói o SELECT sem as colunas de texto grande.
func fdeListCols(sqlDB *sql.DB) string {
	rows, err := sqlDB.Query("SHOW COLUMNS FROM FATURA_DADOS_EXTRAIDOS")
	if err != nil {
		return "*"
	}
	defer rows.Close()

	var selected []string
	for rows.Next() {
		var field, colType, null, key, def, extra sql.NullString
		if rows.Scan(&field, &colType, &null, &key, &def, &extra) != nil || !field.Valid {
			continue
		}
		if !fdeSkipCols[field.String] {
			selected = append(selected, "`"+field.String+"`")
		}
	}
	if len(selected) == 0 {
		return "*"
	}
	return strings.Join(selected, ", ")
}

// ListFaturasDadosExtraidos lista registros de FATURA_DADOS_EXTRAIDOS
// com paginação e filtros opcionais: empresa, uc, search.
// GET /api/v1/faturas-extraidas?empresa=14&uc=3013&limit=100&offset=0
func ListFaturasDadosExtraidos(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco de faturas não disponível"})
		return
	}

	limitStr := c.DefaultQuery("limit", "100")
	offsetStr := c.DefaultQuery("offset", "0")
	limit, _ := strconv.Atoi(limitStr)
	offset, _ := strconv.Atoi(offsetStr)
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	var conditions []string
	var filterArgs []interface{}

	if emp := c.Query("empresa"); emp != "" {
		parts := strings.Split(emp, ",")
		phs := make([]string, 0, len(parts))
		for _, p := range parts {
			v, e := strconv.Atoi(strings.TrimSpace(p))
			if e == nil {
				filterArgs = append(filterArgs, v)
				phs = append(phs, "?")
			}
		}
		if len(phs) > 0 {
			conditions = append(conditions, "cod_empresa IN ("+strings.Join(phs, ",")+")")
		}
	}

	if uc := c.Query("uc"); uc != "" {
		conditions = append(conditions, "codigo_uc LIKE ?")
		filterArgs = append(filterArgs, "%"+uc+"%")
	}

	if search := c.Query("search"); search != "" {
		conditions = append(conditions, "(uid LIKE ? OR codigo_uc LIKE ? OR mes_ref LIKE ?)")
		filterArgs = append(filterArgs, "%"+search+"%", "%"+search+"%", "%"+search+"%")
	}

	where := "1=1"
	if len(conditions) > 0 {
		where = strings.Join(conditions, " AND ")
	}

	selectCols := fdeListCols(sqlDB)
	queryArgs := append(append([]interface{}{}, filterArgs...), limit, offset)

	rows, err := sqlDB.Query(
		"SELECT "+selectCols+" FROM FATURA_DADOS_EXTRAIDOS WHERE "+where+" ORDER BY id DESC LIMIT ? OFFSET ?",
		queryArgs...,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar dados extraídos: " + err.Error()})
		return
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao ler colunas"})
		return
	}

	var result []map[string]interface{}
	for rows.Next() {
		vals := make([]interface{}, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			continue
		}
		row := make(map[string]interface{}, len(cols))
		for i, col := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				row[col] = string(b)
			} else if v == nil {
				row[col] = nil
			} else {
				row[col] = v
			}
		}
		result = append(result, row)
	}
	if result == nil {
		result = []map[string]interface{}{}
	}

	var total int64
	_ = sqlDB.QueryRow("SELECT COUNT(*) FROM FATURA_DADOS_EXTRAIDOS WHERE "+where, filterArgs...).Scan(&total)

	c.JSON(http.StatusOK, gin.H{
		"rows":   result,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

// GetFaturaDadosExtraida retorna todos os campos de um registro específico por uid.
// GET /api/v1/faturas-extraidas/:uid
func GetFaturaDadosExtraida(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco de faturas não disponível"})
		return
	}

	uid := c.Param("uid")
	if uid == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uid obrigatório"})
		return
	}

	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	rows, err := sqlDB.Query("SELECT * FROM FATURA_DADOS_EXTRAIDOS WHERE uid = ? LIMIT 1", uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar fatura"})
		return
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao ler colunas"})
		return
	}

	if !rows.Next() {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}

	vals := make([]interface{}, len(cols))
	ptrs := make([]interface{}, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao ler linha"})
		return
	}

	row := make(map[string]interface{}, len(cols))
	for i, col := range cols {
		v := vals[i]
		if b, ok := v.([]byte); ok {
			row[col] = string(b)
		} else if v == nil {
			row[col] = nil
		} else {
			row[col] = v
		}
	}

	c.JSON(http.StatusOK, row)
}

// GetFDEFichaResumo conta quantas faturas em FATURA_DADOS_EXTRAIDOS têm cada ficha confirmada.
// Substitui /faturas/ficha/resumo (que contava a partir de Faturas_Registradas_Cache).
// GET /api/v1/faturas/fde-ficha-resumo
func GetFDEFichaResumo(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	rows, err := sqlDB.Query(
		"SELECT fichas_apontadas FROM FATURA_DADOS_EXTRAIDOS WHERE fichas_apontadas IS NOT NULL AND fichas_apontadas != ''",
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao contar fichas"})
		return
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var fa sql.NullString
		if rows.Scan(&fa) != nil || !fa.Valid {
			continue
		}
		var d map[string]interface{}
		if json.Unmarshal([]byte(fa.String), &d) != nil {
			continue
		}
		fcs, ok := d["fichas_confirmadas"]
		if !ok {
			continue
		}
		arr, ok := fcs.([]interface{})
		if !ok {
			continue
		}
		for _, f := range arr {
			key := strings.ToLower(strings.TrimSpace(fmt.Sprint(f)))
			if len(key) == 3 { // F01..F14
				counts[key]++
			}
		}
	}

	fichas := make([]map[string]interface{}, 0, len(counts))
	for k, v := range counts {
		fichas = append(fichas, map[string]interface{}{"key": k, "total": v})
	}
	c.JSON(http.StatusOK, gin.H{"fichas": fichas})
}

// GetFDEUCHistorico retorna o histórico mensal de uma UC a partir de FATURA_DADOS_EXTRAIDOS.
// Combina faturas próprias (kwh_confirmado) com historico_consumo_12_meses embutido em cada
// fatura (kwh_historico), produzindo uma série única por mês.
//
// Saída por linha:
//   - mes (YYYY-MM)
//   - kwh_confirmado: soma ponta+fponta de fatura própria (se houver)
//   - kwh_historico:  média dos valores de mês_anterior trazidos por outras faturas
//   - id, link, valor: só se houver fatura própria (clicável no front)
//   - fonte: "fatura" | "historico" | "fatura+historico"
//
// GET /api/v1/faturas/fde-uc-historico?uc=3013593026
func GetFDEUCHistorico(c *gin.Context) {
	uc := strings.TrimSpace(c.Query("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uc obrigatório"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	rows, err := sqlDB.Query(`
		SELECT
			id,
			COALESCE(mes_referencia, '')                                                AS mes_referencia,
			COALESCE(valor_total_fatura, 0)                                             AS valor,
			COALESCE(consumo_ativo_ponta_kwh, 0) + COALESCE(consumo_ativo_fponta_kwh,0) AS kwh_proprio,
			COALESCE(link_fatura, '')                                                   AS link,
			COALESCE(historico_consumo_12_meses, '')                                    AS historico_json,
			COALESCE(numero_fatura, '')                                                 AS numero_fatura,
			COALESCE(numero_medidor, '')                                                AS medidor,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.flag_f04', '0')             AS flag_f04,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.flag_f05', '0')             AS flag_f05,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.detalhe_f04', '')           AS detalhe_f04,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.detalhe_f05', '')           AS detalhe_f05,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.flag_f01', '0')             AS flag_f01,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.flag_f02', '0')             AS flag_f02,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.flag_f03', '0')             AS flag_f03,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.dif_pct_alerta_f02', '')    AS dif_pct_f02,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.status_alerta_f02', '')     AS status_f02,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.qtd_meses_f03', '')         AS qtd_meses_f03,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.valor_fixo_f03', '')        AS valor_fixo_f03,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.consumo_atual_f03', '')     AS consumo_atual_f03,
			COALESCE(fichas_apontadas->>'$.motor_regras_sql.fichas_aplicadas', '')      AS fichas_aplicadas,
			COALESCE(fichas_apontadas->>'$.decisao_final', '')                          AS decisao_final,
			COALESCE(fichas_apontadas->>'$.fichas_confirmadas', '')                     AS fichas_confirmadas,
			COALESCE(fichas_apontadas->>'$.f04_aprovado', '')                           AS f04_aprovado
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE codigo_uc = ?
	`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar histórico: " + err.Error()})
		return
	}
	defer rows.Close()

	// Acumulador agregado por mês (chave: YYYY-MM)
	type acc struct {
		ID              int64
		Link            string
		Valor           float64
		KwhConfirmado   float64
		KwhSomaHist     float64
		KwhCountHist    int
		Medidor         string
		NumeroFatura    string
		FlagF01         int
		FlagF02         int
		FlagF03         int
		FlagF04         int
		FlagF05         int
		F04Aprovado     string // "true" / "false" / "" (nunca votou)
		DetalheF02      string
		DetalheF03      string
		DetalheF04      string
		DetalheF05      string
		FichasAplicadas   string
		DecisaoFinal      string
		FichasConfirmadas string // JSON array string ex: "[\"F02\",\"F03\"]"
	}
	porMes := make(map[string]*acc)

	for rows.Next() {
		var (
			id              int64
			mesRefRaw       sql.NullString
			valor           sql.NullFloat64
			kwhProprio      sql.NullFloat64
			link            sql.NullString
			histJSONRaw     sql.RawBytes
			numFatura       sql.NullString
			medidor         sql.NullString
			flagF04Str      sql.NullString
			flagF05Str      sql.NullString
			detF04          sql.NullString
			detF05          sql.NullString
			flagF01Str      sql.NullString
			flagF02Str      sql.NullString
			flagF03Str      sql.NullString
			difPctF02       sql.NullString
			statusF02       sql.NullString
			qtdMesesF03     sql.NullString
			valorFixoF03    sql.NullString
			consumoAtualF03 sql.NullString
			fichasAplicadas    sql.NullString
			decisaoFinal       sql.NullString
			fichasConfirmadas  sql.NullString
			f04AprovadoRaw     sql.NullString
		)
		if err := rows.Scan(
			&id, &mesRefRaw, &valor, &kwhProprio, &link, &histJSONRaw,
			&numFatura,
			&medidor, &flagF04Str, &flagF05Str, &detF04, &detF05,
			&flagF01Str, &flagF02Str, &flagF03Str,
			&difPctF02, &statusF02, &qtdMesesF03, &valorFixoF03, &consumoAtualF03,
			&fichasAplicadas, &decisaoFinal, &fichasConfirmadas, &f04AprovadoRaw,
		); err != nil {
			continue
		}
		mesRefStr := ""
		if mesRefRaw.Valid {
			mesRefStr = mesRefRaw.String
		}
		valorF := 0.0
		if valor.Valid {
			valorF = valor.Float64
		}
		kwhProp := 0.0
		if kwhProprio.Valid {
			kwhProp = kwhProprio.Float64
		}
		linkStr := ""
		if link.Valid {
			linkStr = link.String
		}
		histJSONStr := string(histJSONRaw)

		mesProprio := normalizarMesYYYYMM(mesRefStr)
		if mesProprio != "" {
			a, ok := porMes[mesProprio]
			if !ok {
				a = &acc{}
				porMes[mesProprio] = a
			}
			if kwhProp > 0 {
				a.KwhConfirmado = kwhProp
			}
			if valorF > 0 {
				a.Valor = valorF
			}
			// Em caso de múltiplas faturas no mesmo mês, prioriza a que TEM link
			// de PDF. Se a entrada atual ainda não tem link e este registro tem,
			// substitui ID + Link. Isso evita barra cinza quando uma duplicata
			// sem link/com link inválido é processada antes da fatura completa.
			// Os metadados de identificação (nº fatura, datas de leitura) seguem
			// junto do registro "vencedor" pra que o tooltip do front exiba os
			// dados do PDF que efetivamente abrirá no clique.
			if linkStr != "" && a.Link == "" {
				a.ID = id
				a.Link = linkStr
				if numFatura.Valid {
					a.NumeroFatura = numFatura.String
				}
			} else if a.ID == 0 {
				a.ID = id
				a.Link = linkStr
				if numFatura.Valid {
					a.NumeroFatura = numFatura.String
				}
			}
			if medidor.Valid && medidor.String != "" {
				a.Medidor = medidor.String
			}
			a.FlagF01 = atoiSafe(flagF01Str)
			a.FlagF02 = atoiSafe(flagF02Str)
			a.FlagF03 = atoiSafe(flagF03Str)
			a.FlagF04 = atoiSafe(flagF04Str)
			a.FlagF05 = atoiSafe(flagF05Str)
			if a.FlagF02 == 1 {
				a.DetalheF02 = montarDetalheF02(statusF02, difPctF02)
			}
			if a.FlagF03 == 1 {
				a.DetalheF03 = montarDetalheF03(qtdMesesF03, valorFixoF03, consumoAtualF03)
			}
			if detF04.Valid {
				a.DetalheF04 = detF04.String
			}
			if detF05.Valid {
				a.DetalheF05 = detF05.String
			}
			if fichasAplicadas.Valid {
				a.FichasAplicadas = fichasAplicadas.String
			}
			if decisaoFinal.Valid {
				a.DecisaoFinal = decisaoFinal.String
			}
			if fichasConfirmadas.Valid {
				a.FichasConfirmadas = fichasConfirmadas.String
			}
			if f04AprovadoRaw.Valid {
				a.F04Aprovado = strings.TrimSpace(f04AprovadoRaw.String)
			}
		}

		for mesH, kwhH := range parseHistorico12m(histJSONStr) {
			if mesH == "" || kwhH <= 0 {
				continue
			}
			a, ok := porMes[mesH]
			if !ok {
				a = &acc{}
				porMes[mesH] = a
			}
			a.KwhSomaHist += kwhH
			a.KwhCountHist++
		}
	}

	type histRow struct {
		Mes             string  `json:"mes"`
		MesRef          string  `json:"Mes_Ref"` // compat antigo
		ID              int64   `json:"id"`
		Link            string  `json:"Link"`
		RSTotal         float64 `json:"RS_Total_Fatura"`
		KWHConfirmado   float64 `json:"kwh_confirmado"`
		KWHHistorico    float64 `json:"kwh_historico"`
		KWHTotal        float64 `json:"KWH_Total"` // compat antigo: prioriza confirmado, fallback histórico
		Fonte           string  `json:"fonte"`
		// Identificação da fatura (para validação visual no tooltip do front
		// e auditoria pós-clique no PDF — bate com o que aparece no documento)
		NumeroFatura    string `json:"numero_fatura"`
		// Motor SQL: flags + detalhes (só presentes em meses com fatura própria)
		Medidor         string `json:"medidor"`
		FlagF01         int    `json:"flag_f01"`
		FlagF02         int    `json:"flag_f02"`
		FlagF03         int    `json:"flag_f03"`
		FlagF04         int    `json:"flag_f04"`
		FlagF05         int    `json:"flag_f05"`
		F04Aprovado     string `json:"f04_aprovado"` // "true" | "false" | "" (não votou)
		DetalheF02      string `json:"detalhe_f02"`
		DetalheF03      string `json:"detalhe_f03"`
		DetalheF04      string `json:"detalhe_f04"`
		DetalheF05      string `json:"detalhe_f05"`
		FichasAplicadas   string `json:"fichas_aplicadas"`
		DecisaoFinal      string `json:"decisao_final"`
		FichasConfirmadas string `json:"fichas_confirmadas"` // JSON array da decisão IA — fonte de verdade pra coluna Flags
		// Tarifa efetiva da fatura (R$/kWh) = valor_total / kwh_confirmado.
		// Ressarcimento estimado = (kwh_confirmado - média) * tarifa, só calculado
		// para meses com F02 confirmado (pico isolado de consumo).
		TarifaKWH            float64 `json:"tarifa_kwh"`
		RessarcimentoEstim   float64 `json:"ressarcimento_estimado"`
	}

	// Ordenar chaves YYYY-MM
	keys := make([]string, 0, len(porMes))
	for k := range porMes {
		keys = append(keys, k)
	}
	// ordem alfabética = ordem cronológica (YYYY-MM)
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}

	// Média de consumo da UC (apenas meses com fatura própria e kwh > 0).
	// Usada como baseline para o cálculo de ressarcimento estimado em F02.
	var somaKwh float64
	var qtdKwh int
	for _, a := range porMes {
		if a.KwhConfirmado > 0 {
			somaKwh += a.KwhConfirmado
			qtdKwh++
		}
	}
	mediaKwhUC := 0.0
	if qtdKwh > 0 {
		mediaKwhUC = somaKwh / float64(qtdKwh)
	}

	var result []histRow
	for _, k := range keys {
		a := porMes[k]
		var kwhHist float64
		if a.KwhCountHist > 0 {
			kwhHist = a.KwhSomaHist / float64(a.KwhCountHist)
		}
		fonte := "historico"
		if a.KwhConfirmado > 0 && a.KwhCountHist > 0 {
			fonte = "fatura+historico"
		} else if a.KwhConfirmado > 0 {
			fonte = "fatura"
		}
		kwhTotal := a.KwhConfirmado
		if kwhTotal == 0 {
			kwhTotal = kwhHist
		}

		// Tarifa efetiva R$/kWh + ressarcimento estimado para F02.
		var tarifaKWH, ressarcimento float64
		if a.KwhConfirmado > 0 && a.Valor > 0 {
			tarifaKWH = a.Valor / a.KwhConfirmado
		}
		if a.FlagF02 == 1 && a.KwhConfirmado > 0 && mediaKwhUC > 0 && tarifaKWH > 0 {
			excesso := a.KwhConfirmado - mediaKwhUC
			if excesso > 0 {
				ressarcimento = excesso * tarifaKWH
			}
		}

		result = append(result, histRow{
			Mes:             k,
			MesRef:          k,
			ID:              a.ID,
			Link:            a.Link,
			RSTotal:         a.Valor,
			KWHConfirmado:   a.KwhConfirmado,
			KWHHistorico:    kwhHist,
			KWHTotal:        kwhTotal,
			Fonte:           fonte,
			NumeroFatura:    a.NumeroFatura,
			Medidor:         a.Medidor,
			FlagF01:         a.FlagF01,
			FlagF02:         a.FlagF02,
			FlagF03:         a.FlagF03,
			FlagF04:         a.FlagF04,
			FlagF05:         a.FlagF05,
			F04Aprovado:     a.F04Aprovado,
			DetalheF02:      a.DetalheF02,
			DetalheF03:      a.DetalheF03,
			DetalheF04:      a.DetalheF04,
			DetalheF05:      a.DetalheF05,
			FichasAplicadas:   a.FichasAplicadas,
			DecisaoFinal:      a.DecisaoFinal,
			FichasConfirmadas: a.FichasConfirmadas,
			TarifaKWH:          tarifaKWH,
			RessarcimentoEstim: ressarcimento,
		})
	}
	if result == nil {
		result = []histRow{}
	}
	c.JSON(http.StatusOK, gin.H{
		"rows":         result,
		"media_kwh_uc": mediaKwhUC,
	})
}

// normalizarMesYYYYMM converte string mes_referencia para "YYYY-MM" ou "" se inválido.
// Aceita: "12/2025", "2025-12-01", "DEZ/2025", "Dez/2025".
func normalizarMesYYYYMM(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Formato "YYYY-MM-DD" ou "YYYY-MM"
	if len(s) >= 7 && s[4] == '-' {
		yy := s[:4]
		mm := s[5:7]
		if isDigits(yy) && isDigits(mm) {
			return yy + "-" + mm
		}
	}
	// Formato "MM/YYYY"
	if len(s) == 7 && s[2] == '/' {
		mm := s[:2]
		yy := s[3:]
		if isDigits(mm) && isDigits(yy) {
			return yy + "-" + mm
		}
	}
	// Formato "MMM/YYYY" (3 letras + 4 dígitos)
	if len(s) == 8 && s[3] == '/' {
		monMap := map[string]string{
			"jan": "01", "fev": "02", "mar": "03", "abr": "04", "mai": "05", "jun": "06",
			"jul": "07", "ago": "08", "set": "09", "out": "10", "nov": "11", "dez": "12",
		}
		mes3 := strings.ToLower(s[:3])
		yy := s[4:]
		if mm, ok := monMap[mes3]; ok && isDigits(yy) {
			return yy + "-" + mm
		}
	}
	return ""
}

// montarDetalheF02 monta string legível para tooltip de F02 (pico isolado).
// Ex: "Desvio P:143.9% — DESVIO_ALTO".
func montarDetalheF02(status, difPct sql.NullString) string {
	parts := []string{}
	if difPct.Valid && strings.TrimSpace(difPct.String) != "" {
		parts = append(parts, "desvio "+strings.TrimSpace(difPct.String))
	}
	if status.Valid && strings.TrimSpace(status.String) != "" {
		parts = append(parts, strings.TrimSpace(status.String))
	}
	return strings.Join(parts, " — ")
}

// montarDetalheF03 monta string legível para tooltip de F03 (acúmulo de consumo).
// Ex: "4 meses fixos em 100kWh — atual 2.500kWh".
func montarDetalheF03(qtdMeses, valorFixo, consumoAtual sql.NullString) string {
	parts := []string{}
	if qtdMeses.Valid && strings.TrimSpace(qtdMeses.String) != "" {
		parts = append(parts, strings.TrimSpace(qtdMeses.String)+" meses fixos")
	}
	if valorFixo.Valid && strings.TrimSpace(valorFixo.String) != "" {
		parts = append(parts, "em "+strings.TrimSpace(valorFixo.String)+"kWh")
	}
	if consumoAtual.Valid && strings.TrimSpace(consumoAtual.String) != "" {
		parts = append(parts, "atual "+strings.TrimSpace(consumoAtual.String)+"kWh")
	}
	return strings.Join(parts, " — ")
}

// atoiSafe converte sql.NullString contendo "0" ou "1" para int (0 quando inválido).
func atoiSafe(s sql.NullString) int {
	if !s.Valid || s.String == "" {
		return 0
	}
	if n, err := strconv.Atoi(strings.TrimSpace(s.String)); err == nil {
		return n
	}
	return 0
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// parseHistorico12m extrai um map[mes_YYYY-MM] -> kwh do JSON gravado em
// historico_consumo_12_meses. Aceita varios formatos:
//   - lista de dicts: [{"mes":"AGO/25","kwh":2815.4,"tipo":"MED"}, ...]
//   - dict {mes:kwh}: {"08/2025": 2815.4, ...}
//   - lista de numeros (sem mes): ignorado, retorna vazio
func parseHistorico12m(raw string) map[string]float64 {
	out := make(map[string]float64)
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return out
	}

	// Tenta como lista de dicts
	var asList []map[string]any
	if err := json.Unmarshal([]byte(raw), &asList); err == nil {
		for _, item := range asList {
			kwh := pegarFloat(item, "kwh", "KWH", "valor", "consumo", "Valor")
			if kwh <= 0 {
				continue
			}
			// Caso 1: {ano: 2023, mes: 10, kwh: 100} — formato numérico
			ano := pegarFloat(item, "ano", "year", "Ano")
			mesNum := pegarFloat(item, "mes", "month", "MES", "Mes")
			if ano >= 1900 && mesNum >= 1 && mesNum <= 12 {
				mes := fmt.Sprintf("%04d-%02d", int(ano), int(mesNum))
				out[mes] = kwh
				continue
			}
			// Caso 2: {mes: "AGO/25", kwh: 2815.4} — formato string
			mesRaw := pegarStr(item, "mes", "Mes", "month", "MES")
			if mes := normalizarMesHistorico(mesRaw); mes != "" {
				out[mes] = kwh
			}
		}
		return out
	}

	// Tenta como dict {mes:kwh}
	var asMap map[string]any
	if err := json.Unmarshal([]byte(raw), &asMap); err == nil {
		for mesRaw, v := range asMap {
			var kwh float64
			switch x := v.(type) {
			case float64:
				kwh = x
			case string:
				if f, err := strconv.ParseFloat(strings.ReplaceAll(x, ",", "."), 64); err == nil {
					kwh = f
				}
			}
			mes := normalizarMesHistorico(mesRaw)
			if mes != "" && kwh > 0 {
				out[mes] = kwh
			}
		}
		return out
	}

	return out
}

func pegarStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok2 := v.(string); ok2 {
				return s
			}
		}
	}
	return ""
}

func pegarFloat(m map[string]any, keys ...string) float64 {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch x := v.(type) {
			case float64:
				return x
			case string:
				if f, err := strconv.ParseFloat(strings.ReplaceAll(x, ",", "."), 64); err == nil {
					return f
				}
			}
		}
	}
	return 0
}

// normalizarMesHistorico aceita "MM/YYYY", "MMM/YY", "MMM/YYYY", "YYYY-MM" → "YYYY-MM"
func normalizarMesHistorico(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if v := normalizarMesYYYYMM(s); v != "" {
		return v
	}
	// Formato "MMM/YY" (ex: "AGO/25")
	if len(s) == 6 && s[3] == '/' {
		monMap := map[string]string{
			"jan": "01", "fev": "02", "mar": "03", "abr": "04", "mai": "05", "jun": "06",
			"jul": "07", "ago": "08", "set": "09", "out": "10", "nov": "11", "dez": "12",
		}
		mes3 := strings.ToLower(s[:3])
		yy2 := s[4:]
		if mm, ok := monMap[mes3]; ok && isDigits(yy2) {
			// Heurística: 00-30 → 2000-2030, 31-99 → 1931-1999
			ynum, _ := strconv.Atoi(yy2)
			if ynum <= 30 {
				return fmt.Sprintf("20%02d-%s", ynum, mm)
			}
			return fmt.Sprintf("19%02d-%s", ynum, mm)
		}
	}
	return ""
}
