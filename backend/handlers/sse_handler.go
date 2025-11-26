package handlers

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"ressarcimento-backend/auth"
	"ressarcimento-backend/sse"
)

// StreamProcessoEvents expõe um endpoint SSE por processo: /api/processos/:id/events?token=...
// Valida o token JWT via query param (EventSource não envia headers customizados) e transmite eventos.
func StreamProcessoEvents(c *gin.Context) {
	pidStr := c.Param("id")
	pid, err := strconv.Atoi(pidStr)
	if err != nil || pid < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID de processo inválido"})
		return
	}

	tokenStr := c.Query("token")
	if tokenStr == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Token ausente"})
		return
	}

	claims := &auth.Claims{}
	tok, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
		return auth.JwtKey, nil
	})
	if err != nil || !tok.Valid {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Token inválido"})
		return
	}

	// Cabeçalhos SSE
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	ch := sse.Subscribe(pid)
	defer sse.Unsubscribe(pid, ch)

	// Evento inicial
	fmt.Fprintf(c.Writer, "event: open\n")
	fmt.Fprintf(c.Writer, "data: {\"ok\":true,\"processo_id\":%d}\n\n", pid)
	c.Writer.Flush()

	notify := c.Stream
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	c.Stream(func(w io.Writer) bool { return false })

	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(c.Writer, "event: update\n")
			fmt.Fprintf(c.Writer, "data: %s\n\n", string(msg))
			c.Writer.Flush()
		case <-ticker.C:
			fmt.Fprintf(c.Writer, "event: ping\n")
			fmt.Fprintf(c.Writer, "data: %d\n\n", time.Now().Unix())
			c.Writer.Flush()
		case <-c.Request.Context().Done():
			return
		}
		notify(func(w io.Writer) bool { return true })
	}
}

// StreamGlobalEvents: SSE global (processoID = 0) para eventos gerais
// Endpoint: GET /api/events?token=...
func StreamGlobalEvents(c *gin.Context) {
	tokenStr := c.Query("token")
	if tokenStr == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Token ausente"})
		return
	}

	claims := &auth.Claims{}
	tok, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
		return auth.JwtKey, nil
	})
	if err != nil || !tok.Valid {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Token inválido"})
		return
	}

	// Cabeçalhos SSE
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	ch := sse.Subscribe(0)
	defer sse.Unsubscribe(0, ch)

	// evento inicial
	fmt.Fprintf(c.Writer, "event: open\n")
	fmt.Fprintf(c.Writer, "data: {\"ok\":true,\"global\":true}\n\n")
	c.Writer.Flush()

	notify := c.Stream
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	c.Stream(func(w io.Writer) bool { return false })

	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(c.Writer, "event: update\n")
			fmt.Fprintf(c.Writer, "data: %s\n\n", string(msg))
			c.Writer.Flush()
		case <-ticker.C:
			fmt.Fprintf(c.Writer, "event: ping\n")
			fmt.Fprintf(c.Writer, "data: %d\n\n", time.Now().Unix())
			c.Writer.Flush()
		case <-c.Request.Context().Done():
			return
		}
		notify(func(w io.Writer) bool { return true })
	}
}
