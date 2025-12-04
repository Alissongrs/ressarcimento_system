package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

type backlogCheck struct {
	ID        int        `json:"id"`
	UC        string     `json:"uc"`
	Cliente   string     `json:"cliente"`
	Concess   string     `json:"concessionaria"`
	Valor     *float64   `json:"valor_estimado,omitempty"`
	DataUlt   time.Time  `json:"data_ultima_movimentacao"`
	DiasSem   int        `json:"dias_sem_movimentacao"`
	Checked   bool       `json:"checked"`
	CheckedAt *time.Time `json:"checked_at,omitempty"`
	CheckedBy *int64     `json:"checked_by,omitempty"`
}

// GetBacklogProcessos retorna processos ordenados pela data de ultima movimentacao mais antiga
func GetBacklogProcessos(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	// base query (será reusada para dados e para contagens)
	base := `
SELECT
    p.id_processo,
    r.uc,
    COALESCE(r.cliente, '') AS cliente,
    COALESCE(r.concessionaria, '') AS concessionaria,
    r.ressarcimento_estimado,
    COALESCE(vh.data_movimentacao, p.ultima_atualizacao, r.data_mudanca_status, r.data_criacao) AS data_ultima_movimentacao,
    TIMESTAMPDIFF(DAY, COALESCE(vh.data_movimentacao, p.ultima_atualizacao, r.data_mudanca_status, r.data_criacao), NOW()) AS dias_sem_movimentacao,
    bc.checked_by,
    bc.checked_at
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
LEFT JOIN (
    SELECT id_requisicao, MAX(data_movimentacao) AS data_movimentacao
      FROM FT_HISTORICO_MOVIMENTACOES
     GROUP BY id_requisicao
) vh ON vh.id_requisicao = p.id_processo
LEFT JOIN BACKLOG_CHECKS bc ON bc.id_processo = p.id_processo
JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban
WHERE LOWER(TRIM(kc.nome_coluna)) NOT IN (
    'concluidos','concluido',
    'indeferidos','indeferido',
    'rejeitados','rejeitado',
    'suspensos','suspenso'
) AND COALESCE(p.suspenso,0)=0
`

	// Apenas processos com última movimentação há 60+ dias
	dataFilter := "WHERE x.dias_sem_movimentacao >= 60"

	queryRows := `
SELECT *
  FROM (` + base + `) x
` + dataFilter + `
ORDER BY x.data_ultima_movimentacao ASC`

	rows, err := db.Query(queryRows)
	if err != nil {
		log.Printf("GetBacklogProcessos query error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao consultar backlog"})
		return
	}
	defer rows.Close()

	out := make([]backlogCheck, 0, 1024)
	var total int
	var tratados int
	for rows.Next() {
		var it backlogCheck
		var checkedBy sql.NullInt64
		var checkedAt sql.NullTime
		if err := rows.Scan(&it.ID, &it.UC, &it.Cliente, &it.Concess, &it.Valor, &it.DataUlt, &it.DiasSem, &checkedBy, &checkedAt); err != nil {
			log.Printf("GetBacklogProcessos scan error: %v", err)
			continue
		}
		total++
		if checkedBy.Valid {
			it.Checked = true
			v := checkedBy.Int64
			it.CheckedBy = &v
			tratados++
		}
		if checkedAt.Valid {
			t := checkedAt.Time
			it.CheckedAt = &t
		}
		out = append(out, it)
	}

	// contagens totais (sem LIMIT)
	var totalCount, tratadosCount int
	countQuery := `
SELECT COUNT(*) AS total,
       SUM(CASE WHEN x.checked_by IS NOT NULL THEN 1 ELSE 0 END) AS tratados
  FROM (` + base + `) x
` + dataFilter
	if err := db.QueryRow(countQuery).Scan(&totalCount, &tratadosCount); err != nil {
		log.Printf("GetBacklogProcessos count error: %v", err)
		// fallback para os contadores obtidos na paginaÇõÇœo
		totalCount = total
		tratadosCount = tratados
	}

	c.JSON(http.StatusOK, gin.H{
		"rows":         out,
		"count":        len(out),
		"total":        totalCount,
		"tratados":     tratadosCount,
		"nao_tratados": totalCount - tratadosCount,
	})
}

// POST /api/v1/processos/:id/backlog-check  {checked: true|false}
func ToggleBacklogCheck(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	uidVal, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
		return
	}
	uid, _ := uidVal.(int64)

	idStr := c.Param("id")
	pid, err := strconv.Atoi(idStr)
	if err != nil || pid <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id invalido"})
		return
	}

	var body struct {
		Checked bool `json:"checked"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload invalido"})
		return
	}

	if body.Checked {
		_, err := db.Exec(
			"INSERT INTO BACKLOG_CHECKS (id_processo, checked_by, checked_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE checked_by=VALUES(checked_by), checked_at=VALUES(checked_at)",
			pid, uid,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao marcar"})
			return
		}
	} else {
		if _, err := db.Exec("DELETE FROM BACKLOG_CHECKS WHERE id_processo = ?", pid); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao desmarcar"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
