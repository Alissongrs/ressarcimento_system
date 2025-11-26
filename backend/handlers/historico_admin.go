package handlers

import (
	"net/http"
	"strconv"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// AdminDeleteHistorico remove um registro de histórico (e vínculos de canais) por id_historico.
// Acesso: admin.
func AdminDeleteHistorico(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.Atoi(idStr)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id_historico inválido"})
		return
	}

	tx, err := database.DB_App.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec(`DELETE FROM FT_HISTORICO_CANAIS WHERE id_historico = ?`, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao remover canais do histórico"})
		return
	}
	if _, err = tx.Exec(`DELETE FROM FT_HISTORICO_MOVIMENTACOES WHERE id_historico = ?`, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao remover registro de histórico"})
		return
	}

	if err = tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao confirmar exclusão"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted_id": id})
}
