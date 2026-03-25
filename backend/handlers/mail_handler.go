package handlers

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
	"github.com/jung-kurt/gofpdf"
	"gorm.io/gorm"
	"golang.org/x/text/encoding/charmap"
)

// mailAllowedUsers carregado via env MAIL_ALLOWED_USERS (emails separados por vírgula).
// Fallback: lista padrão para compatibilidade.
var mailAllowedUsers = func() map[string]bool {
	m := map[string]bool{}
	if v := os.Getenv("MAIL_ALLOWED_USERS"); v != "" {
		for _, email := range strings.Split(v, ",") {
			if e := strings.TrimSpace(email); e != "" {
				m[e] = true
			}
		}
		return m
	}
	// fallback padrão
	for _, e := range []string{
		"alisson.rodrigues@amee.com.br",
		"luana.nascimento@amee.com.br",
		"eliane.araujo@amee.com.br",
		"paulo.passos@amee.com.br",
		"eduardo.navarro@amee.com.br",
	} {
		m[e] = true
	}
	return m
}()

var mailUpsertMu sync.Mutex
var powerbiViewMu sync.Mutex
var powerbiViewChecked bool
var powerbiViewExists bool

func hasPowerBIProcessosView(db *gorm.DB) bool {
	powerbiViewMu.Lock()
	defer powerbiViewMu.Unlock()
	if powerbiViewChecked {
		return powerbiViewExists
	}
	var cnt int
	if err := db.Raw(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = 'VW_POWERBI_PROCESSOS'`,
	).Row().Scan(&cnt); err == nil && cnt > 0 {
		powerbiViewExists = true
	}
	powerbiViewChecked = true
	return powerbiViewExists
}

func isLockErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "lock wait timeout") ||
		strings.Contains(msg, "deadlock") ||
		strings.Contains(msg, "error 1205") ||
		strings.Contains(msg, "error 1213")
}

func execWithRetry(tx *gorm.DB, query string, args ...interface{}) (sql.Result, error) {
	var lastErr error
	for i := 0; i < 3; i++ {
		res, err := execGorm(tx, query, args...)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if !isLockErr(err) {
			return res, err
		}
		time.Sleep(time.Duration(150*(i+1)) * time.Millisecond)
	}
	return nil, lastErr
}

type MailMessageSummary struct {
	ID                string `json:"id"`
	Subject           string `json:"subject"`
	FromEmail         string `json:"from_email"`
	FromName          string `json:"from_name"`
	To               []string `json:"to"`
	Cc               []string `json:"cc"`
	ReceivedAt        string `json:"received_at"`
	Snippet           string `json:"snippet"`
	HasAttachments    bool   `json:"has_attachments"`
	IsRead            bool   `json:"is_read"`
	IsReadLocal       bool   `json:"is_read_local"`
	ReadBy            []string `json:"read_by,omitempty"`
	FolderID          string `json:"folder_id"`
	InternetMessageID string `json:"internet_message_id"`
	ThreadID          string `json:"thread_id"`
	LinkedProcessID   *int64 `json:"linked_processo_id,omitempty"`
}

type MailMessageDetail struct {
	MailMessageSummary
	BodyType    string `json:"body_type"`
	BodyContent string `json:"body_content"`
}

type MailAISuggestion struct {
	Assunto string `json:"assunto"`
	Corpo   string `json:"corpo"`
}

type MailAIResult struct {
	Resumo         string           `json:"resumo"`
	Avaliacao      string           `json:"avaliacao"`
	ProximosPassos []string         `json:"proximos_passos"`
	SugestaoEmail  MailAISuggestion `json:"sugestao_email"`
}

func getUserEmailFromContext(c *gin.Context) (string, bool) {
	uidAny, ok := c.Get("userID")
	if !ok {
		return "", false
	}
	uid, ok := uidAny.(int64)
	if !ok || uid <= 0 {
		return "", false
	}
	var email string
	if err := queryRowGorm(database.GormDB_App, "SELECT email FROM DM_USUARIO WHERE id_usuario = ?", uid).Scan(&email); err != nil {
		return "", false
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return "", false
	}
	return email, true
}

func getMailUserIDFromContext(c *gin.Context) (int64, bool) {
	uidAny, ok := c.Get("userID")
	if !ok {
		return 0, false
	}
	uid, ok := uidAny.(int64)
	if !ok || uid <= 0 {
		return 0, false
	}
	return uid, true
}

func ensureMailAccess(c *gin.Context) bool {
	email, ok := getUserEmailFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return false
	}
	if !mailAllowedUsers[email] {
		c.JSON(http.StatusForbidden, gin.H{"error": "Usuário sem permissão para a caixa de e-mail"})
		return false
	}
	return true
}

// GET /api/mail/folders
// MailFolders godoc
// @Summary      Lista pastas de e-mail
// @Tags         Mail
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/folders [get]
func MailFolders(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	folders, err := services.ListMailFolders()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"folders": folders})
}

// GET /api/mail/messages?folderId=...&q=...&unread=...
// MailMessages godoc
// @Summary      Lista mensagens de e-mail
// @Tags         Mail
// @Param        folderId  query  string  false  "ID da pasta"
// @Param        q         query  string  false  "Busca"
// @Param        unread    query  bool    false  "Somente não lidos"
// @Param        limit     query  int     false  "Limite"
// @Param        skip      query  int     false  "Offset"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages [get]
func MailMessages(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	folderID := strings.TrimSpace(c.Query("folderId"))
	if folderID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folderId é obrigatório"})
		return
	}
	q := strings.TrimSpace(c.Query("q"))
	var unread *bool
	if v := strings.TrimSpace(c.Query("unread")); v != "" {
		b := v == "1" || strings.EqualFold(v, "true")
		unread = &b
	}
	limit := 50
	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	offset := 0
	if v := strings.TrimSpace(c.Query("offset")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	// Sempre busca do Graph API (dados frescos); DB cache apenas como fallback se Graph falhar
	var msgs []services.GraphMessage
	var err error
	msgs, err = services.ListMailMessages(folderID, q, unread, limit, offset)
	if err != nil && strings.TrimSpace(q) == "" {
		msgs, err = listMailMessagesCached(database.GormDB_App, folderID, q, limit, offset)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	linked := lookupLinkedProcessIDs(msgs)
	userID, _ := getMailUserIDFromContext(c)
	readLocal := lookupMailReads(userID, msgs)
	readBy := lookupMailReadUsers(msgs)
	out := make([]MailMessageSummary, 0, len(msgs))
	for _, m := range msgs {
		item := MailMessageSummary{
			ID:                m.ID,
			Subject:           m.Subject,
			FromEmail:         m.FromEmail,
			FromName:          m.FromName,
			To:               m.To,
			Cc:               m.Cc,
			ReceivedAt:        m.ReceivedAt,
			Snippet:           m.BodyPreview,
			HasAttachments:    m.HasAttachments,
			IsRead:            m.IsRead,
			IsReadLocal:       readLocal[m.ID],
			ReadBy:            readBy[m.ID],
			FolderID:          m.FolderID,
			InternetMessageID: m.InternetMessageID,
			ThreadID:          m.ConversationID,
		}
		if pid, ok := linked[m.ID]; ok {
			item.LinkedProcessID = &pid
		}
		out = append(out, item)
	}
	// Persist in background to avoid slowing down listing.
	go func(items []services.GraphMessage) {
		_ = upsertMailMessages(items)
	}(msgs)
	c.JSON(http.StatusOK, gin.H{"messages": out})
}

// GET /api/mail/messages/:id
// MailMessageByID godoc
// @Summary      Detalhe de mensagem
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id} [get]
func MailMessageByID(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	msg, err := services.GetMailMessage(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	userID, _ := getMailUserIDFromContext(c)
	isLocal := isMailReadLocal(userID, id)
	readBy := lookupMailReadUsers([]services.GraphMessage{{ID: id}})
	item := MailMessageDetail{
		MailMessageSummary: MailMessageSummary{
			ID:                msg.ID,
			Subject:           msg.Subject,
			FromEmail:         msg.FromEmail,
			FromName:          msg.FromName,
			To:               msg.To,
			Cc:               msg.Cc,
			ReceivedAt:        msg.ReceivedAt,
			Snippet:           msg.BodyPreview,
			HasAttachments:    msg.HasAttachments,
			IsRead:            msg.IsRead,
			IsReadLocal:       isLocal,
			ReadBy:            readBy[id],
			FolderID:          msg.FolderID,
			InternetMessageID: msg.InternetMessageID,
			ThreadID:          msg.ConversationID,
		},
		BodyType:    msg.BodyType,
		BodyContent: msg.BodyContent,
	}
	if pid, ok := findProcessByGraphMessageID(id); ok {
		item.LinkedProcessID = &pid
	}
	c.JSON(http.StatusOK, item)
}

// GET /api/mail/messages/:id/mime
// MailMessageMime godoc
// @Summary      Baixa MIME (.eml)
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Produce      octet-stream
// @Success      200  {file}  file
// @Failure      401  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/mime [get]
func MailMessageMime(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	data, err := services.GetMailMessageMime(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.eml\"", id))
	c.Data(http.StatusOK, "application/octet-stream", data)
}

// GET /api/mail/messages/:id/attachments
// MailMessageAttachments godoc
// @Summary      Lista anexos
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Produce      json
// @Success      200  {array}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/attachments [get]
func MailMessageAttachments(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	att, err := services.ListMailAttachments(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"attachments": att})
}

// GET /api/mail/messages/:id/attachments/:attId/download
// MailMessageAttachmentDownload godoc
// @Summary      Baixa anexo
// @Tags         Mail
// @Param        id     path  string  true  "ID da mensagem"
// @Param        attId  path  string  true  "ID do anexo"
// @Produce      octet-stream
// @Success      200  {file}  file
// @Failure      401  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/attachments/{attId}/download [get]
func MailMessageAttachmentDownload(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	attID := strings.TrimSpace(c.Param("attId"))
	if id == "" || attID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id e attId são obrigatórios"})
		return
	}
	name, ct, data, err := services.DownloadMailAttachment(id, attID)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "não suportado") || strings.Contains(strings.ToLower(err.Error()), "nao suportado") {
			c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	if name == "" {
		name = "anexo"
	}
	c.Header("Content-Type", ct)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", name))
	c.Data(http.StatusOK, ct, data)
}

// POST /api/mail/messages/:id/move
// MailMessageMove godoc
// @Summary      Move mensagem de pasta
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       multipart/form-data
// @Produce      json
// @Param        to        formData  string  true   "Destinatários (separar por ';')"
// @Param        cc        formData  string  false  "Cópia (separar por ';')"
// @Param        bcc       formData  string  false  "Cópia oculta (separar por ';')"
// @Param        subject   formData  string  true   "Assunto"
// @Param        body      formData  string  true   "Corpo"
// @Param        body_type formData  string  false  "Tipo do corpo (text|html)"
// @Param        attachments formData file   false  "Anexos"
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/move [post]
func MailMessageMove(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	var body struct {
		FolderID string `json:"folderId"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.FolderID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folderId é obrigatório"})
		return
	}
	if err := services.MoveMailMessage(id, strings.TrimSpace(body.FolderID)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/mail/messages/:id/read
// MailMessageSetRead godoc
// @Summary      Marca mensagem como lida/não lida (Graph)
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/read [post]
func MailMessageSetRead(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	var body struct {
		IsRead bool `json:"isRead"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "isRead é obrigatório"})
		return
	}
	if err := services.SetMailRead(id, body.IsRead); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/mail/messages/:id/read-local
// MailMessageSetReadLocal godoc
// @Summary      Marca mensagem como lida/não lida (local)
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/read-local [post]
func MailMessageSetReadLocal(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	userID, ok := getMailUserIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	if err := markMailReadLocal(userID, id); err != nil {
		log.Printf("[mail] mark read-local failed user_id=%d msg_id=%s err=%v", userID, id, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/mail/messages/:id/analisar-ia
// MailMessageAnalyzeIA godoc
// @Summary      Analisar e-mail com IA
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/analisar-ia [post]
func MailMessageAnalyzeIA(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}

	detail, err := services.GetMailMessage(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao obter mensagem"})
		return
	}

	// tenta persistir para manter thread local
	tx := database.GormDB_App.Begin()
	if tx.Error == nil {
		_, _ = upsertMailMessageTx(tx, detail)
		_ = tx.Commit().Error
	}

	threadLines := buildMailThreadContext(detail.ConversationID)
	currentBody := trimText(htmlToText(detail.BodyContent), 4000)
	currentSnippet := trimText(detail.BodyPreview, 800)

	procCtx := ""
	histCtx := ""
	pid, ok := findProcessByGraphMessageID(id)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Mensagem não vinculada a processo"})
		return
	}
	procCtx = buildProcessContext(pid)
	histCtx = buildProcessHistoryContext(pid, 20)

	question := fmt.Sprintf(`Analise o caso abaixo e entregue:
1) Resumo claro do histórico do e-mail e (se existir) do processo.
2) AvaliaÃ§ão do status e próximos passos recomendados.
3) Sugestão de resposta por e-mail.

Responda em JSON estrito no formato:
{"resumo":"...","avaliacao":"...","proximos_passos":["..."],"sugestao_email":{"assunto":"...","corpo":"..."}}

Contexto do processo:
%s

Histórico do processo:
%s

Histórico de e-mails (thread):
%s

Mensagem atual:
Assunto: %s
De: %s <%s>
Data: %s
Resumo: %s
Corpo:
%s
`,
		procCtx,
		histCtx,
		threadLines,
		detail.Subject,
		detail.FromName,
		detail.FromEmail,
		detail.ReceivedAt,
		currentSnippet,
		currentBody,
	)

	queryEmb, err := embedText(question)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "embedding failed", "details": err.Error()})
		return
	}
	topK := envInt("MAIL_AI_TOPK", 6)
	snippets, context, _, err := buildContext(question, queryEmb, topK, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "context build failed", "details": err.Error()})
		return
	}
	answer, err := callOllamaChat(nil, question, context)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "chat failed", "details": err.Error()})
		return
	}

	var parsed MailAIResult
	if err := json.Unmarshal([]byte(answer), &parsed); err != nil {
		parsed = MailAIResult{Resumo: strings.TrimSpace(answer)}
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"result":  parsed,
		"model":   ragOllamaChatModel(),
		"sources": snippets,
		"raw":     answer,
	})
}

// POST /api/mail/messages/:id/reply
// MailMessageReply godoc
// @Summary      Responder e-mail
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/reply [post]
func MailMessageReply(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	var body struct {
		Comment string `json:"comment"`
	}
	_ = c.ShouldBindJSON(&body)
	body.Comment = appendMailSignature(body.Comment)
	if err := services.ReplyMailMessage(id, body.Comment, false); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/mail/messages/:id/reply-all
// MailMessageReplyAll godoc
// @Summary      Responder a todos
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/reply-all [post]
func MailMessageReplyAll(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	var body struct {
		Comment string `json:"comment"`
	}
	_ = c.ShouldBindJSON(&body)
	body.Comment = appendMailSignature(body.Comment)
	if err := services.ReplyMailMessage(id, body.Comment, true); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/mail/messages/:id/forward
// MailMessageForward godoc
// @Summary      Encaminhar e-mail
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/forward [post]
func MailMessageForward(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	var body struct {
		To      string `json:"to"`
		Comment string `json:"comment"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.To) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "to é obrigatório"})
		return
	}
	body.Comment = appendMailSignature(body.Comment)
	if err := services.ForwardMailMessage(id, body.To, body.Comment); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/mail/send
// MailSend godoc
// @Summary      Enviar e-mail
// @Tags         Mail
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/send [post]
func MailSend(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}

	subject := strings.TrimSpace(c.PostForm("subject"))
	body := strings.TrimSpace(c.PostForm("body"))
	bodyType := strings.TrimSpace(c.PostForm("body_type"))
	toRaw := strings.TrimSpace(c.PostForm("to"))
	ccRaw := strings.TrimSpace(c.PostForm("cc"))
	bccRaw := strings.TrimSpace(c.PostForm("bcc"))

	to := parseRecipients(toRaw)
	if len(to) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Destinatário obrigatório"})
		return
	}
	cc := parseRecipients(ccRaw)
	bcc := parseRecipients(bccRaw)

	var attList []services.MailSendAttachment
	if form, err := c.MultipartForm(); err == nil && form != nil {
		files := form.File["attachments"]
		for _, fh := range files {
			if fh == nil {
				continue
			}
			if fh.Size > 10*1024*1024 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Anexo excede 10MB"})
				return
			}
			f, err := fh.Open()
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Falha ao abrir anexo"})
				return
			}
			data, err := io.ReadAll(f)
			_ = f.Close()
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Falha ao ler anexo"})
				return
			}
			ct := fh.Header.Get("Content-Type")
			if ct == "" {
				ct = "application/octet-stream"
			}
			attList = append(attList, services.MailSendAttachment{
				Name:        fh.Filename,
				ContentType: ct,
				Content:     data,
			})
		}
	}

	body = appendMailSignature(body)
	if bodyType == "" {
		bodyType = "HTML"
	}
	msgID, err := services.SendMailMessage(subject, body, bodyType, to, cc, bcc, attList)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "message_id": msgID})
}

// POST /api/mail/messages/:id/link-process
// MailMessageLinkProcess godoc
// @Summary      Vincula e-mail a processo
// @Tags         Mail
// @Param        id   path   string  true  "ID da mensagem"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/messages/{id}/link-process [post]
func MailMessageLinkProcess(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id é obrigatório"})
		return
	}
	var body struct {
		ProcessoID           int64  `json:"processoId"`
		AttachBodyPDF        bool   `json:"attachBodyPdf"`
		AttachAttachments    bool   `json:"attachAttachments"`
		MoveToLinkedFolderID string `json:"moveToLinkedFolderId"`
		Note                 string `json:"note"`
		MoveProcess          bool   `json:"moveProcess"`
		Move                struct {
			Coluna     string `json:"coluna"`
			Etapa      string `json:"etapa"`
			Sub        string `json:"sub"`
			Comentario string `json:"comentario"`
		} `json:"move"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.ProcessoID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "processoId é obrigatório"})
		return
	}
	if body.MoveProcess {
		if strings.TrimSpace(body.Move.Etapa) == "" || strings.TrimSpace(body.Move.Sub) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "etapa e sub-etapa são obrigatórias para vincular"})
			return
		}
	}

	userID, _ := c.Get("userID")
	createdBy, _ := userID.(int64)

	msg, err := services.GetMailMessage(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	mailID, err := upsertMailMessageTx(tx, msg)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha ao salvar mail_messages: %v", err)})
		return
	}

	if err := linkProcessMailTx(tx, body.ProcessoID, mailID, createdBy, body.Note); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Auto-link: vincula toda a conversa (thread) ao mesmo processo
	if strings.TrimSpace(msg.ConversationID) != "" {
		if err := linkThreadMailsTx(tx, body.ProcessoID, msg.ConversationID, createdBy, "auto-link thread"); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	warnings := make([]string, 0)
	if body.AttachBodyPDF {
		if err := attachBodyPDFToProcess(tx, body.ProcessoID, mailID, msg); err != nil {
			warnings = append(warnings, fmt.Sprintf("Falha ao anexar PDF do corpo: %v", err))
		}
	}

	if body.AttachAttachments {
		attWarnings, err := attachMailFilesToProcess(tx, body.ProcessoID, mailID, id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		warnings = append(warnings, attWarnings...)
	}

	histID := int64(0)
	if body.MoveProcess {
		histID, err = registerEmailMoveHistory(tx, body.ProcessoID, createdBy, body.Note, body.Move.Etapa, body.Move.Sub, body.Move.Comentario)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else {
		histID, err = registerProcessHistory(tx, body.ProcessoID, createdBy, body.Note)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao finalizar transação"})
		return
	}

	if strings.TrimSpace(body.MoveToLinkedFolderID) != "" {
		_ = services.MoveMailMessage(id, strings.TrimSpace(body.MoveToLinkedFolderID))
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":              true,
		"mail_message_id": mailID,
		"history_ok":      histID > 0,
		"history_id":      histID,
		"warnings":        warnings,
	})
}

// GET /api/mail/processes/search?q=...
// MailProcessSearch godoc
// @Summary      Busca processos para vínculo
// @Tags         Mail
// @Param        q  query  string  false  "Busca"
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      401  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/mail/processes/search [get]
func MailProcessSearch(c *gin.Context) {
	if !ensureMailAccess(c) {
		return
	}
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q é obrigatório"})
		return
	}
	limit := 20
	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 100 {
			limit = n
		}
	}
	like := "%" + q + "%"
	processID := int64(0)
	if n, err := strconv.ParseInt(q, 10, 64); err == nil && n > 0 {
		processID = n
	}
	query := "SELECT\n" +
		"  id_processo,\n" +
		"  Cliente,\n" +
		"  UC,\n" +
		"  CNPJ,\n" +
		"  Concessionaria,\n" +
		"  `Etapa Atual`,\n" +
		"  `Coluna Kanban Atual`,\n" +
		"  `Ultima Etapa`,\n" +
		"  `Ultima Sub Etapa`,\n" +
		"  `Status Analise`,\n" +
		"  `Data Ultima Movimentacao`,\n" +
		"  Prioridade,\n" +
		"  `Suspenso`\n" +
		"FROM VW_POWERBI_PROCESSOS\n" +
		"WHERE (Cliente LIKE ? OR UC LIKE ? OR CNPJ LIKE ? OR Concessionaria LIKE ? OR id_processo = ?)\n" +
		"ORDER BY id_processo DESC\n" +
		"LIMIT ?"
	out := make([]map[string]any, 0)
	useView := hasPowerBIProcessosView(database.GormDB_App)
	var err error
	var rows *sql.Rows
	if useView {
		rows, err = queryGorm(database.GormDB_App, query, like, like, like, like, processID, limit)
	}
	if useView && err == nil {
		defer rows.Close()
		for rows.Next() {
			var idp int64
			var cliente, uc, cnpj, concess sql.NullString
			var etapaAtual, colunaKanban, ultimaEtapa, ultimaSub, statusAnalise, prioridade sql.NullString
			var dataUlt sql.NullString
			var suspenso sql.NullInt64
			if err := rows.Scan(
				&idp,
				&cliente,
				&uc,
				&cnpj,
				&concess,
				&etapaAtual,
				&colunaKanban,
				&ultimaEtapa,
				&ultimaSub,
				&statusAnalise,
				&dataUlt,
				&prioridade,
				&suspenso,
			); err == nil {
				out = append(out, map[string]any{
					"id_processo":      idp,
					"cliente":          cliente.String,
					"uc":               uc.String,
					"cnpj":             cnpj.String,
					"concessionaria":   concess.String,
					"etapa_atual":      etapaAtual.String,
					"coluna_kanban":    colunaKanban.String,
					"ultima_etapa":     ultimaEtapa.String,
					"ultima_sub_etapa": ultimaSub.String,
					"status_analise":   statusAnalise.String,
					"data_ultima_mov":  dataUlt.String,
					"prioridade":       prioridade.String,
					"suspenso":         suspenso.Int64,
				})
			}
		}
	}

	// Fallback quando a view não existe ou falhou
	if !useView || err != nil {
		fbQuery := `
SELECT
  p.id_processo,
  COALESCE(r.cliente,'')        AS cliente,
  COALESCE(r.uc,'')             AS uc,
  COALESCE(r.cnpj,'')           AS cnpj,
  COALESCE(r.concessionaria,'') AS concessionaria,
  COALESCE(e.etapa,'')          AS etapa_atual,
  COALESCE(kc.nome_coluna,'')   AS coluna_kanban,
  COALESCE(h.etapa_nova,'')     AS ultima_etapa,
  COALESCE(h.sub_etapa,'')      AS ultima_sub_etapa,
  ''                            AS status_analise,
  COALESCE(DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s'), '') AS data_ultima_mov,
  ''                            AS prioridade,
  COALESCE(p.suspenso,0)        AS suspenso
FROM FT_PROCESSOS p
JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
LEFT JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban
LEFT JOIN (
  SELECT h1.id_requisicao, h1.etapa_nova, h1.sub_etapa, h1.data_movimentacao
  FROM FT_HISTORICO_MOVIMENTACOES h1
  JOIN (
    SELECT id_requisicao, MAX(id_historico) AS max_id
    FROM FT_HISTORICO_MOVIMENTACOES
    GROUP BY id_requisicao
  ) h2 ON h2.id_requisicao = h1.id_requisicao AND h2.max_id = h1.id_historico
) h ON h.id_requisicao = p.id_processo
WHERE (r.cliente LIKE ? OR r.uc LIKE ? OR r.cnpj LIKE ? OR r.concessionaria LIKE ? OR p.id_processo = ?)
ORDER BY p.id_processo DESC
LIMIT ?`
		fbRows, fbErr := queryGorm(database.GormDB_App, fbQuery, like, like, like, like, processID, limit)
		if fbErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "falha na busca"})
			return
		}
		defer fbRows.Close()
		out = make([]map[string]any, 0)
		for fbRows.Next() {
			var idp int64
			var cliente, uc, cnpj, concess, etapaAtual, colunaKanban, ultimaEtapa, ultimaSub, statusAnalise, prioridade, dataUlt sql.NullString
			var suspenso sql.NullInt64
			if err := fbRows.Scan(
				&idp,
				&cliente,
				&uc,
				&cnpj,
				&concess,
				&etapaAtual,
				&colunaKanban,
				&ultimaEtapa,
				&ultimaSub,
				&statusAnalise,
				&dataUlt,
				&prioridade,
				&suspenso,
			); err == nil {
				out = append(out, map[string]any{
					"id_processo":      idp,
					"cliente":          cliente.String,
					"uc":               uc.String,
					"cnpj":             cnpj.String,
					"concessionaria":   concess.String,
					"etapa_atual":      etapaAtual.String,
					"coluna_kanban":    colunaKanban.String,
					"ultima_etapa":     ultimaEtapa.String,
					"ultima_sub_etapa": ultimaSub.String,
					"status_analise":   statusAnalise.String,
					"data_ultima_mov":  dataUlt.String,
					"prioridade":       prioridade.String,
					"suspenso":         suspenso.Int64,
				})
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"results": out})
}

func lookupLinkedProcessIDs(msgs []services.GraphMessage) map[string]int64 {
	if len(msgs) == 0 {
		return map[string]int64{}
	}
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return map[string]int64{}
	}
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = strings.TrimSuffix(placeholders, ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := queryGorm(database.GormDB_App, `
		SELECT pm.processo_id, m.graph_message_id
		FROM process_mail_links pm
		JOIN mail_messages m ON m.id = pm.mail_message_id
		WHERE m.graph_message_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return map[string]int64{}
	}
	defer rows.Close()
	out := make(map[string]int64)
	for rows.Next() {
		var pid int64
		var graphID string
		if err := rows.Scan(&pid, &graphID); err == nil {
			out[graphID] = pid
		}
	}
	return out
}

func upsertMailMessages(msgs []services.GraphMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	// Serializa upserts para reduzir lock waits em mail_messages
	mailUpsertMu.Lock()
	defer mailUpsertMu.Unlock()
	// Lock global no MySQL para evitar concorrência entre múltiplos containers
	var gotLock int
	if err := database.GormDB_App.Raw("SELECT GET_LOCK(?, ?)", "mail_messages_upsert", 10).Row().Scan(&gotLock); err != nil {
		return err
	}
	if gotLock != 1 {
		return fmt.Errorf("nao foi possivel obter lock de email")
	}
	defer func() {
		_, _ = execGorm(database.GormDB_App, "SELECT RELEASE_LOCK(?)", "mail_messages_upsert")
	}()
	for _, m := range msgs {
		if _, err := upsertMailMessageTx(database.GormDB_App, &services.GraphMessageDetail{
			ID:                m.ID,
			InternetMessageID: m.InternetMessageID,
			ConversationID:    m.ConversationID,
			Subject:           m.Subject,
			FromEmail:         m.FromEmail,
			FromName:          m.FromName,
			To:               m.To,
			Cc:               m.Cc,
			ReceivedAt:        m.ReceivedAt,
			BodyPreview:       m.BodyPreview,
			HasAttachments:    m.HasAttachments,
			IsRead:            m.IsRead,
			FolderID:          m.FolderID,
			BodyType:          "",
			BodyContent:       "",
		}); err != nil {
			return err
		}
	}
	return nil
}

func listMailMessagesCached(db *gorm.DB, folderID, q string, limit, offset int) ([]services.GraphMessage, error) {
	if db == nil || strings.TrimSpace(folderID) == "" {
		return nil, fmt.Errorf("cache indisponível")
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	where := "WHERE folder_id = ?"
	args := []any{folderID}
	if strings.TrimSpace(q) != "" {
		like := "%" + q + "%"
		where += " AND (subject LIKE ? OR from_email LIKE ? OR from_name LIKE ? OR snippet LIKE ?)"
		args = append(args, like, like, like, like)
	}
	args = append(args, limit, offset)
	rows, err := queryGorm(db, `
		SELECT graph_message_id, internet_message_id, subject, from_email, from_name, to_json, cc_json,
		       received_at, snippet, has_attachments, thread_id, folder_id, raw_meta_json
		  FROM mail_messages
		`+where+`
		 ORDER BY received_at DESC, id DESC
		 LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]services.GraphMessage, 0, limit)
	for rows.Next() {
		var (
			graphID, internetID, subject, fromEmail, fromName, toJSON, ccJSON, snippet, threadID, folder sql.NullString
			receivedAt sql.NullTime
			hasAttach  sql.NullInt64
			rawMeta    sql.NullString
		)
		if err := rows.Scan(
			&graphID, &internetID, &subject, &fromEmail, &fromName, &toJSON, &ccJSON,
			&receivedAt, &snippet, &hasAttach, &threadID, &folder, &rawMeta,
		); err != nil {
			continue
		}
		var toList, ccList []string
		if toJSON.Valid && toJSON.String != "" {
			_ = json.Unmarshal([]byte(toJSON.String), &toList)
		}
		if ccJSON.Valid && ccJSON.String != "" {
			_ = json.Unmarshal([]byte(ccJSON.String), &ccList)
		}
		isRead := false
		if rawMeta.Valid && rawMeta.String != "" {
			var meta map[string]any
			if json.Unmarshal([]byte(rawMeta.String), &meta) == nil {
				if v, ok := meta["is_read"]; ok {
					if b, ok := v.(bool); ok {
						isRead = b
					}
				}
			}
		}
		out = append(out, services.GraphMessage{
			ID:                graphID.String,
			InternetMessageID: internetID.String,
			ConversationID:    threadID.String,
			Subject:           subject.String,
			FromEmail:         fromEmail.String,
			FromName:          fromName.String,
			To:                toList,
			Cc:                ccList,
			ReceivedAt: func() string {
				if receivedAt.Valid {
					return receivedAt.Time.Format("2006-01-02T15:04:05Z")
				}
				return ""
			}(),
			BodyPreview:    snippet.String,
			HasAttachments: hasAttach.Valid && hasAttach.Int64 == 1,
			IsRead:         isRead,
			FolderID:       folder.String,
		})
	}
	return out, nil
}

func upsertMailMessageTx(tx *gorm.DB, msg *services.GraphMessageDetail) (int64, error) {
	if msg == nil || msg.ID == "" {
		return 0, fmt.Errorf("mensagem inválida")
	}
	trunc := func(s string, n int) string {
		if n <= 0 || s == "" {
			return s
		}
		r := []rune(s)
		if len(r) <= n {
			return s
		}
		return string(r[:n])
	}
	toJSON, _ := json.Marshal(msg.To)
	ccJSON, _ := json.Marshal(msg.Cc)
	rawMeta, _ := json.Marshal(msg)
	graphID := trunc(msg.ID, 200)
	internetID := trunc(msg.InternetMessageID, 255)
	subject := msg.Subject
	fromEmail := trunc(msg.FromEmail, 255)
	fromName := trunc(msg.FromName, 255)
	threadID := trunc(msg.ConversationID, 255)
	folderID := trunc(msg.FolderID, 200)
	_, err := execWithRetry(tx, `
		INSERT INTO mail_messages
		  (graph_message_id, internet_message_id, subject, from_email, from_name, to_json, cc_json,
		   received_at, snippet, has_attachments, thread_id, folder_id, raw_meta_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
		  internet_message_id=VALUES(internet_message_id),
		  subject=VALUES(subject),
		  from_email=VALUES(from_email),
		  from_name=VALUES(from_name),
		  to_json=VALUES(to_json),
		  cc_json=VALUES(cc_json),
		  received_at=VALUES(received_at),
		  snippet=VALUES(snippet),
		  has_attachments=VALUES(has_attachments),
		  thread_id=VALUES(thread_id),
		  folder_id=VALUES(folder_id),
		  raw_meta_json=VALUES(raw_meta_json)`,
		graphID, internetID, subject, fromEmail, fromName, string(toJSON), string(ccJSON),
		parseDateTime(msg.ReceivedAt), msg.BodyPreview, msg.HasAttachments, threadID, folderID, string(rawMeta),
	)
	if err != nil {
		// fallback: remove raw_meta_json if DB rejects large/invalid JSON
		_, err2 := execWithRetry(tx, `
			INSERT INTO mail_messages
			  (graph_message_id, internet_message_id, subject, from_email, from_name, to_json, cc_json,
			   received_at, snippet, has_attachments, thread_id, folder_id, raw_meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
			ON DUPLICATE KEY UPDATE
			  internet_message_id=VALUES(internet_message_id),
			  subject=VALUES(subject),
			  from_email=VALUES(from_email),
			  from_name=VALUES(from_name),
			  to_json=VALUES(to_json),
			  cc_json=VALUES(cc_json),
			  received_at=VALUES(received_at),
			  snippet=VALUES(snippet),
			  has_attachments=VALUES(has_attachments),
			  thread_id=VALUES(thread_id),
			  folder_id=VALUES(folder_id)`,
			graphID, internetID, subject, fromEmail, fromName, string(toJSON), string(ccJSON),
			parseDateTime(msg.ReceivedAt), msg.BodyPreview, msg.HasAttachments, threadID, folderID,
		)
		if err2 != nil {
			return 0, err
		}
	}
	var id int64
	if err := queryRowGorm(tx, `SELECT id FROM mail_messages WHERE graph_message_id = ?`, graphID).Scan(&id); err != nil {
		return 0, err
	}
	if threadID != "" {
		if pid, ok := findProcessByThreadIDTx(tx, threadID); ok {
			if !hasProcessMailLinkTx(tx, pid, id) {
				_ = linkProcessMailTx(tx, pid, id, 0, "auto-link thread")
				_, _ = registerProcessHistory(tx, pid, 0, "Resposta de e-mail vinculada automaticamente")
			}
		}
	}
	if !hasAnyLinkForMailTx(tx, id) {
		text := strings.TrimSpace(msg.Subject + " " + msg.BodyPreview)
		if pid, ok := findProcessByUCTx(tx, text); ok {
			_ = linkProcessMailTx(tx, pid, id, 0, "auto-link uc")
			_, _ = registerProcessHistory(tx, pid, 0, "E-mail vinculado automaticamente por UC")
		}
	}
	return id, nil
}

func lookupMailReads(userID int64, msgs []services.GraphMessage) map[string]bool {
	out := map[string]bool{}
	if userID <= 0 || len(msgs) == 0 {
		return out
	}
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		if m.ID == "" {
			continue
		}
		ids = append(ids, m.ID)
	}
	if len(ids) == 0 {
		return out
	}
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = strings.TrimSuffix(placeholders, ",")
	args := make([]any, 0, len(ids)+1)
	args = append(args, userID)
	for _, id := range ids {
		args = append(args, id)
	}
	query := fmt.Sprintf(
		`SELECT graph_message_id FROM MAIL_MESSAGE_READS WHERE user_id = ? AND graph_message_id IN (%s)`,
		placeholders,
	)
	rows, err := queryGorm(database.GormDB_App, query, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			out[id] = true
		}
	}
	return out
}

func lookupMailReadUsers(msgs []services.GraphMessage) map[string][]string {
	out := map[string][]string{}
	if len(msgs) == 0 {
		return out
	}
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		if m.ID == "" {
			continue
		}
		ids = append(ids, m.ID)
	}
	if len(ids) == 0 {
		return out
	}
	placeholders := strings.Repeat("?,", len(ids))
	placeholders = strings.TrimSuffix(placeholders, ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	query := fmt.Sprintf(`
		SELECT r.graph_message_id, COALESCE(u.nome_usuario, u.email, '') AS nome
		FROM MAIL_MESSAGE_READS r
		LEFT JOIN DM_USUARIO u ON u.id_usuario = r.user_id
		WHERE r.graph_message_id IN (%s)
		ORDER BY r.read_at ASC`, placeholders)
	rows, err := queryGorm(database.GormDB_App, query, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var msgID string
		var nome string
		if err := rows.Scan(&msgID, &nome); err != nil {
			continue
		}
		nome = strings.TrimSpace(nome)
		if nome == "" {
			nome = "Usuário"
		}
		out[msgID] = append(out[msgID], nome)
	}
	return out
}

func markMailReadLocal(userID int64, graphMessageID string) error {
	if userID <= 0 || strings.TrimSpace(graphMessageID) == "" {
		return fmt.Errorf("parâmetros inválidos")
	}
	_, err := execGorm(database.GormDB_App, 
		`INSERT INTO MAIL_MESSAGE_READS (user_id, graph_message_id, read_at)
		 VALUES (?, ?, NOW())
		 ON DUPLICATE KEY UPDATE read_at = VALUES(read_at)`,
		userID,
		graphMessageID,
	)
return err
}

func unmarkMailReadLocal(userID int64, graphMessageID string) error {
	if userID <= 0 || strings.TrimSpace(graphMessageID) == "" {
		return fmt.Errorf("parâmetros inválidos")
	}
	_, err := execGorm(database.GormDB_App, 
		`DELETE FROM MAIL_MESSAGE_READS WHERE user_id = ? AND graph_message_id = ?`,
		userID,
		graphMessageID,
	)
	return err
}

func isMailReadLocal(userID int64, graphMessageID string) bool {
	if userID <= 0 || strings.TrimSpace(graphMessageID) == "" {
		return false
	}
	var count int
	if err := queryRowGorm(database.GormDB_App, 
		`SELECT COUNT(1) FROM MAIL_MESSAGE_READS WHERE user_id = ? AND graph_message_id = ?`,
		userID,
		graphMessageID,
	).Scan(&count); err != nil {
		return false
	}
	return count > 0
}

func buildMailThreadContext(threadID string) string {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return ""
	}
	rows, err := queryGorm(database.GormDB_App, `
		SELECT subject, from_email, from_name, received_at, snippet
		FROM mail_messages
		WHERE thread_id = ?
		ORDER BY received_at ASC
		LIMIT 40`, threadID)
	if err != nil {
		return ""
	}
	defer rows.Close()
	lines := make([]string, 0)
	for rows.Next() {
		var subject, fromEmail, fromName, receivedAt, snippet sql.NullString
		if err := rows.Scan(&subject, &fromEmail, &fromName, &receivedAt, &snippet); err != nil {
			continue
		}
		line := fmt.Sprintf(
			"%s | %s <%s> | %s | %s",
			strings.TrimSpace(receivedAt.String),
			strings.TrimSpace(fromName.String),
			strings.TrimSpace(fromEmail.String),
			strings.TrimSpace(subject.String),
			strings.TrimSpace(snippet.String),
		)
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}

func findProcessByGraphMessageID(graphID string) (int64, bool) {
	graphID = strings.TrimSpace(graphID)
	if graphID == "" {
		return 0, false
	}
	var pid sql.NullInt64
	if err := queryRowGorm(database.GormDB_App, `
		SELECT pm.processo_id
		FROM process_mail_links pm
		JOIN mail_messages m ON m.id = pm.mail_message_id
		WHERE m.graph_message_id = ?
		ORDER BY pm.id DESC
		LIMIT 1`, graphID).Scan(&pid); err != nil {
		return 0, false
	}
	if !pid.Valid || pid.Int64 <= 0 {
		return 0, false
	}
	return pid.Int64, true
}

func buildProcessContext(processoID int64) string {
	if processoID <= 0 {
		return ""
	}
	var (
		cliente, uc, concess, etapaAtual, subAtual, colunaKanban, statusAnalise, dataUlt sql.NullString
	)
	if err := queryRowGorm(database.GormDB_App, `
		SELECT Cliente, UC, Concessionaria, `+"`Etapa Atual`"+`, `+"`Ultima Sub Etapa`"+`, `+"`Coluna Kanban Atual`"+`, `+"`Status Analise`"+`, `+"`Data Ultima Movimentacao`"+`
		FROM VW_POWERBI_PROCESSOS
		WHERE id_processo = ?
		LIMIT 1`, processoID).Scan(
		&cliente, &uc, &concess, &etapaAtual, &subAtual, &colunaKanban, &statusAnalise, &dataUlt,
	); err != nil {
		return ""
	}
	return fmt.Sprintf(
		"id_processo: %d\ncliente: %s\nuc: %s\nconcessionaria: %s\netapa_atual: %s\nsubetapa_atual: %s\ncoluna_kanban: %s\nstatus_analise: %s\ndata_ultima_movimentacao: %s",
		processoID,
		cliente.String,
		uc.String,
		concess.String,
		etapaAtual.String,
		subAtual.String,
		colunaKanban.String,
		statusAnalise.String,
		dataUlt.String,
	)
}

func buildProcessHistoryContext(processoID int64, limit int) string {
	if processoID <= 0 {
		return ""
	}
	if limit <= 0 {
		limit = 20
	}
	rows, err := queryGorm(database.GormDB_App, `
		SELECT DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') AS data_mov,
		       COALESCE(h.etapa_nova,''), COALESCE(h.sub_etapa,''), COALESCE(h.comentario,'')
		FROM FT_HISTORICO_MOVIMENTACOES h
		WHERE h.id_requisicao = ?
		ORDER BY h.data_movimentacao DESC
		LIMIT ?`, processoID, limit)
	if err != nil {
		return ""
	}
	defer rows.Close()
	lines := make([]string, 0, limit)
	for rows.Next() {
		var dataMov, etapa, sub, comentario string
		if err := rows.Scan(&dataMov, &etapa, &sub, &comentario); err != nil {
			continue
		}
		lines = append(lines, fmt.Sprintf("%s | %s | %s | %s", dataMov, etapa, sub, comentario))
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}

func linkProcessMailTx(tx *gorm.DB, processoID int64, mailID int64, createdBy int64, note string) error {
	_, err := execGorm(tx, `
		INSERT INTO process_mail_links (processo_id, mail_message_id, created_by, note)
		VALUES (?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE note=VALUES(note)`,
		processoID, mailID, createdBy, note,
	)
	return err
}

func hasProcessMailLinkTx(tx *gorm.DB, processoID int64, mailID int64) bool {
	if processoID <= 0 || mailID <= 0 {
		return false
	}
	var count int
	if err := queryRowGorm(tx,
		`SELECT COUNT(1) FROM process_mail_links WHERE processo_id = ? AND mail_message_id = ?`,
		processoID, mailID).Scan(&count); err != nil {
		return false
	}
	return count > 0
}

func findProcessByThreadIDTx(tx *gorm.DB, threadID string) (int64, bool) {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return 0, false
	}
	var pid sql.NullInt64
	if err := queryRowGorm(tx, `
		SELECT pm.processo_id
		FROM process_mail_links pm
		JOIN mail_messages m ON m.id = pm.mail_message_id
		WHERE m.thread_id = ?
		ORDER BY pm.id DESC
		LIMIT 1`, threadID).Scan(&pid); err != nil {
		return 0, false
	}
	if !pid.Valid || pid.Int64 <= 0 {
		return 0, false
	}
	return pid.Int64, true
}

func linkThreadMailsTx(tx *gorm.DB, processoID int64, threadID string, createdBy int64, note string) error {
	threadID = strings.TrimSpace(threadID)
	if processoID <= 0 || threadID == "" {
		return nil
	}
	rows, err := queryGorm(tx, `SELECT id FROM mail_messages WHERE thread_id = ?`, threadID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var mailID int64
		if err := rows.Scan(&mailID); err != nil {
			continue
		}
		if err := linkProcessMailTx(tx, processoID, mailID, createdBy, note); err != nil {
			return err
		}
	}
	return rows.Err()
}

var htmlBreakRe = regexp.MustCompile(`(?i)<\s*(br|/p|/div)\s*>`)
var htmlTagRe = regexp.MustCompile(`(?s)<[^>]+>`)
var ucTokenRe = regexp.MustCompile(`[A-Za-z0-9-]{5,}`)

func appendMailSignature(body string) string {
	raw := strings.TrimSpace(body)
	if strings.Contains(raw, "assinatura_complaint.png") {
		return body
	}
	baseURL := strings.TrimSpace(os.Getenv("MAIL_SIGNATURE_URL"))
	if baseURL == "" {
		baseURL = "/assinatura_complaint.png"
	}
	sig := `<br/><br/><img src="` + baseURL + `" alt="assinatura" style="max-width:260px;height:auto;" />`
	if raw == "" {
		return sig
	}
	return body + sig
}

func hasAnyLinkForMailTx(tx *gorm.DB, mailID int64) bool {
	if mailID <= 0 {
		return false
	}
	var count int
	if err := queryRowGorm(tx, `SELECT COUNT(1) FROM process_mail_links WHERE mail_message_id = ?`, mailID).Scan(&count); err != nil {
		return false
	}
	return count > 0
}

func findProcessByUCTx(tx *gorm.DB, text string) (int64, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, false
	}
	raw := ucTokenRe.FindAllString(text, -1)
	if len(raw) == 0 {
		return 0, false
	}
	tokens := make([]string, 0, len(raw))
	tokensNoHyphen := make([]string, 0, len(raw))
	seen := map[string]struct{}{}
	seenNo := map[string]struct{}{}
	for _, t := range raw {
		low := strings.ToLower(strings.TrimSpace(t))
		if low == "" {
			continue
		}
		if _, ok := seen[low]; !ok {
			seen[low] = struct{}{}
			tokens = append(tokens, low)
		}
		no := strings.ReplaceAll(low, "-", "")
		if no != "" {
			if _, ok := seenNo[no]; !ok {
				seenNo[no] = struct{}{}
				tokensNoHyphen = append(tokensNoHyphen, no)
			}
		}
	}
	if len(tokens) == 0 && len(tokensNoHyphen) == 0 {
		return 0, false
	}

	candidates := make(map[int64]struct{})

	if len(tokens) > 0 {
		ph := strings.Repeat("?,", len(tokens))
		ph = strings.TrimSuffix(ph, ",")
		args := make([]any, 0, len(tokens))
		for _, t := range tokens {
			args = append(args, t)
		}
		rows, err := queryGorm(tx, `
			SELECT r.id_requisicao
			FROM FT_REQUISICOES r
			WHERE LOWER(r.uc) IN (`+ph+`)`, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var pid int64
				if err := rows.Scan(&pid); err == nil && pid > 0 {
					candidates[pid] = struct{}{}
				}
			}
		}
	}

	if len(tokensNoHyphen) > 0 {
		ph := strings.Repeat("?,", len(tokensNoHyphen))
		ph = strings.TrimSuffix(ph, ",")
		args := make([]any, 0, len(tokensNoHyphen))
		for _, t := range tokensNoHyphen {
			args = append(args, t)
		}
		rows, err := queryGorm(tx, `
			SELECT r.id_requisicao
			FROM FT_REQUISICOES r
			WHERE REPLACE(LOWER(r.uc), '-', '') IN (`+ph+`)`, args...)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var pid int64
				if err := rows.Scan(&pid); err == nil && pid > 0 {
					candidates[pid] = struct{}{}
				}
			}
		}
	}

	if len(candidates) != 1 {
		return 0, false
	}
	for pid := range candidates {
		return pid, true
	}
	return 0, false
}

func htmlToText(input string) string {
	if strings.TrimSpace(input) == "" {
		return ""
	}
	out := htmlBreakRe.ReplaceAllString(input, "\n")
	out = htmlTagRe.ReplaceAllString(out, "")
	out = html.UnescapeString(out)
	out = strings.ReplaceAll(out, "\r\n", "\n")
	out = strings.ReplaceAll(out, "\r", "\n")
	return strings.TrimSpace(out)
}

func buildBodyPDF(msg *services.GraphMessageDetail) ([]byte, error) {
	body := msg.BodyContent
	if strings.TrimSpace(body) == "" {
		body = msg.BodyPreview
	}
	if strings.EqualFold(strings.TrimSpace(msg.BodyType), "html") {
		body = htmlToText(body)
	}
	if strings.TrimSpace(body) == "" {
		body = "(Corpo vazio)"
	}

	sanitizePDFText := func(s string) string {
		return strings.Map(func(r rune) rune {
			if r == '\n' || r == '\t' || r == '\r' {
				return r
			}
			if r < 32 || r > 255 {
				return ' '
			}
			return r
		}, s)
	}
	toPDFText := func(s string) string {
		s = sanitizePDFText(s)
		out, err := charmap.Windows1252.NewEncoder().String(s)
		if err != nil {
			return s
		}
		return out
	}

	header := fmt.Sprintf(
		"Assunto: %s\nDe: %s <%s>\nData: %s\n\n",
		strings.TrimSpace(msg.Subject),
		strings.TrimSpace(msg.FromName),
		strings.TrimSpace(msg.FromEmail),
		strings.TrimSpace(msg.ReceivedAt),
	)
	header = toPDFText(header)
	body = toPDFText(body)

	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(12, 12, 12)
	pdf.AddPage()
	pdf.SetFont("Arial", "", 11)
	pdf.MultiCell(0, 5, header+body, "", "", false)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func attachBodyPDFToProcess(tx *gorm.DB, processoID int64, mailID int64, msg *services.GraphMessageDetail) error {
	data, err := buildBodyPDF(msg)
	if err != nil {
		return err
	}
	if len(data) > 10*1024*1024 {
		return fmt.Errorf("arquivo PDF excede 10MB")
	}
	hash := sha256.Sum256(data)
	hashHex := hex.EncodeToString(hash[:])
	exists, err := mailAttachmentExists(tx, mailID, hashHex)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	filename := fmt.Sprintf("email-%d.pdf", mailID)
	pseudoPath := buildAnexoPath(int(processoID), 0, filename)
	if _, err := execGorm(tx, 
		`INSERT INTO FT_ANEXOS
		  (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
		  VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
		processoID, filename, pseudoPath, "sistema", "application/pdf", len(data), data,
	); err != nil {
		return err
	}
	_, err = execGorm(tx, `
		INSERT INTO mail_message_attachments
		  (mail_message_id, graph_attachment_id, filename, content_type, size, storage_key, sha256)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		mailID, "body_pdf", filename, "application/pdf", len(data), pseudoPath, hashHex,
	)
	return err
}

func attachMailFilesToProcess(tx *gorm.DB, processoID int64, mailID int64, graphMessageID string) ([]string, error) {
	attachments, err := services.ListMailAttachments(graphMessageID)
	if err != nil {
		return nil, err
	}
	warnings := make([]string, 0)
	for _, att := range attachments {
		if att.IsInline {
			warnings = append(warnings, fmt.Sprintf("Anexo inline ignorado: %s", att.Name))
			continue
		}
		if att.Size > 10*1024*1024 {
			warnings = append(warnings, fmt.Sprintf("Anexo %s excede 10MB", att.Name))
			continue
		}
		name, ct, data, err := services.DownloadMailAttachment(graphMessageID, att.ID)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("Falha ao baixar %s", att.Name))
			continue
		}
		if len(data) > 10*1024*1024 {
			warnings = append(warnings, fmt.Sprintf("Anexo %s excede 10MB", att.Name))
			continue
		}
		hash := sha256.Sum256(data)
		hashHex := hex.EncodeToString(hash[:])
		exists, err := mailAttachmentExists(tx, mailID, hashHex)
		if err != nil {
			return warnings, err
		}
		if exists {
			continue
		}
		if name == "" {
			name = "anexo"
		}
		if ct == "" {
			ct = "application/octet-stream"
		}
		pseudoPath := buildAnexoPath(int(processoID), 0, name)
		if _, err := execGorm(tx, 
			`INSERT INTO FT_ANEXOS
			  (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
			  VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
			processoID, name, pseudoPath, "sistema", ct, len(data), data,
		); err != nil {
			return warnings, err
		}
		if _, err := execGorm(tx, `
			INSERT INTO mail_message_attachments
			  (mail_message_id, graph_attachment_id, filename, content_type, size, storage_key, sha256)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
			mailID, att.ID, name, ct, len(data), pseudoPath, hashHex,
		); err != nil {
			return warnings, err
		}
	}
	return warnings, nil
}

func mailAttachmentExists(tx *gorm.DB, mailID int64, sha string) (bool, error) {
	var count int
	if err := queryRowGorm(tx, `SELECT COUNT(1) FROM mail_message_attachments WHERE mail_message_id = ? AND sha256 = ?`, mailID, sha).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func registerProcessHistory(tx *gorm.DB, processoID int64, userID int64, note string) (int64, error) {
	comentario := "E-mail anexado ao processo"
	if strings.TrimSpace(note) != "" {
		comentario = comentario + ": " + strings.TrimSpace(note)
	}
	var etapaAtual, subAtual sql.NullString
	_ = queryRowGorm(tx, `
        SELECT e.etapa, p.sub_etapa
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
         WHERE p.id_processo = ?`, processoID).Scan(&etapaAtual, &subAtual)

	etapaTxt := strings.TrimSpace(etapaAtual.String)
	if etapaTxt == "" {
		etapaTxt = "Distribuidora"
	}
	subTxt := strings.TrimSpace(subAtual.String)
	statusNome := strings.TrimSpace(getStatusNomeByRequisicaoGorm(tx, int64(processoID)))
	if statusNome == "" {
		statusNome = "Em andamento"
	}

	var userVal any
	if userID > 0 {
		userVal = userID
	} else {
		userVal = nil
	}

	res, err := execGorm(tx, `
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_requisicao, id_usuario_gestor,
         status_anterior, status_novo,
         etapa_anterior, etapa_nova, sub_etapa,
         comentario, data_movimentacao, tipo_movimentacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		processoID, userVal, statusNome, statusNome, etapaTxt, etapaTxt, subTxt, comentario, time.Now(), "EMAIL",
	)
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	return id, nil
}

func registerEmailMoveHistory(tx *gorm.DB, processoID int64, userID int64, note string, etapa string, sub string, moveComentario string) (int64, error) {
	novaEtapa := strings.TrimSpace(etapa)
	novaSub := strings.TrimSpace(sub)
	if novaEtapa == "" || novaSub == "" {
		return 0, fmt.Errorf("etapa/sub-etapa obrigatórias")
	}

	var etapaAnterior, subAnterior sql.NullString
	if err := queryRowGorm(tx, `
        SELECT e.etapa, p.sub_etapa
          FROM FT_PROCESSOS p
          JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
         WHERE p.id_processo = ?`, processoID).Scan(&etapaAnterior, &subAnterior); err != nil {
		return 0, err
	}

	var etapaID int64
	if err := queryRowGorm(tx, "SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = ? LIMIT 1", novaEtapa).Scan(&etapaID); err != nil {
		return 0, fmt.Errorf("etapa inválida: %s", novaEtapa)
	}

	subID, _ := resolveSubEtapaIDGorm(tx, novaSub)
	var colID sql.NullInt64
	var colNome sql.NullString
	_ = queryRowGorm(tx, `
		SELECT k.id_coluna, k.nome_coluna
		  FROM DM_ETAPAS_PROCESSO e
		  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
		 WHERE e.id_etapa_processo = ?`,
		etapaID,
	).Scan(&colID, &colNome)
	if _, err := execGorm(tx, 
		`UPDATE FT_PROCESSOS
         SET id_etapa_processo = ?, sub_etapa = ?, id_sub_etapa_processo = ?, id_coluna = ?, nome_coluna = ?, suspenso = 0, ultima_atualizacao = NOW()
         WHERE id_processo = ?`,
		etapaID, novaSub, nullIntToIface(subID), nullIntToIface(colID), func() interface{} { if colNome.Valid { return colNome.String }; return nil }(), processoID,
	); err != nil {
		return 0, err
	}

	statusNome := strings.TrimSpace(getStatusNomeByRequisicaoGorm(tx, int64(processoID)))
	if statusNome == "" {
		statusNome = "Em andamento"
	}

	comentario := "E-mail anexado ao processo"
	if strings.TrimSpace(note) != "" {
		comentario = comentario + ": " + strings.TrimSpace(note)
	}
	if strings.TrimSpace(moveComentario) != "" {
		comentario = comentario + " | " + strings.TrimSpace(moveComentario)
	}

	var userVal any
	if userID > 0 {
		userVal = userID
	} else {
		userVal = nil
	}

	res, err := execGorm(tx, `
        INSERT INTO FT_HISTORICO_MOVIMENTACOES
        (id_requisicao, id_usuario_gestor,
         status_anterior, status_novo,
         etapa_anterior, etapa_nova, sub_etapa,
         comentario, data_movimentacao, tipo_movimentacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		processoID, userVal, statusNome, statusNome, etapaAnterior.String, novaEtapa, novaSub, comentario, time.Now(), "EMAIL",
	)
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	return id, nil
}

func parseRecipients(raw string) []string {
	if raw == "" {
		return []string{}
	}
	raw = strings.ReplaceAll(raw, ",", ";")
	parts := strings.Split(raw, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseDateTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Now()
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t
	}
	if t, err := time.Parse("2006-01-02 15:04:05", raw); err == nil {
		return t
	}
	return time.Now()
}
