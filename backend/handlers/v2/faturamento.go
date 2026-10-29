package v2

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetFaturamentos — GET /api/v2/processos/:id/faturamento (lista)
// Retorna cada NF com sua lista de itens (FT_FATURAMENTO_ITEM), forma de
// devolução resolvida (DM_FORMAS_DEVOLUCAO) e observações.
func GetFaturamentos(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	const q = `
SELECT
    id_faturamento, COALESCE(numero_nf,''), COALESCE(serie_nf,''),
    data_emissao, data_envio_financeiro, data_vencimento, data_pagamento,
    valor,
    COALESCE(status_nf,'em_emissao'),
    COALESCE(observacoes,'')
FROM FT_FATURAMENTO
WHERE id_processo = ?
ORDER BY COALESCE(data_emissao, created_at) DESC, id_faturamento DESC`

	rows, err := db.QueryContext(c.Request.Context(), q, id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	idFaturamentos := []int{}
	itemPorId := map[int]gin.H{}
	for rows.Next() {
		var (
			idFat                                      int
			numNF, serieNF                             string
			dtEmiss, dtEnvio, dtVenc, dtPag            sql.NullTime
			valor                                      sql.NullFloat64
			statusNF, observ                           string
		)
		if err := rows.Scan(&idFat, &numNF, &serieNF,
			&dtEmiss, &dtEnvio, &dtVenc, &dtPag,
			&valor, &statusNF, &observ); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		item := gin.H{
			"id_faturamento": idFat,
			"numero_nf":      nullableStr(numNF),
			"serie_nf":       nullableStr(serieNF),
			"status_nf":      statusNF,
			"observacoes":    nullableStr(observ),
			"itens":          []gin.H{},
		}
		if dtEmiss.Valid {
			item["data_emissao"] = dtEmiss.Time.Format("2006-01-02")
		}
		if dtEnvio.Valid {
			item["data_envio_distribuidora"] = dtEnvio.Time.Format("2006-01-02")
			// Alias moderno pra UI: "Envio ao Financeiro"
			item["data_envio_financeiro"] = dtEnvio.Time.Format("2006-01-02")
		}
		if dtVenc.Valid {
			item["data_vencimento"] = dtVenc.Time.Format("2006-01-02")
		}
		if dtPag.Valid {
			item["data_pagamento"] = dtPag.Time.Format("2006-01-02")
		}
		if valor.Valid {
			item["valor_faturado"] = valor.Float64
		}
		items = append(items, item)
		idFaturamentos = append(idFaturamentos, idFat)
		itemPorId[idFat] = item
	}

	// Buscar itens de devolução em lote (1 query, IN(...))
	if len(idFaturamentos) > 0 {
		placeholders := ""
		args := make([]interface{}, 0, len(idFaturamentos))
		for i, fid := range idFaturamentos {
			if i > 0 {
				placeholders += ","
			}
			placeholders += "?"
			args = append(args, fid)
		}

		qItens := `
SELECT
    fi.id_faturamento_item, fi.id_faturamento, fi.id_forma_devolucao,
    COALESCE(fd.nome,''), fi.data_devolucao, fi.valor, COALESCE(fi.referencia,''),
    fi.data_envio_financeiro, fi.id_fluxo_origem
FROM FT_FATURAMENTO_ITEM fi
LEFT JOIN DM_FORMAS_DEVOLUCAO fd ON fd.id_forma = fi.id_forma_devolucao
WHERE fi.id_faturamento IN (` + placeholders + `)
ORDER BY fi.id_faturamento, fi.id_faturamento_item`

		itRows, err := db.QueryContext(c.Request.Context(), qItens, args...)
		if err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
			return
		}
		defer itRows.Close()

		for itRows.Next() {
			var (
				idIt, idFat   int
				idForma       sql.NullInt64
				formaNome     string
				dtDev         sql.NullTime
				valor         sql.NullFloat64
				referencia    string
				dtEnvioFin    sql.NullTime
				idFluxoOrigem sql.NullInt64
			)
			if err := itRows.Scan(&idIt, &idFat, &idForma, &formaNome, &dtDev, &valor,
				&referencia, &dtEnvioFin, &idFluxoOrigem); err != nil {
				apiError(c, http.StatusInternalServerError, "DB_ERR", "scan_item: "+err.Error(), nil)
				return
			}
			it := gin.H{
				"id_faturamento_item":  idIt,
				"forma_devolucao_nome": nullableStr(formaNome),
				"referencia":           referencia,
			}
			if idForma.Valid {
				it["id_forma_devolucao"] = idForma.Int64
			}
			if dtDev.Valid {
				it["data_devolucao"] = dtDev.Time.Format("2006-01-02")
			}
			if valor.Valid {
				it["valor"] = valor.Float64
			}
			if dtEnvioFin.Valid {
				it["data_envio_financeiro"] = dtEnvioFin.Time.Format("2006-01-02")
			}
			if idFluxoOrigem.Valid {
				it["id_fluxo_origem"] = idFluxoOrigem.Int64
			}
			if parent, ok := itemPorId[idFat]; ok {
				parent["itens"] = append(parent["itens"].([]gin.H), it)
			}
		}
	}

	// Dropdown de formas
	formas := []gin.H{}
	fRows, err := db.QueryContext(c.Request.Context(),
		"SELECT id_forma, nome FROM DM_FORMAS_DEVOLUCAO ORDER BY id_forma")
	if err == nil {
		defer fRows.Close()
		for fRows.Next() {
			var fid int
			var fnome string
			if err := fRows.Scan(&fid, &fnome); err == nil {
				formas = append(formas, gin.H{"id_forma": fid, "nome": fnome})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"items": items, "formas_devolucao": formas})
}
