package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

// GetEtapaSubCombinacoes retorna combinações válidas etapa -> sub_etapas.
// Preferência: DM_ETAPA_SUBETAPAS_VALIDAS; fallback: pares observados em FT_PROCESSOS.
// @Summary Listar combinacoes etapa/subetapa
// @Tags Filtros
// @Produce json
// @Success 200 {object} map[string]any
// @Failure 500 {object} map[string]string
// @Router /api/v1/filtros/etapas-subetapas [get]
func GetEtapaSubCombinacoes(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	// Fonte única: DM_SUBETAPA_PROCESSOS + regras por etapa
	rows, err := queryGorm(db, `SELECT id_subetapa, nome_subetapa FROM DM_SUBETAPA_PROCESSOS ORDER BY id_subetapa`)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"map": gin.H{}})
		return
	}
	defer rows.Close()

	subByID := make(map[int]string)
	for rows.Next() {
		var id int
		var s string
		if err := rows.Scan(&id, &s); err == nil && id > 0 && strings.TrimSpace(s) != "" {
			subByID[id] = strings.TrimSpace(s)
		}
	}

	contains := func(list []string, sub string) bool {
		for _, x := range list {
			if strings.EqualFold(strings.TrimSpace(x), strings.TrimSpace(sub)) {
				return true
			}
		}
		return false
	}
	pick := func(id int) string {
		return strings.TrimSpace(subByID[id])
	}

	out := make(map[string][]string)
	addIDs := func(etapa string, ids ...int) {
		for _, id := range ids {
			if s := pick(id); s != "" && !contains(out[etapa], s) {
				out[etapa] = append(out[etapa], s)
			}
		}
	}

	// Distribuidora (não exibir id 1 "Primeira reclamação - Em elaboração")
	addIDs("Distribuidora", 2, 4, 6)
	// Ouvidoria
	addIDs("Ouvidoria", 3, 7, 8, 9, 10, 11, 12, 13)
	// ANEEL
	addIDs("ANEEL", 3, 7, 8, 9)
	// SMA
	addIDs("SMA", 3, 7, 8, 9)

	// Fluxo de Ressarcimento
	addIDs("Enviado ao Financeiro", 14, 5)
	// Faturamento
	addIDs("Repasse Amee", 15)
	// Indeferido
	addIDs("Indeferido", 16)
	c.JSON(http.StatusOK, gin.H{"map": out})
}
