package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

// ListInstanciasDeferimento devolve as instâncias possíveis para um deferimento
// (Distribuidora, Ouvidoria, ANEEL, SMA), lendo direto de DM_INSTANCIA_DEFERIMENTO.
//
// @Summary Listar instâncias de deferimento
// @Tags    Filtros
// @Produce json
// @Success 200 {array}  map[string]any
// @Failure 500 {object} map[string]string
// @Router  /api/v1/instancias-deferimento [get]
func ListInstanciasDeferimento(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	rows, err := queryGorm(db, `SELECT id_instancia, nome FROM DM_INSTANCIA_DEFERIMENTO ORDER BY id_instancia`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	type item struct {
		ID   int    `json:"id"`
		Nome string `json:"nome"`
	}
	var out []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.ID, &it.Nome); err == nil {
			out = append(out, it)
		}
	}
	if out == nil {
		out = []item{}
	}
	c.JSON(http.StatusOK, out)
}
