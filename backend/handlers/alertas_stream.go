// backend/handlers/alertas_stream.go
package handlers

import (
	"fmt"
	"net/http"
	"time"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/database"
	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// GET /api/alertas/stream  (aceita ?token=JWT para facilitar EventSource)
// @Summary SSE de alertas
// @Tags SSE
// @Produce text/event-stream
// @Param token query string false "JWT"
// @Success 200 {string} string "stream"
// @Failure 401 {object} map[string]string
// @Router /api/v1/alertas/stream [get]
func StreamAlertas(c *gin.Context) {
	var userID int64

	// 1) tenta pegar do middleware
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 {
			userID = id
		}
	}

	// 2) se não tem, aceita ?token= (útil porque EventSource não manda Authorization)
	if userID == 0 {
		if tok := c.Query("token"); tok != "" {
			claims := &auth.Claims{}
			tkn, err := jwt.ParseWithClaims(tok, claims, func(t *jwt.Token) (interface{}, error) {
				return auth.JwtKey, nil
			})
			if err != nil || !tkn.Valid {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token inválido"})
				return
			}
			userID = claims.UserID
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

