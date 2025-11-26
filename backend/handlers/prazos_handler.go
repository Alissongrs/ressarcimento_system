package handlers

import (
	"database/sql"
	"net/http"

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
