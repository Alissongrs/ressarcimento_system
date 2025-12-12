// handlers/ocr_handler.go
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"ressarcimento-backend/database"
	"ressarcimento-backend/repositories"
)

/* ===================== Config OpenAI / Envs ===================== */

func openAIBase() string {
	if v := strings.TrimSpace(os.Getenv("OPENAI_API_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://api.openai.com"
}

func openAIKey() string { return strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) }

/* ===================== Config Ollama (LLaMA) ===================== */

func llmProvider() string {
	if v := strings.TrimSpace(os.Getenv("LLM_PROVIDER")); v != "" {
		return strings.ToLower(v)
	}
	return "ollama"
}

func ollamaURL() string {
	if v := strings.TrimSpace(os.Getenv("LLM_OLLAMA_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://localhost:11434"
}

func ollamaModel() string {
	if v := strings.TrimSpace(os.Getenv("LLM_OLLAMA_MODEL")); v != "" {
		return v
	}
	return "llama3.1:8b"
}

func ollamaKey() string { return strings.TrimSpace(os.Getenv("LLM_API_KEY")) }

// normaliza IDs de modelo e corrige typos comuns (ex.: "gtp-4o-mini")
func normalizeModelID(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return "gpt-4o-mini"
	}
	l := strings.ToLower(v)
	switch l {
	case "gtp-4o-mini", "gpt4o-mini", "gpt-40-mini", "gpt-4o-mini ", "gpt-4o_mini", "gpt4o":
		return "gpt-4o-mini"
	}
	return v
}

func openAIChatModel() string {
	if v := strings.TrimSpace(os.Getenv("OPENAI_MODEL")); v != "" {
		return normalizeModelID(v)
	}
	return "gpt-4o-mini"
}

func openAIOcrModel() string {
	if v := strings.TrimSpace(os.Getenv("OPENAI_OCR_MODEL")); v != "" {
		return normalizeModelID(v)
	}
	return "gpt-4o-mini"
}

func getEnvInt(name string, def int) int {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func getEnvDurationMS(name string, defMs int) time.Duration {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Millisecond
		}
	}
	return time.Duration(defMs) * time.Millisecond
}

/* ===================== Concurrency Gate (Semaphore) ===================== */

var (
	openAISlots chan struct{}
)

func acquireSlot(ctx context.Context) error {
	// lazy init com valor de env
	if openAISlots == nil {
		size := getEnvInt("OPENAI_MAX_CONCURRENCY", 2)
		if size < 1 {
			size = 1
		}
		openAISlots = make(chan struct{}, size)
	}
	select {
	case openAISlots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func releaseSlot() {
	select {
	case <-openAISlots:
	default:
	}
}

/* ===================== HTTP helpers / Retry-After ===================== */

func httpClientWithTimeout() *http.Client {
	to := getEnvDurationMS("OPENAI_TIMEOUT_MS", 0) // 0 = sem timeout global
	return &http.Client{Timeout: to}
}

func parseRetryAfter(h http.Header) time.Duration {
	ra := h.Get("Retry-After")
	if ra == "" {
		return 0
	}
	// formato em segundos (ex.: "2")
	if n, err := strconv.Atoi(ra); err == nil && n >= 0 {
		return time.Duration(n) * time.Second
	}
	// formato data HTTP (RFC1123) – opcional
	if t, err := time.Parse(time.RFC1123, ra); err == nil {
		diff := time.Until(t)
		if diff > 0 {
			return diff
		}
	}
	return 0
}

type upstreamResp struct {
	status int
	body   []byte
	hdr    http.Header
	err    error
}

func callOpenAIChat(ctx context.Context, payload []byte) upstreamResp {
	req, err := http.NewRequestWithContext(ctx, "POST", openAIBase()+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return upstreamResp{status: 0, body: nil, hdr: nil, err: err}
	}
	req.Header.Set("Authorization", "Bearer "+openAIKey())
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClientWithTimeout().Do(req)
	if err != nil {
		return upstreamResp{status: 0, body: nil, hdr: nil, err: err}
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	// Apenas 429/5xx pedem retry com backoff
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return upstreamResp{status: resp.StatusCode, body: rb, hdr: resp.Header, err: errors.New("upstream_unavailable")}
	}
	return upstreamResp{status: resp.StatusCode, body: rb, hdr: resp.Header, err: nil}
}

/* ===================== Retry com backoff e respeito ao Retry-After ===================== */

func doOpenAIWithRetry(ctx context.Context, payload []byte) (upstreamResp, error) {
	maxRetries := getEnvInt("OCR_CHAT_MAX_RETRIES", 5)
	if maxRetries < 0 {
		maxRetries = 0
	}
	base := getEnvDurationMS("OCR_CHAT_BASE_BACKOFF_MS", 700) // 700ms default

	var last upstreamResp
	for attempt := 0; attempt <= maxRetries; attempt++ {
		last = callOpenAIChat(ctx, payload)
		// sucesso (200..499 exceto 429) → sai
		if last.err == nil {
			return last, nil
		}
		// falha que merece retry? só 429/5xx
		if last.status != http.StatusTooManyRequests && last.status < 500 {
			return last, last.err
		}
		// última tentativa → sai
		if attempt == maxRetries {
			return last, last.err
		}
		// respeita Retry-After se vier do upstream; senão exponencial + jitter
		delay := parseRetryAfter(last.hdr)
		if delay <= 0 {
			exp := base * time.Duration(1<<attempt)
			if exp > 8*time.Second {
				exp = 8 * time.Second
			}
			delay = exp + time.Duration(rand.Int63n(int64(300*time.Millisecond)))
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return upstreamResp{status: http.StatusRequestTimeout}, ctx.Err()
		}
	}
	return last, last.err
}

/* ===================== Helpers de erro OpenAI ===================== */

type openAIError struct {
	Error struct {
		Message string      `json:"message"`
		Type    string      `json:"type"`
		Param   interface{} `json:"param"`
		Code    string      `json:"code"`
	} `json:"error"`
}

func parseOpenAIErrorBody(b []byte) (msg, code, typ string) {
	var oe openAIError
	if err := json.Unmarshal(b, &oe); err != nil {
		return "", "", ""
	}
	return strings.TrimSpace(oe.Error.Message), strings.TrimSpace(oe.Error.Code), strings.TrimSpace(oe.Error.Type)
}

/* ===================== OCRChat ===================== */

// Monta um prompt simples a partir da lista de mensagens
func buildPromptFromMessages(msgs []map[string]string) string {
	var sb strings.Builder
	for _, m := range msgs {
		role := strings.ToUpper(strings.TrimSpace(m["role"]))
		if role == "" {
			role = "USER"
		}
		content := strings.TrimSpace(m["content"])
		sb.WriteString(role)
		sb.WriteString(": ")
		sb.WriteString(content)
		sb.WriteString("\n")
	}
	return sb.String()
}

// Chama Ollama /api/generate
func callOllama(ctx context.Context, prompt string) (string, string, error) {
	payload := map[string]any{
		"model":  ollamaModel(),
		"prompt": prompt,
		"stream": false,
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", ollamaURL()+"/api/generate", bytes.NewReader(b))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if k := ollamaKey(); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}
	resp, err := httpClientWithTimeout().Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("ollama_%d: %s", resp.StatusCode, string(body))
	}
	var parsed struct {
		Response string `json:"response"`
	}
	_ = json.Unmarshal(body, &parsed)
	return strings.TrimSpace(parsed.Response), ollamaModel(), nil
}

// POST /api/v1/ocr/chat
// body: { messages: [{role: 'system'|'user'|'assistant', content: string}], model?: string }
func OCRChat(c *gin.Context) {
	var body struct {
		Messages []map[string]string `json:"messages"`
		Model    string              `json:"model"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "JSON invalido"})
		return
	}

	provider := llmProvider()
	hasOpenAI := openAIKey() != ""
	if provider == "" {
		provider = "ollama"
	}

	// Tenta primeiro Ollama; se falhar e houver chave OpenAI, faz fallback automatico.
	if provider == "ollama" || !hasOpenAI {
		prompt := buildPromptFromMessages(body.Messages)
		ctx, cancel := context.WithTimeout(c.Request.Context(), getEnvDurationMS("OCR_CHAT_TIMEOUT_MS", 70000))
		defer cancel()

		text, modelUsed, err := callOllama(ctx, prompt)
		if err == nil {
			c.JSON(http.StatusOK, gin.H{
				"message":       text,
				"model_used":    modelUsed,
				"provider_used": "ollama",
			})
			return
		}

		if !hasOpenAI {
			c.JSON(http.StatusBadGateway, gin.H{
				"error":         "ollama_failed",
				"details":       err.Error(),
				"model_used":    modelUsed,
				"provider_used": "ollama",
			})
			return
		}
		provider = "openai"
	}

	// Caminho OpenAI (ChatGPT ou compat?vel)
	model := normalizeModelID(body.Model)
	if model == "" {
		model = openAIChatModel()
	}

	payload := map[string]interface{}{
		"model":       model,
		"messages":    body.Messages,
		"temperature": 0.2,
	}
	b, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(c.Request.Context(), getEnvDurationMS("OCR_CHAT_TIMEOUT_MS", 70000))
	defer cancel()

	if err := acquireSlot(ctx); err != nil {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error":   "busy",
			"message": "Sistema de IA ocupado, tente novamente em instantes.",
		})
		return
	}
	defer releaseSlot()

	up, err := doOpenAIWithRetry(ctx, b)

	if err != nil {
		if up.status == http.StatusTooManyRequests {
			ra := parseRetryAfter(up.hdr)
			if ra > 0 {
				c.Header("Retry-After", strconv.Itoa(int((ra+time.Second-1)/time.Second)))
			} else {
				c.Header("Retry-After", "2")
			}
			msg, code, _ := parseOpenAIErrorBody(up.body)
			if msg == "" {
				msg = "IA sobrecarregada no momento. Tente novamente em instantes."
			}
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":         "upstream_429",
				"message":       msg,
				"retry_after":   c.Writer.Header().Get("Retry-After"),
				"code":          code,
				"model_used":    model,
				"provider_used": "openai",
			})
			return
		}
		if up.status >= 500 {
			c.JSON(http.StatusBadGateway, gin.H{
				"error":         "ia_failed",
				"details":       string(up.body),
				"model_used":    model,
				"provider_used": "openai",
			})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{
			"error":         "ia_failed",
			"details":       err.Error(),
			"model_used":    model,
			"provider_used": "openai",
		})
		return
	}

	if up.status != http.StatusOK {
		if up.status == http.StatusUnauthorized || up.status == http.StatusForbidden || up.status == http.StatusBadRequest {
			msg, code, typ := parseOpenAIErrorBody(up.body)
			if msg != "" || code != "" || typ != "" {
				c.JSON(up.status, gin.H{
					"error":         typ,
					"message":       msg,
					"code":          code,
					"model_used":    model,
					"provider_used": "openai",
				})
				return
			}
		}
		c.Data(up.status, "application/json", up.body)
		return
	}

	var parsed struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		Model   string `json:"model"`
		Choices []struct {
			Index   int `json:"index"`
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage map[string]any `json:"usage"`
	}
	_ = json.Unmarshal(up.body, &parsed)

	content := ""
	if len(parsed.Choices) > 0 {
		content = strings.TrimSpace(parsed.Choices[0].Message.Content)
	}
	used := parsed.Model
	if strings.TrimSpace(used) == "" {
		used = model
	}
	if content == "" {
		c.JSON(http.StatusOK, gin.H{
			"message":       "",
			"model_used":    normalizeModelID(used),
			"provider_used": "openai",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":       content,
		"model_used":    normalizeModelID(used),
		"provider_used": "openai",
	})
}
/* ===================== OCRAnalyze (compatível one-shot) ===================== */

// POST /api/v1/ocr/analyze (multipart/form-data)
// Encaminha arquivos diretamente para o OCR backend Python em modo one-shot.
func OCRAnalyze(c *gin.Context) {
	ocrURL := strings.TrimSpace(os.Getenv("OCR_BACKEND_URL"))
	if ocrURL == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "ocr_backend_not_configured",
			"message": "OCR_BACKEND_URL não configurado no .env",
		})
		return
	}

	if err := c.Request.ParseMultipartForm(25 << 20); err != nil { // 25MB
		c.JSON(http.StatusBadRequest, gin.H{"error": "multipart inválido", "details": err.Error()})
		return
	}
	files := c.Request.MultipartForm.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "envie pelo menos um arquivo em files[]"})
		return
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

	resp, err := httpClientWithTimeout().Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Falha ao contatar OCR backend", "details": err.Error()})
		return
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		c.JSON(resp.StatusCode, gin.H{
			"error":   "ocr_backend_error",
			"details": string(rb),
		})
		return
	}

	c.Data(http.StatusOK, "application/json", rb)
}

/* ===================== Utils ===================== */

func detectMime(fh *multipart.FileHeader, data []byte) string {
	// Tenta pela extensão primeiro
	name := strings.ToLower(fh.Filename)
	switch {
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".jpg"), strings.HasSuffix(name, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(name, ".pdf"):
		return "application/pdf"
	}
	// Fallback: sniff básico
	ct := http.DetectContentType(data)
	if ct == "application/octet-stream" {
		return "image/png"
	}
	return ct
}

// extractJSON tenta encontrar um objeto/array JSON dentro de um texto
func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	// caminho feliz
	if strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[") {
		return s
	}
	// procura primeiro delimitador JSON
	i := strings.IndexAny(s, "{[")
	if i >= 0 {
		return s[i:]
	}
	return s
}

/* ===================== OCRQuick (Two-Stage OCR - Stage 1: Fast Extraction) ===================== */

// POST /api/v1/ocr/quick (multipart/form-data)
// Executa OCR rápido (Tesseract apenas) e salva raw_text no banco
// Retorna request_id para uso posterior no /ocr/interpret
func OCRQuick(c *gin.Context) {
	ocrURL := strings.TrimSpace(os.Getenv("OCR_BACKEND_URL"))
	if ocrURL == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "ocr_backend_not_configured",
			"message": "OCR_BACKEND_URL não configurado no .env",
		})
		return
	}

	if err := c.Request.ParseMultipartForm(25 << 20); err != nil { // 25MB
		c.JSON(http.StatusBadRequest, gin.H{"error": "multipart inválido", "details": err.Error()})
		return
	}
	files := c.Request.MultipartForm.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "envie pelo menos um arquivo em files[]"})
		return
	}

	// Monta multipart para o OCR Service Python
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)

	// Copia arquivos
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

	// Chama Python /ocr/quick
	req, _ := http.NewRequest("POST", strings.TrimRight(ocrURL, "/")+"/ocr/quick", &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Accept", "application/json")

	resp, err := httpClientWithTimeout().Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Falha ao contatar OCR backend", "details": err.Error()})
		return
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	// Parse response
	var pythonResp struct {
		Results []struct {
			FileName  string `json:"file_name"`
			RawText   string `json:"raw_text"`
			PagesUsed int    `json:"pages_used"`
			Status    string `json:"status"`
		} `json:"results"`
	}

	if err := json.Unmarshal(rb, &pythonResp); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Resposta inválida do OCR backend", "details": string(rb)})
		return
	}

	// Gera request_id único para este batch
	reqID := uuid.New().String()

	// Salva no banco (OCR_RESULTS)
	if database.DB_App != nil {
		repo := repositories.NewOCRResultRepo(database.DB_App)
		ctx := c.Request.Context()
		for _, item := range pythonResp.Results {
			_ = repo.Insert(ctx, reqID, item.FileName, item.RawText, nil)
		}
	}

	// Retorna para o frontend
	c.JSON(http.StatusOK, gin.H{
		"request_id": reqID,
		"results":    pythonResp.Results,
		"message":    "OCR rápido concluído. Use /ocr/interpret para aplicar regras.",
	})
}

/* ===================== OCRInterpret (Two-Stage OCR - Stage 2: Interpretation) ===================== */

// POST /api/v1/ocr/interpret (application/json)
// Body: { request_id, filename, rules?: string[], use_llm?: bool }
// Busca OCR text salvo e chama Python para interpretação com regras
func OCRInterpret(c *gin.Context) {
	ocrURL := strings.TrimSpace(os.Getenv("OCR_BACKEND_URL"))
	if ocrURL == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "ocr_backend_not_configured",
			"message": "OCR_BACKEND_URL não configurado no .env",
		})
		return
	}

	var body struct {
		RequestID string   `json:"request_id" binding:"required"`
		Filename  string   `json:"filename" binding:"required"`
		Rules     []string `json:"rules"`
		UseLLM    bool     `json:"use_llm"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "JSON inválido", "details": err.Error()})
		return
	}

	// Busca OCR text salvo no banco
	if database.DB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database não configurado"})
		return
	}

	repo := repositories.NewOCRResultRepo(database.DB_App)
	ctx := c.Request.Context()
	ocrText, _, err := repo.GetByRequestAndFilename(ctx, body.RequestID, body.Filename)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "ocr_not_found",
			"message": "OCR text não encontrado. Execute /ocr/quick primeiro.",
			"details": err.Error(),
		})
		return
	}

	if strings.TrimSpace(ocrText) == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "ocr_text_empty",
			"message": "OCR text vazio. Verifique se o arquivo foi processado corretamente.",
		})
		return
	}

	// Serializa regras para JSON string
	rulesJSON := "[]"
	if len(body.Rules) > 0 {
		if b, err := json.Marshal(body.Rules); err == nil {
			rulesJSON = string(b)
		}
	}

	// Chama Python /ocr/interpret
	pythonPayload := map[string]string{
		"request_id": body.RequestID,
		"filename":   body.Filename,
		"ocr_text":   ocrText,
		"rules":      rulesJSON,
		"use_llm":    fmt.Sprintf("%t", body.UseLLM),
	}

	payloadBytes, _ := json.Marshal(pythonPayload)
	req, _ := http.NewRequest("POST", strings.TrimRight(ocrURL, "/")+"/ocr/interpret", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClientWithTimeout().Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Falha ao contatar OCR backend", "details": err.Error()})
		return
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	// Parse response
	var pythonResp struct {
		RequestID   string         `json:"request_id"`
		Filename    string         `json:"filename"`
		RuleResults map[string]any `json:"rule_results"`
		LLMResults  map[string]any `json:"llm_results"`
		Status      string         `json:"status"`
	}

	if err := json.Unmarshal(rb, &pythonResp); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Resposta inválida do OCR backend", "details": string(rb)})
		return
	}

	// Atualiza llm_json no banco com os resultados
	combinedResult := map[string]any{
		"rule_results": pythonResp.RuleResults,
		"llm_results":  pythonResp.LLMResults,
	}
	_ = repo.UpdateLLMResult(ctx, body.RequestID, body.Filename, combinedResult)

	// Retorna para o frontend
	c.JSON(http.StatusOK, gin.H{
		"request_id":   pythonResp.RequestID,
		"filename":     pythonResp.Filename,
		"rule_results": pythonResp.RuleResults,
		"llm_results":  pythonResp.LLMResults,
		"status":       pythonResp.Status,
	})
}
