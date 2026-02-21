package handlers

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

type chatSession struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type chatMessage struct {
	ID        int64     `json:"id"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

type createSessionInput struct {
	Title string `json:"title"`
}

type addMessageInput struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func getUserIDFromContext(c *gin.Context) (int64, bool) {
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 && id > 0 {
			return id, true
		}
	}
	return 0, false
}

// POST /api/v1/chat/sessions
// CreateChatSession godoc
// @Summary      Cria sessão de chat
// @Tags         Chat
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/sessions [post]
func CreateChatSession(c *gin.Context) {
	uid, ok := getUserIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}

	var in createSessionInput
	_ = c.ShouldBindJSON(&in)
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "Chat " + time.Now().Format("2006-01-02 15:04")
	}

	res, err := execGorm(database.GormDB_App, `
		INSERT INTO AI_CHAT_SESSIONS (user_id, title)
		VALUES (?, ?)`, uid, title)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}
	id, _ := res.LastInsertId()
	c.JSON(http.StatusCreated, gin.H{"id": id, "title": title})
}

// GET /api/v1/chat/sessions
// ListChatSessions godoc
// @Summary      Lista sessões de chat
// @Tags         Chat
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/sessions [get]
func ListChatSessions(c *gin.Context) {
	uid, ok := getUserIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}

	rows, err := queryGorm(database.GormDB_App, `
		SELECT id, COALESCE(title, ''), created_at, updated_at
		FROM AI_CHAT_SESSIONS
		WHERE user_id = ? AND deleted_at IS NULL
		ORDER BY updated_at DESC`, uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list sessions"})
		return
	}
	defer rows.Close()

	var out []chatSession
	for rows.Next() {
		var s chatSession
		if err := rows.Scan(&s.ID, &s.Title, &s.CreatedAt, &s.UpdatedAt); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read sessions"})
			return
		}
		out = append(out, s)
	}
	c.JSON(http.StatusOK, gin.H{"sessions": out})
}

// GET /api/v1/chat/sessions/:id/messages
// ListChatMessages godoc
// @Summary      Lista mensagens da sessão
// @Tags         Chat
// @Param        id   path   int  true  "ID da sessão"
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/sessions/{id}/messages [get]
func ListChatMessages(c *gin.Context) {
	uid, ok := getUserIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}

	sessionID := c.Param("id")
	var ownerID int64
	err := queryRowGorm(database.GormDB_App, `
		SELECT user_id
		FROM AI_CHAT_SESSIONS
		WHERE id = ? AND deleted_at IS NULL`, sessionID).Scan(&ownerID)
	if err == sql.ErrNoRows || ownerID != uid {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load session"})
		return
	}

	rows, err := queryGorm(database.GormDB_App, `
		SELECT id, role, content, created_at
		FROM AI_CHAT_MESSAGES
		WHERE session_id = ?
		ORDER BY created_at ASC`, sessionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list messages"})
		return
	}
	defer rows.Close()

	var out []chatMessage
	for rows.Next() {
		var m chatMessage
		if err := rows.Scan(&m.ID, &m.Role, &m.Content, &m.CreatedAt); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read messages"})
			return
		}
		out = append(out, m)
	}
	c.JSON(http.StatusOK, gin.H{"messages": out})
}

// POST /api/v1/chat/sessions/:id/messages
// AddChatMessage godoc
// @Summary      Adiciona mensagem na sessão
// @Tags         Chat
// @Param        id   path   int  true  "ID da sessão"
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      400  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/sessions/{id}/messages [post]
func AddChatMessage(c *gin.Context) {
	uid, ok := getUserIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}

	sessionID := c.Param("id")
	var ownerID int64
	err := queryRowGorm(database.GormDB_App, `
		SELECT user_id
		FROM AI_CHAT_SESSIONS
		WHERE id = ? AND deleted_at IS NULL`, sessionID).Scan(&ownerID)
	if err == sql.ErrNoRows || ownerID != uid {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load session"})
		return
	}

	var in addMessageInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid payload"})
		return
	}
	role := strings.ToLower(strings.TrimSpace(in.Role))
	if role != "user" && role != "assistant" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role"})
		return
	}
	content := strings.TrimSpace(in.Content)
	if content == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content required"})
		return
	}

	if _, err := execGorm(database.GormDB_App, `
		INSERT INTO AI_CHAT_MESSAGES (session_id, role, content)
		VALUES (?, ?, ?)`, sessionID, role, content); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save message"})
		return
	}

	_, _ = execGorm(database.GormDB_App, `
		UPDATE AI_CHAT_SESSIONS SET updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`, sessionID)

	c.JSON(http.StatusCreated, gin.H{"ok": true})
}

// DELETE /api/v1/chat/sessions/:id
// DeleteChatSession godoc
// @Summary      Remove sessão de chat
// @Tags         Chat
// @Param        id   path   int  true  "ID da sessão"
// @Produce      json
// @Success      200  {object}  map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/chat/sessions/{id} [delete]
func DeleteChatSession(c *gin.Context) {
	uid, ok := getUserIDFromContext(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "not authenticated"})
		return
	}

	sessionID := c.Param("id")
	res, err := execGorm(database.GormDB_App, `
		UPDATE AI_CHAT_SESSIONS
		SET deleted_at = CURRENT_TIMESTAMP
		WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, sessionID, uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete session"})
		return
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

