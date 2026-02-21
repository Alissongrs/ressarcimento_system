package handlers

import (
	"net/http"
	"strconv"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

type CardMeta struct {
	ID         int64      `json:"id"`
	UltimaMov  *UltMovDTO `json:"ultima_mov,omitempty"`
	Anexos     int        `json:"anexos"`
	Faturas    int        `json:"faturas"`
	Indeferido bool       `json:"indeferido"`
}

type UltMovDTO struct {
	Data       string `json:"data"`
	Comentario string `json:"comentario"`
	Usuario    string `json:"usuario"`
}

// GetProcessosCardsMeta retorna metadados em lote para uma lista de processos (ids separados por vírgula)
// GET /api/v1/processos/cards-meta?ids=1,2,3
// GetProcessosCardsMeta godoc
// @Summary      Metadados de cards de processos
// @Tags         Processos
// @Param        ids  query  string  false  "IDs separados por vírgula"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/cards-meta [get]
func GetProcessosCardsMeta(c *gin.Context) {
	idsParam := strings.TrimSpace(c.Query("ids"))
	if idsParam == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ids obrigatorio"})
		return
	}

	parts := strings.Split(idsParam, ",")
	ids := make([]int64, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if n, err := strconv.ParseInt(p, 10, 64); err == nil && n > 0 {
			ids = append(ids, n)
		}
	}
	if len(ids) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ids invalidos"})
		return
	}

	db := database.GormDB_App

	// Construir placeholders
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	inClause := strings.Join(ph, ",")

	// Último histórico por id
	ultMap := make(map[int64]UltMovDTO, len(ids))
	qUlt := `
        SELECT h.id_requisicao,
               DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') AS data_movimentacao,
               COALESCE(h.comentario, '') AS comentario,
               COALESCE(u.nome_usuario, 'Sistema') AS usuario
          FROM FT_HISTORICO_MOVIMENTACOES h
          LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
          JOIN (
                SELECT id_requisicao, MAX(data_movimentacao) AS max_dt
                  FROM FT_HISTORICO_MOVIMENTACOES
                 WHERE id_requisicao IN (` + inClause + `)
                 GROUP BY id_requisicao
               ) m ON m.id_requisicao = h.id_requisicao AND h.data_movimentacao = m.max_dt`
	if rows, err := queryGorm(db, qUlt, args...); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id int64
			var dt, com, user string
			if err := rows.Scan(&id, &dt, &com, &user); err == nil {
				ultMap[id] = UltMovDTO{Data: dt, Comentario: com, Usuario: user}
			}
		}
	}

	// Contagem de anexos por id
	anexMap := make(map[int64]int, len(ids))
	qAn := `SELECT id_requisicao, COUNT(*) FROM FT_ANEXOS WHERE id_requisicao IN (` + inClause + `) GROUP BY id_requisicao`
	if rows, err := queryGorm(db, qAn, args...); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id int64
			var cnt int
			if err := rows.Scan(&id, &cnt); err == nil {
				anexMap[id] = cnt
			}
		}
	}

	// Indeferido por id (via etapa)
	indefer := make(map[int64]bool, len(ids))
	qInd := `
        SELECT p.id_processo,
               CASE WHEN LOWER(COALESCE(e.etapa,'')) REGEXP 'indefer|improced' THEN 1 ELSE 0 END AS indeferido
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
         WHERE p.id_processo IN (` + inClause + `)`
	if rows, err := queryGorm(db, qInd, args...); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id int64
			var flag int
			if err := rows.Scan(&id, &flag); err == nil {
				indefer[id] = flag == 1
			}
		}
	}

	// Faturas por id (tabela cache se existir)
	fatMap := make(map[int64]int, len(ids))
	// Detecta tabela existente
	hasTable := func(name string) bool {
		var cnt int
		_ = queryRowGorm(db, `SELECT COUNT(1) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, name).Scan(&cnt)
		return cnt > 0
	}
	if hasTable("FT_FATURAS_CACHE") {
		qF := `SELECT id_processo, COUNT(*) FROM FT_FATURAS_CACHE WHERE id_processo IN (` + inClause + `) GROUP BY id_processo`
		if rows, err := queryGorm(db, qF, args...); err == nil {
			defer rows.Close()
			for rows.Next() {
				var id int64
				var cnt int
				if err := rows.Scan(&id, &cnt); err == nil {
					fatMap[id] = cnt
				}
			}
		}
	} else if hasTable("FT_FATURAS") {
		qF := `SELECT id_processo, COUNT(*) FROM FT_FATURAS WHERE id_processo IN (` + inClause + `) GROUP BY id_processo`
		if rows, err := queryGorm(db, qF, args...); err == nil {
			defer rows.Close()
			for rows.Next() {
				var id int64
				var cnt int
				if err := rows.Scan(&id, &cnt); err == nil {
					fatMap[id] = cnt
				}
			}
		}
	}

	out := make([]CardMeta, 0, len(ids))
	for _, id := range ids {
		m := CardMeta{ID: id}
		if u, ok := ultMap[id]; ok {
			m.UltimaMov = &u
		}
		if a, ok := anexMap[id]; ok {
			m.Anexos = a
		}
		if f, ok := fatMap[id]; ok {
			m.Faturas = f
		}
		if b, ok := indefer[id]; ok {
			m.Indeferido = b
		}
		out = append(out, m)
	}
	c.JSON(http.StatusOK, out)
}



