package handlers

import (
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

type chatLearnResult struct {
	Name      string                 `json:"name"`
	HasText   bool                   `json:"has_text"`
	Extracted map[string]interface{} `json:"extracted,omitempty"`
}

type chatLearnResponse struct {
	Ok      bool              `json:"ok"`
	Message string            `json:"message"`
	Learned []chatLearnResult `json:"learned"`
}

// POST /api/v1/chat/learn
// ChatLearnHandler godoc
// @Summary      Treina/ensina no chat
// @Tags         Chat
// @Accept       multipart/form-data
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/learn [post]
func ChatLearnHandler(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid multipart form"})
		return
	}

	message := strings.TrimSpace(c.PostForm("message"))
	files := form.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no files uploaded"})
		return
	}

	baseDir := filepath.Join("uploads", "chat", "learn")
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to prepare upload dir"})
		return
	}

	var out []chatLearnResult
	var ocrFiles []*multipart.FileHeader
	for _, f := range files {
		name := filepath.Base(f.Filename)
		if !isTextFile(name) && !isOCRFile(name) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "tipo de arquivo não permitido: " + filepath.Ext(name)})
			return
		}
		dest := filepath.Join(baseDir, name)
		if err := c.SaveUploadedFile(f, dest); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
			return
		}

		item := chatLearnResult{Name: name}
		if isTextFile(name) && !isOCRFile(name) {
			file, err := os.Open(dest)
			if err == nil {
				defer file.Close()
				limit := int64(2 << 20)
				raw, _ := io.ReadAll(io.LimitReader(file, limit))
				text := strings.TrimSpace(string(raw))
				item.HasText = text != ""
				if text != "" {
					content := map[string]interface{}{
						"filename":   name,
						"message":    message,
						"text":       text,
						"created_at": nowISO(),
					}
					if err := appendLegacyComponent("learn:"+name, "Conhecimento adicionado via /aprenda", content); err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save knowledge"})
						return
					}
				}
			}
		}
		if isOCRFile(name) {
			ocrFiles = append(ocrFiles, f)
		}

		out = append(out, item)
	}

	if len(ocrFiles) > 0 {
		ocrTexts, err := callOCR(ocrFiles)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("ocr error: %v", err)})
			return
		}
		for i := range out {
			ocr, ok := ocrTexts[out[i].Name]
			if !ok {
				continue
			}
			out[i].HasText = strings.TrimSpace(ocr.RawText) != ""
			out[i].Extracted = ocr.RuleResults
			content := map[string]interface{}{
				"filename":   out[i].Name,
				"message":    message,
				"raw_text":   ocr.RawText,
				"extracted":  ocr.RuleResults,
				"created_at": nowISO(),
			}
			if err := appendLegacyComponent("learn:"+out[i].Name, "Conhecimento adicionado via /aprenda", content); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save knowledge"})
				return
			}
		}
	}

	c.JSON(http.StatusOK, chatLearnResponse{
		Ok:      true,
		Message: "Conhecimento adicionado.",
		Learned: out,
	})
}
