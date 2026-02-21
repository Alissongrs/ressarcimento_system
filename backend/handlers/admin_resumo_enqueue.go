package handlers

import (
    "net/http"
    "sort"
    "strconv"
    "strings"

    "github.com/gin-gonic/gin"
    "ressarcimento-backend/database"
    "ressarcimento-backend/repositories"
    "gorm.io/gorm"
)

type enqueueBody struct {
    IDs []int64 `json:"ids"`
    Mode string `json:"mode"` // "changed" (default) ou "all"
}

// POST /api/v1/resumos/enqueue
// - body opcional: { ids: [..], mode: "changed"|"all" }
// - se ids vazio: usa query ?mode=&limit= (busca em FT_PROCESSOS)
// EnqueueResumos godoc
// @Summary      Enfileira resumos
// @Tags         ResumoProcesso
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/resumos/enqueue [post]
func EnqueueResumos(c *gin.Context) {
    repo := repositories.NewResumoRepo(database.GormDB_App)

    var body enqueueBody
    _ = c.ShouldBindJSON(&body)
    mode := strings.ToLower(strings.TrimSpace(body.Mode))
    if mode == "" { mode = strings.ToLower(strings.TrimSpace(c.Query("mode"))) }
    if mode == "" { mode = "changed" }

    ids := body.IDs
    if len(ids) == 0 {
        limit := 100
        if v := c.Query("limit"); v != "" {
            if n, err := strconv.Atoi(v); err == nil && n > 0 { limit = n }
        }
        ids = listProcessoIDs(database.GormDB_App, limit)
    }

    enq := make([]int64, 0, len(ids))
    for _, pid := range ids {
        if mode == "all" {
            // força pendente com hash atual
            hash, _ := repo.ComputeHistoricoHash(c.Request.Context(), pid)
            _, _ = execGorm(database.GormDB_App, `INSERT INTO FT_RESUMOS_PROCESSO (processo_id, status, history_hash, updated_at)
                VALUES (?, 'pending', ?, NOW())
                ON DUPLICATE KEY UPDATE status='pending', history_hash=VALUES(history_hash), updated_at=NOW()`, pid, hash)
        } else {
            _, _ = repo.UpsertPendingIfChanged(c.Request.Context(), pid)
        }
        enq = append(enq, pid)
    }

    sort.Slice(enq, func(i, j int) bool { return enq[i] < enq[j] })
    // log resumido
    println("[resumo] enqueue bulk count=", len(enq), "ids=", toCSV(enq))

    c.JSON(http.StatusOK, gin.H{"enqueued": enq, "count": len(enq), "mode": mode})
}

func listProcessoIDs(db *gorm.DB, limit int) []int64 {
    if db == nil { return nil }
    rows, err := queryGorm(db, `SELECT id FROM FT_PROCESSOS ORDER BY updated_at DESC LIMIT ?`, limit)
    if err != nil { return nil }
    defer rows.Close()
    out := make([]int64, 0, limit)
    for rows.Next() {
        var id int64
        if err := rows.Scan(&id); err == nil { out = append(out, id) }
    }
    return out
}

func toCSV(ids []int64) string {
    if len(ids) == 0 { return "" }
    b := strings.Builder{}
    for i, id := range ids {
        if i > 0 { b.WriteByte(',') }
        b.WriteString(strconv.FormatInt(id, 10))
    }
    return b.String()
}
