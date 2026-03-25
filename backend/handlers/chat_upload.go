package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type chatUploadFile struct {
	Name      string                 `json:"name"`
	Path      string                 `json:"path"`
	Text      string                 `json:"text"`
	Extracted map[string]interface{} `json:"extracted,omitempty"`
}

type chatUploadResponse struct {
	Files []chatUploadFile `json:"files"`
}

type ocrResult struct {
	RawText     string
	RuleResults map[string]interface{}
}

func isTextFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".txt", ".md", ".csv", ".json":
		return true
	default:
		return false
	}
}

func isOCRFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff":
		return true
	default:
		return false
	}
}

func ocrBackendURL() string {
	return strings.TrimSpace(os.Getenv("OCR_BACKEND_URL"))
}

func callOCR(files []*multipart.FileHeader) (map[string]ocrResult, error) {
	ocrURL := ocrBackendURL()
	if len(files) == 0 {
		return map[string]ocrResult{}, nil
	}
	if ocrURL == "" {
		return nil, fmt.Errorf("OCR backend not configured (OCR_BACKEND_URL)")
	}

	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	for _, fh := range files {
		f, err := fh.Open()
		if err != nil {
			continue
		}
		w, _ := mw.CreateFormFile("files", fh.Filename)
		_, _ = io.Copy(w, f)
		_ = f.Close()
	}
	_ = mw.Close()

	req, _ := http.NewRequest("POST", strings.TrimRight(ocrURL, "/")+"/ocr/analyze", &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("ocr backend error: %s", string(raw))
	}

	var parsed struct {
		Results []struct {
			FileName   string          `json:"file_name"`
			RawText    string          `json:"raw_text"`
			RuleResult json.RawMessage `json:"rule_results"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}

	out := make(map[string]ocrResult)
	for _, r := range parsed.Results {
		ocrText := strings.TrimSpace(r.RawText)
		if ocrText == "" && len(r.RuleResult) == 0 {
			continue
		}
		var rules map[string]interface{}
		if len(r.RuleResult) > 0 {
			_ = json.Unmarshal(r.RuleResult, &rules)
		}
		out[r.FileName] = ocrResult{
			RawText:     ocrText,
			RuleResults: rules,
		}
	}
	return out, nil
}

// POST /api/v1/chat/upload
// ChatUploadHandler godoc
// @Summary      Upload de arquivos para chat
// @Tags         Chat
// @Accept       multipart/form-data
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/upload [post]
func ChatUploadHandler(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid multipart form"})
		return
	}
	files := form.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no files uploaded"})
		return
	}

	baseDir := filepath.Join("uploads", "chat")
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to prepare upload dir"})
		return
	}

	var out []chatUploadFile
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

		item := chatUploadFile{Name: name, Path: "/" + dest}
		if isTextFile(name) && !isOCRFile(name) {
			file, err := os.Open(dest)
			if err == nil {
				defer file.Close()
				limit := int64(2 << 20)
				raw, _ := io.ReadAll(io.LimitReader(file, limit))
				item.Text = strings.TrimSpace(string(raw))
			}
		}
		if isOCRFile(name) {
			ocrFiles = append(ocrFiles, f)
		}
		out = append(out, item)
	}

	if len(ocrFiles) > 0 {
		ocrTexts, ocrErr := callOCR(ocrFiles)
		if ocrErr != nil {
			// OCR indisponível — retorna arquivos sem texto extraído (não é fatal)
			c.JSON(http.StatusOK, chatUploadResponse{Files: out})
			return
		}
		for i := range out {
			if ocr, ok := ocrTexts[out[i].Name]; ok {
				out[i].Text = ocr.RawText
				out[i].Extracted = ocr.RuleResults
				if len(ocr.RuleResults) > 0 {
					if b, err := json.Marshal(ocr.RuleResults); err == nil {
						joined := strings.TrimSpace(out[i].Text)
						joined = strings.TrimSpace(joined + "\n\nDados extraidos:\n" + string(b))
						out[i].Text = joined
					}
				}

				if strings.TrimSpace(ocr.RawText) != "" || len(ocr.RuleResults) > 0 {
					content := map[string]interface{}{
						"filename":   out[i].Name,
						"raw_text":   ocr.RawText,
						"extracted":  ocr.RuleResults,
						"created_at": time.Now().Format(time.RFC3339),
					}
					if err := appendLegacyComponent("ocr:"+out[i].Name, "OCR extraido e analisado", content); err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save ocr knowledge"})
						return
					}
				}
			}
		}
	}

	c.JSON(http.StatusOK, chatUploadResponse{Files: out})
}
