package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
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

	"ressarcimento-backend/database"
)

/* â”€â”€â”€ cache de arquivos de texto (TTL 60s) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

/* â”€â”€â”€ tipos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

/* â”€â”€â”€ system prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const aisureSystemPrompt = `VocÃª Ã© o AISURE, assistente especializado em anÃ¡lise de anomalias em faturas de energia elÃ©trica.
VocÃª tem acesso a dados reais de cinco fichas de irregularidade (F01â€“F05) do banco de faturas.
Responda sempre em portuguÃªs brasileiro, de forma objetiva e tÃ©cnica.
Quando o usuÃ¡rio perguntar sobre uma UC especÃ­fica, analise os dados daquela UC nas fichas disponÃ­veis.
Quando identificar anomalias, explique o tipo de irregularidade e sugira se vale abrir um processo de ressarcimento.
Se nÃ£o houver dados suficientes no contexto, informe claramente.
NÃ£o invente dados â€” use apenas o que estÃ¡ no contexto fornecido.`

/* â”€â”€â”€ regex para extrair UC da pergunta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

var reUC = regexp.MustCompile(`\b\d{6,12}\b`)
var reAisureTotalConfirmadas = regexp.MustCompile(`(?im)total\s+de\s+fichas\s+confirmadas\s*:\s*(\d+)`)
var reAisureFichasConfirmadas = regexp.MustCompile(`(?im)fichas\s+confirmadas\s*:\s*(\d+)`)
var reAisureLinhaConfirmada = regexp.MustCompile(`(?im)^f0[1-5]\b.*\bconfirmado\b`)
var reAisureLinhaNaoConfirmada = regexp.MustCompile(`(?im)^f0[1-5]\b.*\b(nÃ£o|nao)\s+confirmado\b`)

/* â”€â”€â”€ meta das fichas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

/* â”€â”€â”€ build contexto â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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
		fmt.Fprintf(&sb, "## %s â€“ %s (%d registros)\n", f.key, f.nome, total)

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

/* â”€â”€â”€ chamada OpenAI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

func callAisureOpenAI(ctx context.Context, history []aisureMsg, question, ctxStr string, systemPromptOverride ...string) (string, error) {
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
		"temperature":          0.3,
		aisureTokensKey(model): 1024,
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

/* â”€â”€â”€ Chamada OpenAI com visÃ£o (imagem base64) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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
		"temperature":          0.3,
		aisureTokensKey(model): 4096,
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

/* â”€â”€â”€ Handler de confirmaÃ§Ã£o por linha â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

type faturaImageItem struct {
	Base64 string `json:"base64"`
	Mime   string `json:"mime"`
}

type aisureConfirmarReq struct {
	UC           string            `json:"uc"`
	Fichas       string            `json:"fichas"`
	Detalhamento string            `json:"detalhamento"`
	RowData      map[string]string `json:"row_data"`
	FaturaLink   string            `json:"fatura_link"`
	FaturaText   string            `json:"fatura_text"`   // texto extraÃ­do (fallback)
	FaturaBase64 string            `json:"fatura_base64"` // imagem Ãºnica (legado)
	FaturaMime   string            `json:"fatura_mime"`
	FaturaImages []faturaImageItem `json:"fatura_images"` // array de pÃ¡ginas (PDF convertido)
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

	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	filename := aisureInferRemoteFilename(link, contentType)
	return data, contentType, filename, nil
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

// AisureConfirmarHandler godoc
// POST /api/v1/faturas/aisure/confirmar
func AisureConfirmarHandler(c *gin.Context) {
	var in aisureConfirmarReq
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.UC) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload invÃ¡lido"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
	defer cancel()

	// Busca histÃ³rico completo da UC â€” inclui leituras para verificaÃ§Ã£o de F05
	var ucCtx strings.Builder
	if db := database.GormDB_Faturas; db != nil {
		if sqlDB, err := db.DB(); err == nil {
			rows, err := sqlDB.QueryContext(ctx,
				`SELECT Mes_Ref, NroMedidor,
				        KWH_Ponta, KWH_FPonta, KWH_Reservado, KWH_Total,
				        Leitura_Anterior_KWH_P,  Leitura_Atual_KWH_P,
				        Leitura_Anterior_KWH_FP, Leitura_Atual_KWH_FP,
				        Leitura_Anterior_KWH_R,  Leitura_Atual_KWH_R,
				        Constante_KWH_P, Constante_KWH_FP, Constante_KWH_R,
				        RS_Total_Fatura
				 FROM Faturas_Registradas_Cache
				 WHERE UC = ? ORDER BY Mes_Ref DESC LIMIT 24`, in.UC)
			if err == nil {
				defer rows.Close()
				ucCtx.WriteString("=== HISTÃ“RICO DE FATURAS DA UC " + in.UC + " (Ãºltimos 24 meses) ===\n")
				ucCtx.WriteString("Mes_Ref | Medidor | KWH_P | KWH_FP | KWH_R | KWH_Total | LeitAnt_P | LeitAtu_P | LeitAnt_FP | LeitAtu_FP | LeitAnt_R | LeitAtu_R | Const_P | Const_FP | Const_R | RS_Total\n")
				for rows.Next() {
					var mes, med, kp, kfp, kr, kt, lap, lcp, lafp, lcfp, lar, lcr, cp, cfp, cr, rs string
					if rows.Scan(&mes, &med, &kp, &kfp, &kr, &kt, &lap, &lcp, &lafp, &lcfp, &lar, &lcr, &cp, &cfp, &cr, &rs) == nil {
						fmt.Fprintf(&ucCtx, "%s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s\n",
							mes, med, kp, kfp, kr, kt, lap, lcp, lafp, lcfp, lar, lcr, cp, cfp, cr, rs)
					}
				}
			}
		}
	}

	// Detecta RURAL/IRRIGANTE para alertar a IA explicitamente
	ruralTag := aisureDetectRuralTag(in.RowData)

	// Monta contexto com dados da linha
	var rowCtx strings.Builder
	rowCtx.WriteString("=== DADOS DO SISTEMA PARA ESTA FATURA ===\n")
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

	if len(images) == 0 && strings.TrimSpace(in.FaturaText) == "" {
		if link := aisureResolveFaturaLink(in); link != "" {
			rowCtx.WriteString("Aviso: a fatura por link precisa chegar como imagens; se o frontend não carregar automaticamente, faça o anexo manual.\n")
		}
	}

	ctxStr := rowCtx.String() + "\n" + ucCtx.String()

	// Monta pergunta — formato de saída definido exclusivamente pelo prompt_confirmar.txt (system prompt).
	var question string
	switch {
	case len(images) > 0:
		question = fmt.Sprintf("Fatura UC %s: leia todos os dados nas imagens e aplique F01-F05 conforme as regras do system prompt. Use o historico do banco no contexto para F02/F03/F04/F05. Responda EXATAMENTE no formato do system prompt.", in.UC)
	case strings.TrimSpace(in.FaturaText) != "":
		question = fmt.Sprintf("Fatura UC %s. Aplique F01-F05 conforme regras do system prompt. Conteudo da fatura: %s", in.UC, in.FaturaText)
	default:
		question = fmt.Sprintf("Fatura UC %s: aplique F01-F05 com os dados do contexto conforme regras do system prompt.", in.UC)
	}

	// Única chamada de IA — usa somente prompt_confirmar.txt.
	confirmarPrompt := loadConfirmarPrompt()

	var answer string
	var err error
	if len(images) > 0 {
		answer, err = callAisureOpenAIVision(ctx, question, ctxStr, images, confirmarPrompt)
	} else {
		answer, err = callAisureOpenAI(ctx, nil, question, ctxStr, confirmarPrompt)
	}
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao chamar IA: " + err.Error()})
		return
	}

	confirmado := aisureParseConfirmado(answer)

	c.JSON(http.StatusOK, aisureConfirmarResp{
		Confirmado: confirmado,
		Analise:    answer,
		Model:      aisureOpenAIModel(),
	})
}

/* â”€â”€â”€ Handler HTTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

/* â”€â”€â”€ GerarEmailHandler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   POST /api/v1/faturas/aisure/gerar-email
   Body JSON:
     uc, cliente, concessionaria, periodos (string), tipo_irregularidade,
     subtipo_irregularidade, problema_identificado, descricao_irregularidade,
     ressarcimento_estimado, analise_ia, calc_financeiro
   Retorna: { email: "..." }
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

/* â”€â”€â”€ GerarCobrancaEmailHandler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   POST /api/v1/processos/:id/gerar-cobranca
   Analisa histÃ³rico + e-mails do processo e gera 2 sugestÃµes de
   e-mail de cobranÃ§a de resposta para a concessionÃ¡ria.
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const cobrancaSystemPrompt = `VocÃª Ã© especialista em ressarcimento de energia elÃ©trica conforme a REN 1000/2021 da ANEEL.
Gere EXATAMENTE DUAS sugestÃµes de e-mail de cobranÃ§a de resposta dirigido Ã  concessionÃ¡ria distribuidora.
Cada sugestÃ£o deve:
- Ser sucinta (mÃ¡x 180 palavras), profissional e assertiva
- Citar art. 126 Â§1Âº da REN 1000/2021 (prazo mÃ¡ximo de 30 dias Ãºteis para resposta) quando o prazo estiver vencido
- Mencionar nÃºmero do processo, UC, cliente e a sub-etapa atual
- Solicitar posicionamento formal com urgÃªncia
- Estar em HTML usando apenas <p> e <strong> â€” sem DOCTYPE, sem <html>, sem <head>

Retorne SOMENTE o JSON abaixo, sem markdown, sem texto extra:
{"subject":"...","opcao1":"<p>...</p>","opcao2":"<p>...</p>"}`

var reMarkdownBlock = regexp.MustCompile(`(?s)^` + "```" + `[a-z]*\n?`)

func GerarCobrancaEmailHandler(c *gin.Context) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id invÃ¡lido"})
		return
	}

	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponÃ­vel"})
		return
	}

	// 1. Dados do processo
	var uc, cliente, conc, subEtapa, etapa, tipoNome, subtipoNome, descricao, ressarcimento, dataMov string
	scanErr := queryRowGorm(db, `
		SELECT
		  COALESCE(uc,''),
		  COALESCE(cliente,''),
		  COALESCE(concessionaria,''),
		  COALESCE(sub_etapa,''),
		  COALESCE(etapa,''),
		  COALESCE(nome_tipo_irregularidade,''),
		  COALESCE(nome_subtipo_irregularidade,''),
		  COALESCE(descricao_irregularidade,''),
		  COALESCE(CAST(ressarcimento_estimado AS CHAR),''),
		  DATE_FORMAT(COALESCE(data_movimentacao, ultima_atualizacao, NOW()), '%d/%m/%Y %H:%i')
		FROM FT_PROCESSOS WHERE id_processo = ? LIMIT 1`, id).
		Scan(&uc, &cliente, &conc, &subEtapa, &etapa, &tipoNome, &subtipoNome, &descricao, &ressarcimento, &dataMov)
	if scanErr != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "processo nÃ£o encontrado"})
		return
	}

	// 2. HistÃ³rico de movimentaÃ§Ãµes (atÃ© 20 Ãºltimas)
	histRows, err := queryGorm(db, `
		SELECT
		  COALESCE(h.etapa_anterior,''),
		  COALESCE(h.etapa_nova,''),
		  COALESCE(h.sub_etapa,''),
		  COALESCE(h.comentario,''),
		  DATE_FORMAT(h.data_movimentacao,'%d/%m/%Y %H:%i'),
		  COALESCE(u.nome_usuario,'Sistema')
		FROM FT_HISTORICO_MOVIMENTACOES h
		LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
		WHERE h.id_requisicao = ?
		ORDER BY h.data_movimentacao DESC LIMIT 20`, id)
	var histLines []string
	if err == nil {
		defer histRows.Close()
		for histRows.Next() {
			var etAnt, etNov, sub, coment, data, usuario string
			if histRows.Scan(&etAnt, &etNov, &sub, &coment, &data, &usuario) == nil {
				line := fmt.Sprintf("[%s] %s â†’ %s", data, etAnt, etNov)
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
		SELECT COALESCE(assunto,''), DATE_FORMAT(data_envio,'%d/%m/%Y'), COALESCE(para_email,'')
		FROM FT_EMAILS_PROCESSO
		WHERE id_processo = ?
		ORDER BY data_envio DESC LIMIT 5`, id)
	var emailLines []string
	if err == nil {
		defer emailRows.Close()
		for emailRows.Next() {
			var assunto, data, para string
			if emailRows.Scan(&assunto, &data, &para) == nil {
				emailLines = append(emailLines, fmt.Sprintf("[%s] Para: %s | Assunto: %s", data, para, assunto))
			}
		}
	}

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

	if len(histLines) > 0 {
		sb.WriteString("\n=== HISTÃ“RICO DE MOVIMENTAÃ‡Ã•ES ===\n")
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

	// Inclui templates de referÃªncia no contexto (se disponÃ­veis)
	if tmpl := loadCobrancaTemplates(); tmpl != "" {
		sb.WriteString("\n=== MODELOS DE REFERÃŠNCIA (use apenas para calibrar tom/estrutura) ===\n")
		sb.WriteString(tmpl)
		sb.WriteString("\n")
	}

	question := fmt.Sprintf(
		"Processo #%d â€” UC %s â€” Cliente: %s â€” ConcessionÃ¡ria: %s â€” Sub-etapa: %s. "+
			"O prazo de resposta estÃ¡ vencido. Analise o histÃ³rico e e-mails anteriores. "+
			"Gere as 2 sugestÃµes de e-mail de cobranÃ§a conforme o system prompt.",
		id, uc, cliente, conc, subEtapa,
	)

	// Carrega prompt do arquivo; usa const como fallback
	sysPrompt := loadCobrancaPrompt()
	if sysPrompt == "" {
		sysPrompt = cobrancaSystemPrompt
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	raw, err := callAisureOpenAI(ctx, nil, question, sb.String(), sysPrompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao gerar cobranÃ§a: " + err.Error()})
		return
	}

	// Strip markdown code block if present
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "```") {
		raw = reMarkdownBlock.ReplaceAllString(raw, "")
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
		raw = strings.TrimSpace(raw)
	}

	var parsed struct {
		Subject string `json:"subject"`
		Opcao1  string `json:"opcao1"`
		Opcao2  string `json:"opcao2"`
	}
	if jsonErr := json.Unmarshal([]byte(raw), &parsed); jsonErr != nil {
		// Fallback: return raw text as opcao1
		c.JSON(http.StatusOK, gin.H{
			"subject":        fmt.Sprintf("CobranÃ§a de Resposta â€” Processo #%d", id),
			"opcao1":         raw,
			"opcao2":         "",
			"uc":             uc,
			"cliente":        cliente,
			"concessionaria": conc,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"subject":        parsed.Subject,
		"opcao1":         parsed.Opcao1,
		"opcao2":         parsed.Opcao2,
		"uc":             uc,
		"cliente":        cliente,
		"concessionaria": conc,
	})
}
