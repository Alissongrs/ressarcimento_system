package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"ressarcimento-backend/database"
	"ressarcimento-backend/services"
)

/* â"€â"€â"€ cache de arquivos de texto (TTL 60s) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

type txtCache struct {
	mu       sync.RWMutex
	value    string
	loadedAt time.Time
}

func (c *txtCache) load(candidates []string) string {
	c.mu.RLock()
	if time.Since(c.loadedAt) < 60*time.Second {
		v := c.value
		c.mu.RUnlock()
		return v
	}
	c.mu.RUnlock()

	var text string
	for _, p := range candidates {
		if raw, err := os.ReadFile(p); err == nil {
			if t := strings.TrimSpace(string(raw)); t != "" {
				text = t
				break
			}
		}
	}
	c.mu.Lock()
	c.value = text
	c.loadedAt = time.Now()
	c.mu.Unlock()
	return text
}

var (
	aisureRulesCache       txtCache
	confirmarPromptCache   txtCache
	extrairPromptCache     txtCache
	conferirPromptCache    txtCache
	auditarPromptCache     txtCache
	valorEstimadoCache     txtCache
	emailPromptCache       txtCache
	emailTemplatesCache    txtCache
	cobrancaPromptCache    txtCache
	cobrancaTemplatesCache txtCache
)

func loadAisureRules() string {
	return aisureRulesCache.load([]string{
		filepath.Join("data", "regras_aisure.txt"),
		filepath.Join("backend", "data", "regras_aisure.txt"),
	})
}

func loadConfirmarPrompt() string {
	return confirmarPromptCache.load([]string{
		filepath.Join("data", "prompt_confirmar.txt"),
		filepath.Join("backend", "data", "prompt_confirmar.txt"),
	})
}

func loadExtrairPrompt() string {
	return extrairPromptCache.load([]string{
		filepath.Join("data", "prompt_extrair.txt"),
		filepath.Join("backend", "data", "prompt_extrair.txt"),
	})
}

func loadConferirPrompt() string {
	return conferirPromptCache.load([]string{
		filepath.Join("data", "prompt_conferir.txt"),
		filepath.Join("backend", "data", "prompt_conferir.txt"),
	})
}

func loadAuditarPrompt() string {
	return auditarPromptCache.load([]string{
		filepath.Join("data", "prompt_auditar.txt"),
		filepath.Join("backend", "data", "prompt_auditar.txt"),
	})
}

func loadValorEstimadoPrompt() string {
	return valorEstimadoCache.load([]string{
		filepath.Join("data", "prompt_valor_estimado.txt"),
		filepath.Join("backend", "data", "prompt_valor_estimado.txt"),
	})
}

func loadEmailPrompt() string {
	return emailPromptCache.load([]string{
		filepath.Join("data", "prompt_email.txt"),
		filepath.Join("backend", "data", "prompt_email.txt"),
	})
}

func loadEmailTemplates() string {
	return emailTemplatesCache.load([]string{
		filepath.Join("data", "email_templates.txt"),
		filepath.Join("backend", "data", "email_templates.txt"),
	})
}

func loadCobrancaPrompt() string {
	return cobrancaPromptCache.load([]string{
		filepath.Join("data", "prompt_cobranca.txt"),
		filepath.Join("backend", "data", "prompt_cobranca.txt"),
	})
}

func loadCobrancaTemplates() string {
	return cobrancaTemplatesCache.load([]string{
		filepath.Join("data", "cobranca_templates.txt"),
		filepath.Join("backend", "data", "cobranca_templates.txt"),
	})
}

/* â"€â"€â"€ tipos â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

type aisureMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type aisureAttachment struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type aisureChatReq struct {
	Question    string             `json:"question"`
	History     []aisureMsg        `json:"history"`
	Attachments []aisureAttachment `json:"attachments"`
}

type aisureChatResp struct {
	Answer string `json:"answer"`
	Model  string `json:"model"`
}

type aisureAttachFaturaReq struct {
	ProcessoID int64  `json:"id_processo"`
	URL        string `json:"url"`
	Comentario string `json:"comentario"`
}

/* â"€â"€â"€ system prompt â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

const aisureSystemPrompt = `VocÃª Ã© o AISURE, assistente especializado em anÃ¡lise de anomalias em faturas de energia elÃ©trica.
VocÃª tem acesso a dados reais de cinco fichas de irregularidade (F01—F05) do banco de faturas.
Responda sempre em portuguÃªs brasileiro, de forma objetiva e tÃ©cnica.
Quando o usuÃ¡rio perguntar sobre uma UC especÃ­fica, analise os dados daquela UC nas fichas disponÃ­veis.
Quando identificar anomalias, explique o tipo de irregularidade e sugira se vale abrir um processo de ressarcimento.
Se nÃ£o houver dados suficientes no contexto, informe claramente.
NÃ£o invente dados — use apenas o que estÃ¡ no contexto fornecido.`

/* â"€â"€â"€ regex para extrair UC da pergunta â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

var reUC = regexp.MustCompile(`\b\d{6,12}\b`)
var reAisureTotalConfirmadas = regexp.MustCompile(`(?im)total\s+de\s+fichas\s+confirmadas\s*:\s*(\d+)`)
var reAisureFichasConfirmadas = regexp.MustCompile(`(?im)fichas\s+confirmadas\s*:\s*(\d+)`)
var reAisureLinhaConfirmada = regexp.MustCompile(`(?im)^f0[1-5]\b.*\bconfirmado\b`)
var reAisureLinhaNaoConfirmada = regexp.MustCompile(`(?im)^f0[1-5]\b.*\b(nÃ£o|nao)\s+confirmado\b`)

/* â"€â"€â"€ meta das fichas â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

type fichaCtxInfo struct {
	key    string
	nome   string
	filtro string
}

var fichasCtxList = []fichaCtxInfo{
	{"F01", "DivergÃªncia de FÃ³rmula", " AND flag_f01 = 1"},
	{"F02", "Desvio de MÃ©dia", " AND flag_f02 = 1"},
	{"F03", "AcÃºmulo de Consumo", " AND flag_f03 = 1"},
	{"F04", "Troca de Medidor", " AND flag_f04 = 1"},
	{"F05", "Quebra de Leitura", " AND flag_f05 = 1"},
}

/* â"€â"€â"€ build contexto â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

func buildAisureContext(question string) string {
	db := database.GormDB_App
	if db == nil {
		return "Banco local indisponÃ­vel no momento."
	}
	sqlDB, err := db.DB()
	if err != nil {
		return "Erro ao conectar ao banco local."
	}

	ucMentions := reUC.FindAllString(question, -1)
	ucSet := make(map[string]struct{}, len(ucMentions))
	for _, u := range ucMentions {
		ucSet[u] = struct{}{}
	}

	var sb strings.Builder
	sb.WriteString("=== CONTEXTO DAS FICHAS DE ANOMALIA ===\n\n")

	for _, f := range fichasCtxList {
		var total int64
		_ = sqlDB.QueryRow("SELECT COUNT(*) FROM fichas_anomalias_cache WHERE 1=1" + f.filtro).Scan(&total)
		fmt.Fprintf(&sb, "## %s — %s (%d registros)\n", f.key, f.nome, total)

		if total == 0 {
			sb.WriteString("(sem registros)\n\n")
			continue
		}

		base := "SELECT * FROM fichas_anomalias_cache WHERE 1=1" + f.filtro

		if len(ucSet) > 0 {
			for uc := range ucSet {
				rows, err := sqlDB.Query(base+" AND UC LIKE ? LIMIT 10", "%"+uc+"%")
				if err != nil {
					continue
				}
				rowMaps, colNames := aisureScanRows(rows)
				_ = rows.Close()
				if len(rowMaps) == 0 {
					continue
				}
				fmt.Fprintf(&sb, "Registros para UC %s:\n", uc)
				sb.WriteString(aisureFormatRows(colNames, rowMaps))
			}
		} else {
			rows, err := sqlDB.Query(base + " LIMIT 5")
			if err == nil {
				rowMaps, colNames := aisureScanRows(rows)
				_ = rows.Close()
				if len(rowMaps) > 0 {
					sb.WriteString("Amostra (5 registros):\n")
					sb.WriteString(aisureFormatRows(colNames, rowMaps))
				}
			}
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

func aisureScanRows(rows *sql.Rows) ([]map[string]string, []string) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, nil
	}
	var result []map[string]string
	for rows.Next() {
		vals := make([]interface{}, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if rows.Scan(ptrs...) != nil {
			continue
		}
		row := make(map[string]string, len(cols))
		for i, col := range cols {
			v := vals[i]
			if v == nil {
				row[col] = "-"
			} else if b, ok := v.([]byte); ok {
				row[col] = string(b)
			} else {
				row[col] = fmt.Sprintf("%v", v)
			}
		}
		result = append(result, row)
	}
	return result, cols
}

func aisureFormatRows(cols []string, rows []map[string]string) string {
	if len(rows) == 0 || len(cols) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(strings.Join(cols, " | "))
	sb.WriteString("\n")
	for _, row := range rows {
		vals := make([]string, len(cols))
		for i, col := range cols {
			v := row[col]
			if len(v) > 30 {
				v = v[:30] + "â€¦"
			}
			vals[i] = v
		}
		sb.WriteString(strings.Join(vals, " | "))
		sb.WriteString("\n")
	}
	return sb.String()
}

/* â"€â"€â"€ chamada OpenAI â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

func aisureParseConfirmado(answer string) bool {
	text := strings.TrimSpace(answer)
	if text == "" {
		return false
	}

	if m := reAisureTotalConfirmadas.FindStringSubmatch(text); len(m) == 2 {
		if n, err := strconv.Atoi(strings.TrimSpace(m[1])); err == nil {
			return n > 0
		}
	}
	if m := reAisureFichasConfirmadas.FindStringSubmatch(text); len(m) == 2 {
		if n, err := strconv.Atoi(strings.TrimSpace(m[1])); err == nil {
			return n > 0
		}
	}

	lines := reAisureLinhaConfirmada.FindAllString(text, -1)
	confirmedCount := 0
	for _, line := range lines {
		if reAisureLinhaNaoConfirmada.MatchString(line) {
			continue
		}
		confirmedCount++
	}

	return confirmedCount > 0
}

func aisureOpenAIModel() string {
	if v := strings.TrimSpace(os.Getenv("OPENAI_MODEL")); v != "" {
		return v
	}
	return "gpt-4o-mini"
}

// aisureTokensKey retorna "max_completion_tokens" para modelos que não aceitam
// "max_tokens" (família o1/o3/o4 e gpt-5+), e "max_tokens" para os demais.
func aisureTokensKey(model string) string {
	for _, prefix := range []string{"o1", "o3", "o4", "gpt-5"} {
		if strings.HasPrefix(model, prefix) {
			return "max_completion_tokens"
		}
	}
	return "max_tokens"
}

// aisureSupportsTemperature retorna false para modelos que só aceitam temperature padrão (1).
func aisureSupportsTemperature(model string) bool {
	for _, prefix := range []string{"o1", "o3", "o4", "gpt-5"} {
		if strings.HasPrefix(model, prefix) {
			return false
		}
	}
	return true
}

// aisureSupportsReasoningEffort retorna true apenas para modelos de raciocínio
// que aceitam o parâmetro reasoning_effort (o1, o3, o4). Outros modelos (gpt-4.x,
// gpt-4.1, gpt-5.x chat, etc.) retornam erro 400 se o parâmetro for enviado.
func aisureSupportsReasoningEffort(model string) bool {
	for _, prefix := range []string{"o1", "o3", "o4"} {
		if strings.HasPrefix(model, prefix) {
			return true
		}
	}
	return false
}


func callAisureOpenAI(ctx context.Context, history []aisureMsg, question, ctxStr string, systemPromptOverride ...string) (string, error) {
	return callAisureOpenAIMaxTokens(ctx, history, question, ctxStr, 1024, systemPromptOverride...)
}

// callAisureOpenAIMaxTokens é callAisureOpenAI com o teto de tokens de saída configurável.
// Usada quando a resposta esperada é sabidamente maior que o padrão de 1024 (ex: cobrança
// com 4 tons no mesmo JSON) — sem mudar o limite padrão dos outros ~10 chamadores.
func callAisureOpenAIMaxTokens(ctx context.Context, history []aisureMsg, question, ctxStr string, maxTokens int, systemPromptOverride ...string) (string, error) {
	model := aisureOpenAIModel()

	type oaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}

	sysPrompt := aisureSystemPrompt
	if len(systemPromptOverride) > 0 && strings.TrimSpace(systemPromptOverride[0]) != "" {
		sysPrompt = systemPromptOverride[0]
	}

	msgs := make([]oaiMsg, 0, len(history)+3)
	msgs = append(msgs, oaiMsg{Role: "system", Content: sysPrompt})
	msgs = append(msgs, oaiMsg{Role: "system", Content: ctxStr})

	for _, h := range history {
		role := strings.ToLower(strings.TrimSpace(h.Role))
		if role != "user" && role != "assistant" {
			continue
		}
		msgs = append(msgs, oaiMsg{Role: role, Content: h.Content})
	}
	msgs = append(msgs, oaiMsg{Role: "user", Content: question})

	reqBody := map[string]interface{}{
		"model":                model,
		"messages":             msgs,
		aisureTokensKey(model): maxTokens,
	}
	if effort := strings.TrimSpace(os.Getenv("OPENAI_REASONING_EFFORT")); effort != "" && aisureSupportsReasoningEffort(model) {
		reqBody["reasoning_effort"] = effort
	}
	if aisureSupportsTemperature(model) {
		reqBody["temperature"] = 0.3
	}


	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	res, retryErr := doOpenAIWithRetry(ctx, payload)
	if retryErr != nil {
		return "", fmt.Errorf("openai: %w", retryErr)
	}
	if res.status != http.StatusOK {
		return "", fmt.Errorf("openai status %d: %s", res.status, string(res.body))
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(res.body, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("sem resposta do modelo")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

/* â"€â"€â"€ Chamada OpenAI com visÃ£o (imagem base64) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

func callAisureOpenAIVision(ctx context.Context, question, ctxStr string, images []faturaImageItem, systemPromptOverride ...string) (string, error) {
	model := aisureOpenAIModel()

	sysPrompt := aisureSystemPrompt
	if len(systemPromptOverride) > 0 && strings.TrimSpace(systemPromptOverride[0]) != "" {
		sysPrompt = systemPromptOverride[0]
	}

	type imgURL struct {
		URL    string `json:"url"`
		Detail string `json:"detail"`
	}
	type contentPart struct {
		Type     string  `json:"type"`
		Text     string  `json:"text,omitempty"`
		ImageURL *imgURL `json:"image_url,omitempty"`
	}
	type msgFlex struct {
		Role    string      `json:"role"`
		Content interface{} `json:"content"`
	}

	// Monta partes: texto + uma entrada por pÃ¡gina
	parts := make([]contentPart, 0, len(images)+1)
	parts = append(parts, contentPart{Type: "text", Text: question})
	for _, img := range images {
		mime := img.Mime
		if mime == "" {
			mime = "image/jpeg"
		}
		parts = append(parts, contentPart{
			Type:     "image_url",
			ImageURL: &imgURL{URL: "data:" + mime + ";base64," + img.Base64, Detail: "high"},
		})
	}

	msgs := []msgFlex{
		{Role: "system", Content: sysPrompt},
		{Role: "system", Content: ctxStr},
		{Role: "user", Content: parts},
	}

	reqBody := map[string]interface{}{
		"model":                model,
		"messages":             msgs,
		aisureTokensKey(model): 4096,
	}
	if effort := strings.TrimSpace(os.Getenv("OPENAI_REASONING_EFFORT")); effort != "" && aisureSupportsReasoningEffort(model) {
		reqBody["reasoning_effort"] = effort
	}
	if aisureSupportsTemperature(model) {
		reqBody["temperature"] = 0.3
	}


	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	res, retryErr := doOpenAIWithRetry(ctx, payload)
	if retryErr != nil {
		return "", fmt.Errorf("openai vision: %w", retryErr)
	}
	if res.status != http.StatusOK {
		return "", fmt.Errorf("openai vision status %d: %s", res.status, string(res.body))
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(res.body, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("sem resposta do modelo")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

/* --- Chamada OpenAI com PDF puro (base64) — sem conversão para imagem --- */

func callAisureOpenAIPDF(ctx context.Context, question, ctxStr, pdfBase64, pdfName string, systemPromptOverride ...string) (string, error) {
	model := aisureOpenAIModel()

	sysPrompt := aisureSystemPrompt
	if len(systemPromptOverride) > 0 && strings.TrimSpace(systemPromptOverride[0]) != "" {
		sysPrompt = systemPromptOverride[0]
	}

	if pdfName == "" {
		pdfName = "fatura.pdf"
	}

	type fileContent struct {
		Filename string `json:"filename"`
		FileData string `json:"file_data"`
	}
	type contentPart struct {
		Type string       `json:"type"`
		Text string       `json:"text,omitempty"`
		File *fileContent `json:"file,omitempty"`
	}
	type msgFlex struct {
		Role    string `json:"role"`
		Content any    `json:"content"`
	}

	parts := []contentPart{
		{Type: "text", Text: question},
		{
			Type: "file",
			File: &fileContent{
				Filename: pdfName,
				FileData: "data:application/pdf;base64," + pdfBase64,
			},
		},
	}

	msgs := []msgFlex{
		{Role: "system", Content: sysPrompt},
		{Role: "system", Content: ctxStr},
		{Role: "user", Content: parts},
	}

	reqBody := map[string]any{
		"model":                model,
		"messages":             msgs,
		aisureTokensKey(model): 4096,
	}
	if effort := strings.TrimSpace(os.Getenv("OPENAI_REASONING_EFFORT")); effort != "" && aisureSupportsReasoningEffort(model) {
		reqBody["reasoning_effort"] = effort
	}
	if aisureSupportsTemperature(model) {
		reqBody["temperature"] = 0.3
	}


	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	res, retryErr := doOpenAIWithRetry(ctx, payload)
	if retryErr != nil {
		return "", fmt.Errorf("openai pdf: %w", retryErr)
	}
	if res.status != http.StatusOK {
		return "", fmt.Errorf("openai pdf status %d: %s", res.status, string(res.body))
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(res.body, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("sem resposta do modelo")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

/* --- Handler de confirmação por linha --- */

type faturaImageItem struct {
	Base64 string `json:"base64"`
	Mime   string `json:"mime"`
}

type aisureConfirmarReq struct {
	UC              string            `json:"uc"`
	Fichas          string            `json:"fichas"`
	Detalhamento    string            `json:"detalhamento"`
	RowData         map[string]string `json:"row_data"`
	FaturaLink      string            `json:"fatura_link"`
	FaturaText      string            `json:"fatura_text"`      // texto extraído (contexto adicional)
	FaturaOCRText   string            `json:"fatura_ocr_text"`  // texto OCR Tesseract (extração local)
	FaturaRegion    string            `json:"fatura_region_base64"` // área destacada pelo usuário (PNG base64)
	FaturaBase64    string            `json:"fatura_base64"`    // imagem única (legado)
	FaturaMime      string            `json:"fatura_mime"`
	FaturaImages    []faturaImageItem `json:"fatura_images"`    // array de páginas (PDF convertido)
	FaturaPDFBase64 string            `json:"fatura_pdf_base64"` // PDF puro em base64 (preferencial)
	FaturaPDFName   string            `json:"fatura_pdf_name"`
}

type aisureConfirmarResp struct {
	Confirmado     bool   `json:"confirmado"`
	Analise        string `json:"analise"`
	CalcFinanceiro string `json:"calculo_financeiro,omitempty"`
	Model          string `json:"model"`
}

type aisureOCRExtract struct {
	RawText               string                 `json:"raw_text"`
	Status                string                 `json:"status"`
	Confidence            interface{}            `json:"confidence"`
	ExtractedFields       map[string]interface{} `json:"extracted_fields"`
	MissingFields         []string               `json:"missing_fields"`
	MissingEvidenceFields []string               `json:"missing_evidence_fields"`
	EvidenceMap           map[string]interface{} `json:"evidence_map"`
	Warnings              []string               `json:"warnings"`
	Errors                []string               `json:"errors"`
	PagesUsed             interface{}            `json:"pages_used"`
}

func aisureResolveFaturaLink(in aisureConfirmarReq) string {
	if v := strings.TrimSpace(in.FaturaLink); v != "" {
		return v
	}
	for _, k := range []string{"Link", "link"} {
		if v := strings.TrimSpace(in.RowData[k]); v != "" {
			return v
		}
	}
	return ""
}

func aisureFirstNonEmpty(m map[string]string, keys ...string) string {
	for _, k := range keys {
		v := strings.TrimSpace(m[k])
		if v != "" && strings.ToLower(v) != "null" && strings.ToLower(v) != "undefined" {
			return v
		}
	}
	return ""
}

// aisureDetectRuralTag verifica se qualquer campo do RowData contém "RURAL" ou "IRRIGANTE"
// e retorna a tag correspondente ("RURAL", "IRRIGANTE" ou "").
func aisureDetectRuralTag(m map[string]string) string {
	hasIrrigante := false
	hasRural := false
	for _, v := range m {
		upper := strings.ToUpper(v)
		if strings.Contains(upper, "IRRIGANTE") {
			hasIrrigante = true
		}
		if strings.Contains(upper, "RURAL") {
			hasRural = true
		}
	}
	switch {
	case hasIrrigante && hasRural:
		return "RURAL / IRRIGANTE"
	case hasIrrigante:
		return "IRRIGANTE"
	case hasRural:
		return "RURAL"
	}
	return ""
}

func aisureInferRemoteFilename(link, contentType string) string {
	if u, err := url.Parse(strings.TrimSpace(link)); err == nil {
		if base := path.Base(strings.TrimSpace(u.Path)); base != "" && base != "." && base != "/" {
			return base
		}
	}
	ct := strings.ToLower(strings.TrimSpace(contentType))
	switch {
	case strings.Contains(ct, "pdf"):
		return "fatura.pdf"
	case strings.Contains(ct, "png"):
		return "fatura.png"
	case strings.Contains(ct, "webp"):
		return "fatura.webp"
	default:
		return "fatura.jpg"
	}
}
func aisureDownloadRemoteFatura(ctx context.Context, link string) ([]byte, string, string, error) {
	link = strings.TrimSpace(link)
	if link == "" {
		return nil, "", "", nil
	}
	if !strings.HasPrefix(strings.ToLower(link), "http://") && !strings.HasPrefix(strings.ToLower(link), "https://") {
		return nil, "", "", fmt.Errorf("link da fatura inválido")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("Accept", "application/pdf,image/*,*/*")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", "", fmt.Errorf("download da fatura falhou: status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", "", err
	}
	if len(data) == 0 {
		return nil, "", "", fmt.Errorf("arquivo da fatura vazio")
	}
	if int64(len(data)) > maxAnexoBytes {
		return nil, "", "", fmt.Errorf("arquivo da fatura excede o limite de %d bytes", maxAnexoBytes)
	}

	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	filename := aisureInferRemoteFilename(link, contentType)

	// Diagnóstico: loga o que foi baixado para ajudar a detectar HTML em vez de PDF
	isPDFContent := strings.Contains(strings.ToLower(contentType), "pdf") || (len(data) >= 4 && string(data[:4]) == "%PDF")
	log.Printf("[aisure/fetch] url=%s status=%d content-type=%q size=%d isPDF=%v filename=%q",
		link, resp.StatusCode, contentType, len(data), isPDFContent, filename)
	if !isPDFContent && len(data) > 0 {
		snippet := string(data[:min(200, len(data))])
		log.Printf("[aisure/fetch] AVISO: conteúdo não parece PDF. Início do arquivo: %q", snippet)
	}

	return data, contentType, filename, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func aisureCurrentProcessStep(tx *gorm.DB, processoID int64) (string, string) {
	var etapa sql.NullString
	var sub sql.NullString
	_ = queryRowGorm(tx, `
		SELECT
			COALESCE(e.nome, ''),
			COALESCE((SELECT nome FROM DM_STATUS_PROCESSO WHERE id_status = p.id_status_atual), '')
		FROM FT_PROCESSOS p
		LEFT JOIN DM_ETAPAS e ON e.id_etapa = p.id_etapa_atual
		WHERE p.id_processo = ?
		ORDER BY p.ultima_atualizacao DESC, p.id_processo DESC
		LIMIT 1`,
		processoID,
	).Scan(&etapa, &sub)
	return strings.TrimSpace(etapa.String), strings.TrimSpace(sub.String)
}

func aisureRegisterRawFaturaHistory(tx *gorm.DB, processoID int64, userName, sourceURL, filename, comment string) {
	parts := []string{
		fmt.Sprintf("Fatura anexada automaticamente via link: %s", filename),
	}
	if strings.TrimSpace(sourceURL) != "" {
		parts = append(parts, "Origem: "+strings.TrimSpace(sourceURL))
	}
	if strings.TrimSpace(comment) != "" {
		parts = append(parts, strings.TrimSpace(comment))
	}
	comentario := strings.Join(parts, "\n")

	// P1-1: histórico no schema V2 (anexo de fatura não muda etapa/status → novo = atual).
	_ = registrarHistoricoV2(tx, int(processoID), 0, "fatura", comentario, nil, nil)
	// Sincroniza FT_PROCESSOS com a ultima movimentacao do historico (best-effort).
	_ = SincronizarStatusProcesso(tx, int(processoID))
}

func aisureAttachRawFaturaToProcessTx(tx *gorm.DB, processoID int64, sourceURL, filename, mimeType, userName, comment string, data []byte) (int64, error) {
	if processoID <= 0 {
		return 0, fmt.Errorf("processo inválido")
	}
	if len(data) == 0 {
		return 0, fmt.Errorf("arquivo da fatura vazio")
	}
	if int64(len(data)) > maxAnexoBytes {
		return 0, fmt.Errorf("arquivo da fatura excede o limite de %d bytes", maxAnexoBytes)
	}

	var exists int
	if err := queryRowGorm(tx, `SELECT COUNT(1) FROM FT_REQUISICOES WHERE id_requisicao = ?`, processoID).Scan(&exists); err != nil {
		return 0, err
	}
	if exists == 0 {
		return 0, sql.ErrNoRows
	}

	name := filepath.Base(strings.TrimSpace(filename))
	if name == "" {
		name = aisureInferRemoteFilename(sourceURL, mimeType)
	}
	if name == "" {
		name = "fatura.pdf"
	}
	if strings.TrimSpace(mimeType) == "" {
		mimeType = http.DetectContentType(data)
	}
	if strings.TrimSpace(userName) == "" {
		userName = "aisure"
	}

	// Evita anexos idênticos em cliques repetidos.
	var existingID sql.NullInt64
	err := queryRowGorm(tx, `
		SELECT id_anexo
		FROM FT_ANEXOS
		WHERE id_processo = ?
		  AND nome_arquivo = ?
		  AND tamanho_bytes = ?
		ORDER BY id_anexo DESC
		LIMIT 1`,
		processoID, name, len(data),
	).Scan(&existingID)
	if err == nil && existingID.Valid && existingID.Int64 > 0 {
		return existingID.Int64, nil
	}
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}

	pseudoPath := buildAnexoPath(int(processoID), 0, name)
	fullPath := filepath.Join("uploads", pseudoPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), os.ModePerm); err == nil {
		_ = os.WriteFile(fullPath, data, 0644)
	}

	res, err := execGorm(tx, `
		INSERT INTO FT_ANEXOS
		  (id_processo, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		processoID, name, pseudoPath, userName, time.Now(), mimeType, len(data), data,
	)
	if err != nil {
		return 0, err
	}

	anexoID, _ := res.LastInsertId()
	aisureRegisterRawFaturaHistory(tx, processoID, userName, sourceURL, name, comment)
	return anexoID, nil
}

func aisureCandidateOCRURLs() []string {
	raw := strings.TrimSpace(ocrBackendURL())
	if raw == "" {
		return nil
	}

	urls := []string{strings.TrimRight(raw, "/")}
	if u, err := url.Parse(raw); err == nil && strings.EqualFold(u.Hostname(), "ocr") {
		local := *u
		local.Host = strings.Replace(u.Host, u.Hostname(), "localhost", 1)
		alt := strings.TrimRight(local.String(), "/")
		if alt != urls[0] {
			urls = append(urls, alt)
		}
	}
	return urls
}

func aisureExtractTextFromRemoteFatura(ctx context.Context, link string) (*aisureOCRExtract, error) {
	link = strings.TrimSpace(link)
	if link == "" {
		return nil, nil
	}
	if !strings.HasPrefix(strings.ToLower(link), "http://") && !strings.HasPrefix(strings.ToLower(link), "https://") {
		return nil, fmt.Errorf("link da fatura invÃ¡lido")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/pdf,image/*,*/*")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download da fatura falhou: status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("arquivo da fatura vazio")
	}

	ocrURLs := aisureCandidateOCRURLs()
	if len(ocrURLs) == 0 {
		return nil, fmt.Errorf("OCR_BACKEND_URL nÃ£o configurado")
	}

	filename := aisureInferRemoteFilename(link, resp.Header.Get("Content-Type"))

	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	w, err := mw.CreateFormFile("files", filename)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	_ = mw.Close()

	var lastErr error
	for _, ocrURL := range ocrURLs {
		ocrReq, err := http.NewRequestWithContext(ctx, http.MethodPost, ocrURL+"/ocr/analyze", bytes.NewReader(b.Bytes()))
		if err != nil {
			lastErr = err
			continue
		}
		ocrReq.Header.Set("Content-Type", mw.FormDataContentType())
		ocrReq.Header.Set("Accept", "application/json")

		ocrResp, err := client.Do(ocrReq)
		if err != nil {
			lastErr = err
			continue
		}

		raw, readErr := io.ReadAll(ocrResp.Body)
		_ = ocrResp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if ocrResp.StatusCode >= 400 {
			lastErr = fmt.Errorf("ocr backend error: %s", string(raw))
			continue
		}

		var parsed struct {
			Results []aisureOCRExtract `json:"results"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			lastErr = err
			continue
		}
		if len(parsed.Results) == 0 {
			lastErr = fmt.Errorf("OCR sem resultados")
			continue
		}

		result := parsed.Results[0]
		result.RawText = strings.TrimSpace(result.RawText)
		return &result, nil
	}

	return nil, lastErr
}

// AisureFetchFaturaHandler godoc
// GET /api/v1/faturas/aisure/fetch?url=...
func AisureFetchFaturaHandler(c *gin.Context) {
	link := strings.TrimSpace(c.Query("url"))
	if link == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url da fatura não informada"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
	defer cancel()

	data, contentType, filename, err := aisureDownloadRemoteFatura(ctx, link)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "falha ao baixar fatura: " + err.Error()})
		return
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("inline; filename=%q", filename))
	c.Header("Cache-Control", "no-store")
	c.Data(http.StatusOK, contentType, data)
}

// AisureAttachFaturaToProcessHandler godoc
// POST /api/v1/faturas/aisure/anexar-ao-processo
func AisureAttachFaturaToProcessHandler(c *gin.Context) {
	var in aisureAttachFaturaReq
	if err := c.ShouldBindJSON(&in); err != nil || in.ProcessoID <= 0 || strings.TrimSpace(in.URL) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
	defer cancel()

	data, contentType, filename, err := aisureDownloadRemoteFatura(ctx, in.URL)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "falha ao baixar fatura: " + err.Error()})
		return
	}

	userName := "aisure"
	if v, ok := c.Get("userName"); ok {
		if s, ok2 := v.(string); ok2 && strings.TrimSpace(s) != "" {
			userName = strings.TrimSpace(s)
		}
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	anexoID, err := aisureAttachRawFaturaToProcessTx(tx, in.ProcessoID, in.URL, filename, contentType, userName, in.Comentario, data)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "processo não encontrado"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao anexar fatura: " + err.Error()})
		return
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao finalizar transação"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":         true,
		"anexo_id":   anexoID,
		"filename":   filepath.Base(strings.TrimSpace(filename)),
		"mime_type":  contentType,
		"downloaded": len(data),
		"url":        strings.TrimSpace(in.URL),
	})
}

// AisureConfirmarHandler godoc
// POST /api/v1/faturas/aisure/confirmar
func AisureConfirmarHandler(c *gin.Context) {
	var in aisureConfirmarReq
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.UC) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload invÃ¡lido"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 240*time.Second)
	defer cancel()

	// Detecta se a concessionária é Energisa para ajustar prioridade do histórico
	concessionaria := strings.TrimSpace(in.RowData["Concessionaria"])
	if concessionaria == "" {
		concessionaria = strings.TrimSpace(in.RowData["concessionaria"])
	}
	isEnergisa := strings.Contains(strings.ToUpper(concessionaria), "ENERGISA")
	log.Printf("[aisure/confirmar] UC=%s concessionaria=%q isEnergisa=%v GormDB_Faturas=%v",
		in.UC, concessionaria, isEnergisa, database.GormDB_Faturas != nil)

	// Busca histórico completo da UC — inclui leituras para verificação de F05
	// Determina o mês de referência da fatura para filtrar apenas os meses anteriores
	mesRefStr := strings.TrimSpace(aisureFirstNonEmpty(in.RowData, "Mes_Ref", "mes_ref", "Mês de Referência"))
	// Tenta converter MM/AAAA → data para filtro SQL; fallback: sem filtro de data
	// Converte mesRefStr para "AAAA-MM" — aceita vários formatos
	var mesRefDate string
	switch {
	case len(mesRefStr) == 7 && mesRefStr[2] == '/':
		// "09/2025" → "2025-09"
		mesRefDate = mesRefStr[3:7] + "-" + mesRefStr[0:2]
	case len(mesRefStr) >= 7 && mesRefStr[4] == '-':
		// "2025-09-01..." → "2025-09"
		mesRefDate = mesRefStr[:7]
	case len(mesRefStr) == 5 && mesRefStr[2] == '/':
		// "09/25" → "2025-09"
		mesRefDate = "20" + mesRefStr[3:5] + "-" + mesRefStr[0:2]
	}

	type historicoRow struct {
		Mes              string
		KWH_Ponta        float64
		KWH_FPonta       float64
		KWH_Reservado    float64
		KWH_Total        float64
		RS_Total         float64
		TarifaPonta      float64
		TarifaFPonta     float64
		TarifaReservado  float64
	}
	var historicoRows []historicoRow

	var ucCtx strings.Builder
	if db := database.GormDB_Faturas; db != nil {
		if sqlDB, err := db.DB(); err == nil {
			// Busca todos os meses da UC (até 36 meses) e filtra em Go
			rows, err := sqlDB.QueryContext(ctx,
				`SELECT Mes_Ref,
				        COALESCE(KWH_Ponta, 0),
				        COALESCE(KWH_FPonta, 0),
				        COALESCE(KWH_Reservado, 0),
				        COALESCE(KWH_Total, 0),
				        COALESCE(RS_Total_Fatura, 0),
				        COALESCE(Tarifa_Cheia_KWH_Ponta_SImpostos, 0),
				        COALESCE(Tarifa_Cheia_KWH_FPonta_SImpostos, 0),
				        COALESCE(Tarifa_Cheia_KWH_Reservado_SImpostos, 0)
				 FROM Faturas_Registradas_Cache
				 WHERE UC = ? ORDER BY Mes_Ref DESC LIMIT 36`, in.UC)
			log.Printf("[aisure/confirmar] histórico banco UC=%s mesRef=%q mesRefDate=%q", in.UC, mesRefStr, mesRefDate)
			if err == nil {
				defer rows.Close()
				var allRows []historicoRow
				for rows.Next() {
					var mes string
					var kwp, kwfp, kwr, kwt, rs, tp, tfp, tr float64
					if rows.Scan(&mes, &kwp, &kwfp, &kwr, &kwt, &rs, &tp, &tfp, &tr) == nil {
						allRows = append(allRows, historicoRow{mes, kwp, kwfp, kwr, kwt, rs, tp, tfp, tr})
					}
				}
				// Filtra em Go: meses anteriores → histórico (até 12); meses posteriores → PASSO E (até 3)
				// Mes_Ref do banco: "2025-08-01T00:00:00-03:00" → prefixo "2025-08"
				// mesRefDate: "2025-09" → mesPrefix = "2025-09"
				mesPrefix := mesRefDate // já é "AAAA-MM" (ex: "2025-09")
				// Coleta todos os meses posteriores ao analisado (sem limite)
				// e depois pega os 3 IMEDIATAMENTE seguintes (menores prefixos > mesPrefix)
				var todosPosteriores []historicoRow
				for _, r := range allRows {
					rowPrefix := r.Mes
					if len(rowPrefix) >= 7 {
						rowPrefix = rowPrefix[:7]
					}
					if mesPrefix != "" && rowPrefix > mesPrefix {
						todosPosteriores = append(todosPosteriores, r)
					}
				}
				// allRows está em DESC — reverter posteriores para ASC e pegar os 3 primeiros
				for i, j := 0, len(todosPosteriores)-1; i < j; i, j = i+1, j-1 {
					todosPosteriores[i], todosPosteriores[j] = todosPosteriores[j], todosPosteriores[i]
				}
				var posterioresRows []historicoRow
				if len(todosPosteriores) > 3 {
					posterioresRows = todosPosteriores[:3]
				} else {
					posterioresRows = todosPosteriores
				}

				for _, r := range allRows {
					rowPrefix := r.Mes
					if len(rowPrefix) >= 7 {
						rowPrefix = rowPrefix[:7]
					}
					if mesPrefix == "" || rowPrefix < mesPrefix {
						historicoRows = append(historicoRows, r)
						if len(historicoRows) >= 12 {
							break
						}
					}
				}
				log.Printf("[aisure/confirmar] histórico banco UC=%s total=%d filtrados=%d mesPrefix=%q", in.UC, len(allRows), len(historicoRows), mesPrefix)
				nLinhas := len(historicoRows)
				log.Printf("[aisure/confirmar] histórico banco UC=%s linhas=%d", in.UC, nLinhas)

				if isEnergisa {
					ucCtx.WriteString("=== HISTÓRICO_BANCO_ENERGISA — UC " + in.UC + " ===\n")
					ucCtx.WriteString("⚠️ FONTE PRIMÁRIA OBRIGATÓRIA para F02/F03. IGNORE completamente a tabela de 13 meses da fatura.\n")
					ucCtx.WriteString("NÃO use a tabela visual da fatura para histórico — use EXCLUSIVAMENTE o JSON abaixo.\n")
					ucCtx.WriteString("kwh_ponta = posto Ponta | kwh_fp = posto Fora Ponta | kwh_reservado = posto Reservado\n\n")
				} else {
					ucCtx.WriteString("=== HISTÓRICO_BANCO — UC " + in.UC + " ===\n")
					fmt.Fprintf(&ucCtx, "Meses disponíveis no banco: %d (anteriores ao mês analisado)\n", len(historicoRows))
					ucCtx.WriteString("REGRA: Se a fatura não trouxer 12 meses completos de histórico, " +
						"complemente com os meses do banco abaixo até totalizar 12 meses.\n")
					ucCtx.WriteString("PREÇO/kWh: use os campos tarifa_ponta / tarifa_fp / tarifa_reservado deste JSON " +
						"(colunas Tarifa_Cheia_KWH_*_SImpostos do banco). NÃO derive pela fatura se o banco tiver o valor.\n\n")
				}
				ucCtx.WriteString("historico_banco_json=[\n")
				for _, r := range historicoRows {
					fmt.Fprintf(&ucCtx, "  {\"mes\":\"%s\",\"kwh_ponta\":%.2f,\"kwh_fp\":%.2f,\"kwh_reservado\":%.2f,\"kwh_total\":%.2f,\"rs_total\":%.2f,\"tarifa_ponta\":%.6f,\"tarifa_fp\":%.6f,\"tarifa_reservado\":%.6f},\n",
						r.Mes, r.KWH_Ponta, r.KWH_FPonta, r.KWH_Reservado, r.KWH_Total, r.RS_Total,
						r.TarifaPonta, r.TarifaFPonta, r.TarifaReservado)
				}
				ucCtx.WriteString("]\n")

				// Injeta meses posteriores para o PASSO E (análise de retorno ao padrão)
				if len(posterioresRows) > 0 {
					ucCtx.WriteString("\n=== MESES_POSTERIORES — UC " + in.UC + " ===\n")
					ucCtx.WriteString("Meses POSTERIORES ao mês analisado — usar EXCLUSIVAMENTE no PASSO E (retorno ao padrão).\n")
					ucCtx.WriteString("NÃO usar estes meses na média histórica do F02.\n")
					fmt.Fprintf(&ucCtx, "Quantidade de meses posteriores disponíveis: %d\n", len(posterioresRows))
					ucCtx.WriteString("meses_posteriores_json=[\n")
					for _, r := range posterioresRows {
						fmt.Fprintf(&ucCtx, "  {\"mes\":\"%s\",\"kwh_ponta\":%.2f,\"kwh_fp\":%.2f,\"kwh_reservado\":%.2f,\"kwh_total\":%.2f},\n",
							r.Mes, r.KWH_Ponta, r.KWH_FPonta, r.KWH_Reservado, r.KWH_Total)
					}
					ucCtx.WriteString("]\n")
				} else {
					ucCtx.WriteString("\n=== MESES_POSTERIORES — UC " + in.UC + " ===\n")
					ucCtx.WriteString("Nenhum mês posterior ao mês analisado disponível no banco.\n")
					ucCtx.WriteString("retorno_ao_padrao: não disponível\n")
				}

				preview := ucCtx.String()
				if len(preview) > 1000 {
					preview = preview[:1000]
				}
				log.Printf("[aisure/confirmar] histórico banco preview UC=%s:\n%s", in.UC, preview)
			} else {
				log.Printf("[aisure/confirmar] erro query histórico UC=%s: %v", in.UC, err)
			}
		}
	} else {
		log.Printf("[aisure/confirmar] GormDB_Faturas nil — histórico indisponível UC=%s", in.UC)
	}

	// Detecta RURAL/IRRIGANTE para alertar a IA explicitamente
	ruralTag := aisureDetectRuralTag(in.RowData)

	// Monta contexto com dados da linha
	var rowCtx strings.Builder
	rowCtx.WriteString("=== DADOS DO SISTEMA PARA ESTA FATURA ===\n")
	if isEnergisa {
		rowCtx.WriteString("⚠️ CONCESSIONÁRIA ENERGISA: Use OBRIGATORIAMENTE o histórico do banco de dados (seção abaixo) " +
			"como fonte primária para KWH_P (Ponta), KWH_FP (Fora Ponta) e KWH_R (Reservado). " +
			"NÃO tente ler a tabela de histórico da fatura para calcular a média do F02 — " +
			"a imagem de fundo da fatura Energisa impede leitura confiável dos cabeçalhos pelo OCR.\n\n")
	}
	if ruralTag != "" {
		fmt.Fprintf(&rowCtx, "ATENCAO: CLIENTE %s - aplique regras de RURAL/IRRIGANTE e destaque obrigatoriamente no cabecalho da saida.\n\n", ruralTag)
	}
	fmt.Fprintf(&rowCtx, "Fichas detectadas automaticamente: %s\n", in.Fichas)
	fmt.Fprintf(&rowCtx, "Detalhamento automático: %s\n", in.Detalhamento)
	rowCtx.WriteString("=== CAMPOS NORMALIZADOS DO SISTEMA ===\n")
	fmt.Fprintf(&rowCtx, "UC: %s\n", strings.TrimSpace(in.UC))
	fmt.Fprintf(&rowCtx, "Nome do Cliente: %s\n", aisureFirstNonEmpty(in.RowData, "RAZAO_SOCIAL", "Razao_Social", "cliente", "Cliente", "nome_cliente", "Nome do Cliente", "Nome_do_Cliente"))
	fmt.Fprintf(&rowCtx, "Mês de Referência: %s\n", aisureFirstNonEmpty(in.RowData, "Mes_Ref", "mes_ref", "Mês de Referência", "Mes de Referencia"))
	fmt.Fprintf(&rowCtx, "Concessionária: %s\n", aisureFirstNonEmpty(in.RowData, "Concessionaria", "concessionaria"))
	fmt.Fprintf(&rowCtx, "Classe: %s\n", aisureFirstNonEmpty(in.RowData, "Classe", "classe", "Classe_Tarifaria", "classe_tarifaria"))
	fmt.Fprintf(&rowCtx, "Modalidade Tarifária: %s\n", aisureFirstNonEmpty(in.RowData, "Modalidade_Tarifaria", "modalidade_tarifaria", "Modalidade Tarifária", "Modalidade Tarifaria"))
	fmt.Fprintf(&rowCtx, "Grupo de Tensão: %s\n", aisureFirstNonEmpty(in.RowData, "Tp_Tensao", "tp_tensao", "Grupo de Tensão", "Grupo de Tensao"))
	fmt.Fprintf(&rowCtx, "Medidor: %s\n", aisureFirstNonEmpty(in.RowData, "NroMedidor", "nro_medidor", "medidor", "Medidor"))
	fmt.Fprintf(&rowCtx, "Link da Fatura: %s\n", aisureResolveFaturaLink(in))
	// Campos adicionais — identificação e contexto. Valores estatísticos pré-calculados
	// (media, limite_sup, etc.) são do sistema de detecção; recalcular sempre a partir da fatura.
	rowCtx.WriteString("=== DEMAIS CAMPOS DA LINHA ===\n")
	for k, v := range in.RowData {
		fmt.Fprintf(&rowCtx, "%s: %s\n", k, v)
	}

	// Resolve lista de imagens: preferÃªncia para fatura_images, fallback para fatura_base64 (legado)
	var images []faturaImageItem
	if len(in.FaturaImages) > 0 {
		images = in.FaturaImages
	} else if strings.TrimSpace(in.FaturaBase64) != "" {
		mime := in.FaturaMime
		if mime == "" {
			mime = "image/jpeg"
		}
		images = []faturaImageItem{{Base64: in.FaturaBase64, Mime: mime}}
	}

	// Appenda texto nativo ao contexto quando disponível (complementa o PDF)
	if t := strings.TrimSpace(in.FaturaText); t != "" {
		rowCtx.WriteString("\n=== TEXTO NATIVO EXTRAÍDO DO PDF (pdfjs) ===\n")
		rowCtx.WriteString(t)
		rowCtx.WriteString("\n")
	}

	// Injeta área destacada pelo usuário como imagem adicional
	if r := strings.TrimSpace(in.FaturaRegion); r != "" {
		images = append(images, faturaImageItem{Base64: r, Mime: "image/png"})
		rowCtx.WriteString("\n⚠️ ÁREA DESTACADA PELO USUÁRIO: A última imagem enviada é um recorte da fatura " +
			"selecionado manualmente pelo analista para atenção especial. " +
			"Priorize a leitura e interpretação dessa área — ela contém informações críticas para a análise.\n")
	}

	// Fonte 1 — Markitdown pré-processado (estruturado, preferencial para tabelas e composição)
	if faturaID := strings.TrimSpace(in.RowData["id"]); faturaID != "" {
		if gormDB := database.GormDB_App; gormDB != nil {
			if sqlDB, err := gormDB.DB(); err == nil {
				var mdText, paddleText string
				_ = sqlDB.QueryRow(
					"SELECT COALESCE(texto_markitdown, ''), COALESCE(texto_paddle, '') FROM Faturas_Registradas_Cache WHERE id = ? LIMIT 1",
					faturaID,
				).Scan(&mdText, &paddleText)

				// Fonte 1a — Markitdown
				mdText = strings.TrimSpace(mdText)
				if mdText != "" && !strings.HasPrefix(mdText, "[ERRO_") {
					rowCtx.WriteString("\n=== TEXTO MARKITDOWN (estruturado — preferencial para tabelas, composição e DESCRIÇÃO DO FATURAMENTO) ===\n")
					rowCtx.WriteString(mdText)
					rowCtx.WriteString("\n=== FIM DO MARKITDOWN ===\n")
				}

				// Fonte 1b — PaddleOCR (alta precisão para tabelas e números)
				paddleText = strings.TrimSpace(paddleText)
				if paddleText != "" && !strings.HasPrefix(paddleText, "[ERRO_") {
					rowCtx.WriteString("\n=== TEXTO PADDLE OCR (alta precisão — tabelas de composição da fatura, itens e valores) ===\n")
					rowCtx.WriteString(paddleText)
					rowCtx.WriteString("\n=== FIM DO PADDLE OCR ===\n")
				}
			}
		}
	}

	// Fonte 2 — OCR Tesseract (captura campos impressos e seções não-digitais)
	if t := strings.TrimSpace(in.FaturaOCRText); t != "" {
		rowCtx.WriteString("\n=== TEXTO OCR TESSERACT (campos impressos — Descrição da Fatura, histórico impresso) ===\n")
		rowCtx.WriteString(t)
		rowCtx.WriteString("\n=== FIM DO TEXTO OCR ===\n")

		// Grava o OCR no banco para reuso futuro (evita re-extrair a cada análise)
		if faturaID := strings.TrimSpace(in.RowData["id"]); faturaID != "" {
			if gormDB := database.GormDB_App; gormDB != nil {
				if sqlDB, err := gormDB.DB(); err == nil {
					_, _ = sqlDB.Exec(
						"UPDATE Faturas_Registradas_Cache SET texto_ocr = ?, ocr_gerado_em = NOW() WHERE id = ? AND texto_ocr IS NULL",
						t, faturaID,
					)
				}
			}
		}
	}

	ctxStr := rowCtx.String() + "\n" + ucCtx.String()

	// Se nenhum PDF/imagem foi enviado pelo frontend, tenta baixar a fatura do link automaticamente.
	// Isso garante que a análise "sem anexo" use o mesmo PDF que a análise "com anexo manual".
	if strings.TrimSpace(in.FaturaPDFBase64) == "" && len(images) == 0 {
		autoLink := aisureResolveFaturaLink(in)
		if autoLink != "" {
			fetchCtx, fetchCancel := context.WithTimeout(ctx, 60*time.Second)
			autoData, autoCT, autoName, fetchErr := aisureDownloadRemoteFatura(fetchCtx, autoLink)
			fetchCancel()
			if fetchErr == nil && len(autoData) > 0 {
				isAutoPDF := strings.Contains(strings.ToLower(autoCT), "pdf") ||
					(len(autoData) >= 4 && string(autoData[:4]) == "%PDF")
				if isAutoPDF {
					in.FaturaPDFBase64 = base64.StdEncoding.EncodeToString(autoData)
					if in.FaturaPDFName == "" {
						in.FaturaPDFName = autoName
					}
					// Avisa o modelo que o PDF pode ser de período diferente do mês analisado
					mesRef := aisureFirstNonEmpty(in.RowData, "Mes_Ref", "mes_ref", "Mês de Referência")
					rowCtx.WriteString(fmt.Sprintf("\n⚠️ AVISO: O PDF foi obtido automaticamente do link da linha. "+
						"O mês de referência desta análise é %s. "+
						"Se o PDF for de período diferente, use os dados de identificação do sistema (UC, mês, cliente) "+
						"para orientar a análise — a fatura pode ser a mais recente disponível para esta UC.\n", mesRef))
					log.Printf("[aisure/confirmar] auto-fetched PDF from link: %s (%d bytes)", autoLink, len(autoData))
				} else {
					log.Printf("[aisure/confirmar] auto-fetch retornou conteúdo não-PDF para UC=%s, link=%s", in.UC, autoLink)
				}
			} else if fetchErr != nil {
				log.Printf("[aisure/confirmar] auto-fetch falhou para UC=%s: %v", in.UC, fetchErr)
			}
		}
	}

	// Monta pergunta — formato de saída definido exclusivamente pelo prompt_confirmar.txt (system prompt).
	hasPDF := strings.TrimSpace(in.FaturaPDFBase64) != ""
	var question string
	nativeText := strings.TrimSpace(in.FaturaText)
	energisaBancoHint := ""
	if isEnergisa {
		energisaBancoHint = "⚠️ ENERGISA: use a seção '=== PRÉ-CÁLCULO F02 ENERGISA ===' do contexto. " +
			"O sistema já calculou a média histórica por posto (média_historica_kwh). " +
			"Use esses valores diretamente no PASSO C — NÃO leia a tabela da fatura nem recalcule. "
	}
	switch {
	case hasPDF && nativeText != "":
		// PDF + texto nativo: modelo lê o arquivo E tem o texto como redundância
		question = fmt.Sprintf("Fatura UC %s — analise o PDF anexado e o texto extraído abaixo.\n\n"+
			"=== TEXTO EXTRAÍDO DA FATURA ===\n%s\n=== FIM DO TEXTO ===\n\n"+
			"%s"+
			"Use o PDF e o texto acima como fonte primária para TODOS os campos (medição, consumo, preço, mensagens). "+
			"Recalcule a média manualmente — nunca use médias pré-calculadas do contexto. "+
			"Aplique F01-F05 conforme o system prompt e responda EXATAMENTE no formato definido.", in.UC, nativeText, energisaBancoHint)
	case hasPDF:
		// PDF sem texto nativo extraído (provavelmente escaneado)
		question = fmt.Sprintf("Fatura UC %s: leia o PDF anexado na íntegra e aplique F01-F05. "+
			"%s"+
			"Recalcule a média manualmente. "+
			"Responda EXATAMENTE no formato do system prompt.", in.UC, energisaBancoHint)
	case len(images) > 0:
		question = fmt.Sprintf("Fatura UC %s: leia as imagens e aplique F01-F05. "+
			"%s"+
			"Recalcule a média manualmente. "+
			"Responda EXATAMENTE no formato do system prompt.", in.UC, energisaBancoHint)
	case nativeText != "":
		question = fmt.Sprintf("Fatura UC %s — texto extraído da fatura:\n\n%s\n\n%sAplique F01-F05 conforme o system prompt.", in.UC, nativeText, energisaBancoHint)
	default:
		question = fmt.Sprintf("Fatura UC %s: %sAplique F01-F05 com o histórico do banco no contexto. Recalcule a média manualmente.", in.UC, energisaBancoHint)
	}

	// ── ETAPA E: Extração estruturada dos dados da fatura ──────────────────
	// Envia o PDF/imagem para um modelo extrator que devolve JSON puro.
	// O JSON é injetado no contexto da análise principal para eliminar
	// ambiguidade na leitura de valores (preço/kWh, consumos por posto, histórico).
	var dadosExtraidos string
	extrairPrompt := loadExtrairPrompt()
	if extrairPrompt != "" && (hasPDF || len(images) > 0) {
		extractCtx, extractCancel := context.WithTimeout(ctx, 75*time.Second)
		ocrHint := ""
		if t := strings.TrimSpace(in.FaturaOCRText); t != "" {
			ocrHint = fmt.Sprintf("\n\nTexto OCR Tesseract disponível como referência adicional (especialmente para seções 'Descrição da Fatura', histórico e campos impressos):\n%s", t)
		}
		extractQ := fmt.Sprintf(
			"Extraia todos os dados numéricos desta fatura de energia elétrica. UC: %s. "+
				"Busque dados em TODAS as seções: Detalhes de Leitura, Composição da Fatura, Descrição da Fatura, Histórico de Consumo e qualquer tabela de valores. "+
				"Retorne SOMENTE o JSON conforme especificado, sem texto adicional.%s", in.UC, ocrHint)
		var extractErr error
		switch {
		case hasPDF:
			dadosExtraidos, extractErr = callAisureOpenAIPDF(extractCtx, extractQ, "", in.FaturaPDFBase64, in.FaturaPDFName, extrairPrompt)
		default:
			dadosExtraidos, extractErr = callAisureOpenAIVision(extractCtx, extractQ, "", images, extrairPrompt)
		}
		extractCancel()
		if extractErr != nil {
			log.Printf("[aisure/confirmar] etapa E (extração) falhou — seguindo sem JSON extraído: %v", extractErr)
			dadosExtraidos = ""
		} else {
			// Remove possíveis delimitadores markdown que alguns modelos adicionam
			dadosExtraidos = strings.TrimPrefix(strings.TrimSpace(dadosExtraidos), "```json")
			dadosExtraidos = strings.TrimPrefix(dadosExtraidos, "```")
			dadosExtraidos = strings.TrimSuffix(dadosExtraidos, "```")
			dadosExtraidos = strings.TrimSpace(dadosExtraidos)
			log.Printf("[aisure/confirmar] etapa E OK — %d bytes extraídos", len(dadosExtraidos))
		}
	}

	// ── ETAPA C: Conferência dos dados extraídos ────────────────────────────
	// Re-lê o PDF com foco exclusivo nos valores numéricos do JSON extraído,
	// corrige divergências e devolve um JSON validado com preço/kWh verificado.
	// Só executa se tiver PDF e JSON extraído (sem ambos não há base para conferir).
	dadosVerificados := dadosExtraidos
	conferirPrompt := loadConferirPrompt()
	if conferirPrompt != "" && dadosExtraidos != "" && (hasPDF || len(images) > 0) {
		conferirCtx, conferirCancel := context.WithTimeout(ctx, 75*time.Second)
		conferirQ := fmt.Sprintf(
			"Confira os dados extraídos abaixo contra o PDF desta fatura. UC: %s.\n\n"+
				"=== JSON EXTRAÍDO PARA CONFERÊNCIA ===\n%s\n=== FIM DO JSON ===\n\n"+
				"Retorne SOMENTE o JSON corrigido com o campo 'conferencia' adicionado.",
			in.UC, dadosExtraidos)
		var conferirErr error
		switch {
		case hasPDF:
			dadosVerificados, conferirErr = callAisureOpenAIPDF(conferirCtx, conferirQ, "", in.FaturaPDFBase64, in.FaturaPDFName, conferirPrompt)
		default:
			dadosVerificados, conferirErr = callAisureOpenAIVision(conferirCtx, conferirQ, "", images, conferirPrompt)
		}
		conferirCancel()
		if conferirErr != nil {
			log.Printf("[aisure/confirmar] etapa C (conferência) falhou — usando extração original: %v", conferirErr)
			dadosVerificados = dadosExtraidos
		} else {
			dadosVerificados = strings.TrimPrefix(strings.TrimSpace(dadosVerificados), "```json")
			dadosVerificados = strings.TrimPrefix(dadosVerificados, "```")
			dadosVerificados = strings.TrimSuffix(dadosVerificados, "```")
			dadosVerificados = strings.TrimSpace(dadosVerificados)
			log.Printf("[aisure/confirmar] etapa C OK — JSON conferido: %d bytes", len(dadosVerificados))
		}
	}

	// Para Energisa: injeta o histórico do banco diretamente no campo historico_consumo do JSON verificado.
	// Isso garante que a IA leia o histórico da fonte correta (banco), não da tabela visual da fatura.
	if isEnergisa && len(historicoRows) > 0 && dadosVerificados != "" {
		// Calcula médias por posto diretamente no backend — a IA recebe o resultado pronto
		var sumP, sumFP, sumR float64
		var countP, countFP, countR int
		var detalheLinhas strings.Builder
		for _, r := range historicoRows {
			mes := r.Mes
			if len(mes) >= 7 {
				mes = r.Mes[5:7] + "/" + r.Mes[2:4]
			}
			// Exclui zeros da média — meses com 0 kWh não representam consumo real
			if r.KWH_Ponta > 0 {
				sumP += r.KWH_Ponta
				countP++
			}
			if r.KWH_FPonta > 0 {
				sumFP += r.KWH_FPonta
				countFP++
			}
			if r.KWH_Reservado > 0 {
				sumR += r.KWH_Reservado
				countR++
			}
			fmt.Fprintf(&detalheLinhas, "  %s: ponta=%.2f | fp=%.2f | reservado=%.2f\n", mes, r.KWH_Ponta, r.KWH_FPonta, r.KWH_Reservado)
		}
		mediaP := 0.0
		if countP > 0 {
			mediaP = sumP / float64(countP)
		}
		mediaFP := 0.0
		if countFP > 0 {
			mediaFP = sumFP / float64(countFP)
		}
		mediaR := 0.0
		if countR > 0 {
			mediaR = sumR / float64(countR)
		}
		// Pega tarifas do mês mais recente com tarifa > 0
		tarifaP, tarifaFP, tarifaR := 0.0, 0.0, 0.0
		for _, r := range historicoRows {
			if tarifaP == 0 && r.TarifaPonta > 0 {
				tarifaP = r.TarifaPonta
			}
			if tarifaFP == 0 && r.TarifaFPonta > 0 {
				tarifaFP = r.TarifaFPonta
			}
			if tarifaR == 0 && r.TarifaReservado > 0 {
				tarifaR = r.TarifaReservado
			}
			if tarifaP > 0 && tarifaFP > 0 && tarifaR > 0 {
				break
			}
		}

		log.Printf("[aisure/confirmar] pré-cálculo F02 Energisa UC=%s meses=%d mediaP=%.2f mediaFP=%.2f mediaR=%.2f tarifaP=%.6f tarifaFP=%.6f tarifaR=%.6f",
			in.UC, len(historicoRows), mediaP, mediaFP, mediaR, tarifaP, tarifaFP, tarifaR)

		tarifaPStr := fmt.Sprintf("%.6f", tarifaP)
		if tarifaP == 0 {
			tarifaPStr = "não encontrado no banco"
		}
		tarifaFPStr := fmt.Sprintf("%.6f", tarifaFP)
		if tarifaFP == 0 {
			tarifaFPStr = "não encontrado no banco"
		}
		tarifaRStr := fmt.Sprintf("%.6f", tarifaR)
		if tarifaR == 0 {
			tarifaRStr = "não encontrado no banco"
		}

		ctxStr += fmt.Sprintf(
			"\n=== PRÉ-CÁLCULO F02 ENERGISA — FONTE: BANCO DE DADOS ===\n"+
				"UC: %s | Meses históricos usados: %d (meses anteriores ao mês analisado)\n"+
				"⚠️ Use OBRIGATORIAMENTE estes valores. NÃO recalcule pela tabela da fatura.\n\n"+
				"[Posto Ponta]\n"+
				"  média_historica_kwh = %.2f  (soma=%.2f / %d meses com consumo > 0)\n"+
				"  preco_kwh = %s  (Tarifa_Cheia_KWH_Ponta_SImpostos do banco)\n"+
				"[Posto Fora Ponta]\n"+
				"  média_historica_kwh = %.2f  (soma=%.2f / %d meses com consumo > 0)\n"+
				"  preco_kwh = %s  (Tarifa_Cheia_KWH_FPonta_SImpostos do banco)\n"+
				"[Posto Reservado]\n"+
				"  média_historica_kwh = %.2f  (soma=%.2f / %d meses com consumo > 0)\n"+
				"  preco_kwh = %s  (Tarifa_Cheia_KWH_Reservado_SImpostos do banco)\n\n"+
				"Detalhe mensal:\n%s"+
				"=== FIM PRÉ-CÁLCULO F02 ===\n",
			in.UC, len(historicoRows),
			mediaP, sumP, countP, tarifaPStr,
			mediaFP, sumFP, countFP, tarifaFPStr,
			mediaR, sumR, countR, tarifaRStr,
			detalheLinhas.String())
	}

	// Injeta JSON verificado no contexto — a análise principal deve usar
	// EXCLUSIVAMENTE estes valores para cálculos, sem tentar ler do PDF.
	if dadosVerificados != "" {
		energisaHistoricoHint := ""
		if isEnergisa {
			energisaHistoricoHint = "⚠️ EXCEÇÃO ENERGISA — HISTÓRICO: use a seção '=== PRÉ-CÁLCULO F02 ENERGISA ===' " +
				"para as médias históricas por posto. Não recalcule pela tabela da fatura nem pelo historico_consumo do JSON.\n"
		}
		ctxStr += "\n=== DADOS DA FATURA — JSON VERIFICADO (use EXCLUSIVAMENTE para cálculos) ===\n" +
			dadosVerificados +
			"\n=== FIM DO JSON VERIFICADO ===\n" +
			"⚠️ ATENÇÃO: Para TODO cálculo numérico (consumo_kwh, valor_R$, preço/kWh), " +
			"use SOMENTE os valores do JSON acima. NÃO tente ler números diretamente do PDF.\n" +
			energisaHistoricoHint
	}

	// ── ETAPA 1: Análise principal (prompt_confirmar.txt) ───────────────────
	confirmarPrompt := loadConfirmarPrompt()

	var answer string
	var err error
	switch {
	case hasPDF:
		answer, err = callAisureOpenAIPDF(ctx, question, ctxStr, in.FaturaPDFBase64, in.FaturaPDFName, confirmarPrompt)
	case len(images) > 0:
		answer, err = callAisureOpenAIVision(ctx, question, ctxStr, images, confirmarPrompt)
	default:
		answer, err = callAisureOpenAI(ctx, nil, question, ctxStr, confirmarPrompt)
	}
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao chamar IA: " + err.Error()})
		return
	}

	// ── ETAPA B: Auditoria (prompt_auditar.txt) ─────────────────────────────
	// Recebe o JSON extraído + análise e verifica/corrige cálculos.
	// Só executa se tiver JSON extraído (sem ele, a auditoria não tem base confiável).
	auditarPrompt := loadAuditarPrompt()
	if auditarPrompt != "" && strings.TrimSpace(answer) != "" && dadosVerificados != "" {
		auditCtx, auditCancel := context.WithTimeout(ctx, 75*time.Second)
		auditQ := fmt.Sprintf(
			"=== DADOS VERIFICADOS DA FATURA (JSON conferido) ===\n%s\n\n"+
				"=== ANÁLISE PRÉVIA PARA AUDITORIA ===\n%s\n\n"+
				"Audite a análise acima usando o JSON verificado como fonte de verdade. "+
				"Retorne a análise no mesmo formato, com a linha de Auditoria ao final do bloco DIAGNÓSTICO.",
			dadosVerificados, answer)
		auditAnswer, auditErr := callAisureOpenAI(auditCtx, nil, auditQ, "", auditarPrompt)
		auditCancel()
		if auditErr != nil {
			log.Printf("[aisure/confirmar] etapa B (auditoria) falhou — usando análise original: %v", auditErr)
		} else if strings.TrimSpace(auditAnswer) != "" {
			log.Printf("[aisure/confirmar] etapa B OK — análise auditada")
			answer = auditAnswer
		}
	}

	confirmado := aisureParseConfirmado(answer)

	c.JSON(http.StatusOK, aisureConfirmarResp{
		Confirmado: confirmado,
		Analise:    answer,
		Model:      aisureOpenAIModel(),
	})
}

/* â"€â"€â"€ Handler HTTP â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

// AisureChatHandler godoc
// POST /api/v1/faturas/aisure/chat
func AisureChatHandler(c *gin.Context) {
	var in aisureChatReq
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload invÃ¡lido"})
		return
	}
	in.Question = strings.TrimSpace(in.Question)
	if in.Question == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question obrigatÃ³rio"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	fichasCtxStr := buildAisureContext(in.Question)

	// Injeta texto dos anexos no contexto
	if len(in.Attachments) > 0 {
		var attachSb strings.Builder
		attachSb.WriteString("\n\n=== REGRAS / DOCUMENTOS ANEXADOS ===\n\n")
		for _, a := range in.Attachments {
			name := strings.TrimSpace(a.Name)
			text := strings.TrimSpace(a.Text)
			if text == "" {
				continue
			}
			if len(text) > 8000 {
				text = text[:8000] + "\n...[truncado]..."
			}
			attachSb.WriteString(fmt.Sprintf("--- %s ---\n%s\n\n", name, text))
		}
		fichasCtxStr += attachSb.String()
	}

	answer, err := callAisureOpenAI(ctx, in.History, in.Question, fichasCtxStr, loadConfirmarPrompt())
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao chamar IA: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, aisureChatResp{
		Answer: answer,
		Model:  aisureOpenAIModel(),
	})
}

/* â"€â"€â"€ GerarEmailHandler â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
   POST /api/v1/faturas/aisure/gerar-email
   Body JSON:
     uc, cliente, concessionaria, periodos (string), tipo_irregularidade,
     subtipo_irregularidade, problema_identificado, descricao_irregularidade,
     ressarcimento_estimado, analise_ia, calc_financeiro
   Retorna: { email: "..." }
â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

type gerarEmailReq struct {
	UC                      string `json:"uc"`
	Cliente                 string `json:"cliente"`
	Concessionaria          string `json:"concessionaria"`
	Periodos                string `json:"periodos"`
	TipoIrregularidade      string `json:"tipo_irregularidade"`
	SubtipoIrregularidade   string `json:"subtipo_irregularidade"`
	ProblemaIdentificado    string `json:"problema_identificado"`
	DescricaoIrregularidade string `json:"descricao_irregularidade"`
	RessarcimentoEstimado   string `json:"ressarcimento_estimado"`
	LinkFatura              string `json:"link_fatura"`
	Endereco                string `json:"endereco"`
	AnaliseIA               string `json:"analise_ia"`
	CalcFinanceiro          string `json:"calc_financeiro"`
}

func GerarEmailHandler(c *gin.Context) {
	var in gerarEmailReq
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.UC) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload invÃ¡lido"})
		return
	}

	emailPrompt := loadEmailPrompt()
	if emailPrompt == "" {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "prompt_email.txt nÃ£o encontrado"})
		return
	}
	templates := loadEmailTemplates()

	// Monta contexto: templates + dados do caso
	var ctxSb strings.Builder
	if templates != "" {
		ctxSb.WriteString("=== MODELOS DE REFERÃŠNCIA ===\n\n")
		ctxSb.WriteString(templates)
		ctxSb.WriteString("\n\n")
	}

	ctxSb.WriteString("=== DADOS DO CASO ===\n\n")
	ctxSb.WriteString("UC: " + in.UC + "\n")
	ctxSb.WriteString("Cliente: " + in.Cliente + "\n")
	ctxSb.WriteString("ConcessionÃ¡ria: " + in.Concessionaria + "\n")
	ctxSb.WriteString("PerÃ­odo(s) da irregularidade: " + in.Periodos + "\n")
	if in.TipoIrregularidade != "" {
		ctxSb.WriteString("Tipo de irregularidade: " + in.TipoIrregularidade + "\n")
	}
	if in.SubtipoIrregularidade != "" {
		ctxSb.WriteString("Subtipo de irregularidade: " + in.SubtipoIrregularidade + "\n")
	}
	if in.ProblemaIdentificado != "" {
		ctxSb.WriteString("Fichas detectadas: " + in.ProblemaIdentificado + "\n")
	}
	if in.RessarcimentoEstimado != "" {
		ctxSb.WriteString("Ressarcimento estimado: R$ " + in.RessarcimentoEstimado + "\n")
	}
	if in.DescricaoIrregularidade != "" {
		ctxSb.WriteString("\nDescriÃ§Ã£o da irregularidade:\n" + in.DescricaoIrregularidade + "\n")
	}
	if in.AnaliseIA != "" {
		ctxSb.WriteString("\nAnÃ¡lise da IA:\n" + in.AnaliseIA + "\n")
	}
	if in.LinkFatura != "" {
		ctxSb.WriteString("Link/nÃºmero da fatura: " + in.LinkFatura + "\n")
	}
	if in.Endereco != "" {
		ctxSb.WriteString("EndereÃ§o da unidade: " + in.Endereco + "\n")
	}
	if in.CalcFinanceiro != "" {
		ctxSb.WriteString("\nCÃ¡lculo financeiro estimado (extraia daqui os meses, valores e desvios para montar a tabela de evidÃªncias):\n" + in.CalcFinanceiro + "\n")
	}

	question := "Com base nos dados do caso e nos modelos de referÃªncia, redija o email completo de reclamaÃ§Ã£o/ressarcimento em HTML, incluindo tabela de evidÃªncias com os desvios por perÃ­odo extraÃ­dos do cÃ¡lculo financeiro."

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	emailText, err := callAisureOpenAI(ctx, nil, question, ctxSb.String(), emailPrompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao gerar email: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"email": emailText})
}

/* ─── GerarDescricaoApontamentoHandler ───────────────────────────────────
   POST /api/v1/faturas/aisure/descricao-apontamento
   Gera a descrição do apontamento (F02) via gpt-4o-mini (modelo FIXADO — não
   segue OPENAI_MODEL global) quando o analista clica em "confirmar erro".
   Recebe os fatos já calculados no front e devolve um texto claro pro processo. */
type gerarDescApontReq struct {
	Ficha         string  `json:"ficha"`
	Cliente       string  `json:"cliente"`
	UC            string  `json:"uc"`
	Instalacao    string  `json:"instalacao"`
	Grupo         string  `json:"grupo"`
	Modalidade    string  `json:"modalidade"`
	Classificacao string  `json:"classificacao"`
	Fichas        string  `json:"fichas"`
	Distribuidora string  `json:"distribuidora"`
	MesRef        string  `json:"mes_ref"`
	Cruzamento    string  `json:"cruzamento"`
	ConsumoKwh    float64 `json:"consumo_kwh"`
	MediaKwh      float64 `json:"media_kwh"`
	BaseMeses     int     `json:"base_meses"`
	ExcedenteKwh  float64 `json:"excedente_kwh"`
	DesvioPct     float64 `json:"desvio_pct"`
	TarifaKwh     float64 `json:"tarifa_kwh"`
	BaseEnergia   float64 `json:"base_energia"`
	Ressarcimento float64 `json:"ressarcimento"`
	Observacao    string  `json:"observacao"`
}

func GerarDescricaoApontamentoHandler(c *gin.Context) {
	var in gerarDescApontReq
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}
	const modelo = "gpt-4o-mini"

	system := "Você é analista de ressarcimento de energia elétrica. Escreva a DESCRIÇÃO de um apontamento de desvio de consumo, em português, para que qualquer analista que assuma o processo entenda o caso SEM contexto prévio. Regras: baseie-se ESTRITAMENTE nos dados fornecidos (não invente nem arredonde valores; use os números como vieram, no padrão brasileiro R$ e kWh); seja objetivo e técnico; organize em blocos curtos — (1) identificação da UC/cliente, (2) o desvio de consumo detectado com os números, (3) como o ressarcimento foi estimado (tarifa de energia × excedente), (4) fontes/validação. Não use saudações, assinatura, nem promessas; no máximo ~12 linhas."

	// formata em pt-BR (milhar '.', decimal ',') p/ o texto do processo ficar apresentável.
	brFmt := func(v float64, dec int) string {
		s := strconv.FormatFloat(v, 'f', dec, 64)
		neg := strings.HasPrefix(s, "-")
		if neg {
			s = s[1:]
		}
		intp, frac := s, ""
		if i := strings.IndexByte(s, '.'); i >= 0 {
			intp, frac = s[:i], s[i+1:]
		}
		var out []byte
		for i := 0; i < len(intp); i++ {
			if i > 0 && (len(intp)-i)%3 == 0 {
				out = append(out, '.')
			}
			out = append(out, intp[i])
		}
		res := string(out)
		if frac != "" {
			res += "," + frac
		}
		if neg {
			res = "-" + res
		}
		return res
	}
	fnf := func(v float64) string { return brFmt(v, 2) }
	var b strings.Builder
	b.WriteString("=== DADOS DO APONTAMENTO (" + first2(in.Ficha, "F02") + ") ===\n")
	if in.Cliente != "" {
		b.WriteString("Cliente: " + in.Cliente + "\n")
	}
	if in.UC != "" {
		b.WriteString("UC: " + in.UC + "\n")
	}
	if in.Instalacao != "" && in.Instalacao != in.UC {
		b.WriteString("Instalação: " + in.Instalacao + "\n")
	}
	if in.Grupo != "" {
		b.WriteString("Grupo/Subgrupo: " + in.Grupo + "\n")
	}
	if in.Modalidade != "" {
		b.WriteString("Modalidade tarifária: " + in.Modalidade + "\n")
	}
	if in.Classificacao != "" {
		b.WriteString("Classificação pelo histórico: " + in.Classificacao + "\n")
	}
	if in.Fichas != "" {
		b.WriteString("Fichas aplicadas: " + in.Fichas + "\n")
	}
	if in.Distribuidora != "" {
		b.WriteString("Distribuidora: " + in.Distribuidora + "\n")
	}
	if in.MesRef != "" {
		b.WriteString("Mês de referência: " + in.MesRef + "\n")
	}
	b.WriteString("Consumo do mês: " + brFmt(in.ConsumoKwh, 0) + " kWh\n")
	b.WriteString("Média histórica (" + strconv.Itoa(in.BaseMeses) + " meses): " + brFmt(in.MediaKwh, 0) + " kWh\n")
	b.WriteString("Excedente sobre a média: " + brFmt(in.ExcedenteKwh, 0) + " kWh\n")
	b.WriteString("Desvio sobre a média: " + brFmt(in.DesvioPct, 1) + "%\n")
	b.WriteString("Tarifa de energia aplicada: R$ " + brFmt(in.TarifaKwh, 4) + "/kWh\n")
	b.WriteString("Base de energia da fatura (R$): R$ " + fnf(in.BaseEnergia) + "\n")
	b.WriteString("Ressarcimento estimado (excedente × tarifa): R$ " + fnf(in.Ressarcimento) + "\n")
	if in.Cruzamento != "" {
		b.WriteString("Cruzamento parser × SEFAZ × itens: " + in.Cruzamento + "\n")
	}
	if strings.TrimSpace(in.Observacao) != "" {
		b.WriteString("OBSERVAÇÃO A DESTACAR (ressalva de confiança — inclua na descrição como alerta ao analista): " + in.Observacao + "\n")
	}

	type oaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	msgs := []oaiMsg{
		{Role: "system", Content: system},
		{Role: "user", Content: b.String()},
	}
	reqBody := map[string]interface{}{
		"model":       modelo,
		"messages":    msgs,
		"max_tokens":  700,
		"temperature": 0.3,
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()
	res, retryErr := doOpenAIWithRetry(ctx, payload)
	if retryErr != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao gerar descrição: " + retryErr.Error()})
		return
	}
	if res.status != http.StatusOK {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": fmt.Sprintf("openai status %d", res.status)})
		return
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(res.body, &out); err != nil || len(out.Choices) == 0 {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sem resposta do modelo"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"descricao": strings.TrimSpace(out.Choices[0].Message.Content), "modelo": modelo})
}

// first2 devolve o primeiro valor não-vazio (helper local).
func first2(v, def string) string {
	if strings.TrimSpace(v) != "" {
		return v
	}
	return def
}

/* â"€â"€â"€ GerarCobrancaEmailHandler â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
   POST /api/v1/processos/:id/gerar-cobranca
   Analisa histÃ³rico + e-mails do processo e gera 2 sugestÃµes de
   e-mail de cobranÃ§a de resposta para a concessionÃ¡ria.
â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */

const cobrancaSystemPrompt = "Voce e especialista em ressarcimento de energia eletrica conforme a REN 1000/2021 da ANEEL.\n" + "Gere EXATAMENTE QUATRO sugestoes de e-mail de cobranca de resposta dirigido a concessionaria distribuidora, em tons diferentes: formal, direto, amigavel e firme.\n" + "Cada sugestao deve:\n" + "- Ser sucinta (max 150 palavras), profissional\n" + "- Citar art. 126 par.1 da REN 1000/2021 (prazo maximo de 30 dias uteis para resposta) na versao formal, quando o prazo estiver vencido\n" + "- Mencionar UC, cliente e a sub-etapa atual\n" + "- Solicitar posicionamento com urgencia, sem ameaca, litigio ou medida judicial\n" + "- Estar em HTML usando apenas <p>, <strong> e <br> - sem DOCTYPE, sem <html>, sem <head>\n\n" + "Retorne SOMENTE o JSON abaixo, sem markdown, sem texto extra:\n" + `{"subject":"...","formal":"<p>...</p>","direto":"<p>...</p>","amigavel":"<p>...</p>","firme":"<p>...</p>"}`

var reMarkdownBlock = regexp.MustCompile(`(?s)^` + "```" + `[a-z]*\n?`)

func GerarCobrancaEmailHandler(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id invÃ¡lido"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	res, err := GerarCobrancaParaProcesso(ctx, id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "processo nÃ£o encontrado"})
			return
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao gerar cobranÃ§a: " + err.Error()})
		return
	}

	// Atualiza o cache (PROCESSO_COBRANCA_CACHE) com o resultado fresco — próxima leitura
	// via GetCobrancaCacheHandler já vem instantânea, sem chamar IA de novo.
	if db := database.GormDB_App; db != nil {
		salvarCacheCobranca(db, id, emailThreadHash(db, id), res, "ready", "")
	}

	c.JSON(http.StatusOK, gin.H{
		"subject":          res.Subject,
		"formal":           res.Formal,
		"direto":           res.Direto,
		"amigavel":         res.Amigavel,
		"firme":            res.Firme,
		"uc":               res.UC,
		"cliente":          res.Cliente,
		"concessionaria":   res.Concessionaria,
		"para":             res.Para,
		"cc":               res.Cc,
		"sem_retorno":      res.SemRetorno,
		"dias_sem_retorno": res.DiasSemRetorno,
	})
}

// CobrancaResultado é o resultado da análise de cobrança/SR de um processo, com os 4
// tons gerados numa única chamada de IA (Formal/Direto/Amigável/Firme).
type CobrancaResultado struct {
	Subject         string
	Formal          string
	Direto          string
	Amigavel        string
	Firme           string
	UC              string
	Cliente         string
	Concessionaria  string
	Para            string // destinatário do último e-mail enviado (vazio se nunca houve)
	Cc              string // demais destinatários (Para+CC) do último e-mail, exceto o próprio Para
	SemRetorno      bool
	TemEmailEnviado bool
	DiasSemRetorno  int
}

// GerarCobrancaParaProcesso monta o contexto do processo (dados + histórico + e-mails),
// decide a situação de contato (SR/pendência) e chama a IA pra sugerir 2 opções de
// e-mail de cobrança. Reaproveitada tanto pelo endpoint HTTP (GerarCobrancaEmailHandler)
// quanto pelo cron de cache (ProcessarCobrancasCache) — só a IA é chamada em qualquer um
// dos dois caminhos, nunca duplicada.
func GerarCobrancaParaProcesso(ctx context.Context, id int) (*CobrancaResultado, error) {
	db := database.GormDB_App
	if db == nil {
		return nil, fmt.Errorf("banco indisponÃ­vel")
	}

	// 1. Dados do processo
	var uc, cliente, conc, subEtapa, etapa, tipoNome, subtipoNome, descricao, ressarcimento, dataMov string
	var idStatusAtual, idInstanciaAtual sql.NullInt64
	scanErr := queryRowGorm(db, `
		SELECT
		  COALESCE(uc,''),
		  COALESCE(cliente,''),
		  COALESCE(concessionaria,''),
		  COALESCE((SELECT nome FROM DM_STATUS_PROCESSO WHERE id_status = id_status_atual),''),
		  COALESCE((SELECT nome FROM DM_ETAPAS WHERE id_etapa = id_etapa_atual),''),
		  COALESCE(nome_tipo_irregularidade,''),
		  COALESCE(nome_subtipo_irregularidade,''),
		  COALESCE(descricao_irregularidade,''),
		  COALESCE(CAST(ressarcimento_estimado AS CHAR),''),
		  DATE_FORMAT(COALESCE(data_movimentacao, ultima_atualizacao, NOW()), '%d/%m/%Y %H:%i'),
		  id_status_atual,
		  id_instancia_atual
		FROM FT_PROCESSOS WHERE id_processo = ? LIMIT 1`, id).
		Scan(&uc, &cliente, &conc, &subEtapa, &etapa, &tipoNome, &subtipoNome, &descricao, &ressarcimento, &dataMov,
			&idStatusAtual, &idInstanciaAtual)
	if scanErr != nil {
		return nil, sql.ErrNoRows
	}

	// 1b. Data-base REAL do prazo vencido — mesma fonte de verdade usada na tela (Prazos.jsx,
	// coluna Prazos do Controle de Processos): quando o processo entrou no status ATUAL,
	// não uma data qualquer do histórico. É isso, e não o histórico de movimentações em
	// texto livre, que define "há quantos dias está sem retorno" — passamos esse fato já
	// calculado pra IA em vez de pedir que ela infira a partir de comentários antigos
	// (causa raiz de um bug real: a IA citou uma movimentação de ~4 meses atrás como se
	// fosse o último contato, quando o prazo correto — calculado pela mesma regra da tela —
	// era de 39 dias).
	var prazoDataBaseStr, prazoInstanciaNome string
	var prazoDiasDecorridos, prazoDiasLimite int
	var prazoUteis bool
	if idStatusAtual.Valid && idInstanciaAtual.Valid {
		var dataBase sql.NullTime
		_ = queryRowGorm(db, `
			SELECT MAX(data_movimentacao) FROM FT_HISTORICO_MOVIMENTACOES
			WHERE id_processo = ? AND id_status_novo = ?`, id, idStatusAtual.Int64,
		).Scan(&dataBase)
		if dataBase.Valid {
			if regra, ok := services.PrazoPorInstancia[int(idInstanciaAtual.Int64)]; ok {
				prazoDiasLimite = regra.Dias
				prazoUteis = regra.Uteis
				if regra.Uteis {
					prazoDiasDecorridos = services.DiasUteisEntre(dataBase.Time, time.Now())
				} else {
					prazoDiasDecorridos = services.DiasCorridosEntre(dataBase.Time, time.Now())
				}
				prazoDataBaseStr = dataBase.Time.Format("02/01/2006")
			}
		}
		_ = queryRowGorm(db, `SELECT COALESCE(nome,'') FROM DM_INSTANCIAS WHERE id_instancia = ?`, idInstanciaAtual.Int64).Scan(&prazoInstanciaNome)
	}

	// 2. HistÃ³rico de movimentaÃ§Ãµes (atÃ© 20 Ãºltimas)
	histRows, err := queryGorm(db, `
		SELECT
		  COALESCE((SELECT nome FROM DM_ETAPAS WHERE id_etapa = h.id_etapa_anterior),''),
		  COALESCE((SELECT nome FROM DM_ETAPAS WHERE id_etapa = h.id_etapa_nova),''),
		  COALESCE((SELECT nome FROM DM_STATUS_PROCESSO WHERE id_status = h.id_status_novo),''),
		  COALESCE(h.comentario,''),
		  DATE_FORMAT(h.data_movimentacao,'%d/%m/%Y %H:%i'),
		  COALESCE(u.nome_usuario,'Sistema')
		FROM FT_HISTORICO_MOVIMENTACOES h
		LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
		WHERE h.id_processo = ?
		ORDER BY h.data_movimentacao DESC LIMIT 20`, id)
	var histLines []string
	if err == nil {
		defer histRows.Close()
		for histRows.Next() {
			var etAnt, etNov, sub, coment, data, usuario string
			if histRows.Scan(&etAnt, &etNov, &sub, &coment, &data, &usuario) == nil {
				line := fmt.Sprintf("[%s] %s â†' %s", data, etAnt, etNov)
				if sub != "" {
					line += " | Sub-etapa: " + sub
				}
				if coment != "" {
					line += " | ComentÃ¡rio: " + coment
				}
				line += " | Por: " + usuario
				histLines = append(histLines, line)
			}
		}
	}

	// 3. E-mails jÃ¡ enviados para o processo (contexto de cobranÃ§as anteriores)
	emailRows, err := queryGorm(db, `
		SELECT COALESCE(assunto,''), DATE_FORMAT(data_envio,'%d/%m/%Y'), COALESCE(para_email,''), tipo
		FROM FT_EMAILS_PROCESSO
		WHERE id_processo = ?
		ORDER BY data_envio DESC LIMIT 8`, id)
	var emailLines []string
	if err == nil {
		defer emailRows.Close()
		for emailRows.Next() {
			var assunto, data, para, tipo string
			if emailRows.Scan(&assunto, &data, &para, &tipo) == nil {
				dir := "Enviado"
				if tipo == "recebido" {
					dir = "Recebido"
				}
				emailLines = append(emailLines, fmt.Sprintf("[%s] %s | Para/De: %s | Assunto: %s", data, dir, para, assunto))
			}
		}
	}

	// 3b. Verifica se cabe cobrança de retorno (SR = "Sem Resposta"). Nem todo processo tem
	// e-mail 'enviado' registrado — alguns começam pelo site da distribuidora, e as tratativas
	// seguintes é que viram e-mail (ou nem isso). Regra: SR vale SEMPRE, exceto quando o último
	// evento de e-mail foi um 'recebido' sem nada nosso depois — aí é pendência (resposta não
	// tratada), não falta de retorno.
	var ultimoEnviado, ultimoRecebido sql.NullTime
	_ = queryRowGorm(db, `
		SELECT MAX(CASE WHEN tipo='enviado' THEN data_envio END),
		       MAX(CASE WHEN tipo='recebido' THEN data_envio END)
		FROM FT_EMAILS_PROCESSO WHERE id_processo = ?`, id,
	).Scan(&ultimoEnviado, &ultimoRecebido)
	pendenciaNaoTratada := ultimoRecebido.Valid && (!ultimoEnviado.Valid || ultimoRecebido.Time.After(ultimoEnviado.Time))
	semRetorno := !pendenciaNaoTratada
	diasSemRetorno := 0
	temEmailEnviado := ultimoEnviado.Valid
	if semRetorno && temEmailEnviado {
		diasSemRetorno = int(time.Since(ultimoEnviado.Time).Hours() / 24)
	}

	// 3c. Destinatário e CC do último e-mail ENVIADO — a cobrança deve ir para o mesmo
	// contato, com os mesmos destinatários em cópia (Para+CC do e-mail anterior, exceto o
	// próprio Para novo). Se nunca houve e-mail enviado, fica vazio — usuário preenche.
	emailPara, emailCc := ultimoEmailEnviadoDestinatarios(db, id)

	// 4. Monta contexto
	var sb strings.Builder
	sb.WriteString("=== DADOS DO PROCESSO ===\n")
	fmt.Fprintf(&sb, "Processo: #%d\n", id)
	sb.WriteString("UC: " + uc + "\n")
	sb.WriteString("Cliente: " + cliente + "\n")
	sb.WriteString("ConcessionÃ¡ria: " + conc + "\n")
	sb.WriteString("Etapa atual: " + etapa + "\n")
	if subEtapa != "" {
		sb.WriteString("Sub-etapa: " + subEtapa + "\n")
	}
	if tipoNome != "" {
		sb.WriteString("Tipo de irregularidade: " + tipoNome + "\n")
	}
	if subtipoNome != "" {
		sb.WriteString("Subtipo: " + subtipoNome + "\n")
	}
	if ressarcimento != "" && ressarcimento != "0" && ressarcimento != "<nil>" {
		sb.WriteString("Ressarcimento estimado: R$ " + ressarcimento + "\n")
	}
	if descricao != "" {
		sb.WriteString("DescriÃ§Ã£o: " + descricao + "\n")
	}
	sb.WriteString("Ãšltima atualizaÃ§Ã£o: " + dataMov + "\n")

	if prazoDataBaseStr != "" {
		unidade := "dias corridos"
		if prazoUteis {
			unidade = "dias Ãºteis"
		}
		fmt.Fprintf(&sb,
			"\n=== PRAZO REGULATÃ“RIO (jÃ¡ calculado â€” Ã© O FATO CORRETO, use exatamente este, NÃƒO calcule ou infira outra data a partir do histÃ³rico abaixo) ===\n"+
				"O processo estÃ¡ na instÃ¢ncia %s desde %s (data de entrada no status/etapa atual).\n"+
				"Prazo regulatÃ³rio desta instÃ¢ncia: %d %s.\n"+
				"Dias decorridos desde essa data: %d.\n"+
				"Esta Ã© a Ãºnica data que deve ser usada como referÃªncia de \"hÃ¡ quanto tempo estÃ¡ sem retorno\" â€” "+
				"o histÃ³rico de movimentaÃ§Ãµes abaixo pode conter datas mais antigas (ex: protocolo original, "+
				"tratativas anteriores a uma reentrada nesta etapa) que NÃƒO devem ser usadas para calcular o prazo vencido.\n",
			prazoInstanciaNome, prazoDataBaseStr, prazoDiasLimite, unidade, prazoDiasDecorridos,
		)
	}

	if len(histLines) > 0 {
		sb.WriteString("\n=== HISTÓRICO DE MOVIMENTAÃ‡Ã•ES ===\n")
		for _, l := range histLines {
			sb.WriteString(l + "\n")
		}
	}

	if len(emailLines) > 0 {
		sb.WriteString("\n=== E-MAILS JÃ ENVIADOS PARA ESTE PROCESSO ===\n")
		for _, l := range emailLines {
			sb.WriteString(l + "\n")
		}
	}

	if semRetorno {
		if temEmailEnviado {
			fmt.Fprintf(&sb, "\n=== SITUACAO DO CONTATO ===\nUltimo contato foi um e-mail ENVIADO, sem resposta ('recebido') desde entao, ha %d dia(s). Reforce esse ponto na cobranca.\n", diasSemRetorno)
		} else {
			sb.WriteString("\n=== SITUACAO DO CONTATO ===\nNao ha e-mail enviado registrado para este processo (o primeiro contato provavelmente foi feito pelo site/portal da distribuidora). O prazo esta vencido e nao ha retorno. Redija como um PRIMEIRO reforco por e-mail sobre o caso, sem se referir a um e-mail anterior que nao existiu.\n")
		}
	}

	// Inclui templates de referÃªncia no contexto (se disponÃ­veis)
	if tmpl := loadCobrancaTemplates(); tmpl != "" {
		sb.WriteString("\n=== MODELOS DE REFERÃŠNCIA (use apenas para calibrar tom/estrutura) ===\n")
		sb.WriteString(tmpl)
		sb.WriteString("\n")
	}

	question := fmt.Sprintf(
		"Processo #%d — UC %s — Cliente: %s — ConcessionÃ¡ria: %s — Sub-etapa: %s. "+
			"O prazo de resposta estÃ¡ vencido. Use o bloco de PRAZO REGULATÃ“RIO jÃ¡ calculado no "+
			"contexto como fonte da data/dias decorridos â€” NÃƒO infira essa informaÃ§Ã£o do histÃ³rico "+
			"de movimentaÃ§Ãµes. Gere as 4 sugestÃµes de e-mail de cobranÃ§a conforme o system prompt.",
		id, uc, cliente, conc, subEtapa,
	)

	// Carrega prompt do arquivo; usa const como fallback
	sysPrompt := loadCobrancaPrompt()
	if sysPrompt == "" {
		sysPrompt = cobrancaSystemPrompt
	}

	// 4 tons x até 150 palavras + HTML + wrapper JSON facilmente passa do teto padrão de
	// 1024 tokens (visto na prática: campos finais do JSON saindo vazios quando cortado
	// no meio da geração) — usa um teto maior só aqui.
	raw, err := callAisureOpenAIMaxTokens(ctx, nil, question, sb.String(), 3000, sysPrompt)
	if err != nil {
		return nil, fmt.Errorf("falha ao gerar cobranca: %w", err)
	}

	// Strip markdown code block if present
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```") {
		raw = reMarkdownBlock.ReplaceAllString(raw, "")
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
		raw = strings.TrimSpace(raw)
	}

	var parsed struct {
		Subject  string `json:"subject"`
		Formal   string `json:"formal"`
		Direto   string `json:"direto"`
		Amigavel string `json:"amigavel"`
		Firme    string `json:"firme"`
	}
	if jsonErr := json.Unmarshal([]byte(raw), &parsed); jsonErr != nil {
		// Fallback: usa o texto cru como versão formal (as outras ficam vazias — o
		// frontend já trata tom sem texto como indisponível, sem quebrar o seletor).
		return &CobrancaResultado{
			Subject:         fmt.Sprintf("Cobranca de Resposta — Processo #%d", id),
			Formal:          raw,
			UC:              uc,
			Cliente:         cliente,
			Concessionaria:  conc,
			Para:            emailPara,
			Cc:              emailCc,
			SemRetorno:      semRetorno,
			TemEmailEnviado: temEmailEnviado,
			DiasSemRetorno:  diasSemRetorno,
		}, nil
	}

	return &CobrancaResultado{
		Subject:         parsed.Subject,
		Formal:          parsed.Formal,
		Direto:          parsed.Direto,
		Amigavel:        parsed.Amigavel,
		Firme:           parsed.Firme,
		UC:              uc,
		Cliente:         cliente,
		Concessionaria:  conc,
		Para:            emailPara,
		Cc:              emailCc,
		SemRetorno:      semRetorno,
		TemEmailEnviado: temEmailEnviado,
		DiasSemRetorno:  diasSemRetorno,
	}, nil
}

// ultimoEmailEnviadoDestinatarios busca o destinatário principal e o conjunto de CC do
// último e-mail ENVIADO para o processo. O CC devolvido é a união (Para+CC) do e-mail
// anterior, deduplicada e SEM o endereço que já vai no novo "Para" (evita duplicar o
// mesmo contato nos dois campos). Endereços podem vir separados por vírgula ou ponto-e-vírgula.
func ultimoEmailEnviadoDestinatarios(db *gorm.DB, idProcesso int) (para string, cc string) {
	var paraRaw, ccRaw sql.NullString
	err := queryRowGorm(db, `
		SELECT para_email, cc_email FROM FT_EMAILS_PROCESSO
		WHERE id_processo = ? AND tipo = 'enviado'
		ORDER BY data_envio DESC LIMIT 1`, idProcesso,
	).Scan(&paraRaw, &ccRaw)
	if err != nil {
		return "", ""
	}
	para = strings.TrimSpace(paraRaw.String)
	if para == "" {
		return "", ""
	}

	paraLower := strings.ToLower(para)
	seen := map[string]bool{paraLower: true}
	var ccList []string
	for _, addr := range splitEmailList(ccRaw.String) {
		low := strings.ToLower(addr)
		if !seen[low] {
			seen[low] = true
			ccList = append(ccList, addr)
		}
	}
	return para, strings.Join(ccList, ", ")
}

func splitEmailList(raw string) []string {
	raw = strings.ReplaceAll(raw, ";", ",")
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
