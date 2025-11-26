package handlers

import (
	"net/http"
	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// Definição dos tipos
type TipoIrregularidade struct {
	ID   int    `json:"id"`
	Nome string `json:"nome"`
}

type SubtipoIrregularidade struct {
	ID   int    `json:"id"`
	Nome string `json:"nome"`
}

// ----------------------------
// Buscar todos os Tipos
// ----------------------------
func GetTiposIrregularidade(c *gin.Context) {
	rows, err := database.DB_App.Query("SELECT id_tipo, nome FROM DM_TIPO_IRREGULARIDADE ORDER BY nome")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar tipos de irregularidade"})
		return
	}
	defer rows.Close()

	var tipos []TipoIrregularidade

	for rows.Next() {
		var t TipoIrregularidade
		if err := rows.Scan(&t.ID, &t.Nome); err != nil {
			continue
		}
		tipos = append(tipos, t)
	}

	c.JSON(http.StatusOK, tipos)
}

// ----------------------------
// Buscar subtipos por tipoID
// ----------------------------
func GetSubtiposIrregularidade(c *gin.Context) {
	tipoID := c.Param("tipoID")

	rows, err := database.DB_App.Query(
		"SELECT id_subtipo, nome FROM DM_SUBTIPO_IRREGULARIDADE WHERE id_tipo = ? ORDER BY nome", tipoID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar subtipos de irregularidade"})
		return
	}
	defer rows.Close()

	var subtipos []SubtipoIrregularidade

	for rows.Next() {
		var s SubtipoIrregularidade
		if err := rows.Scan(&s.ID, &s.Nome); err != nil {
			continue
		}
		subtipos = append(subtipos, s)
	}

	c.JSON(http.StatusOK, subtipos)
}
