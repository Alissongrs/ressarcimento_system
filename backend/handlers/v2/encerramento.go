package v2

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetEncerramento — GET /api/v2/processos/:id/encerramento
func GetEncerramento(c *gin.Context) {
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
    e.id_encerramento, e.data_encerramento, e.motivo,
    e.id_aprovacao_final, a.nome,
    COALESCE(e.parecer_final,'')
FROM FT_ENCERRAMENTO e
JOIN DM_STATUS_APROVACAO a ON a.id_aprovacao = e.id_aprovacao_final
WHERE e.id_processo = ?`

	var (
		idEnc     int
		dtEnc     sql.NullTime
		motivo    string
		aprovID   int
		aprovNome string
		parecer   string
	)
	err := db.QueryRowContext(c.Request.Context(), q, id).Scan(
		&idEnc, &dtEnc, &motivo, &aprovID, &aprovNome, &parecer)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusOK, nil)
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	out := gin.H{
		"id_encerramento":   idEnc,
		"motivo":            motivo,
		"aprovacao_final":   RefID{ID: aprovID, Nome: aprovNome},
		"parecer_final":     nullableStr(parecer),
	}
	if dtEnc.Valid {
		out["data_encerramento"] = dtEnc.Time.Format("2006-01-02")
	}
	c.JSON(http.StatusOK, out)
}
