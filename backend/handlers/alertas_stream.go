// backend/handlers/alertas_stream.go
package handlers

import (
	"fmt"
	"net/http"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
)

// GET /api/alertas/stream — SSE de alertas por usuário
// Auth via cookie auth_token ou Authorization: Bearer (middleware AuthOrQueryToken).
// @Summary SSE de alertas
// @Tags SSE
// @Produce text/event-stream
// @Success 200 {string} string "stream"
// @Failure 401 {object} map[string]string
// @Router /api/v1/alertas/stream [get]
func StreamAlertas(c *gin.Context) {
	var userID int64
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 {
			userID = id
		}
	}
	if userID == 0 {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "não autenticado"})
		return
	}

	// Headers SSE
	w := c.Writer
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")

	// Inscreve-se no hub por usuário
	ch, cancel := sse.SubscribeUser(userID)
	defer cancel()

	// Envia um boot com contagem de não lidos (mesmo nome de evento do notifyUnread)
	var unread int
	_ = queryRowGorm(database.GormDB_App, 
		"SELECT COUNT(*) FROM FT_ALERTAS WHERE id_usuario=? AND lido=0",
		userID,
	).Scan(&unread)
	fmt.Fprintf(w, "event: alerta_unread\n")
	fmt.Fprintf(w, "data: {\"unread\": %d}\n\n", unread) // <-- aqui estava faltando passar 'unread'
	w.Flush()

	// Heartbeat a cada 25s
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	ctx := c.Request.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			// Repassa mensagens do hub como "alerta" (payload já vem em JSON)
			fmt.Fprintf(w, "event: alerta\n")
			w.Write([]byte("data: "))
			w.Write(msg)
			w.Write([]byte("\n\n"))
			w.Flush()
		case <-ticker.C:
			// comentário (linha iniciada com ":") mantém a conexão viva
			w.Write([]byte(":\n\n"))
			w.Flush()
		}
	}
}

