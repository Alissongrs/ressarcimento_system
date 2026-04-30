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
// Substitui /faturas/uc-historico (que lia de Faturas_Registradas_Cache).
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
			COALESCE(mes_referencia, '')                                                        AS Mes_Ref,
			COALESCE(valor_total_fatura, 0)                                                     AS RS_Total_Fatura,
			COALESCE(consumo_ativo_ponta_kwh, 0) + COALESCE(consumo_ativo_fponta_kwh, 0)       AS KWH_Total,
			COALESCE(link_fatura, '')                                                           AS Link
		FROM FATURA_DADOS_EXTRAIDOS
		WHERE codigo_uc = ?
		ORDER BY CASE
				WHEN mes_referencia REGEXP '^[0-9]{2}/[0-9]{4}$'
				THEN CONCAT(RIGHT(mes_referencia,4),'-',LEFT(mes_referencia,2),'-01')
				ELSE mes_referencia
			END ASC
	`, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar histórico"})
		return
	}
	defer rows.Close()

	type histRow struct {
		ID             int64   `json:"id"`
		MesRef         string  `json:"Mes_Ref"`
		RSTotal        float64 `json:"RS_Total_Fatura"`
		KWHTotal       float64 `json:"KWH_Total"`
		Link           string  `json:"Link"`
	}

	var result []histRow
	for rows.Next() {
		var r histRow
		if err := rows.Scan(&r.ID, &r.MesRef, &r.RSTotal, &r.KWHTotal, &r.Link); err != nil {
			continue
		}
		result = append(result, r)
	}
	if result == nil {
		result = []histRow{}
	}
	c.JSON(http.StatusOK, gin.H{"rows": result})
}
