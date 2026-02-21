package handlers

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// POST /requisicoes/:id/anexos
// @Summary Adicionar anexos na requisicao
// @Tags Anexos
// @Accept multipart/form-data
// @Produce json
// @Param id path int true "ID da requisicao"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/{id}/anexos [post]
func AddAnexoByRequisicaoID(c *gin.Context) {
	reqID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID da requisicao invalido"})
		return
	}
	if err := c.Request.ParseMultipartForm(50 << 20); err != nil {
		log.Printf("[ANEXO] parse multipart error (req=%d): %v", reqID, err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Falha ao ler anexos"})
		return
	}
	form := c.Request.MultipartForm
	if form == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Formulario de anexos vazio"})
		return
	}
	files := form.File["anexos"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Nenhum anexo enviado"})
		return
	}

	userName := "gestor"
	if v, ok := c.Get("userName"); ok {
		if s, ok2 := v.(string); ok2 && strings.TrimSpace(s) != "" {
			userName = strings.TrimSpace(s)
		}
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transacao"})
		return
	}
	defer tx.Rollback()

	_ = os.MkdirAll("uploads/", os.ModePerm)
	for _, fh := range files {
		filename, data, mimeType, sizeBytes, err := readAnexoFile(fh)
		if err != nil {
			log.Printf("[ANEXO] read error (req=%d file=%s): %v", reqID, fh.Filename, err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Falha ao ler anexo"})
			return
		}
		pseudoPath := buildAnexoPath(reqID, 0, filename)
		fullPath := filepath.Join("uploads", pseudoPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), os.ModePerm); err == nil {
			_ = os.WriteFile(fullPath, data, 0644)
		}
		_, err = execGorm(tx, 
			`INSERT INTO FT_ANEXOS
			  (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
			  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			reqID, filename, pseudoPath, userName, time.Now(), mimeType, sizeBytes, data,
		)
		if err != nil {
			log.Printf("[ANEXO] insert error (req=%d file=%s): %v", reqID, filename, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar anexo"})
			return
		}
	}

	if err := tx.Commit().Error; err != nil {
		log.Printf("[ANEXO] commit error (req=%d): %v", reqID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar transacao"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DELETE /requisicoes/:id/anexos/:anexoId
// @Summary Remover anexo de requisicao
// @Tags Anexos
// @Produce json
// @Param id path int true "ID da requisicao"
// @Param anexoId path int true "ID do anexo"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/{id}/anexos/{anexoId} [delete]
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

	res, err := execGorm(database.GormDB_App, 
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

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /anexos/:anexoId/download
// @Summary Download de anexo
// @Tags Anexos
// @Produce application/octet-stream
// @Param anexoId path int true "ID do anexo"
// @Success 200 {file} file
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/anexos/{anexoId}/download [get]
func DownloadAnexoByID(c *gin.Context) {
	anexoID, err := strconv.Atoi(c.Param("anexoId"))
	if err != nil || anexoID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID do anexo invalido"})
		return
	}

	var nome sql.NullString
	var mime sql.NullString
	var caminho sql.NullString
	var data []byte
	err = queryRowGorm(database.GormDB_App, 
		"SELECT nome_arquivo, mime_type, caminho_arquivo, arquivo_blob FROM FT_ANEXOS WHERE id_anexo = ?",
		anexoID,
	).Scan(&nome, &mime, &caminho, &data)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "Anexo nao encontrado"})
			return
		}
		log.Printf("[ANEXO] download query error (anexo=%d): %v", anexoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar anexo"})
		return
	}

	filename := strings.TrimSpace(nome.String)
	if filename == "" {
		filename = fmt.Sprintf("anexo-%d", anexoID)
	}

	if len(data) > 0 {
		contentType := strings.TrimSpace(mime.String)
		if contentType == "" {
			contentType = http.DetectContentType(data)
		}
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
		c.Data(http.StatusOK, contentType, data)
		return
	}

	// Fallback legado: caminho_arquivo no disco
	clean := strings.TrimSpace(caminho.String)
	if clean != "" {
		clean = filepath.Clean(clean)
		slash := filepath.ToSlash(clean)
		if strings.HasPrefix(slash, "uploads/") && !strings.Contains(slash, "..") {
			if fileBytes, err := os.ReadFile(clean); err == nil {
				contentType := strings.TrimSpace(mime.String)
				if contentType == "" {
					contentType = http.DetectContentType(fileBytes)
				}
				c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
				c.Data(http.StatusOK, contentType, fileBytes)
				return
			}
		}
	}

	c.JSON(http.StatusNotFound, gin.H{"error": "Anexo nao encontrado"})
}

