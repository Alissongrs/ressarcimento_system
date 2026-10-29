package v2

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetDeferimento — GET /api/v2/processos/:id/deferimento
// 1 registro por processo (id_processo UNIQUE em FT_DEFERIMENTOS).
func GetDeferimento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	// LEFT JOIN em DM_STATUS_APROVACAO porque agora id_aprovacao pode ser NULL
	// (a aprovação Deferido/Indeferido só é definida no Encerramento).
	const q = `
SELECT
    d.id_deferimento,
    d.id_aprovacao, COALESCE(a.nome,''),
    d.id_instancia, COALESCE(i.nome,''),
    d.data_procedencia,
    d.credito_simples, d.credito_dobro, d.data_credito_dobro,
    COALESCE(d.observacao,'')
FROM FT_DEFERIMENTOS d
LEFT JOIN DM_STATUS_APROVACAO a ON a.id_aprovacao = d.id_aprovacao
LEFT JOIN DM_INSTANCIAS i ON i.id_instancia = d.id_instancia
WHERE d.id_processo = ?`

	var (
		idDef                                                int
		aprovID                                              sql.NullInt64
		aprovNome                                            string
		instID                                               sql.NullInt64
		instNome                                             string
		dtProc                                               sql.NullTime
		creditoSimples, creditoDobro                         sql.NullFloat64
		dtDobro                                              sql.NullTime
		observacao                                           string
	)
	err := db.QueryRowContext(c.Request.Context(), q, id).Scan(
		&idDef, &aprovID, &aprovNome,
		&instID, &instNome,
		&dtProc, &creditoSimples, &creditoDobro, &dtDobro, &observacao)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusOK, nil) // nenhum deferimento ainda
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	out := gin.H{
		"id_deferimento": idDef,
		"aprovacao":      nilableRef(intFromNull(aprovID), aprovNome),
		"instancia":      nilableRef(intFromNull(instID), instNome),
		"observacoes":    observacao,
	}
	if dtProc.Valid {
		out["data_procedencia"] = dtProc.Time.Format("2006-01-02")
	}
	if creditoSimples.Valid {
		out["credito_simples"] = creditoSimples.Float64
	}
	if creditoDobro.Valid {
		out["credito_dobro"] = creditoDobro.Float64
	}
	if dtDobro.Valid {
		out["data_credito_dobro"] = dtDobro.Time.Format("2006-01-02")
	}

	c.JSON(http.StatusOK, out)
}
