package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

type SearchHit struct {
	IDHistorico      int64  `json:"id_historico"`
	ProcessoID       int64  `json:"processo_id"`
	DataMovimentacao string `json:"data_movimentacao"`
	UsuarioNome      string `json:"usuario_nome"`
	Comentario       string `json:"comentario"`
	StatusComposto   string `json:"status_composto"`
	CanaisCSV        string `json:"canais"`
}

// GET /api/v1/search/global?q=texto&limit=100&offset=0
// Busca texto em todo o histórico de movimentaÃ§ões e retorna hits com id do processo.
// @Summary Busca global no historico
// @Tags Search
// @Produce json
// @Param q query string true "Termo"
// @Param limit query int false "Limite"
// @Param offset query int false "Offset"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/search/global [get]
func SearchGlobal(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "parâmetro q é obrigatório"})
		return
	}
	limit := 100
	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	offset := 0
	if v := strings.TrimSpace(c.Query("offset")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	like := "%" + strings.ToLower(q) + "%"
	processID := int64(0)
	if n, err := strconv.ParseInt(q, 10, 64); err == nil && n > 0 {
		processID = n
	}
	whereParts := []string{
		"LOWER(CONCAT_WS(' ', COALESCE(h.comentario,''), COALESCE(u.nome_usuario,''), COALESCE(NULLIF(h.etapa_nova,''), NULLIF(h.etapa_anterior,''), ''), COALESCE(h.sub_etapa,''))) LIKE ?",
		`EXISTS (
                SELECT 1 
                FROM FT_HISTORICO_CANAIS hc2
                JOIN DM_CANAIS_COMUNICACAO dc2 ON dc2.id_canal = hc2.id_canal
                WHERE hc2.id_historico = h.id_historico
                  AND LOWER(TRIM(dc2.nome)) LIKE ?
            )`,
		"LOWER(COALESCE(r.uc,'')) LIKE ?",
	}
	args := []any{like, like, like}
	if processID > 0 {
		whereParts = append(whereParts, "r.id_requisicao = ?")
		args = append(args, processID)
	}
	whereSQL := "WHERE " + strings.Join(whereParts, " OR ")

	rows, err := queryGorm(database.GormDB_App, `
        SELECT
            COALESCE(h.id_historico, 0) AS id_historico,
            r.id_requisicao AS processo_id,
            DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') AS data_movimentacao,
            COALESCE(u.nome_usuario, '') AS usuario_nome,
            COALESCE(h.comentario, '') AS comentario,
            CONCAT_WS(' - ', COALESCE(NULLIF(h.etapa_nova,''), NULLIF(h.etapa_anterior,''), ''), COALESCE(h.sub_etapa, '')) AS status_composto,
            COALESCE(GROUP_CONCAT(LOWER(TRIM(dc.nome)) ORDER BY dc.nome SEPARATOR ','), '') AS canais_csv
        FROM FT_REQUISICOES r
        LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = r.id_requisicao
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        LEFT JOIN FT_HISTORICO_CANAIS hc ON hc.id_historico = h.id_historico
        LEFT JOIN DM_CANAIS_COMUNICACAO dc ON dc.id_canal = hc.id_canal
        `+whereSQL+`
        GROUP BY
            r.id_requisicao,
            h.id_historico,
            h.id_requisicao,
            h.data_movimentacao,
            u.nome_usuario,
            h.comentario,
            h.status_anterior,
            h.status_novo,
            h.etapa_anterior,
            h.etapa_nova,
            h.sub_etapa
        ORDER BY h.data_movimentacao DESC, h.id_historico DESC
        LIMIT ? OFFSET ?
    `, append(args, limit, offset)...)
	if err != nil {
		log.Printf("[SearchGlobal] primary query error: %v\n", err)
		// Fallback: sem canais (sem joins/exists), evita 500 em ambientes sem tabelas auxiliares
		fallbackWhereParts := []string{
			"LOWER(CONCAT_WS(' ', COALESCE(h.comentario,''), COALESCE(u.nome_usuario,''), COALESCE(NULLIF(h.etapa_nova,''), NULLIF(h.etapa_anterior,''), ''), COALESCE(h.sub_etapa,''))) LIKE ?",
			"LOWER(COALESCE(r.uc,'')) LIKE ?",
		}
		fallbackArgs := []any{like, like}
		if processID > 0 {
			fallbackWhereParts = append(fallbackWhereParts, "r.id_requisicao = ?")
			fallbackArgs = append(fallbackArgs, processID)
		}
		fallbackWhereSQL := "WHERE " + strings.Join(fallbackWhereParts, " OR ")
		rows, err = queryGorm(database.GormDB_App, `
            SELECT
                COALESCE(h.id_historico, 0) AS id_historico,
                r.id_requisicao AS processo_id,
                DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') AS data_movimentacao,
                COALESCE(u.nome_usuario, '') AS usuario_nome,
                COALESCE(h.comentario, '') AS comentario,
                CONCAT_WS(' - ', COALESCE(NULLIF(h.etapa_nova,''), NULLIF(h.etapa_anterior,''), ''), COALESCE(h.sub_etapa, '')) AS status_composto,
                '' AS canais_csv
            FROM FT_REQUISICOES r
            LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = r.id_requisicao
            LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
            `+fallbackWhereSQL+`
            ORDER BY h.data_movimentacao DESC, h.id_historico DESC
            LIMIT ? OFFSET ?
        `, append(fallbackArgs, limit, offset)...)
		if err != nil {
			log.Printf("[SearchGlobal] fallback query error: %v\n", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "falha na busca"})
			return
		}
	}
	defer rows.Close()

	results := make([]SearchHit, 0)
	for rows.Next() {
		var it SearchHit
		var canais sql.NullString
		if err := rows.Scan(&it.IDHistorico, &it.ProcessoID, &it.DataMovimentacao, &it.UsuarioNome, &it.Comentario, &it.StatusComposto, &canais); err == nil {
			if canais.Valid {
				it.CanaisCSV = canais.String
			}
			results = append(results, it)
		}
	}
	if results == nil {
		results = []SearchHit{}
	}
	c.JSON(http.StatusOK, gin.H{"results": results, "count": len(results)})
}

