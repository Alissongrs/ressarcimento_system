package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
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
// GetBacklogProcessos godoc
// @Summary      Lista processos em backlog
// @Tags         Processos
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/backlog [get]
func GetBacklogProcessos(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	// base query — processos em "Em elaboração" (id_status_atual=2). O corte de quem
	// entra no backlog não é mais "60 dias sem movimentação" e sim o prazo por instância
	// (Fase 1, services.PrazoPorInstancia), calculado em Go logo abaixo (dias úteis para
	// Distribuidora/Ouvidoria, corridos para ANEEL/SMA — não dá pra fazer isso em SQL puro).
	base := `
SELECT
    p.id_processo,
    r.uc,
    COALESCE(r.cliente, '') AS cliente,
    COALESCE(r.concessionaria, '') AS concessionaria,
    r.ressarcimento_estimado,
    COALESCE(vh.data_movimentacao, p.ultima_atualizacao, r.data_mudanca_status, r.data_criacao) AS data_ultima_movimentacao,
    TIMESTAMPDIFF(DAY, COALESCE(vh.data_movimentacao, p.ultima_atualizacao, r.data_mudanca_status, r.data_criacao), NOW()) AS dias_sem_movimentacao,
    COALESCE(p.id_instancia_atual, 0) AS id_instancia,
    hs.data_movimentacao AS prazo_data_base,
    bc.checked_by,
    bc.checked_at
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
LEFT JOIN (
    SELECT id_processo, MAX(data_movimentacao) AS data_movimentacao
      FROM FT_HISTORICO_MOVIMENTACOES
     GROUP BY id_processo
) vh ON vh.id_processo = p.id_processo
LEFT JOIN (
    -- data em que o processo entrou no status atual (2=Em elaboração) — base do prazo (Fase 1)
    SELECT id_processo, id_status_novo, MAX(data_movimentacao) AS data_movimentacao
      FROM FT_HISTORICO_MOVIMENTACOES
     GROUP BY id_processo, id_status_novo
) hs ON hs.id_processo = p.id_processo AND hs.id_status_novo = p.id_status_atual
LEFT JOIN BACKLOG_CHECKS bc ON bc.id_processo = p.id_processo
JOIN DM_ETAPAS e ON e.id_etapa = p.id_etapa_atual
WHERE LOWER(TRIM(CASE WHEN p.id_aprovacao_atual=2 THEN 'Indeferidos' WHEN p.id_status_atual=5 THEN 'Suspensos' WHEN p.id_etapa_atual=6 THEN 'Concluídos' WHEN p.id_etapa_atual IN (4,5) THEN 'Faturamento' WHEN p.id_aprovacao_atual=1 THEN 'Deferidos' ELSE 'Ativos' END)) NOT IN (
    'concluidos','concluido',
    'indeferidos','indeferido',
    'rejeitados','rejeitado',
    'suspensos','suspenso'
) AND COALESCE((p.id_status_atual=5)/* TODO V2 */,0)=0
  AND p.id_status_atual = 2 -- Em elaboração
`

	rows, err := queryGorm(db, `SELECT * FROM (`+base+`) x ORDER BY x.data_ultima_movimentacao ASC`)
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
		var idInstancia int
		var prazoDataBase sql.NullTime
		var checkedBy sql.NullInt64
		var checkedAt sql.NullTime
		if err := rows.Scan(&it.ID, &it.UC, &it.Cliente, &it.Concess, &it.Valor, &it.DataUlt, &it.DiasSem, &idInstancia, &prazoDataBase, &checkedBy, &checkedAt); err != nil {
			log.Printf("GetBacklogProcessos scan error: %v", err)
			continue
		}
		// Só entra no backlog se estiver vencido pela regra de prazo por instância.
		if !prazoDataBase.Valid {
			continue
		}
		regra, ok := services.PrazoPorInstancia[idInstancia]
		if !ok {
			continue
		}
		var decorridos int
		if regra.Uteis {
			decorridos = services.DiasUteisEntre(prazoDataBase.Time, time.Now())
		} else {
			decorridos = services.DiasCorridosEntre(prazoDataBase.Time, time.Now())
		}
		if decorridos <= regra.Dias {
			continue // ainda dentro do prazo
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

	c.JSON(http.StatusOK, gin.H{
		"rows":         out,
		"count":        len(out),
		"total":        total,
		"tratados":     tratados,
		"nao_tratados": total - tratados,
	})
}

// POST /api/v1/processos/:id/backlog-check  {checked: true|false}
// ToggleBacklogCheck godoc
// @Summary      Marca/desmarca backlog check
// @Tags         Processos
// @Param        id   path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/{id}/backlog-check [post]
func ToggleBacklogCheck(c *gin.Context) {
	db := database.GormDB_App
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
		_, err := execGorm(db,
			"INSERT INTO BACKLOG_CHECKS (id_processo, checked_by, checked_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE checked_by=VALUES(checked_by), checked_at=VALUES(checked_at)",
			pid, uid,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao marcar"})
			return
		}
	} else {
		if _, err := execGorm(db, "DELETE FROM BACKLOG_CHECKS WHERE id_processo = ?", pid); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao desmarcar"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
