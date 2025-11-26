package handlers

import (
    "net/http"
    "strconv"

    "github.com/gin-gonic/gin"
    "ressarcimento-backend/database"
    "ressarcimento-backend/repositories"
)

// GET /api/v1/resumos/pending?limit=50
func GetResumosPending(c *gin.Context) {
    repo := repositories.NewResumoRepo(database.DB_App)
    _ = repo.EnsureTable(c.Request.Context())
    limit := 50
    if v := c.Query("limit"); v != "" {
        if n, err := strconv.Atoi(v); err == nil && n > 0 { limit = n }
    }
    ids, err := repo.ListPending(c.Request.Context(), limit)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"pending_ids": ids, "limit": limit})
}

