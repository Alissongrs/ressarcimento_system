package v2

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// SetRelevancia — PATCH /api/v2/processos/:id/relevancia
// Body: { "relevante": bool }  → grava FT_PROCESSOS.relevancia (0/1).
func SetRelevancia(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	if !ensureProcesso(c, db, id) {
		return
	}

	var req struct {
		Relevante bool `json:"relevante"`
	}
	if !bindJSON(c, &req) {
		return
	}

	val := 0
	if req.Relevante {
		val = 1
	}
	if _, err := db.ExecContext(c.Request.Context(),
		"UPDATE FT_PROCESSOS SET relevancia = ?, ultima_atualizacao = CURRENT_TIMESTAMP WHERE id_processo = ?",
		val, id); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	c.JSON(http.StatusOK, gin.H{"relevante": req.Relevante})
}
