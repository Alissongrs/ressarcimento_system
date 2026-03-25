package handlers

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ListFaturasCache retorna todos os campos de Faturas_Registradas_Cache dinamicamente.
func ListFaturasCache(c *gin.Context) {
	db := database.GormDB_Faturas
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco de faturas não disponível"})
		return
	}

	limitStr := c.DefaultQuery("limit", "200")
	offsetStr := c.DefaultQuery("offset", "0")
	limit, _ := strconv.Atoi(limitStr)
	offset, _ := strconv.Atoi(offsetStr)
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}

	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	rows, err := sqlDB.Query("SELECT * FROM Faturas_Registradas_Cache ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao consultar faturas"})
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
	if err := sqlDB.QueryRow("SELECT COUNT(*) FROM Faturas_Registradas_Cache").Scan(&total); err != nil {
		total = 0
	}

	_ = sql.ErrNoRows // evitar import não usado

	c.JSON(http.StatusOK, gin.H{
		"columns": cols,
		"rows":    result,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	})
}
