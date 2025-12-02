package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

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

func GetPrazosConfig(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	// Kanban columns + prazos
	kanban := make([]prazoKanbanRow, 0, 8)
	rows, err := db.Query(`
        SELECT kc.id_coluna, kc.nome_coluna, pk.prazo_dias
        FROM DM_KANBAN_COLUNAS kc
        LEFT JOIN DM_PRAZOS_KANBAN pk ON pk.id_coluna_kanban = kc.id_coluna
        ORDER BY kc.ordem
    `)
	if err != nil {
		// Sem tabela em dev? segue com lista vazia
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

	// Etapas + overrides (sub_etapa opcional)
	etapas := make([]prazoEtapaRow, 0, 64)
	rows2, err := db.Query(`
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

func SavePrazosConfig(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	var p savePrazosPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}

	tx, err := db.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer tx.Rollback()

	if len(p.Kanban) > 0 {
		stmt := "INSERT INTO DM_PRAZOS_KANBAN (id_coluna_kanban, prazo_dias) VALUES (?, ?) ON DUPLICATE KEY UPDATE prazo_dias=VALUES(prazo_dias)"
		for _, k := range p.Kanban {
			if _, err := tx.Exec(stmt, k.IDColuna, k.PrazoDias); err != nil {
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
			if _, err := tx.Exec(stmt, o.IDEtapa, sub, o.PrazoDias); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetProcessosComPrazo retorna processos com prazo configurado (kanban/etapa/sub-etapa) e deadline prГіximo.
// Query params:
//   - within_hours: horas restantes mГЎximas para incluir (default: 72)
//   - min_hours: horas restantes mГ­nimas (default: -168, para incluir atГ© 7 dias atrasados)
//   - limit: limite de linhas (default: 100)
func GetProcessosComPrazo(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	withinHours := 72
	if v := strings.TrimSpace(c.DefaultQuery("within_hours", "72")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 24*30 {
			withinHours = n
		}
	}
	minHours := -100000 // inclui atrasados de longa data por padrão
	if v := strings.TrimSpace(c.DefaultQuery("min_hours", "-100000")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= -24*365 {
			minHours = n
		}
	}
	limit := 100
	if v := strings.TrimSpace(c.DefaultQuery("limit", "100")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	q := `
SELECT
  p.id_processo,
  kc.nome_coluna,
  e.etapa,
  p.sub_etapa,
  (SELECT a.prazo_dias
     FROM DM_ALARMES a
    WHERE a.ativo = 1
      AND (
            (a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci = LOWER(TRIM(p.sub_etapa)) COLLATE utf8mb4_unicode_ci))
         OR (a.id_coluna_kanban = e.id_coluna_kanban)
          )
    ORDER BY
      CASE
        WHEN a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci = LOWER(TRIM(p.sub_etapa)) COLLATE utf8mb4_unicode_ci) THEN 2
        WHEN a.id_etapa_processo = e.id_etapa_processo THEN 1
        ELSE 0
      END DESC
    LIMIT 1) AS prazo_alarm,
  COALESCE(
    (SELECT a.prazo_dias
       FROM DM_ALARMES a
      WHERE a.ativo = 1
        AND (
              (a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci = LOWER(TRIM(p.sub_etapa)) COLLATE utf8mb4_unicode_ci))
           OR (a.id_coluna_kanban = e.id_coluna_kanban)
            )
      ORDER BY
        CASE
          WHEN a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci = LOWER(TRIM(p.sub_etapa)) COLLATE utf8mb4_unicode_ci) THEN 2
          WHEN a.id_etapa_processo = e.id_etapa_processo THEN 1
          ELSE 0
        END DESC
      LIMIT 1),
    pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) AS prazo_dias,
  (SELECT a.severity
     FROM DM_ALARMES a
    WHERE a.ativo = 1
      AND (
            (a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci = LOWER(TRIM(p.sub_etapa)) COLLATE utf8mb4_unicode_ci))
         OR (a.id_coluna_kanban = e.id_coluna_kanban)
          )
    ORDER BY
      CASE
        WHEN a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) COLLATE utf8mb4_unicode_ci = LOWER(TRIM(p.sub_etapa)) COLLATE utf8mb4_unicode_ci) THEN 2
        WHEN a.id_etapa_processo = e.id_etapa_processo THEN 1
        ELSE 0
      END DESC
    LIMIT 1) AS severity,
  COALESCE(vh.data_movimentacao, p.ultima_atualizacao, NOW())                    AS data_base,
  DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao, NOW()),
           INTERVAL COALESCE(
             (SELECT a.prazo_dias
                FROM DM_ALARMES a
               WHERE a.ativo = 1
                 AND (
                       (a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR a.sub_etapa = p.sub_etapa))
                    OR (a.id_coluna_kanban = e.id_coluna_kanban)
                 )
               ORDER BY
                 CASE
                   WHEN a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR a.sub_etapa = p.sub_etapa) THEN 2
                   WHEN a.id_etapa_processo = e.id_etapa_processo THEN 1
                   ELSE 0
                 END DESC
               LIMIT 1),
             pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY) AS deadline_dt,
  TIMESTAMPDIFF(
    HOUR,
    NOW(),
    DATE_ADD(COALESCE(vh.data_movimentacao, p.ultima_atualizacao, NOW()),
             INTERVAL COALESCE(
               (SELECT a.prazo_dias
                  FROM DM_ALARMES a
                 WHERE a.ativo = 1
                   AND (
                         (a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR a.sub_etapa = p.sub_etapa))
                      OR (a.id_coluna_kanban = e.id_coluna_kanban)
                   )
                 ORDER BY
                   CASE
                     WHEN a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR a.sub_etapa = p.sub_etapa) THEN 2
                     WHEN a.id_etapa_processo = e.id_etapa_processo THEN 1
                     ELSE 0
                   END DESC
                 LIMIT 1),
               pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias) DAY)
  ) AS horas_restantes,
  r.uc,
  r.cliente,
  r.concessionaria
FROM FT_PROCESSOS p
JOIN DM_ETAPAS_PROCESSO   e   ON e.id_etapa_processo = p.id_etapa_processo
JOIN DM_KANBAN_COLUNAS    kc  ON kc.id_coluna        = e.id_coluna_kanban
LEFT JOIN FT_REQUISICOES  r   ON r.id_requisicao     = p.id_processo
LEFT JOIN DM_PRAZOS_ETAPA pe   ON pe.id_etapa_processo = e.id_etapa_processo AND pe.sub_etapa IS NULL
LEFT JOIN DM_PRAZOS_ETAPA pe_sub ON pe_sub.id_etapa_processo = e.id_etapa_processo AND pe_sub.sub_etapa = p.sub_etapa
LEFT JOIN DM_PRAZOS_KANBAN pk   ON pk.id_coluna_kanban = e.id_coluna_kanban
LEFT JOIN VW_ULTIMO_HISTORICO vh ON vh.id_requisicao = p.id_processo
WHERE COALESCE(
        (SELECT a.prazo_dias
           FROM DM_ALARMES a
          WHERE a.ativo = 1
            AND (
                  (a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) = LOWER(TRIM(p.sub_etapa))))
               OR (a.id_coluna_kanban = e.id_coluna_kanban)
            )
          ORDER BY
            CASE
              WHEN a.id_etapa_processo = e.id_etapa_processo AND (a.sub_etapa IS NULL OR LOWER(TRIM(a.sub_etapa)) = LOWER(TRIM(p.sub_etapa))) THEN 2
              WHEN a.id_etapa_processo = e.id_etapa_processo THEN 1
              ELSE 0
            END DESC
          LIMIT 1),
        pe_sub.prazo_dias, pe.prazo_dias, pk.prazo_dias
      ) IS NOT NULL
HAVING horas_restantes <= ? AND horas_restantes >= ?
ORDER BY horas_restantes ASC
LIMIT ?;
`

	rows, err := db.Query(q, withinHours, minHours, limit)
	if err != nil {
		log.Printf("GetProcessosComPrazo query error: %v", err)
		c.JSON(http.StatusOK, gin.H{
			"rows":         []interface{}{},
			"within_hours": withinHours,
			"min_hours":    minHours,
			"limit":        limit,
			"error":        "Falha ao buscar prazos (confira se as tabelas DM_PRAZOS_*/VW_ULTIMO_HISTORICO existem).",
		})
		return
	}
	defer rows.Close()

	type item struct {
		ID             int64   `json:"id"`
		Coluna         string  `json:"coluna"`
		Etapa          string  `json:"etapa"`
		SubEtapa       string  `json:"sub_etapa"`
		Severity       string  `json:"severity"`
		PrazoDias      int64   `json:"prazo_dias"`
		DataBase       *string `json:"data_base,omitempty"`
		Deadline       *string `json:"deadline,omitempty"`
		HorasRestantes int64   `json:"horas_restantes"`
		UC             string  `json:"uc"`
		Cliente        string  `json:"cliente"`
		Concessionaria string  `json:"concessionaria"`
	}
	out := make([]item, 0, 32)

	for rows.Next() {
		var (
			it   item
			dbase, deadline sql.NullTime
			sub             sql.NullString
			uc, cli, conc   sql.NullString
			col             sql.NullString
			et              sql.NullString
			sev             sql.NullString
		)
		if err := rows.Scan(
			&it.ID,
			&col,
			&et,
			&sub,
			&sev,
			&it.PrazoDias,
			&dbase,
			&deadline,
			&it.HorasRestantes,
			&uc,
			&cli,
			&conc,
		); err != nil {
			continue
		}
		if col.Valid {
			it.Coluna = col.String
		}
		if et.Valid {
			it.Etapa = et.String
		}
		if sub.Valid {
			it.SubEtapa = sub.String
		}
		if sev.Valid {
			it.Severity = sev.String
		}
		if dbase.Valid {
			s := dbase.Time.Format(time.RFC3339)
			it.DataBase = &s
		}
		if deadline.Valid {
			s := deadline.Time.Format(time.RFC3339)
			it.Deadline = &s
		}
		if uc.Valid {
			it.UC = uc.String
		}
		if cli.Valid {
			it.Cliente = cli.String
		}
		if conc.Valid {
			it.Concessionaria = conc.String
		}
		out = append(out, it)
	}

	if out == nil {
		out = []item{}
	}
	c.JSON(http.StatusOK, gin.H{
		"rows":         out,
		"within_hours": withinHours,
		"min_hours":    minHours,
		"limit":        limit,
	})
}
