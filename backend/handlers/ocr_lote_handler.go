package handlers

// Módulo de Auditoria Inteligente de Faturas — OCR em lote (Fase 2).
// Sandbox: NÃO grava em FATURA_DADOS_EXTRAIDOS. Tudo em jobs/<id>/.
// Ponte Go->Python via os/exec (mesmo padrão de desvio_media_handler.go),
// rodando ia/Copia/essencial/_fase1_pipeline.py em modo JOB (env JOB_DIR).

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// ---- localização de jobs / python / script ----

func ocrLoteJobsBase() string {
	base := strings.TrimSpace(os.Getenv("OCR_LOTE_JOBS_DIR"))
	if base == "" {
		base = filepath.Join("..", "jobs_ocr_lote")
	}
	abs, err := filepath.Abs(base)
	if err == nil {
		base = abs
	}
	_ = os.MkdirAll(base, 0o755)
	return base
}

func ocrLotePython() string {
	py := strings.TrimSpace(os.Getenv("PYTHON_PATH"))
	if py != "" {
		return py
	}
	// Caminhos ABSOLUTOS — o subprocesso roda com cmd.Dir no diretório do script,
	// então um python relativo (../ocr_service/...) não resolveria.
	// ORDEM: o .venv da RAIZ (Docker/.venv) tem as deps do pipeline (fitz/pdfplumber/openai);
	// o venv do ocr_service NÃO tem fitz — deixá-lo por último.
	for _, cand := range []string{
		filepath.Join("..", "..", ".venv", "Scripts", "python.exe"),
		filepath.Join("..", "..", ".venv", "bin", "python"),
		filepath.Join("..", ".venv", "Scripts", "python.exe"),
		filepath.Join("..", "ocr_service", ".venv", "Scripts", "python.exe"),
		filepath.Join("..", "ocr_service", ".venv", "bin", "python"),
	} {
		if abs, err := filepath.Abs(cand); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs
			}
		}
	}
	return "python"
}

func ocrLoteScript() string {
	s := strings.TrimSpace(os.Getenv("FASE1_PIPELINE_PATH"))
	if s == "" {
		s = filepath.Join("..", "ia", "Copia", "essencial", "_fase1_pipeline.py")
	}
	abs, err := filepath.Abs(s)
	if err == nil {
		s = abs
	}
	return s
}

func ocrLoteSafeJobID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}

func ocrLoteWriteStatus(jobDir string, m map[string]interface{}) {
	b, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(jobDir, "status.json"), b, 0o644)
}

// ---- POST /ocr-lote/upload  (multipart "files"; opcional "job_id" p/ acumular lotes) ----

func OcrLoteUpload(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "form inválido: " + err.Error()})
		return
	}
	files := form.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nenhum arquivo (campo 'files')"})
		return
	}
	jobID := strings.TrimSpace(c.PostForm("job_id"))
	if jobID == "" {
		jobID = "job_" + time.Now().Format("20060102_150405")
	}
	if !ocrLoteSafeJobID(jobID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job_id inválido"})
		return
	}
	jobDir := filepath.Join(ocrLoteJobsBase(), jobID)
	pdfsDir := filepath.Join(jobDir, "pdfs")
	if err := os.MkdirAll(pdfsDir, 0o755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "não criou job: " + err.Error()})
		return
	}
	saved := 0
	for _, fh := range files {
		if !strings.HasSuffix(strings.ToLower(fh.Filename), ".pdf") {
			continue
		}
		dst := filepath.Join(pdfsDir, filepath.Base(fh.Filename))
		if err := c.SaveUploadedFile(fh, dst); err == nil {
			saved++
		}
	}
	total := ocrLoteCountPdfs(pdfsDir)
	ocrLoteWriteStatus(jobDir, map[string]interface{}{
		"estado": "aguardando_ocr", "total": total, "prontas": 0, "erros": 0,
	})
	c.JSON(http.StatusOK, gin.H{"job_id": jobID, "recebidos": saved, "total_no_job": total,
		"limite": 300, "excedeu": total > 300})
}

func ocrLoteCountPdfs(pdfsDir string) int {
	ents, err := os.ReadDir(pdfsDir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".pdf") {
			n++
		}
	}
	return n
}

// ---- POST /ocr-lote/:job/run  (dispara o pipeline assíncrono) ----

func OcrLoteRun(c *gin.Context) {
	jobID := c.Param("job")
	if !ocrLoteSafeJobID(jobID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job_id inválido"})
		return
	}
	jobDir := filepath.Join(ocrLoteJobsBase(), jobID)
	pdfsDir := filepath.Join(jobDir, "pdfs")
	total := ocrLoteCountPdfs(pdfsDir)
	if total == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job sem PDFs"})
		return
	}
	// evita rodar 2x
	if b, err := os.ReadFile(filepath.Join(jobDir, "status.json")); err == nil {
		var st map[string]interface{}
		if json.Unmarshal(b, &st) == nil {
			if e, _ := st["estado"].(string); e == "processando" {
				c.JSON(http.StatusConflict, gin.H{"error": "job já em processamento"})
				return
			}
		}
	}
	ocrLoteWriteStatus(jobDir, map[string]interface{}{
		"estado": "processando", "etapa": "iniciando", "total": total, "prontas": 0, "erros": 0, "tempo_s": 0,
	})
	script := ocrLoteScript()
	py := ocrLotePython()
	// goroutine detached (não usa o context da request, que cancela na resposta)
	go func() {
		cmd := exec.Command(py, script)
		cmd.Dir = filepath.Dir(script)
		cmd.Env = append(os.Environ(),
			"JOB_DIR="+jobDir,
			"FASE1_LLM=1",
			"SKIP_SEFAZ=1",
			"PYTHONIOENCODING=utf-8",
		)
		out, err := cmd.CombinedOutput()
		// grava log
		_ = os.WriteFile(filepath.Join(jobDir, "pipeline.log"), out, 0o644)
		if err != nil {
			// se o pipeline não escreveu status final, marca erro
			ocrLoteWriteStatus(jobDir, map[string]interface{}{
				"estado": "erro", "erro": err.Error(), "total": total,
			})
		}
	}()
	c.JSON(http.StatusAccepted, gin.H{"job_id": jobID, "estado": "processando", "total": total})
}

// ---- GET /ocr-lote/cruzar-fde?instalacao=X  (flag "cruzar com o banco") ----
// Pega TODAS as faturas da UC no FDE (sem o filtro fichas_apontadas, que é vazio) +
// roda o motor F01–F05 cacheado (mesmo da tela Auditoria) e devolve fichas por mês.
func OcrLoteCruzarFDE(c *gin.Context) {
	inst := strings.Map(func(r rune) rune {
		if (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '/' {
			return r
		}
		return -1
	}, strings.TrimSpace(c.Query("instalacao")))
	if inst == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "instalacao vazia"})
		return
	}
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}
	// Match normalizado (Fix 01/08): a mesma UC aparece na FDE com a instalação em formatos
	// divergentes — sufixo " DEVEC"/" - DEVEC" (parcelamento) e zeros à esquerda. O match exato
	// pegava só parte (ex. inst 413076505952: 59 de 112 faturas). Normaliza p/ só dígitos sem
	// zero à esquerda dos dois lados. Mantém o `= ?` (usa idx_fde_motor no caso comum).
	normInst := strings.TrimLeft(strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, inst), "0")
	var rows *sql.Rows
	if normInst != "" {
		rows, err = sqlDB.Query(
			"SELECT id, COALESCE(mes_referencia,''), COALESCE(razao_social,''), COALESCE(cpf_cnpj,'') "+
				"FROM FATURA_DADOS_EXTRAIDOS "+
				"WHERE numero_instalacao = ? "+
				"   OR TRIM(LEADING '0' FROM REGEXP_REPLACE(COALESCE(numero_instalacao,''),'[^0-9]','')) = ? "+
				"ORDER BY mes_referencia", inst, normInst)
	} else {
		rows, err = sqlDB.Query(
			"SELECT id, COALESCE(mes_referencia,''), COALESCE(razao_social,''), COALESCE(cpf_cnpj,'') "+
				"FROM FATURA_DADOS_EXTRAIDOS WHERE numero_instalacao = ? ORDER BY mes_referencia", inst)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta FDE: " + err.Error()})
		return
	}
	defer rows.Close()
	type fat struct {
		id            int64
		mes, rz, cnpj string
	}
	var faturas []fat
	for rows.Next() {
		var f fat
		if rows.Scan(&f.id, &f.mes, &f.rz, &f.cnpj) == nil {
			faturas = append(faturas, f)
		}
	}
	if len(faturas) == 0 {
		c.JSON(http.StatusOK, gin.H{"encontrada": false, "instalacao": inst})
		return
	}
	// motor F01–F05 ao vivo (cacheado, mesmo da tela Auditoria)
	motorRes, mErr := motorApontamentosCached(sqlDB, "", true)
	if mErr != nil {
		motorRes = map[int64]ResultadoDesvio{}
	}
	fichasAgg := map[string]bool{}
	porMes := make([]gin.H, 0, len(faturas))
	for _, f := range faturas {
		var fichas []string
		if r, ok := motorRes[f.id]; ok {
			fichas = r.FichasAplicadas
		}
		for _, fi := range fichas {
			fichasAgg[fi] = true
		}
		porMes = append(porMes, gin.H{"mes": f.mes, "fichas": fichas})
	}
	agg := make([]string, 0, len(fichasAgg))
	for k := range fichasAgg {
		agg = append(agg, k)
	}
	c.JSON(http.StatusOK, gin.H{
		"encontrada": true, "instalacao": inst, "n": len(faturas),
		"razao_social": faturas[0].rz, "cpf_cnpj": faturas[0].cnpj,
		"fichas": agg, "por_mes": porMes,
	})
}

// ---- GET /ocr-lote/:job/status ----

func OcrLoteStatus(c *gin.Context) {
	jobID := c.Param("job")
	if !ocrLoteSafeJobID(jobID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job_id inválido"})
		return
	}
	jobDir := filepath.Join(ocrLoteJobsBase(), jobID)
	b, err := os.ReadFile(filepath.Join(jobDir, "status.json"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "job não encontrado"})
		return
	}
	var st map[string]interface{}
	if json.Unmarshal(b, &st) != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "status corrompido"})
		return
	}
	c.JSON(http.StatusOK, st)
}

// ---- GET /ocr-lote/:job/relatorio  (?tipo=metricas|relatorio) ----

func OcrLoteRelatorio(c *gin.Context) {
	jobID := c.Param("job")
	if !ocrLoteSafeJobID(jobID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "job_id inválido"})
		return
	}
	tipo := c.DefaultQuery("tipo", "relatorio")
	if tipo != "relatorio" && tipo != "metricas" {
		tipo = "relatorio"
	}
	jobDir := filepath.Join(ocrLoteJobsBase(), jobID)
	path := filepath.Join(jobDir, "relatorio", tipo+".json")
	b, err := os.ReadFile(path)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("%s ainda não disponível", tipo)})
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", b)
}
