package handlers

// Teste E2E dos endpoints /ocr-lote/* SEM abrir porta (httptest, in-process) — não
// dispara firewall. Exercita upload -> run -> status(polling) -> relatorio de verdade,
// incluindo o subprocesso do pipeline Python. Rode:
//   go test ./handlers -run TestOcrLoteE2E -timeout 300s -v

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func absPath(parts ...string) string {
	p, _ := filepath.Abs(filepath.Join(parts...))
	return p
}

func TestOcrLoteE2E(t *testing.T) {
	script := absPath("..", "..", "ia", "Copia", "essencial", "_fase1_pipeline.py")
	if _, err := os.Stat(script); err != nil {
		t.Skip("pipeline não encontrado: " + script)
	}
	samples := `C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho\Docker\protótipos\Faturas Santander - Vinicius_19-06-2026`
	files := []string{
		filepath.Join(samples, "11.477.786.018-22_3014465625_05-26.pdf"),
		filepath.Join(samples, "14802970_09-25.pdf"),
	}
	for _, f := range files {
		if _, err := os.Stat(f); err != nil {
			t.Skip("amostra não encontrada: " + f)
		}
	}
	py := absPath("..", "..", "..", ".venv", "Scripts", "python.exe")
	if _, err := os.Stat(py); err != nil {
		py = "python"
	}
	t.Setenv("OCR_LOTE_JOBS_DIR", t.TempDir())
	t.Setenv("FASE1_PIPELINE_PATH", script)
	t.Setenv("PYTHON_PATH", py)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.POST("/ocr-lote/upload", OcrLoteUpload)
	r.POST("/ocr-lote/run/:job", OcrLoteRun)
	r.GET("/ocr-lote/status/:job", OcrLoteStatus)
	r.GET("/ocr-lote/relatorio/:job", OcrLoteRelatorio)

	// ---- upload (multipart, 2 PDFs) ----
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	for _, f := range files {
		src, err := os.Open(f)
		if err != nil {
			t.Fatalf("abrir %s: %v", f, err)
		}
		fw, _ := mw.CreateFormFile("files", filepath.Base(f))
		io.Copy(fw, src)
		src.Close()
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/ocr-lote/upload", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	t.Logf("UPLOAD %d: %s", w.Code, w.Body.String())
	if w.Code != http.StatusOK {
		t.Fatalf("upload falhou: %d", w.Code)
	}
	var up map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &up)
	job, _ := up["job_id"].(string)
	if job == "" {
		t.Fatal("sem job_id")
	}

	// ---- run ----
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/ocr-lote/run/"+job, nil))
	t.Logf("RUN %d: %s", w.Code, w.Body.String())
	if w.Code != http.StatusAccepted {
		t.Fatalf("run falhou: %d %s", w.Code, w.Body.String())
	}

	// ---- polling status ----
	var st map[string]interface{}
	for i := 0; i < 120; i++ {
		time.Sleep(2 * time.Second)
		w = httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", "/ocr-lote/status/"+job, nil))
		st = map[string]interface{}{}
		json.Unmarshal(w.Body.Bytes(), &st)
		e, _ := st["estado"].(string)
		if e == "concluido" || e == "erro" {
			break
		}
	}
	t.Logf("STATUS final: %v", st)
	if st["estado"] != "concluido" {
		t.Fatalf("não concluiu: %v", st)
	}

	// ---- relatorio ----
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/ocr-lote/relatorio/"+job, nil))
	t.Logf("RELATORIO status=%d bytes=%d", w.Code, w.Body.Len())
	if w.Code != http.StatusOK || w.Body.Len() < 50 {
		t.Fatalf("relatorio vazio/erro: %d", w.Code)
	}
	var rel []map[string]interface{}
	if json.Unmarshal(w.Body.Bytes(), &rel) != nil || len(rel) == 0 {
		t.Fatal("relatorio não parseou / vazio")
	}
	t.Logf("OK — %d faturas no relatorio", len(rel))
}
