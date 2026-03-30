// backend/handlers/tese_handler.go
package handlers

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"ressarcimento-backend/database"
	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
	"github.com/jung-kurt/gofpdf"
)

/* ─── cache do prompt da tese ───────────────────────────────────────── */

var tesePromptCache txtCache

func loadTesePrompt() string {
	return tesePromptCache.load([]string{
		filepath.Join("data", "prompt_tese.txt"),
		filepath.Join("backend", "data", "prompt_tese.txt"),
	})
}

/* ─── migração da tabela ────────────────────────────────────────────── */

var teseTableOnce sync.Once

func ensureTeseTable() {
	teseTableOnce.Do(func() {
		db := database.GormDB_App
		if db == nil {
			return
		}
		sql := `CREATE TABLE IF NOT EXISTS FT_TESES (
			id_tese         INT AUTO_INCREMENT PRIMARY KEY,
			id_processo     INT NOT NULL,
			conteudo        LONGTEXT NOT NULL,
			criado_em       DATETIME DEFAULT CURRENT_TIMESTAMP,
			atualizado_em   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			criado_por      VARCHAR(255),
			UNIQUE KEY uk_tese_processo (id_processo)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
		if err := db.Exec(sql).Error; err != nil {
			log.Printf("[tese] aviso: falha ao criar tabela FT_TESES: %v", err)
		}
	})
}

/* ─── dados do processo para geração ───────────────────────────────── */

type processoTeseData struct {
	ID                      int
	UC                      string
	Cliente                 string
	Concessionaria          string
	RessarcimentoEstimado   string
	DescricaoIrregularidade string
	PeriodosIrregularidade  string
	NomeTipoIrregularidade  string
	NomeSubtipoIrregularidade string
}

func fetchProcessoTeseData(processoID int) (*processoTeseData, error) {
	db := database.GormDB_App
	if db == nil {
		return nil, fmt.Errorf("banco não disponível")
	}

	row := db.Raw(`
		SELECT
			id_processo,
			COALESCE(uc, '') AS uc,
			COALESCE(cliente, '') AS cliente,
			COALESCE(concessionaria, '') AS concessionaria,
			COALESCE(CAST(ressarcimento_estimado AS CHAR), '') AS ressarcimento_estimado,
			COALESCE(descricao_irregularidade, '') AS descricao_irregularidade,
			COALESCE(periodos_irregularidade, '') AS periodos_irregularidade,
			COALESCE(nome_tipo_irregularidade, '') AS nome_tipo,
			COALESCE(nome_subtipo_irregularidade, '') AS nome_subtipo
		FROM FT_PROCESSOS
		WHERE id_processo = ?`, processoID).Row()

	var d processoTeseData
	var ressNum sql.NullString
	if err := row.Scan(
		&d.ID, &d.UC, &d.Cliente, &d.Concessionaria,
		&ressNum,
		&d.DescricaoIrregularidade, &d.PeriodosIrregularidade,
		&d.NomeTipoIrregularidade, &d.NomeSubtipoIrregularidade,
	); err != nil {
		return nil, fmt.Errorf("processo não encontrado: %w", err)
	}
	if ressNum.Valid {
		d.RessarcimentoEstimado = ressNum.String
	}
	return &d, nil
}

/* ─── geração do contexto para o prompt ────────────────────────────── */

func buildTeseContext(d *processoTeseData) string {
	var sb strings.Builder
	sb.WriteString("=== DADOS DO PROCESSO ===\n\n")
	sb.WriteString(fmt.Sprintf("ID do Processo: %d\n", d.ID))
	sb.WriteString(fmt.Sprintf("Unidade Consumidora (UC): %s\n", d.UC))
	sb.WriteString(fmt.Sprintf("Cliente / Titular: %s\n", d.Cliente))
	sb.WriteString(fmt.Sprintf("Distribuidora (Concessionária): %s\n", d.Concessionaria))
	sb.WriteString(fmt.Sprintf("Tipo de Irregularidade: %s\n", d.NomeTipoIrregularidade))
	sb.WriteString(fmt.Sprintf("Subtipo de Irregularidade: %s\n", d.NomeSubtipoIrregularidade))
	sb.WriteString(fmt.Sprintf("Valor Estimado de Ressarcimento: R$ %s\n", d.RessarcimentoEstimado))
	if d.PeriodosIrregularidade != "" {
		sb.WriteString(fmt.Sprintf("Períodos da Irregularidade: %s\n", d.PeriodosIrregularidade))
	}
	if d.DescricaoIrregularidade != "" {
		sb.WriteString(fmt.Sprintf("Descrição da Irregularidade: %s\n", d.DescricaoIrregularidade))
	}
	return sb.String()
}

/* ─── geração de PDF com gofpdf ─────────────────────────────────────── */

func gerarTesePDF(conteudo string) ([]byte, error) {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(25, 25, 20)
	pdf.SetAutoPageBreak(true, 20)
	pdf.AddPage()

	// Título do documento
	pdf.SetFont("Arial", "B", 14)
	pdf.SetTextColor(30, 60, 120)
	pdf.CellFormat(0, 10, "TESE TÉCNICO-JURÍDICA DE RESSARCIMENTO", "", 1, "C", false, 0, "")
	pdf.SetTextColor(0, 0, 0)
	pdf.Ln(4)

	// Linha separadora
	pdf.SetDrawColor(30, 60, 120)
	pdf.SetLineWidth(0.5)
	pdf.Line(25, pdf.GetY(), 185, pdf.GetY())
	pdf.Ln(6)

	// Corpo do documento
	lines := strings.Split(conteudo, "\n")
	inIdentificacao := false

	for _, line := range lines {
		raw := strings.TrimRight(line, " \t")

		// Pular marcadores de início/fim
		if raw == "---TESE---" || raw == "---FIM DA TESE---" {
			continue
		}

		// Seção de identificação
		if raw == "IDENTIFICAÇÃO DO CASO" {
			inIdentificacao = true
			pdf.SetFont("Arial", "B", 11)
			pdf.SetFillColor(240, 245, 255)
			pdf.CellFormat(0, 7, raw, "1", 1, "L", true, 0, "")
			pdf.SetFont("Arial", "", 10)
			pdf.Ln(1)
			continue
		}

		// Cabeçalhos de seção numerada (ex: "1. FUNDAMENTO FÁTICO")
		if len(raw) >= 3 && raw[1] == '.' && raw[0] >= '1' && raw[0] <= '9' {
			inIdentificacao = false
			pdf.Ln(3)
			pdf.SetFont("Arial", "B", 11)
			pdf.SetFillColor(240, 245, 255)
			pdf.CellFormat(0, 7, raw, "1", 1, "L", true, 0, "")
			pdf.Ln(2)
			pdf.SetFont("Arial", "", 10)
			continue
		}

		// Linha em branco
		if strings.TrimSpace(raw) == "" {
			if inIdentificacao {
				continue
			}
			pdf.Ln(3)
			continue
		}

		// Campos de identificação (chave: valor)
		if inIdentificacao && strings.Contains(raw, ":") {
			parts := strings.SplitN(raw, ":", 2)
			pdf.SetFont("Arial", "B", 9)
			key := strings.TrimSpace(parts[0]) + ":"
			pdf.CellFormat(65, 5, key, "", 0, "L", false, 0, "")
			pdf.SetFont("Arial", "", 9)
			val := strings.TrimSpace(parts[1])
			pdf.MultiCell(0, 5, latinize(val), "", "L", false)
			continue
		}

		// Texto normal com suporte a incisos romanos (I., II., etc.)
		pdf.SetFont("Arial", "", 10)
		trimmed := strings.TrimSpace(raw)

		// Incisos
		if len(trimmed) > 2 && trimmed[1] == '.' && (trimmed[0] == 'I' || trimmed[0] == 'V' || trimmed[0] == 'X') {
			pdf.SetX(30)
			pdf.MultiCell(155, 5, latinize(trimmed), "", "L", false)
			continue
		}

		pdf.MultiCell(0, 5, latinize(raw), "", "L", false)
	}

	// Rodapé com data
	pdf.SetFont("Arial", "I", 8)
	pdf.SetTextColor(120, 120, 120)
	pdf.Ln(10)
	pdf.Line(25, pdf.GetY(), 185, pdf.GetY())
	pdf.Ln(3)
	pdf.CellFormat(0, 5, "Documento gerado em "+time.Now().Format("02/01/2006")+" — AMEnergia", "", 0, "C", false, 0, "")

	var byteBuf []byte
	w := &byteWriter{buf: &byteBuf}
	if err := pdf.Output(w); err != nil {
		return nil, err
	}
	return byteBuf, nil
}

// latinize converte UTF-8 para Latin-1 aproximado (gofpdf usa Latin-1 internamente)
func latinize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 128 {
			b.WriteRune(r)
			continue
		}
		switch r {
		case 'á', 'à', 'â', 'ã', 'ä':
			b.WriteRune('a')
		case 'é', 'è', 'ê', 'ë':
			b.WriteRune('e')
		case 'í', 'ì', 'î', 'ï':
			b.WriteRune('i')
		case 'ó', 'ò', 'ô', 'õ', 'ö':
			b.WriteRune('o')
		case 'ú', 'ù', 'û', 'ü':
			b.WriteRune('u')
		case 'ç':
			b.WriteRune('c')
		case 'ñ':
			b.WriteRune('n')
		case 'Á', 'À', 'Â', 'Ã', 'Ä':
			b.WriteRune('A')
		case 'É', 'È', 'Ê', 'Ë':
			b.WriteRune('E')
		case 'Í', 'Ì', 'Î', 'Ï':
			b.WriteRune('I')
		case 'Ó', 'Ò', 'Ô', 'Õ', 'Ö':
			b.WriteRune('O')
		case 'Ú', 'Ù', 'Û', 'Ü':
			b.WriteRune('U')
		case 'Ç':
			b.WriteRune('C')
		case '\u2014', '\u2013': // em dash, en dash
			b.WriteString("--")
		case '\u2019', '\u2018': // curly quotes
			b.WriteRune('\'')
		case '\u201c', '\u201d': // curly double quotes
			b.WriteRune('"')
		default:
			if unicode.IsPrint(r) && r < 256 {
				b.WriteRune(r)
			} else {
				b.WriteRune('?')
			}
		}
	}
	return b.String()
}

type byteWriter struct {
	buf *[]byte
}

func (w *byteWriter) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}

/* ─── handlers HTTP ─────────────────────────────────────────────────── */

// GetTeseHandler — GET /api/v1/processos/:id/tese
func GetTeseHandler(c *gin.Context) {
	ensureTeseTable()
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	db := database.GormDB_App
	var conteudo string
	var criadoEm, atualizadoEm string
	row := db.Raw(`SELECT conteudo, criado_em, atualizado_em FROM FT_TESES WHERE id_processo = ?`, processoID).Row()
	if err := row.Scan(&conteudo, &criadoEm, &atualizadoEm); err != nil {
		// sem tese salva — retorna vazio sem erro
		c.JSON(http.StatusOK, gin.H{"conteudo": "", "existe": false})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"conteudo":      conteudo,
		"existe":        true,
		"criado_em":     criadoEm,
		"atualizado_em": atualizadoEm,
	})
}

// GerarTeseHandler — POST /api/v1/processos/:id/tese/gerar
func GerarTeseHandler(c *gin.Context) {
	ensureTeseTable()
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	d, err := fetchProcessoTeseData(processoID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	prompt := loadTesePrompt()
	if prompt == "" {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "prompt_tese.txt não encontrado"})
		return
	}

	ctxData := buildTeseContext(d)
	question := fmt.Sprintf(
		"Gere a tese técnico-jurídica completa para o processo %d conforme os dados acima e as instruções do sistema.",
		processoID,
	)

	timeout := 120 * time.Second
	if ms := strings.TrimSpace(os.Getenv("OPENAI_TIMEOUT_MS")); ms != "" {
		if v, err := strconv.Atoi(ms); err == nil && v > 0 {
			timeout = time.Duration(v) * time.Millisecond
		}
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
	defer cancel()

	tese, err := callAisureOpenAI(ctx, nil, question, ctxData, prompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao gerar tese: " + err.Error()})
		return
	}

	// Extrai só o conteúdo entre ---TESE--- e ---FIM DA TESE---
	tese = extractTeseFim(tese)

	c.JSON(http.StatusOK, gin.H{"conteudo": tese})
}

func extractTeseFim(s string) string {
	start := strings.Index(s, "---TESE---")
	end := strings.Index(s, "---FIM DA TESE---")
	if start >= 0 && end > start {
		s = strings.TrimSpace(s[start+len("---TESE---") : end])
	}
	return strings.TrimSpace(s)
}

// SalvarTeseHandler — POST /api/v1/processos/:id/tese/salvar
func SalvarTeseHandler(c *gin.Context) {
	ensureTeseTable()
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	var body struct {
		Conteudo string `json:"conteudo"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Conteudo) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "conteudo obrigatório"})
		return
	}

	criador := ""
	if u, ok := c.Get("userID"); ok {
		criador = fmt.Sprint(u)
	}

	db := database.GormDB_App
	err = db.Exec(`
		INSERT INTO FT_TESES (id_processo, conteudo, criado_por)
		VALUES (?, ?, ?)
		ON DUPLICATE KEY UPDATE conteudo = VALUES(conteudo), atualizado_em = NOW()`,
		processoID, body.Conteudo, criador,
	).Error
	if err != nil {
		log.Printf("[tese] erro ao salvar id=%d: %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao salvar tese"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// PDFTeseHandler — GET /api/v1/processos/:id/tese/pdf
func PDFTeseHandler(c *gin.Context) {
	ensureTeseTable()
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	db := database.GormDB_App
	var conteudo string
	row := db.Raw(`SELECT conteudo FROM FT_TESES WHERE id_processo = ?`, processoID).Row()
	if err := row.Scan(&conteudo); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tese não encontrada para este processo"})
		return
	}

	pdfBytes, err := gerarTesePDF(conteudo)
	if err != nil {
		log.Printf("[tese] erro ao gerar PDF id=%d: %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao gerar PDF"})
		return
	}

	filename := fmt.Sprintf("tese-processo-%d.pdf", processoID)
	c.Header("Content-Disposition", "attachment; filename="+filename)
	c.Header("Content-Type", "application/pdf")
	c.Data(http.StatusOK, "application/pdf", pdfBytes)
}

// EnviarEmailTeseHandler — POST /api/v1/processos/:id/tese/enviar-email
func EnviarEmailTeseHandler(c *gin.Context) {
	ensureTeseTable()
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	var input struct {
		Para    string `json:"para"`
		Cc      string `json:"cc"`
		Assunto string `json:"assunto"`
		Corpo   string `json:"corpo"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}
	if strings.TrimSpace(input.Para) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "destinatário obrigatório"})
		return
	}

	// Busca tese salva
	db := database.GormDB_App
	var conteudo string
	row := db.Raw(`SELECT conteudo FROM FT_TESES WHERE id_processo = ?`, processoID).Row()
	if err := row.Scan(&conteudo); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tese não encontrada — salve a tese antes de enviar"})
		return
	}

	pdfBytes, err := gerarTesePDF(conteudo)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao gerar PDF: " + err.Error()})
		return
	}

	assunto := input.Assunto
	if strings.TrimSpace(assunto) == "" {
		assunto = fmt.Sprintf("Pedido de Ressarcimento — Processo %d", processoID)
	}

	corpo := input.Corpo
	if strings.TrimSpace(corpo) == "" {
		corpo = fmt.Sprintf(
			"<p>Prezados,</p><p>Encaminhamos em anexo a tese técnico-jurídica referente ao processo %d.</p><p>Aguardamos retorno no prazo regulamentar.</p>",
			processoID,
		)
	}
	corpo = appendEmailProcessSignature(corpo)

	err = services.SendEmailDetailedWithAttachments(
		input.Para, input.Cc, "", assunto, corpo,
		[]services.EmailAttachment{
			{
				Name:        fmt.Sprintf("tese-processo-%d.pdf", processoID),
				ContentType: "application/pdf",
				Data:        pdfBytes,
			},
		},
	)
	if err != nil {
		log.Printf("[tese] erro ao enviar email id=%d: %v", processoID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao enviar e-mail"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "E-mail enviado com sucesso"})
}

// GerarEmailTeseHandler — POST /api/v1/processos/:id/tese/gerar-email
// Gera sugestão de e-mail com IA baseada nos dados do processo.
func GerarEmailTeseHandler(c *gin.Context) {
	processoID, err := strconv.Atoi(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	d, err := fetchProcessoTeseData(processoID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	emailPrompt := `Você é um especialista em comunicação formal do setor elétrico.
Gere um e-mail profissional e formal para envio à distribuidora solicitando análise
e deferimento de pedido de ressarcimento.

Formato obrigatório:
ASSUNTO: [assunto do email]
CORPO:
[corpo completo do email em HTML simples, com parágrafos <p>]`

	ctxData := buildTeseContext(d)
	question := "Gere o e-mail de encaminhamento da tese de ressarcimento com base nos dados do processo."

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	resultado, err := callAisureOpenAI(ctx, nil, question, ctxData, emailPrompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao gerar e-mail: " + err.Error()})
		return
	}

	// Extrai assunto e corpo
	assunto := ""
	corpo := resultado
	if idx := strings.Index(resultado, "ASSUNTO:"); idx >= 0 {
		rest := resultado[idx+len("ASSUNTO:"):]
		lines := strings.SplitN(rest, "\n", 3)
		if len(lines) >= 1 {
			assunto = strings.TrimSpace(lines[0])
		}
		if idx2 := strings.Index(rest, "CORPO:"); idx2 >= 0 {
			corpo = strings.TrimSpace(rest[idx2+len("CORPO:"):])
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"assunto": assunto,
		"corpo":   corpo,
	})
}
