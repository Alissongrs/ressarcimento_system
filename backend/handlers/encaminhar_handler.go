package handlers

// Encaminhar — ações em lote sobre TODAS as faturas de uma unidade (numero_instalacao):
//   1) Baixar todas em .zip (stream, sem persistir no servidor).
//   2) Passar todas no OCR Inteligente (cria um job populado com os PDFs da unidade).
// Fonte dos PDFs: coluna link_fatura (portal sgeeasy), baixada via aisureDownloadRemoteFatura.

import (
	"archive/zip"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

type faturaUnidade struct {
	id       int64
	mes      string
	link     string
	numFat   string
}

// faturasDaUnidade — faturas com link de uma unidade (numero_instalacao), opcional empresa.
func faturasDaUnidade(sqlDB *sql.DB, inst, empresa string) ([]faturaUnidade, error) {
	q := "SELECT id, COALESCE(mes_referencia,''), COALESCE(link_fatura,''), COALESCE(numero_fatura,'') " +
		"FROM FATURA_DADOS_EXTRAIDOS WHERE numero_instalacao = ? AND COALESCE(link_fatura,'') <> ''"
	args := []interface{}{inst}
	if empresa != "" && empresa != "0" {
		q += " AND cod_empresa = ?"
		args = append(args, empresa)
	}
	q += " ORDER BY mes_referencia"
	rows, err := sqlDB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []faturaUnidade
	for rows.Next() {
		var f faturaUnidade
		if rows.Scan(&f.id, &f.mes, &f.link, &f.numFat) == nil {
			out = append(out, f)
		}
	}
	return out, nil
}

func encInstEmpresa(c *gin.Context) (string, string) {
	inst := strings.Map(func(r rune) rune {
		if (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || r == '.' || r == '-' || r == '/' {
			return r
		}
		return -1
	}, strings.TrimSpace(c.Query("inst")))
	empresa := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.TrimSpace(c.Query("empresa")))
	return inst, empresa
}

func encSafeMes(m string) string {
	if len(m) >= 7 {
		return strings.ReplaceAll(m[:7], "-", "")
	}
	return "semdata"
}

// GET /api/v1/faturas/download-zip?inst=<numero_instalacao>&empresa=<cod>
// Baixa TODAS as faturas da unidade e devolve um .zip (stream). Não grava no servidor.
func DownloadFaturasZip(c *gin.Context) {
	inst, empresa := encInstEmpresa(c)
	if inst == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "inst (numero_instalacao) obrigatório"})
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
	faturas, err := faturasDaUnidade(sqlDB, inst, empresa)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta: " + err.Error()})
		return
	}
	if len(faturas) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "nenhuma fatura com link para esta unidade"})
		return
	}

	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="faturas_%s.zip"`, inst))
	zw := zip.NewWriter(c.Writer)
	defer zw.Close()

	usados := map[string]int{}
	ok := 0
	for _, f := range faturas {
		b, _, _, derr := aisureDownloadRemoteFatura(c.Request.Context(), f.link)
		if derr != nil || len(b) == 0 {
			continue // pula fatura que não baixou (não interrompe o zip)
		}
		name := fmt.Sprintf("%s_%d.pdf", encSafeMes(f.mes), f.id)
		if usados[name] > 0 {
			name = fmt.Sprintf("%s_%d_%d.pdf", encSafeMes(f.mes), f.id, usados[name])
		}
		usados[name]++
		w, werr := zw.Create(name)
		if werr != nil {
			continue
		}
		_, _ = w.Write(b)
		ok++
		if fl, okk := c.Writer.(interface{ Flush() }); okk {
			fl.Flush()
		}
	}
	_ = ok // (o zip é finalizado no defer zw.Close())
}

// POST /api/v1/faturas/ocr-lote-from-unidade?inst=<numero_instalacao>&empresa=<cod>
// Cria um job de OCR em lote populado com TODAS as faturas da unidade (baixadas dos links).
// Devolve job_id; o front dispara POST /ocr-lote/run/:job e navega pra tela OcrLote.
func OcrLoteFromUnidade(c *gin.Context) {
	inst, empresa := encInstEmpresa(c)
	if inst == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "inst (numero_instalacao) obrigatório"})
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
	faturas, err := faturasDaUnidade(sqlDB, inst, empresa)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta: " + err.Error()})
		return
	}
	if len(faturas) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "nenhuma fatura com link para esta unidade"})
		return
	}

	safeInst := strings.Map(func(r rune) rune {
		if (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			return r
		}
		return '_'
	}, inst)
	jobID := "uc_" + safeInst + "_" + time.Now().Format("20060102_150405")
	jobDir := filepath.Join(ocrLoteJobsBase(), jobID)
	pdfsDir := filepath.Join(jobDir, "pdfs")
	if err := os.MkdirAll(pdfsDir, 0o755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "não criou job: " + err.Error()})
		return
	}

	saved := 0
	usados := map[string]bool{}
	for _, f := range faturas {
		b, _, _, derr := aisureDownloadRemoteFatura(c.Request.Context(), f.link)
		if derr != nil || len(b) == 0 {
			continue
		}
		name := fmt.Sprintf("%s_%d.pdf", encSafeMes(f.mes), f.id)
		if usados[name] {
			name = fmt.Sprintf("%s_%d_x.pdf", encSafeMes(f.mes), f.id)
		}
		usados[name] = true
		if os.WriteFile(filepath.Join(pdfsDir, name), b, 0o644) == nil {
			saved++
		}
	}
	if saved == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"error": "nenhum PDF baixou (links indisponíveis)"})
		return
	}
	ocrLoteWriteStatus(jobDir, map[string]interface{}{
		"estado": "aguardando_ocr", "total": saved, "prontas": 0, "erros": 0,
	})
	c.JSON(http.StatusOK, gin.H{"job_id": jobID, "recebidos": saved, "total_no_job": saved, "unidade": inst})
}
