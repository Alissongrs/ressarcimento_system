package handlers

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// DELETE /requisicoes/:id/anexos/:anexoId
func DeleteAnexoByRequisicaoID(c *gin.Context) {
	reqID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID da requisicao invalido"})
		return
	}
	anexoID, err := strconv.Atoi(c.Param("anexoId"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do anexo invalido"})
		return
	}

	var caminho string
	err = database.DB_App.QueryRow(
		"SELECT caminho_arquivo FROM FT_ANEXOS WHERE id_anexo = ? AND id_requisicao = ?",
		anexoID, reqID,
	).Scan(&caminho)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Anexo nao encontrado"})
		return
	}

	res, err := database.DB_App.Exec(
		"DELETE FROM FT_ANEXOS WHERE id_anexo = ? AND id_requisicao = ?",
		anexoID, reqID,
	)
	if err != nil {
		log.Printf("[ANEXO] delete error (req=%d anexo=%d): %v", reqID, anexoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao remover anexo"})
		return
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "Anexo nao encontrado"})
		return
	}

	clean := strings.TrimSpace(caminho)
	if clean != "" {
		clean = filepath.Clean(clean)
		slash := filepath.ToSlash(clean)
		if strings.HasPrefix(slash, "uploads/") && !strings.Contains(slash, "..") {
			if err := os.Remove(clean); err != nil && !os.IsNotExist(err) {
				log.Printf("[ANEXO] remove file warning (req=%d anexo=%d path=%s): %v", reqID, anexoID, clean, err)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
