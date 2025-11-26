package handlers

import (
    "net/http"
    "strconv"

    "github.com/gin-gonic/gin"
    "ressarcimento-backend/database"
    "ressarcimento-backend/repositories"
)

// GET /api/v1/processos/:id/summary
func GetProcessoSummary(c *gin.Context) {
    repo := repositories.NewResumoRepo(database.DB_App)
    _ = repo.EnsureTable(c.Request.Context())
    pidStr := c.Param("id")
    pid, _ := strconv.ParseInt(pidStr, 10, 64)
    row, _ := repo.Get(c.Request.Context(), pid)
    if row == nil {
        c.JSON(http.StatusOK, gin.H{"status":"none"})
        return
    }
    out := gin.H{"status": row.Status}
    if row.SummaryText.Valid { out["summary_text"] = row.SummaryText.String }
    c.JSON(http.StatusOK, out)
}

// POST /api/v1/processos/:id/summary/refresh
func RefreshProcessoSummary(c *gin.Context) {
    repo := repositories.NewResumoRepo(database.DB_App)
    _ = repo.EnsureTable(c.Request.Context())
    pidStr := c.Param("id")
    pid, _ := strconv.ParseInt(pidStr, 10, 64)
    changed, err := repo.UpsertPendingIfChanged(c.Request.Context(), pid)
    if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
    // even if not changed, mark pending to force regen on request
    if !changed {
        _, _ = database.DB_App.Exec(`UPDATE FT_RESUMOS_PROCESSO SET status='pending', updated_at=NOW() WHERE processo_id = ?`, pid)
    }
    // log simples para auditoria
    println("[resumo] enqueue by refresh id=", pid, "changed=", changed)
    c.JSON(http.StatusOK, gin.H{"ok": true})
}
