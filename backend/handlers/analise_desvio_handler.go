package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

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
