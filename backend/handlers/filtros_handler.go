package handlers

import (
	"net/http"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// Retorna todas as etapas disponíveis para filtro (sem duplicar)
// @Summary Listar etapas para filtro
// @Tags Filtros
// @Produce json
// @Success 200 {array} string
// @Router /api/v1/filtros/etapas [get]
func GetEtapasParaFiltro(c *gin.Context) {
	rows, err := queryGorm(database.GormDB_App, `
		SELECT DISTINCT etapa
		  FROM DM_ETAPAS_PROCESSO
		 WHERE etapa IS NOT NULL AND TRIM(etapa) <> ''
		 ORDER BY etapa ASC;
	`)
	if err != nil {
		// Fallback em dev: retorna lista vazia
		c.JSON(http.StatusOK, []string{})
		return
	}
	defer rows.Close()

	out := make([]string, 0, 16)
	for rows.Next() {
		var etapa string
		if err := rows.Scan(&etapa); err == nil {
			etapa = strings.TrimSpace(etapa)
			if etapa != "" {
				out = append(out, etapa)
			}
		}
	}
	c.JSON(http.StatusOK, out)
}

// Retorna todas as subetapas distintas existentes nos processos (sem duplicar)
// @Summary Listar subetapas para filtro
// @Tags Filtros
// @Produce json
// @Success 200 {array} string
// @Router /api/v1/filtros/subetapas [get]
func GetSubEtapasParaFiltro(c *gin.Context) {
	rows, err := queryGorm(database.GormDB_App, `
		SELECT DISTINCT sub_etapa
		  FROM FT_PROCESSOS
		 WHERE sub_etapa IS NOT NULL AND TRIM(sub_etapa) <> ''
		 ORDER BY sub_etapa ASC;
	`)
	if err != nil {
		// Fallback em dev: retorna lista vazia
		c.JSON(http.StatusOK, []string{})
		return
	}
	defer rows.Close()

	out := make([]string, 0, 32)
	for rows.Next() {
		var se string
		if err := rows.Scan(&se); err == nil {
			se = strings.TrimSpace(se)
			if se != "" {
				out = append(out, se)
			}
		}
	}
	c.JSON(http.StatusOK, out)
}

