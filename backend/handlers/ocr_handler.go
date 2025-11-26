// handlers/ocr_handler.go
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/base64"
	"errors"
	"io"
	"math/rand"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

/* ===================== Config OpenAI / Envs ===================== */

func openAIBase() string {
	if v := strings.TrimSpace(os.Getenv("OPENAI_API_BASE")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "https://api.openai.com"
}

func openAIKey() string { return strings.TrimSpace(os.Getenv("OPENAI_API_KEY")) }

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
	to := getEnvDurationMS("OPENAI_TIMEOUT_MS", 60000)
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

// POST /api/v1/ocr/chat
// body: { messages: [{role: 'system'|'user'|'assistant', content: string}], model?: string }
func OCRChat(c *gin.Context) {
    if openAIKey() == "" {
        c.JSON(http.StatusServiceUnavailable, gin.H{
            "error":   "service_unavailable",
            "message": "OPENAI_API_KEY ausente (defina no .env para habilitar o chat de IA)",
        })
        return
    }

	var body struct {
		Messages []map[string]string `json:"messages"`
		Model    string              `json:"model"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "JSON inválido"})
		return
	}

	// força/normaliza para gpt-4o-mini (corrige "gtp-4o-mini" automaticamente)
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

	// Timeout do handler (maior que o do cliente http para abarcar retries)
	ctx, cancel := context.WithTimeout(c.Request.Context(), getEnvDurationMS("OCR_CHAT_TIMEOUT_MS", 70000))
	defer cancel()

	// Gate de concorrência para proteger upstream/local
	if err := acquireSlot(ctx); err != nil {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"error":   "busy",
			"message": "Sistema de IA ocupado, tente novamente em instantes.",
		})
		return
	}
	defer releaseSlot()

	up, err := doOpenAIWithRetry(ctx, b)

	// Se houve erro de transporte/retry, trate com mapeamento
	if err != nil {
		// Se a última foi 429, propaga com Retry-After (se houver)
		if up.status == http.StatusTooManyRequests {
			ra := parseRetryAfter(up.hdr)
			if ra > 0 {
				c.Header("Retry-After", strconv.Itoa(int((ra+time.Second-1)/time.Second)))
			} else {
				c.Header("Retry-After", "2")
			}
			// tenta extrair mensagem/código do upstream
			msg, code, _ := parseOpenAIErrorBody(up.body)
			if msg == "" {
				msg = "IA sobrecarregada no momento. Tente novamente em instantes."
			}
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":       "upstream_429",
				"message":     msg,
				"retry_after": c.Writer.Header().Get("Retry-After"),
				"code":        code,
				"model_used":  model,
			})
			return
		}
		// 5xx
		if up.status >= 500 {
			c.JSON(http.StatusBadGateway, gin.H{
				"error":      "ia_failed",
				"details":    string(up.body),
				"model_used": model,
			})
			return
		}
		// Falha genérica
		c.JSON(http.StatusBadGateway, gin.H{
			"error":      "ia_failed",
			"details":    err.Error(),
			"model_used": model,
		})
		return
	}

	// Se upstream não retornou 200, devolve conteúdo bruto (p.ex. 400, 401, 403)
	if up.status != http.StatusOK {
		// enriquecer mensagens comuns
		if up.status == http.StatusUnauthorized || up.status == http.StatusForbidden || up.status == http.StatusBadRequest {
			msg, code, typ := parseOpenAIErrorBody(up.body)
			if msg != "" || code != "" || typ != "" {
				c.JSON(up.status, gin.H{
					"error":      typ,
					"message":    msg,
					"code":       code,
					"model_used": model,
				})
				return
			}
		}
		c.Data(up.status, "application/json", up.body)
		return
	}

	// Minimiza a resposta ao essencial, mas devolve também model_used
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
		// se a API não retornar o campo (ou retornar vazio), use o solicitado
		used = model
	}
	if content == "" {
		c.JSON(http.StatusOK, gin.H{
			"message":    "",
			"model_used": normalizeModelID(used),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":    content,
		"model_used": normalizeModelID(used),
	})
}

/* ===================== OCRAnalyze ===================== */

// POST /api/v1/ocr/analyze (multipart/form-data)
// fields: files[] (one or more), instruction (optional), model (optional)
func OCRAnalyze(c *gin.Context) {
	if err := c.Request.ParseMultipartForm(25 << 20); err != nil { // 25MB
		c.JSON(http.StatusBadRequest, gin.H{"error": "multipart inválido", "details": err.Error()})
		return
	}
	files := c.Request.MultipartForm.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "envie pelo menos um arquivo em files[]"})
		return
	}

    ocrURL := strings.TrimSpace(os.Getenv("OCR_BACKEND_URL"))
    if ocrURL != "" {
		var b bytes.Buffer
		mw := multipart.NewWriter(&b)
		// copy files
		for _, fh := range files {
			f, err := fh.Open()
			if err != nil {
				continue
			}
			w, _ := mw.CreateFormFile("files", fh.Filename)
			_, _ = io.Copy(w, f)
			_ = f.Close()
		}
		// optional fields
		lang := strings.TrimSpace(c.PostForm("lang"))
		if lang == "" {
			lang = "por+eng"
		}
		_ = mw.WriteField("lang", lang)

		maxPages := strings.TrimSpace(c.PostForm("max_pages"))
		if maxPages == "" {
			maxPages = "3"
		}
		_ = mw.WriteField("max_pages", maxPages)

		applyRules := strings.TrimSpace(c.PostForm("apply_rules"))
		rules := strings.TrimSpace(c.PostForm("rules"))
		if applyRules == "1" || strings.ToLower(applyRules) == "true" {
			_ = mw.WriteField("apply_rules_flag", "1")
			if rules != "" {
				_ = mw.WriteField("rules", rules)
			}
		}
		_ = mw.Close()

		req, _ := http.NewRequest("POST", strings.TrimRight(ocrURL, "/")+"/analyze", &b)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Accept", "application/json")
		resp, err := httpClientWithTimeout().Do(req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "Falha ao contatar OCR backend", "details": err.Error()})
			return
		}
		defer resp.Body.Close()
		rb, _ := io.ReadAll(resp.Body)
        c.Data(resp.StatusCode, "application/json", rb)
        return
    }
    // Fallback: usar OpenAI Vision (gpt-4o-mini) para imagens (png/jpg)
    // Observação: PDF não é suportado no fallback (sem conversão), retornaremos 415.
    results := make([]map[string]any, 0, len(files))
    // Mensagem padrão
    instr := strings.TrimSpace(c.PostForm("instruction"))
    if instr == "" {
        instr = "Extraia o texto legível da imagem da fatura. Responda somente com o texto OCR."
    }
    model := openAIOcrModel()

    for _, fh := range files {
        f, err := fh.Open()
        if err != nil { continue }
        data, _ := io.ReadAll(f)
        _ = f.Close()
        mime := detectMime(fh, data)
        if strings.HasPrefix(mime, "application/pdf") {
            c.JSON(http.StatusUnsupportedMediaType, gin.H{"error": "pdf_unsupported_in_fallback", "message": "PDF não suportado no fallback OpenAI Vision. Configure OCR_BACKEND_URL."})
            return
        }
        b64 := base64.StdEncoding.EncodeToString(data)
        // Monta payload com content parts (input_text + input_image)
        messages := []map[string]any{
            {"role": "system", "content": "Você é um OCR preciso. Retorne somente o texto extraído (pt-BR) sem comentários."},
            {"role": "user", "content": []any{
                map[string]any{"type": "input_text", "text": instr},
                map[string]any{"type": "input_image", "image_url": map[string]any{"url": "data:" + mime + ";base64," + b64}},
            }},
        }
        payload := map[string]any{
            "model":       model,
            "messages":    messages,
            "temperature": 0.0,
        }
        body, _ := json.Marshal(payload)
        ctx, cancel := context.WithTimeout(c.Request.Context(), getEnvDurationMS("OCR_CHAT_TIMEOUT_MS", 70000))
        defer cancel()
        if err := acquireSlot(ctx); err != nil {
            c.JSON(http.StatusTooManyRequests, gin.H{"error": "busy", "message": "Sistema de IA ocupado, tente novamente."})
            return
        }
        up, _ := doOpenAIWithRetry(ctx, body)
        releaseSlot()
        text := ""
        if up.status == http.StatusOK && len(up.body) > 0 {
            var parsed struct{ Choices []struct{ Message struct{ Content string `json:"content"` } `json:"message"` } `json:"choices"` }
            _ = json.Unmarshal(up.body, &parsed)
            if len(parsed.Choices) > 0 {
                text = strings.TrimSpace(parsed.Choices[0].Message.Content)
            }
        }
        // Normaliza resultado em formato compatível com o front
        results = append(results, map[string]any{
            "file_name": fh.Filename,
            "rule_results": map[string]any{
                "META": map[string]any{
                    "texto_extraido": text,
                    "model_used":     normalizeModelID(model),
                },
            },
        })
    }
    if results == nil { results = []map[string]any{} }
    c.JSON(http.StatusOK, results)
}

/* ===================== Utils ===================== */

func detectMime(fh *multipart.FileHeader, data []byte) string {
	// Try extension first
	name := strings.ToLower(fh.Filename)
	switch {
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".jpg"), strings.HasSuffix(name, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(name, ".pdf"):
		return "application/pdf"
	}
	// Fallback basic sniff
	ct := http.DetectContentType(data)
	if ct == "application/octet-stream" {
		return "image/png"
	}
	return ct
}

// extractJSON tries to find a JSON object or array within a text block
func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	// fast path
	if strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[") {
		return s
	}
	// find first JSON delimiter
	i := strings.IndexAny(s, "{[")
	if i >= 0 {
		return s[i:]
	}
	return s
}
