package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"ressarcimento-backend/database"
)

type ragMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ragChatRequest struct {
	Question string       `json:"question"`
	History  []ragMessage `json:"history"`
	TopK     int          `json:"top_k"`
	Attachments []ragAttachment `json:"attachments"`
}

type ragChatResponse struct {
	Answer  string       `json:"answer"`
	Sources []ragSnippet `json:"sources"`
	Model   string       `json:"model"`
}

type ragSnippet struct {
	Source string `json:"source"`
	Text   string `json:"text"`
	Score  float64 `json:"score"`
}

type ragAttachment struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type ragDoc struct {
	Source    string    `json:"source"`
	Text      string    `json:"text"`
	Embedding []float64 `json:"embedding"`
}

type feedbackDoc struct {
	ID        int64
	Text      string
	Embedding []float64
}

type ragIndexCache struct {
	mu      sync.RWMutex
	loaded  bool
	modTime time.Time
	path    string
	docs    []ragDoc
}

var ragIndex ragIndexCache
var ragEmbedClient = &http.Client{Timeout: 60 * time.Second}

func getRagIndexPath() string {
	if p := strings.TrimSpace(os.Getenv("AUDITTA_RAG_INDEX")); p != "" {
		return p
	}
	candidates := []string{
		filepath.Join("data", "catalogo.txt"),
		filepath.Join("backend", "data", "catalogo.txt"),
		filepath.Join("data", "auditta_index.json"),
		filepath.Join("backend", "data", "auditta_index.json"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return candidates[0]
}

func loadIndexIfNeeded() ([]ragDoc, error) {
	path := getRagIndexPath()
	stat, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("index file not found: %w", err)
	}

	ragIndex.mu.RLock()
	if ragIndex.loaded && ragIndex.path == path && stat.ModTime().Equal(ragIndex.modTime) {
		docs := ragIndex.docs
		ragIndex.mu.RUnlock()
		return docs, nil
	}
	ragIndex.mu.RUnlock()

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading index: %w", err)
	}

	var docs []ragDoc
	if isTextIndex(path) {
		text := strings.TrimSpace(string(raw))
		if text == "" {
			return nil, fmt.Errorf("text index is empty")
		}
		chunkSize := envInt("RAG_TEXT_CHUNK_CHARS", 1500)
		parts := chunkText(text, chunkSize)
		docs = make([]ragDoc, 0, len(parts))
		for i, p := range parts {
			source := fmt.Sprintf("%s#%d", filepath.Base(path), i+1)
			docs = append(docs, ragDoc{Source: source, Text: p})
		}
	} else {
		var err error
		docs, err = parseRagIndex(raw)
		if err != nil {
			return nil, fmt.Errorf("parsing index: %w", err)
		}
	}
	for i := range docs {
		if len(docs[i].Embedding) > 0 {
			continue
		}
		maxEmbedChars := envInt("RAG_EMBED_MAX_CHARS", 1500)
		embText := trimText(docs[i].Text, maxEmbedChars)
		emb, err := embedText(embText)
		if err != nil {
			return nil, fmt.Errorf("embedding doc %s: %w", docs[i].Source, err)
		}
		docs[i].Embedding = emb
	}

	ragIndex.mu.Lock()
	ragIndex.loaded = true
	ragIndex.path = path
	ragIndex.modTime = stat.ModTime()
	ragIndex.docs = docs
	ragIndex.mu.Unlock()

	return docs, nil
}

func parseRagIndex(raw []byte) ([]ragDoc, error) {
	var docs []ragDoc
	if err := json.Unmarshal(raw, &docs); err == nil && len(docs) > 0 {
		return docs, nil
	}

	var legacy legacyIndex
	if err := json.Unmarshal(raw, &legacy); err != nil {
		return nil, err
	}
	if len(legacy.Componentes) == 0 {
		return nil, fmt.Errorf("legacy index has no componentes")
	}

	out := make([]ragDoc, 0, len(legacy.Componentes))
	for _, c := range legacy.Componentes {
		text := legacyComponentText(legacy.Fonte, c)
		if strings.TrimSpace(text) == "" {
			continue
		}
		source := c.Nome
		if source == "" {
			source = "legacy-component"
		}
		out = append(out, ragDoc{
			Source: source,
			Text:   text,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("legacy index has no usable content")
	}
	return out, nil
}

func legacyComponentText(fonte string, c legacyComponent) string {
	var parts []string
	if strings.TrimSpace(fonte) != "" {
		parts = append(parts, "Fonte: "+strings.TrimSpace(fonte))
	}
	if strings.TrimSpace(c.Nome) != "" {
		parts = append(parts, "Nome: "+strings.TrimSpace(c.Nome))
	}
	if strings.TrimSpace(c.Descricao) != "" {
		parts = append(parts, "Descricao: "+strings.TrimSpace(c.Descricao))
	}
	if c.Conteudo != nil {
		if b, err := json.MarshalIndent(c.Conteudo, "", "  "); err == nil && len(b) > 0 {
			parts = append(parts, "Conteudo:\n"+string(b))
		}
	}
	return strings.Join(parts, "\n")
}

func ragOllamaURL() string {
	if u := strings.TrimSpace(os.Getenv("OLLAMA_URL")); u != "" {
		return u
	}
	return "http://localhost:11434"
}

func ragOllamaEmbedModel() string {
	if m := strings.TrimSpace(os.Getenv("OLLAMA_EMBED_MODEL")); m != "" {
		return m
	}
	return "nomic-embed-text"
}

func ragOllamaChatModel() string {
	if m := strings.TrimSpace(os.Getenv("OLLAMA_CHAT_MODEL")); m != "" {
		return m
	}
	return "auditta-llama3"
}

func envInt(name string, def int) int {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			return parsed
		}
	}
	return def
}

func ragChatHTTPClient() *http.Client {
	sec := envInt("RAG_CHAT_TIMEOUT_SEC", 240)
	if sec <= 0 {
		sec = 240
	}
	return &http.Client{Timeout: time.Duration(sec) * time.Second}
}

func systemPrompt() string {
	return strings.Join([]string{
		"You are an AI agent specialized in auditing electricity bills in Brazil.",
		"The Base instructions loaded from the knowledge file are authoritative principles and must be followed.",
		"Only answer using the provided context; never invent rules.",
		"If no rule is found in the context, say: 'Nao encontrei regra no material.'",
		"Follow the given rules strictly and never assume missing data.",
		"Ask objective questions when required data is missing.",
		"Always calculate taxes as 'por dentro' and apply GD exemptions correctly.",
		"Use the provided context as the primary source of truth.",
	}, " ")
}

func trimText(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max] + "\n...[truncado]..."
}

func chunkText(s string, max int) []string {
	text := strings.TrimSpace(s)
	if text == "" {
		return []string{}
	}
	if max <= 0 || len(text) <= max {
		return []string{text}
	}
	paras := strings.Split(text, "\n\n")
	var chunks []string
	var cur strings.Builder
	curLen := 0
	flush := func() {
		if curLen == 0 {
			return
		}
		chunks = append(chunks, strings.TrimSpace(cur.String()))
		cur.Reset()
		curLen = 0
	}
	for _, p := range paras {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if curLen > 0 && curLen+2+len(p) > max {
			flush()
		}
		if curLen > 0 {
			cur.WriteString("\n\n")
			curLen += 2
		}
		if len(p) > max {
			p = trimText(p, max)
		}
		cur.WriteString(p)
		curLen += len(p)
	}
	flush()
	return chunks
}
func embedText(text string) ([]float64, error) {
	payload := map[string]string{
		"model":  ragOllamaEmbedModel(),
		"prompt": text,
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", ragOllamaURL()+"/api/embeddings", bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := ragEmbedClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama embeddings: %s", string(raw))
	}

	var out struct {
		Embedding []float64 `json:"embedding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Embedding, nil
}

func cosine(a, b []float64) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	var dot, na, nb float64
	for i := 0; i < n; i++ {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	return dot / (math.Sqrt(na)*math.Sqrt(nb) + 1e-9)
}

func tokenSet(s string) map[string]struct{} {
	out := make(map[string]struct{})
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
	for _, f := range fields {
		if len(f) < 3 {
			continue
		}
		out[f] = struct{}{}
	}
	return out
}

func overlapScore(query, text string) float64 {
	qset := tokenSet(query)
	if len(qset) == 0 {
		return 0
	}
	tset := tokenSet(text)
	var hit float64
	for k := range qset {
		if _, ok := tset[k]; ok {
			hit++
		}
	}
	return hit / float64(len(qset))
}

func fetchFeedbackDocs(db *gorm.DB, limit int) ([]feedbackDoc, error) {
	rows, err := queryGorm(db, `
		SELECT id, doc_text, embedding
		FROM AI_CHAT_FEEDBACK
		WHERE embedding IS NOT NULL
		ORDER BY created_at DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []feedbackDoc
	for rows.Next() {
		var id int64
		var text string
		var embRaw []byte
		if err := rows.Scan(&id, &text, &embRaw); err != nil {
			return nil, err
		}
		var emb []float64
		_ = json.Unmarshal(embRaw, &emb)
		if len(emb) == 0 || text == "" {
			continue
		}
		out = append(out, feedbackDoc{ID: id, Text: text, Embedding: emb})
	}
	return out, nil
}

func buildContext(question string, queryEmb []float64, topK int, attachments []ragAttachment) ([]ragSnippet, string, bool, error) {
	if topK <= 0 {
		topK = 4
	}
	maxTopK := envInt("RAG_MAX_TOPK", 4)
	if maxTopK > 0 && topK > maxTopK {
		topK = maxTopK
	}
	maxContextChars := envInt("RAG_MAX_CONTEXT_CHARS", 6000)
	maxSnippetChars := envInt("RAG_SNIPPET_MAX_CHARS", 1200)
	maxAttachmentChars := envInt("RAG_ATTACHMENT_MAX_CHARS", 2000)

	docs, err := loadIndexIfNeeded()
	if err != nil {
		return nil, "", false, err
	}

	feedbackDocs, _ := fetchFeedbackDocs(database.GormDB_App, 200)

	type scoredDoc struct {
		Source string
		Text   string
		Score  float64
	}

	scored := make([]scoredDoc, 0, len(docs)+len(feedbackDocs))
	for _, d := range docs {
		if strings.HasPrefix(d.Source, "ocr:") || strings.HasPrefix(d.Source, "chat_feedback:") {
			continue
		}
		score := cosine(queryEmb, d.Embedding)
		score += 0.08 * overlapScore(question, d.Text)
		scored = append(scored, scoredDoc{Source: d.Source, Text: d.Text, Score: score})
	}
	for _, fb := range feedbackDocs {
		score := cosine(queryEmb, fb.Embedding)
		score += 0.08 * overlapScore(question, fb.Text)
		scored = append(scored, scoredDoc{
			Source: fmt.Sprintf("feedback:%d", fb.ID),
			Text:   fb.Text,
			Score:  score,
		})
	}

	sort.Slice(scored, func(i, j int) bool { return scored[i].Score > scored[j].Score })
	if len(scored) > topK {
		scored = scored[:topK]
	}

	var snippets []ragSnippet
	var ctxParts []string
	minScore := 0.2
	if v := strings.TrimSpace(os.Getenv("RAG_MIN_SCORE")); v != "" {
		if parsed, err := strconv.ParseFloat(v, 64); err == nil {
			minScore = parsed
		}
	}

	for _, a := range attachments {
		name := strings.TrimSpace(a.Name)
		text := strings.TrimSpace(a.Text)
		if text == "" {
			continue
		}
		text = trimText(text, maxAttachmentChars)
		source := "attachment"
		if name != "" {
			source = "attachment:" + name
		}
		snippets = append(snippets, ragSnippet{Source: source, Text: text, Score: 1})
		part := fmt.Sprintf("Source: %s\nSnippet:\n%s", source, text)
		if maxContextChars <= 0 || len(strings.Join(ctxParts, "\n\n"))+len(part) <= maxContextChars {
			ctxParts = append(ctxParts, part)
		}
	}
	foundRule := false
	for _, s := range scored {
		if s.Score < minScore {
			continue
		}
		foundRule = true
		text := trimText(s.Text, maxSnippetChars)
		snippets = append(snippets, ragSnippet{Source: s.Source, Text: text, Score: s.Score})
		part := fmt.Sprintf("Source: %s\nSnippet:\n%s", s.Source, text)
		if maxContextChars > 0 && len(strings.Join(ctxParts, "\n\n"))+len(part) > maxContextChars {
			break
		}
		ctxParts = append(ctxParts, part)
	}

	context := strings.Join(ctxParts, "\n\n")
	if context == "" {
		context = "No relevant context found."
	}

	return snippets, context, foundRule, nil
}

func callOllamaChat(history []ragMessage, question, context string) (string, error) {
	msgs := make([]ragMessage, 0, len(history)+2)
	prompt := systemPrompt()
	if extra := instructionContext(); extra != "" {
		prompt = prompt + "\n\nBase instructions:\n" + extra
	}
	msgs = append(msgs, ragMessage{Role: "system", Content: prompt})
	for _, h := range history {
		role := strings.ToLower(strings.TrimSpace(h.Role))
		if role != "user" && role != "assistant" {
			continue
		}
		msgs = append(msgs, ragMessage{Role: role, Content: h.Content})
	}
	msgs = append(msgs, ragMessage{
		Role: "user",
		Content: fmt.Sprintf("Context:\n%s\n\nQuestion:\n%s", context, question),
	})

	payload := map[string]interface{}{
		"model":    ragOllamaChatModel(),
		"messages": msgs,
		"stream":   false,
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", ragOllamaURL()+"/api/chat", bytes.NewBuffer(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := ragChatHTTPClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("ollama chat: %s", string(raw))
	}

	var out struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.Message.Content), nil
}

// POST /api/v1/chat/rag
// ChatRAGHandler godoc
// @Summary      Chat RAG
// @Tags         Chat
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/rag [post]
func ChatRAGHandler(c *gin.Context) {
	var in ragChatRequest
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
		return
	}
	in.Question = strings.TrimSpace(in.Question)
	if in.Question == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question is required"})
		return
	}

	queryEmb, err := embedText(in.Question)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "embedding failed", "details": err.Error()})
		return
	}

	snippets, context, hasRule, err := buildContext(in.Question, queryEmb, in.TopK, in.Attachments)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "context build failed", "details": err.Error()})
		return
	}

	if !hasRule && len(in.Attachments) == 0 {
		c.JSON(http.StatusOK, ragChatResponse{
			Answer:  "Nao encontrei regra no material.",
			Sources: []ragSnippet{},
			Model:   ragOllamaChatModel(),
		})
		return
	}

	answer, err := callOllamaChat(in.History, in.Question, context)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "chat failed", "details": err.Error()})
		return
	}

	var uid int64
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 {
			uid = id
		}
	}
	if uid > 0 {
		sourcesJSON, _ := json.Marshal(snippets)
		_, _ = execGorm(database.GormDB_App, `
			INSERT INTO AI_CHAT_LOG (user_id, question, answer, sources, model)
			VALUES (?, ?, ?, ?, ?)`,
			uid, in.Question, answer, sourcesJSON, ragOllamaChatModel(),
		)
	}

	c.JSON(http.StatusOK, ragChatResponse{
		Answer:  answer,
		Sources: []ragSnippet{},
		Model:   ragOllamaChatModel(),
	})
}

type chatFeedbackInput struct {
	Question      string      `json:"question"`
	Answer        string      `json:"answer"`
	Rating        int         `json:"rating"`
	Comment       string      `json:"comment"`
	Sources       []ragSnippet `json:"sources"`
	Model         string      `json:"model"`
	PromptVersion string      `json:"prompt_version"`
}

// POST /api/v1/chat/feedback
// CreateChatFeedback godoc
// @Summary      Feedback do chat
// @Tags         Chat
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/feedback [post]
func CreateChatFeedback(c *gin.Context) {
	var uid int64
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 {
			uid = id
		}
	}
	if uid == 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}

	var in chatFeedbackInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
		return
	}

	in.Question = strings.TrimSpace(in.Question)
	in.Answer = strings.TrimSpace(in.Answer)
	in.Comment = strings.TrimSpace(in.Comment)
	in.Model = strings.TrimSpace(in.Model)
	in.PromptVersion = strings.TrimSpace(in.PromptVersion)

	if in.Question == "" || in.Answer == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question and answer required"})
		return
	}
	if in.Rating < 1 || in.Rating > 5 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "rating must be 1..5"})
		return
	}

	docText := strings.TrimSpace(strings.Join([]string{
		"Question: " + in.Question,
		"Answer: " + in.Answer,
		"Comment: " + in.Comment,
	}, "\n"))

	var embedding []float64
	emb, err := embedText(docText)
	if err == nil {
		embedding = emb
	}
	embJSON, _ := json.Marshal(embedding)
	sourcesJSON, _ := json.Marshal(in.Sources)

	_, err = execGorm(database.GormDB_App, `
		INSERT INTO AI_CHAT_FEEDBACK (
			user_id, question, answer, rating, comment, sources, model, prompt_version, doc_text, embedding
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, uid, in.Question, in.Answer, in.Rating, in.Comment, sourcesJSON, in.Model, in.PromptVersion, docText, embJSON)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save feedback"})
		return
	}

	if in.Rating >= 4 {
		content := map[string]interface{}{
			"question":   in.Question,
			"answer":     in.Answer,
			"rating":     in.Rating,
			"comment":    in.Comment,
			"sources":    in.Sources,
			"model":      in.Model,
			"created_at": nowISO(),
		}
		if err := appendLegacyComponent("chat_feedback:"+fmt.Sprint(time.Now().Unix()), "Resposta validada por feedback", content); err != nil {
			log.Printf("failed to append feedback to auditta_index: %v", err)
		}
	}

	c.JSON(http.StatusCreated, gin.H{"ok": true})
}

