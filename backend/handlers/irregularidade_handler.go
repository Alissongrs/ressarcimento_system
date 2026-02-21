package handlers

import (
	"net/http"
	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// DefiniÃ§ão dos tipos
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
// GetTiposIrregularidade godoc
// @Summary      Lista tipos de irregularidade
// @Tags         Irregularidades
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/tipos-irregularidade [get]
func GetTiposIrregularidade(c *gin.Context) {
	rows, err := queryGorm(database.GormDB_App, "SELECT id_tipo, nome FROM DM_TIPO_IRREGULARIDADE ORDER BY nome")
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
// GetSubtiposIrregularidade godoc
// @Summary      Lista subtipos de irregularidade
// @Tags         Irregularidades
// @Param        tipoID  path   int  true  "ID do tipo"
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/tipos-irregularidade/{tipoID}/subtipos [get]
func GetSubtiposIrregularidade(c *gin.Context) {
	tipoID := c.Param("tipoID")

	rows, err := queryGorm(database.GormDB_App, 
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

