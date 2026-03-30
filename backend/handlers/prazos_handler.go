package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// GetPrazosConfig e SavePrazosConfig mantidos para compatibilidade (não usados na regra fixa)

type prazoKanbanRow struct {
	IDColuna int           `json:"id_coluna_kanban"`
	Nome     string        `json:"nome_coluna"`
	Prazo    sql.NullInt64 `json:"prazo_dias"`
}

type prazoEtapaRow struct {
	IDEtapa  int            `json:"id_etapa_processo"`
	Etapa    string         `json:"etapa"`
	ColunaID int            `json:"id_coluna_kanban"`
	SubEtapa sql.NullString `json:"sub_etapa"`
	Prazo    sql.NullInt64  `json:"prazo_dias"`
}

// GetPrazosConfig godoc
// @Summary      Lista configuraÃ§ão de prazos
// @Tags         Admin
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/prazos [get]
func GetPrazosConfig(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	kanban := make([]prazoKanbanRow, 0, 8)
	rows, err := queryGorm(db, `
        SELECT kc.id_coluna, kc.nome_coluna, pk.prazo_dias
        FROM DM_KANBAN_COLUNAS kc
        LEFT JOIN DM_PRAZOS_KANBAN pk ON pk.id_coluna_kanban = kc.id_coluna
        ORDER BY kc.ordem
    `)
	if err != nil {
		kanban = []prazoKanbanRow{}
	} else {
		defer rows.Close()
		for rows.Next() {
			var r prazoKanbanRow
			if err := rows.Scan(&r.IDColuna, &r.Nome, &r.Prazo); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			kanban = append(kanban, r)
		}
	}

	etapas := make([]prazoEtapaRow, 0, 64)
	rows2, err := queryGorm(db, `
        SELECT e.id_etapa_processo, e.etapa, e.id_coluna_kanban, pe.sub_etapa, pe.prazo_dias
        FROM DM_ETAPAS_PROCESSO e
        LEFT JOIN DM_PRAZOS_ETAPA pe ON pe.id_etapa_processo = e.id_etapa_processo
        ORDER BY e.id_coluna_kanban, e.id_etapa_processo
    `)
	if err != nil {
		etapas = []prazoEtapaRow{}
	} else {
		defer rows2.Close()
		for rows2.Next() {
			var r prazoEtapaRow
			if err := rows2.Scan(&r.IDEtapa, &r.Etapa, &r.ColunaID, &r.SubEtapa, &r.Prazo); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			etapas = append(etapas, r)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"kanban": kanban,
		"etapas": etapas,
	})
}

type savePrazosPayload struct {
	Kanban []struct {
		IDColuna  int  `json:"id_coluna_kanban"`
		PrazoDias *int `json:"prazo_dias"`
	} `json:"kanban"`
	Overrides []struct {
		IDEtapa   int     `json:"id_etapa_processo"`
		SubEtapa  *string `json:"sub_etapa"`
		PrazoDias int     `json:"prazo_dias"`
	} `json:"overrides"`
}

// SavePrazosConfig godoc
// @Summary      Salva configuraÃ§ão de prazos
// @Tags         Admin
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/admin/prazos [post]
func SavePrazosConfig(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	var p savePrazosPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}

	tx := db.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": tx.Error.Error()})
		return
	}
	defer tx.Rollback()

	if len(p.Kanban) > 0 {
		stmt := "INSERT INTO DM_PRAZOS_KANBAN (id_coluna_kanban, prazo_dias) VALUES (?, ?) ON DUPLICATE KEY UPDATE prazo_dias=VALUES(prazo_dias)"
		for _, k := range p.Kanban {
			if _, err := execGorm(tx, stmt, k.IDColuna, k.PrazoDias); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
	}

	if len(p.Overrides) > 0 {
		stmt := "INSERT INTO DM_PRAZOS_ETAPA (id_etapa_processo, sub_etapa, prazo_dias) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE prazo_dias=VALUES(prazo_dias)"
		for _, o := range p.Overrides {
			var sub interface{}
			if o.SubEtapa == nil || *o.SubEtapa == "" {
				sub = nil
			} else {
				sub = *o.SubEtapa
			}
			if _, err := execGorm(tx, stmt, o.IDEtapa, sub, o.PrazoDias); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetProcessosComPrazo retorna apenas as combinaÃ§ões fixas solicitadas (Distribuidora/Ouvidoria/ANEEL + Aguardando retorno).
// GetProcessosComPrazo godoc
// @Summary      Processos com prazo
// @Tags         Processos
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/prazos [get]
func GetProcessosComPrazo(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	limit := 300
	if v := strings.TrimSpace(c.DefaultQuery("limit", "300")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	q := `
WITH alvo AS (
    SELECT 'Distribuidora' AS etapa, 'Aguardando retorno' AS sub_etapa, 7 AS prazo_dias
    UNION ALL SELECT 'Distribuidora', 'Primeira reclamação - Aguardando retorno', 7
    UNION ALL SELECT 'Ouvidoria', 'Aguardando retorno', 15
    UNION ALL SELECT 'Ouvidoria', 'Em contestação - Aguardando retorno', 15
    UNION ALL SELECT 'Ouvidoria', 'Em Conciliação - Aguardando retorno', 15
    UNION ALL SELECT 'ANEEL', 'Aguardando retorno', 15
    UNION ALL SELECT 'ANEEL', 'Em contestação - Aguardando retorno', 15
    UNION ALL SELECT 'ANEEL', 'Em Conciliação - Aguardando retorno', 15
    UNION ALL SELECT 'SMA', 'Aguardando retorno', 15
    UNION ALL SELECT 'SMA', 'Em contestação - Aguardando retorno', 15
    UNION ALL SELECT 'SMA', 'Em Conciliação - Aguardando retorno', 15
),
hist AS (
    -- Data em que o processo ENTROU na sub-etapa de aguardando retorno (pelo historico)
    -- Processos sem esse registro no historico sao excluidos (nao aparecem no painel)
    SELECT hm.id_requisicao, MAX(hm.data_movimentacao) AS data_movimentacao
      FROM FT_HISTORICO_MOVIMENTACOES hm
     WHERE LOWER(TRIM(COALESCE(hm.sub_etapa, ''))) IN (
               'aguardando retorno',
               'primeira reclamação - aguardando retorno',
               'em contestação - aguardando retorno',
               'em conciliação - aguardando retorno'
           )
     GROUP BY hm.id_requisicao
)
SELECT
    p.id_processo,
    e.etapa,
    p.sub_etapa,
    a.prazo_dias,
    h.data_movimentacao AS data_base,
    COALESCE(p.uc, '')             AS uc,
    COALESCE(p.cliente, '')        AS cliente,
    COALESCE(p.concessionaria, '') AS concessionaria
FROM FT_PROCESSOS p
JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
JOIN alvo a ON LOWER(TRIM(e.etapa)) = LOWER(TRIM(a.etapa)) COLLATE utf8mb4_unicode_ci
           AND LOWER(TRIM(COALESCE(p.sub_etapa,''))) = LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci
JOIN hist h ON h.id_requisicao = p.id_processo
WHERE COALESCE(p.suspenso, 0) = 0
  AND LOWER(TRIM(COALESCE(p.sub_etapa, ''))) NOT LIKE 'suspenso%'
LIMIT ?`

	rows, err := queryGorm(db, q, limit)
	if err != nil {
		log.Printf("GetProcessosComPrazo query error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro na consulta de prazos"})
		return
	}
	defer rows.Close()

	type row struct {
		ID            int            `json:"id_processo"`
		Etapa         string         `json:"etapa"`
		SubEtapa      sql.NullString `json:"sub_etapa"`
		Prazo         int            `json:"prazo_dias"`
		DataBase      time.Time      `json:"data_base"`
		UC            string         `json:"uc"`
		Cliente       string         `json:"cliente"`
		Concessionaria string        `json:"concessionaria"`
	}

	list := make([]row, 0, 64)
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ID, &r.Etapa, &r.SubEtapa, &r.Prazo, &r.DataBase, &r.UC, &r.Cliente, &r.Concessionaria); err != nil {
			log.Printf("GetProcessosComPrazo scan error: %v", err)
			continue
		}
		list = append(list, r)
	}

	type outItem struct {
		ID              int     `json:"id_processo"`
		Etapa           string  `json:"etapa"`
		SubEtapa        string  `json:"sub_etapa"`
		PrazoDias       int     `json:"prazo_dias"`
		Deadline        string  `json:"deadline"`
		DeadlineUnix    int64   `json:"deadline_unix"`
		HorasRestantes  float64 `json:"horas_restantes"`
		DiasRestantes   float64 `json:"dias_restantes"`
		Atrasado        bool    `json:"atrasado"`
		DataBase        string  `json:"data_base"`
		DataBaseUnix    int64   `json:"data_base_unix"`
		UC              string  `json:"uc"`
		Cliente         string  `json:"cliente"`
		Concessionaria  string  `json:"concessionaria"`
	}

	now := time.Now()
	out := make([]outItem, 0, len(list))
	atrasados := make([]outItem, 0)
	for _, r := range list {
		base := r.DataBase
		deadline := base.Add(time.Duration(r.Prazo) * 24 * time.Hour)
		delta := deadline.Sub(now)
		out = append(out, outItem{
			ID:             r.ID,
			Etapa:          r.Etapa,
			SubEtapa:       strings.TrimSpace(r.SubEtapa.String),
			PrazoDias:      r.Prazo,
			Deadline:       deadline.Format(time.RFC3339),
			DeadlineUnix:   deadline.Unix(),
			HorasRestantes: delta.Hours(),
			DiasRestantes:  delta.Hours() / 24.0,
			Atrasado:       delta < 0,
			DataBase:       base.Format(time.RFC3339),
			DataBaseUnix:   base.Unix(),
			UC:             strings.TrimSpace(r.UC),
			Cliente:        strings.TrimSpace(r.Cliente),
			Concessionaria: strings.TrimSpace(r.Concessionaria),
		})
		if delta < 0 {
			atrasados = append(atrasados, out[len(out)-1])
		}
	}

	// Cria alerta para gestores quando houver atrasados (1 por dia/proc/gestor)
	if len(atrasados) > 0 {
		idsGestores := make([]int64, 0)
		if rows, err := queryGorm(db, `SELECT id_usuario FROM DM_USUARIO WHERE perfil='gestor' AND ativo=1`); err == nil {
			defer rows.Close()
			for rows.Next() {
				var uid int64
				if err := rows.Scan(&uid); err == nil {
					idsGestores = append(idsGestores, uid)
				}
			}
		}

		for _, a := range atrasados {
			msg := "Prazo limite expirou para o processo #" + strconv.Itoa(a.ID) + " (" + strings.TrimSpace(a.Etapa) + " / " + strings.TrimSpace(a.SubEtapa) + ")"
			for _, uid := range idsGestores {
				var cnt int
				_ = queryRowGorm(db, 
					"SELECT COUNT(1) FROM FT_ALERTAS WHERE id_usuario=? AND id_processo=? AND DATE(data_criacao)=CURRENT_DATE AND mensagem LIKE 'Prazo limite expirou%'",
					uid, a.ID,
				).Scan(&cnt)
				if cnt == 0 {
					_, _ = execGorm(db,
						"INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta) VALUES (?, ?, ?, 0, 0, NOW(), CURRENT_DATE)",
						uid, a.ID, msg,
					)
				}
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"rows": out, "count": len(out)})
}
