package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

type AlarmeRow struct {
	ID              int            `json:"id"`
	Nome            string         `json:"nome"`
	Ativo           bool           `json:"ativo"`
	Tipo            string         `json:"tipo"`
	IDColunaKanban  sql.NullInt64  `json:"id_coluna_kanban"`
	IDEtapaProcesso sql.NullInt64  `json:"id_etapa_processo"`
	SubEtapa        sql.NullString `json:"sub_etapa"`
	PrazoDias       int            `json:"prazo_dias"`
	Severity        string         `json:"severity"`
}

func GetAlarmes(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}
	rows, err := db.Query(`SELECT id, nome, ativo, tipo, id_coluna_kanban, id_etapa_processo, sub_etapa, prazo_dias, severity FROM DM_ALARMES ORDER BY id DESC`)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"alarmes": []AlarmeRow{}})
		return
	}
	defer rows.Close()
	out := make([]AlarmeRow, 0, 64)
	for rows.Next() {
		var r AlarmeRow
		var ativo int
		if err := rows.Scan(&r.ID, &r.Nome, &ativo, &r.Tipo, &r.IDColunaKanban, &r.IDEtapaProcesso, &r.SubEtapa, &r.PrazoDias, &r.Severity); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		r.Ativo = ativo == 1
		out = append(out, r)
	}
	c.JSON(http.StatusOK, gin.H{"alarmes": out})
}

type SaveAlarmePayload struct {
	ID              *int    `json:"id"`
	Nome            string  `json:"nome"` // required
	Ativo           *bool   `json:"ativo"`
	Tipo            string  `json:"tipo"` // coluna|etapa|etapa_sub
	IDColunaKanban  *int    `json:"id_coluna_kanban"`
	IDEtapaProcesso *int    `json:"id_etapa_processo"`
	SubEtapa        *string `json:"sub_etapa"`
	PrazoDias       int     `json:"prazo_dias"` // required > 0
	Severity        string  `json:"severity"`   // info|warn|crit
}

func SaveAlarme(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}
	var p SaveAlarmePayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}
	if p.Nome == "" || p.PrazoDias <= 0 || (p.Tipo != "coluna" && p.Tipo != "etapa" && p.Tipo != "etapa_sub") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "campos obrigatórios inválidos"})
		return
	}
	if p.Severity == "" {
		p.Severity = "warn"
	}
	ativo := 1
	if p.Ativo != nil && !*p.Ativo {
		ativo = 0
	}

	if p.ID != nil && *p.ID > 0 {
		// update
		_, err := db.Exec(`UPDATE DM_ALARMES SET nome=?, ativo=?, tipo=?, id_coluna_kanban=?, id_etapa_processo=?, sub_etapa=?, prazo_dias=?, severity=? WHERE id=?`,
			p.Nome, ativo, p.Tipo, p.IDColunaKanban, p.IDEtapaProcesso, nullIfEmpty(p.SubEtapa), p.PrazoDias, p.Severity, *p.ID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "id": *p.ID})
		return
	}
	// insert
	res, err := db.Exec(`INSERT INTO DM_ALARMES (nome, ativo, tipo, id_coluna_kanban, id_etapa_processo, sub_etapa, prazo_dias, severity) VALUES (?,?,?,?,?,?,?,?)`,
		p.Nome, ativo, p.Tipo, p.IDColunaKanban, p.IDEtapaProcesso, nullIfEmpty(p.SubEtapa), p.PrazoDias, p.Severity,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	id, _ := res.LastInsertId()
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id})
}

func DeleteAlarme(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id ausente"})
		return
	}
	if _, err := db.Exec(`DELETE FROM DM_ALARMES WHERE id = ?`, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func nullIfEmpty(s *string) interface{} {
	if s == nil {
		return nil
	}
	if *s == "" {
		return nil
	}
	return *s
}
