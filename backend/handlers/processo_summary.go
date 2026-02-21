package handlers

import (
    "net/http"
    "strconv"

    "github.com/gin-gonic/gin"
    "ressarcimento-backend/database"
    "ressarcimento-backend/repositories"
    "ressarcimento-backend/services"
)

// GET /api/v1/processos/:id/summary
// GetProcessoSummary godoc
// @Summary      Resumo do processo
// @Tags         ResumoProcesso
// @Param        id   path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/{id}/summary [get]
func GetProcessoSummary(c *gin.Context) {
    repo := repositories.NewResumoRepo(database.GormDB_App)
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
// RefreshProcessoSummary godoc
// @Summary      Atualiza resumo do processo
// @Tags         ResumoProcesso
// @Param        id   path   int  true  "ID do processo"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/{id}/summary/refresh [post]
func RefreshProcessoSummary(c *gin.Context) {
    repo := repositories.NewResumoRepo(database.GormDB_App)
    pidStr := c.Param("id")
    pid, _ := strconv.ParseInt(pidStr, 10, 64)
    changed, err := repo.UpsertPendingIfChanged(c.Request.Context(), pid)
    if err != nil { c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()}); return }
    // even if not changed, mark pending to force regen on request
    if !changed {
        _, _ = execGorm(database.GormDB_App, `UPDATE FT_RESUMOS_PROCESSO SET status='pending', updated_at=NOW() WHERE processo_id = ?`, pid)
    }

    // gerar imediatamente para evitar status "none"
    procRepo := repositories.NewProcessosRepo(database.GormDB_App)
    srv := services.NewResumoService(repo, procRepo)
    if _, err := srv.GerarResumoAgora(c.Request.Context(), pid); err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }

    // log simples para auditoria
    println("[resumo] enqueue by refresh id=", pid, "changed=", changed)
    c.JSON(http.StatusOK, gin.H{"ok": true, "status": "ready"})
}

