package handlers

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ListarReanalisesHandler — retorna o histórico de reanálises IA de uma fatura.
//
// GET /api/v1/faturas/:id/reanalises
//
// Resposta:
//   [
//     { id, fatura_id, decisao_final, ficha_principal, fichas_confirmadas,
//       confianca_final, percentual_ressarcimento, justificativa, recomendacao,
//       modelo, pdf_anexado, v19_score_confianca, v19_parcela_alerta,
//       v19_total_estimado, v19_status_passibilidade,
//       usuario_id, usuario_nome, criado_em },
//     ...
//   ]
//
// Ordenado por criado_em DESC (mais recente primeiro).
func ListarReanalisesHandler(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	rows, err := sqlDB.Query(`
		SELECT
			id, fatura_id, decisao_final, ficha_principal, fichas_confirmadas,
			confianca_final, percentual_ressarcimento, justificativa, recomendacao,
			modelo, pdf_anexado,
			v19_score_confianca, v19_parcela_alerta, v19_total_estimado,
			v19_status_passibilidade,
			usuario_id, usuario_nome, criado_em
		FROM FATURA_REANALISES
		WHERE fatura_id = ?
		ORDER BY criado_em DESC
		LIMIT 50
	`, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao listar histórico: " + err.Error()})
		return
	}
	defer rows.Close()

	type linha struct {
		ID                 int64       `json:"id"`
		FaturaID           int64       `json:"fatura_id"`
		DecisaoFinal       *string     `json:"decisao_final"`
		FichaPrincipal     *string     `json:"ficha_principal"`
		FichasConfirmadas  interface{} `json:"fichas_confirmadas"`
		ConfiancaFinal     *int        `json:"confianca_final"`
		PercentualRess     *float64    `json:"percentual_ressarcimento"`
		Justificativa      *string     `json:"justificativa"`
		Recomendacao       *string     `json:"recomendacao"`
		Modelo             *string     `json:"modelo"`
		PdfAnexado         int         `json:"pdf_anexado"`
		V19Score           *int        `json:"v19_score_confianca"`
		V19Alerta          *string     `json:"v19_parcela_alerta"`
		V19Total           *float64    `json:"v19_total_estimado"`
		V19StatusPassib    *string     `json:"v19_status_passibilidade"`
		UsuarioID          *int64      `json:"usuario_id"`
		UsuarioNome        *string     `json:"usuario_nome"`
		CriadoEm           string      `json:"criado_em"`
	}

	resp := []linha{}
	for rows.Next() {
		var (
			l linha
			decisao, ficha, justif, recom, modelo, alerta, statusPass, usuario sql.NullString
			fichas sql.NullString
			conf, score sql.NullInt64
			usrID sql.NullInt64
			pctRess, total sql.NullFloat64
			pdfAnex int
			criadoEm sql.NullTime
		)
		if err := rows.Scan(&l.ID, &l.FaturaID, &decisao, &ficha, &fichas,
			&conf, &pctRess, &justif, &recom, &modelo, &pdfAnex,
			&score, &alerta, &total, &statusPass,
			&usrID, &usuario, &criadoEm); err != nil {
			continue
		}
		setIfStr := func(p **string, v sql.NullString) { if v.Valid && v.String != "" { s := v.String; *p = &s } }
		setIfInt := func(p **int, v sql.NullInt64)       { if v.Valid { n := int(v.Int64); *p = &n } }
		setIfFloat := func(p **float64, v sql.NullFloat64) { if v.Valid { f := v.Float64; *p = &f } }

		setIfStr(&l.DecisaoFinal, decisao)
		setIfStr(&l.FichaPrincipal, ficha)
		setIfInt(&l.ConfiancaFinal, conf)
		setIfFloat(&l.PercentualRess, pctRess)
		setIfStr(&l.Justificativa, justif)
		setIfStr(&l.Recomendacao, recom)
		setIfStr(&l.Modelo, modelo)
		setIfInt(&l.V19Score, score)
		setIfStr(&l.V19Alerta, alerta)
		setIfFloat(&l.V19Total, total)
		setIfStr(&l.V19StatusPassib, statusPass)
		setIfStr(&l.UsuarioNome, usuario)
		l.PdfAnexado = pdfAnex
		if usrID.Valid {
			n := usrID.Int64
			l.UsuarioID = &n
		}
		if fichas.Valid && fichas.String != "" {
			l.FichasConfirmadas = fichas.String // pode parsear JSON no front
		}
		if criadoEm.Valid {
			l.CriadoEm = criadoEm.Time.Format("2006-01-02T15:04:05Z07:00")
		}

		resp = append(resp, l)
	}

	c.JSON(http.StatusOK, resp)
}
