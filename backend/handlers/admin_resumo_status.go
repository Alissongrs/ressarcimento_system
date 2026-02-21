package handlers

import (
    "net/http"
    "strconv"

    "github.com/gin-gonic/gin"
    "ressarcimento-backend/database"
    "ressarcimento-backend/repositories"
    "ressarcimento-backend/services"
)

// GET /api/v1/admin/resumos/status
// Query params: minutes (default 30), limit (default 20)
// GetResumosStatus godoc
// @Summary      Status de resumos
// @Tags         ResumoProcesso
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/resumos/status [get]
func GetResumosStatus(c *gin.Context) {
    repo := repositories.NewResumoRepo(database.GormDB_App)
    minutes := 30
    if v := c.Query("minutes"); v != "" {
        if n, err := strconv.Atoi(v); err == nil && n > 0 { minutes = n }
    }
    limit := 20
    if v := c.Query("limit"); v != "" {
        if n, err := strconv.Atoi(v); err == nil && n > 0 { limit = n }
    }

    pending, _ := repo.CountByStatus(c.Request.Context(), "pending")
    readyRecent, _ := repo.ListRecentByStatus(c.Request.Context(), "ready", minutes, limit)
    errorRecent, _ := repo.ListRecentByStatus(c.Request.Context(), "error", minutes, limit)

    // runtime stats (memória)
    rs := services.GetResumoRuntimeStatus()

    c.JSON(http.StatusOK, gin.H{
        "pending_count": pending,
        "ready_recent_ids": readyRecent,
        "error_recent_ids": errorRecent,
        "window_minutes": minutes,
        "limit": limit,
        // preview runtime
        "last_dispatch_ids": rs.LastDispatchIDs,
        "last_ok_ids": rs.LastOKIDs,
        "last_err_ids": rs.LastErrIDs,
        "last_cycle": gin.H{
            "pending": rs.LastCyclePending,
            "batches": rs.LastCycleBatches,
            "limit": rs.LastCycleLimit,
            "processed": rs.LastCycleProcessed,
            "at": rs.LastCycleAt,
        },
    })
}
