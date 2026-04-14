package handlers

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"ressarcimento-backend/database"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// processoDocData contém os campos usados na geração do documento.
type processoDocData struct {
	ID              int
	Cliente         string
	UC              string
	Concessionaria  string
	NumeroProtocolo string
}

func fetchProcessoDocData(processoID int) (*processoDocData, error) {
	db := database.GormDB_App
	var d processoDocData
	row := db.Raw(`
		SELECT
			p.id_processo,
			COALESCE(p.cliente, '')        AS cliente,
			COALESCE(p.uc, '')             AS uc,
			COALESCE(p.concessionaria, '') AS concessionaria,
			COALESCE(r.numero_protocolo, '') AS numero_protocolo
		FROM FT_PROCESSOS p
		LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		WHERE p.id_processo = ?
		LIMIT 1
	`, processoID).Row()

	if err := row.Scan(&d.ID, &d.Cliente, &d.UC, &d.Concessionaria, &d.NumeroProtocolo); err != nil {
		return nil, err
	}
	return &d, nil
}

// patchDocx lê o DOCX template, substitui os placeholders e retorna os bytes do novo arquivo.
func patchDocx(templatePath string, replacements map[string]string) ([]byte, error) {
	src, err := os.Open(templatePath)
	if err != nil {
		return nil, err
	}
	defer src.Close()

	info, err := src.Stat()
	if err != nil {
		return nil, err
	}

	zr, err := zip.NewReader(src, info.Size())
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, err
		}

		if f.Name == "word/document.xml" {
			xml := string(data)
			for placeholder, value := range replacements {
				xml = strings.ReplaceAll(xml, placeholder, value)
			}
			data = []byte(xml)
		}

		w, err := zw.CreateHeader(&f.FileHeader)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var mesesPT = [...]string{
	"", "janeiro", "fevereiro", "março", "abril", "maio", "junho",
	"julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
}

func dataHojePT() string {
	t := time.Now()
	return fmt.Sprintf("%02d de %s de %d", t.Day(), mesesPT[t.Month()], t.Year())
}

// GerarDocumentoHandler gera o DOCX de ofício preenchido com os dados do processo.
func GerarDocumentoHandler(c *gin.Context) {
	idStr := c.Param("id")
	processoID, err := strconv.Atoi(idStr)
	if err != nil || processoID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}

	// Template pré-processado com placeholders; fallback para o original
	templatePath := filepath.Join("data", "template", "template_ouvidoria.docx")
	if _, statErr := os.Stat(templatePath); os.IsNotExist(statErr) {
		templatePath = filepath.Join("data", "template", "CEMIG - Ouvidoria.docx")
	}
	if _, statErr := os.Stat(templatePath); os.IsNotExist(statErr) {
		c.JSON(http.StatusNotFound, gin.H{"error": "template não encontrado"})
		return
	}

	d, err := fetchProcessoDocData(processoID)
	if err != nil {
		d = &processoDocData{ID: processoID}
	}

	protocolo := d.NumeroProtocolo
	if protocolo == "" {
		protocolo = strconv.Itoa(d.ID)
	}

	replacements := map[string]string{
		"{{DATA}}":       dataHojePT(),
		"{{CLIENTE}}":    d.Cliente,
		"{{UC}}":         d.UC,
		"{{PROTOCOLO}}":  protocolo,
		"{{REFERENCIA}}": protocolo,
	}

	docBytes, err := patchDocx(templatePath, replacements)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao gerar documento"})
		return
	}

	filename := fmt.Sprintf("Oficio_%d.docx", processoID)
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	c.Header("Content-Length", strconv.Itoa(len(docBytes)))
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docBytes)
}
