package middleware

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type rlRecord struct {
	count       int
	windowStart time.Time
}

type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	recs   map[string]*rlRecord
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		limit:  limit,
		window: window,
		recs:   make(map[string]*rlRecord),
	}
}

// allow retorna (allowed, resetIn, limit, remaining)
func (r *rateLimiter) allow(key string) (bool, time.Duration, int, int) {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	rec, ok := r.recs[key]
	if !ok || now.Sub(rec.windowStart) >= r.window {
		// nova janela
		r.recs[key] = &rlRecord{count: 1, windowStart: now}
		return true, r.window, r.limit, r.limit - 1
	}

	elapsed := now.Sub(rec.windowStart)
	resetIn := r.window - elapsed

	if rec.count < r.limit {
		rec.count++
		return true, resetIn, r.limit, r.limit - rec.count
	}

	// bloqueado
	return false, resetIn, r.limit, 0
}

// ===== Helpers =====

func userOrIP(c *gin.Context) string {
	if uid, ok := c.Get("userID"); ok && uid != nil {
		s := fmt.Sprint(uid)
		if s != "" && s != "<nil>" {
			return "user:" + s
		}
	}
	return "ip:" + c.ClientIP()
}

func getEnvInt(name string, def int) int {
	if v := getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// separado para facilitar testes (pode ser monkey-patch em testes)
var getenv = os.Getenv

// ===== Middleware =====

// GlobalRateLimit aplica rate limiting global a todas as rotas (exceto health checks).
// Padrão: 100 req/min por IP. Ajuste por env GLOBAL_RATE_LIMIT_PER_MIN.
func GlobalRateLimit() gin.HandlerFunc {
	limit := getEnvInt("GLOBAL_RATE_LIMIT_PER_MIN", 100)
	window := time.Minute
	rl := newRateLimiter(limit, window)

	// Rotas excluídas do rate limiting global
	excludedPaths := map[string]bool{
		"/api/v1/healthz": true,
		"/api/healthz":    true,
		"/metrics":        true,
		"/ping":           true,
	}

	return func(c *gin.Context) {
		// Pula rate limit para rotas de health check
		if excludedPaths[c.Request.URL.Path] {
			c.Next()
			return
		}

		key := "ip:" + c.ClientIP()
		allowed, resetIn, lim, remaining := rl.allow(key)

		// Cabeçalhos úteis pro cliente
		c.Header("X-RateLimit-Limit", strconv.Itoa(lim))
		c.Header("X-RateLimit-Remaining", strconv.Itoa(remaining))
		c.Header("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(resetIn).Unix(), 10))

		if !allowed {
			c.Header("Retry-After", strconv.Itoa(int((resetIn+time.Second-1)/time.Second)))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":       "rate_limit_exceeded",
				"message":     "Muitas requisições. Tente novamente em alguns segundos.",
				"retry_after": int((resetIn + time.Second - 1) / time.Second),
				"limit":       lim,
			})
			return
		}

		c.Next()
	}
}

// AuthRateLimit rate limiting mais restrito para rotas de autenticação.
// Padrão: 5 req/5min por IP. Ajuste por env AUTH_RATE_LIMIT_PER_5MIN.
func AuthRateLimit() gin.HandlerFunc {
	limit := getEnvInt("AUTH_RATE_LIMIT_PER_5MIN", 5)
	window := 5 * time.Minute
	rl := newRateLimiter(limit, window)

	return func(c *gin.Context) {
		key := "auth-ip:" + c.ClientIP()
		allowed, resetIn, lim, remaining := rl.allow(key)

		c.Header("X-RateLimit-Limit", strconv.Itoa(lim))
		c.Header("X-RateLimit-Remaining", strconv.Itoa(remaining))
		c.Header("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(resetIn).Unix(), 10))

		if !allowed {
			c.Header("Retry-After", strconv.Itoa(int((resetIn+time.Second-1)/time.Second)))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":       "too_many_auth_attempts",
				"message":     "Muitas tentativas de login/registro. Aguarde alguns minutos.",
				"retry_after": int((resetIn + time.Second - 1) / time.Second),
				"limit":       lim,
			})
			return
		}

		c.Next()
	}
}

// OCRChatRateLimit limita requisições ao endpoint /api/v1/ocr/chat.
// Padrão: 12 req/min por usuário (JWT) ou IP (fallback). Ajuste por env OCR_CHAT_MAX_PER_MIN.
func OCRChatRateLimit() gin.HandlerFunc {
	limit := getEnvInt("OCR_CHAT_MAX_PER_MIN", 12)
	window := time.Minute
	rl := newRateLimiter(limit, window)

	return func(c *gin.Context) {
		key := userOrIP(c)
		allowed, resetIn, lim, remaining := rl.allow(key)

		// Cabeçalhos úteis pro cliente/backoff
		c.Header("X-RateLimit-Limit", strconv.Itoa(lim))
		c.Header("X-RateLimit-Remaining", strconv.Itoa(remaining))
		c.Header("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(resetIn).Unix(), 10))

		if !allowed {
			c.Header("Retry-After", strconv.Itoa(int((resetIn+time.Second-1)/time.Second)))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":       "too_many_requests",
				"message":     "Muitas requisições para /ocr/chat. Tente novamente em alguns segundos.",
				"retry_after": int((resetIn + time.Second - 1) / time.Second),
				"limit":       lim,
			})
			return
		}

		c.Next()
	}
}
