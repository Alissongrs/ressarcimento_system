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

type FaturaComAnalise struct {
	ID                int64           `json:"id"`
	UC                string          `json:"UC"`
	Valor             float64         `json:"valor"`
	Concessionaria    string          `json:"concessionaria"`
	MesRef            string          `json:"mes_ref"`
	Status            string          `json:"status"`
	CodEmpresa        int64           `json:"Cod_Empresa"`
	Cliente           string          `json:"cliente"`
	ResultadoAnalises json.RawMessage `json:"resultado_analises"`
}

// GET /api/v1/faturas/com-analise
// Lista faturas com resultado_analises preenchido
// Query Params: empresa (int), status (string), limit (int)
func ListFaturasComAnalise(c *gin.Context) {
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

	// Parse query params
	empresa := c.DefaultQuery("empresa", "")
	status := c.DefaultQuery("status", "")
	limitStr := c.DefaultQuery("limit", "1000")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}

	// Monta query base — JOIN com Tab_Empresa para trazer Rz_Social do cliente
	query := `
		SELECT
			frc.id,
			frc.UC,
			frc.RS_Total_Fatura                                                                        AS valor,
			frc.Concessionaria,
			frc.Mes_Ref,
			COALESCE(JSON_EXTRACT(frc.resultado_analises, '$.ia_opus_5_4_decisao.decisao_final'), 'PENDENTE') AS status,
			COALESCE(frc.Cod_Empresa, 0)                                                                AS cod_empresa,
			COALESCE((SELECT e.Rz_Social FROM Tab_Empresa e WHERE e.Cod_Empresa = frc.Cod_Empresa LIMIT 1), '') AS cliente,
			frc.resultado_analises
		FROM Faturas_Registradas_Cache frc
		WHERE frc.resultado_analises IS NOT NULL
		  AND LOWER(COALESCE(frc.UC, '')) NOT LIKE '%boleto%'
		  AND LOWER(COALESCE(frc.RAZAO_SOCIAL, '')) NOT LIKE '%boleto%'
		  AND LOWER(COALESCE(frc.Concessionaria, '')) NOT LIKE '%boleto%'
	`

	var args []interface{}

	// Filtro por empresa (Cod_Empresa)
	if empresa != "" && empresa != "0" {
		query += " AND frc.Cod_Empresa = ?"
		args = append(args, empresa)
	}

	// Filtro por status (decisão final da análise)
	if status != "" {
		query += " AND JSON_EXTRACT(frc.resultado_analises, '$.ia_opus_5_4_decisao.decisao_final') = ?"
		args = append(args, status)
	}

	query += " ORDER BY frc.id DESC LIMIT ?"
	args = append(args, limit)

	rows, qErr := sqlDB.Query(query, args...)
	if qErr != nil {
		fmt.Printf("[ListFaturasComAnalise] erro: %v\n", qErr)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar faturas"})
		return
	}
	defer rows.Close()

	var faturas []FaturaComAnalise
	for rows.Next() {
		var f FaturaComAnalise
		var resultado sql.NullString
		var cliente sql.NullString
		err := rows.Scan(
			&f.ID,
			&f.UC,
			&f.Valor,
			&f.Concessionaria,
			&f.MesRef,
			&f.Status,
			&f.CodEmpresa,
			&cliente,
			&resultado,
		)
		if err != nil {
			fmt.Printf("[ListFaturasComAnalise] erro ao escanear: %v\n", err)
			continue
		}
		if resultado.Valid {
			f.ResultadoAnalises = json.RawMessage(resultado.String)
		}
		if cliente.Valid {
			f.Cliente = cliente.String
		}
		faturas = append(faturas, f)
	}

	c.JSON(http.StatusOK, faturas)
}

// GET /api/v1/faturas/{id}/detalhes
// Retorna detalhes completos de uma fatura com resultado_analises
func GetFaturaDetalhes(c *gin.Context) {
	faturaID := c.Param("id")
	if faturaID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id obrigatório"})
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

	query := `
		SELECT
			frc.id,
			frc.UC,
			frc.RS_Total_Fatura                                                                        AS valor,
			frc.Concessionaria,
			frc.Mes_Ref,
			COALESCE(JSON_EXTRACT(frc.resultado_analises, '$.ia_opus_5_4_decisao.decisao_final'), 'PENDENTE') AS status,
			COALESCE(frc.Cod_Empresa, 0)                                                                AS cod_empresa,
			COALESCE((SELECT e.Rz_Social FROM Tab_Empresa e WHERE e.Cod_Empresa = frc.Cod_Empresa LIMIT 1), '') AS cliente,
			frc.resultado_analises
		FROM Faturas_Registradas_Cache frc
		WHERE frc.id = ?
	`

	var f FaturaComAnalise
	var resultado sql.NullString
	var cliente sql.NullString
	err = sqlDB.QueryRow(query, faturaID).Scan(
		&f.ID,
		&f.UC,
		&f.Valor,
		&f.Concessionaria,
		&f.MesRef,
		&f.Status,
		&f.CodEmpresa,
		&cliente,
		&resultado,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
			return
		}
		fmt.Printf("[GetFaturaDetalhes] erro: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar fatura"})
		return
	}

	if resultado.Valid {
		f.ResultadoAnalises = json.RawMessage(resultado.String)
	}
	if cliente.Valid {
		f.Cliente = cliente.String
	}

	c.JSON(http.StatusOK, f)
}

// POST /api/v1/faturas/{id}/reprocessar-ia
// Reprocessa uma fatura com IA (chama arbitragem)
func ReprocessarFaturaIA(c *gin.Context) {
	faturaID := c.Param("id")
	if faturaID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id obrigatório"})
		return
	}

	// Valida que é um ID válido
	_, err := strconv.ParseInt(faturaID, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	// Chama o handler de arbitragem existente
	ArbitrarFaturaHandler(c)
}

// ListFaturasFDEAnalise lista registros de FATURA_DADOS_EXTRAIDOS que têm fichas_apontadas preenchidas
// (resultado do pipeline IA). Retorna os campos no mesmo formato que AnaliseDesvio.jsx espera,
// mantendo compatibilidade com getDecisao() e extractFichas() do frontend.
//
// GET /api/v1/faturas/fde-analise?empresa=14&status=CONFIRMADO&ficha=F02&limit=2000
func ListFaturasFDEAnalise(c *gin.Context) {
	// FATURA_DADOS_EXTRAIDOS fica em db_ressarcimento, conectado via GormDB_App
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

	limitStr := c.DefaultQuery("limit", "2000")
	limit, _ := strconv.Atoi(limitStr)
	if limit <= 0 || limit > 5000 {
		limit = 2000
	}

	empresa := strings.TrimSpace(c.Query("empresa"))
	status := strings.TrimSpace(c.Query("status"))                // CONFIRMADO | INCONCLUSIVO | REFUTADO
	ficha := strings.ToUpper(strings.TrimSpace(c.Query("ficha"))) // F01..F14

	conditions := []string{
		"fde.fichas_apontadas IS NOT NULL",
		"fde.fichas_apontadas != ''",
	}
	var args []interface{}

	if empresa != "" && empresa != "0" {
		conditions = append(conditions, "fde.cod_empresa = ?")
		args = append(args, empresa)
	}
	if status != "" {
		// decisao_final está direto no JSON de fichas_apontadas
		conditions = append(conditions, "JSON_UNQUOTE(JSON_EXTRACT(fde.fichas_apontadas, '$.decisao_final')) = ?")
		args = append(args, status)
	}
	if ficha != "" {
		// Verifica se a ficha aparece em fichas_apontadas.fichas_confirmadas[]
		conditions = append(conditions, "JSON_SEARCH(fde.fichas_apontadas, 'one', ?, NULL, '$.fichas_confirmadas[*]') IS NOT NULL")
		args = append(args, ficha)
	}

	query := `
		SELECT
			fde.id,
			COALESCE(fde.uid, '')                          AS uid,
			COALESCE(fde.codigo_uc, '')                    AS codigo_uc,
			COALESCE(fde.valor_total_fatura, 0)            AS valor_total_fatura,
			COALESCE(fde.mes_referencia, '')               AS mes_referencia,
			fde.cod_empresa,
			COALESCE(fde.link_fatura, '')                  AS link_fatura,
			fde.fichas_apontadas
		FROM FATURA_DADOS_EXTRAIDOS fde
		WHERE ` + strings.Join(conditions, " AND ") + `
		ORDER BY fde.id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := sqlDB.Query(query, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar análises FDE: " + err.Error()})
		return
	}
	defer rows.Close()

	var result []map[string]interface{}
	for rows.Next() {
		var (
			id              int64
			uid             string
			codigoUC        string
			totalRS         sql.NullFloat64
			mesRef          string
			codEmpresa      sql.NullInt64
			linkFatura      string
			fichasApontadas sql.NullString
		)
		if err := rows.Scan(&id, &uid, &codigoUC, &totalRS, &mesRef, &codEmpresa, &linkFatura, &fichasApontadas); err != nil {
			continue
		}

		// Parse do JSON de decisão armazenado em fichas_apontadas
		var decisaoMap map[string]interface{}
		fichasStr := ""
		if fichasApontadas.Valid && fichasApontadas.String != "" {
			if json.Unmarshal([]byte(fichasApontadas.String), &decisaoMap) == nil {
				if fcs, ok := decisaoMap["fichas_confirmadas"]; ok {
					if fcsArr, ok := fcs.([]interface{}); ok {
						parts := make([]string, 0, len(fcsArr))
						for _, f := range fcsArr {
							parts = append(parts, fmt.Sprint(f))
						}
						fichasStr = strings.Join(parts, ",")
					}
				}
			}
		}

		rsTotal := 0.0
		if totalRS.Valid {
			rsTotal = totalRS.Float64
		}
		codEmp := int64(0)
		if codEmpresa.Valid {
			codEmp = codEmpresa.Int64
		}

		// Wrapper que mantém compatibilidade com getDecisao() do frontend:
		// getDecisao lê row.resultado_analises.ia_opus_5_4_decisao
		row := map[string]interface{}{
			"id":              id,
			"uid":             uid,
			"UC":              codigoUC,
			"RS_Total_Fatura": rsTotal,
			"Mes_Ref":         mesRef,
			"Cod_Empresa":     codEmp,
			"cod_empresa":     codEmp,
			"Link":            linkFatura,
			"Concessionaria":  "",
			"RAZAO_SOCIAL":    "",
			"desvio_pct_max":  nil,
			"peso_alerta_max": 1,
			"fichas_aplicadas": fichasStr,
			"resultado_analises": map[string]interface{}{
				"ia_opus_5_4_decisao": decisaoMap,
			},
		}
		result = append(result, row)
	}

	if result == nil {
		result = []map[string]interface{}{}
	}
	c.JSON(http.StatusOK, result)
}
