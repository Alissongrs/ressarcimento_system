package v2

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetRepasses — GET /api/v2/processos/:id/repasse (lista)
func GetRepasses(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	// O repasse ao cliente final é a data em que a NF de ressarcimento foi paga
	// (FT_FATURAMENTO.data_pagamento) — NÃO as datas de devolução do fluxo, que
	// pertencem ao Faturamento. Lista uma linha por NF do processo.
	const q = `
SELECT
    fat.id_faturamento AS id_repasse,
    fat.valor AS valor_repasse,
    fat.data_pagamento AS data_repasse,
    COALESCE(fat.numero_nf,'') AS numero_nf,
    COALESCE(fat.observacoes,'') AS observacoes,
    def.repasse_simples, def.repasse_dobro
FROM FT_FATURAMENTO fat
LEFT JOIN FT_DEFERIMENTOS def ON def.id_processo = fat.id_processo
WHERE fat.id_processo = ?
ORDER BY COALESCE(fat.data_pagamento, fat.created_at) DESC, fat.id_faturamento DESC`

	rows, err := db.QueryContext(c.Request.Context(), q, id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var (
			idRep     int
			valor     sql.NullFloat64
			dtRep     sql.NullTime
			numeroNF  string
			obs       string
			repS      sql.NullFloat64
			repD      sql.NullFloat64
		)
		if err := rows.Scan(&idRep, &valor, &dtRep, &numeroNF, &obs, &repS, &repD); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		item := gin.H{
			"id_repasse": idRep,
			"numero_nf":   nullableStr(numeroNF),
			"observacoes": nullableStr(obs),
		}
		if repS.Valid {
			item["repasse_simples"] = repS.Float64
		}
		if repD.Valid {
			item["repasse_dobro"] = repD.Float64
		}
		if valor.Valid {
			item["valor_repasse"] = valor.Float64
		}
		if dtRep.Valid {
			item["data_repasse"] = dtRep.Time.Format("2006-01-02")
		}
		items = append(items, item)
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}
