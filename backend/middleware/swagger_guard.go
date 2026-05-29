package middleware

import (
	"net"
	"net/http"
	"strings"

	"ressarcimento-backend/auth"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

var privateRanges = []string{
	"10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.",
	"172.21.", "172.22.", "172.23.", "172.24.", "172.25.", "172.26.",
	"172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
	"192.168.", "127.", "::1",
}

// SwaggerGuard permite acesso ao Swagger apenas para IPs privados ou admins autenticados.
func SwaggerGuard() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := clientIP(c)
		if isPrivateIP(ip) {
			c.Next()
			return
		}

		// Tenta autenticar como admin via cookie ou Bearer
		tokenStr := ""
		if cook, err := c.Cookie("auth_token"); err == nil {
			tokenStr = strings.TrimSpace(cook)
		}
		if tokenStr == "" {
			if h := c.GetHeader("Authorization"); strings.HasPrefix(strings.ToLower(h), "bearer ") {
				tokenStr = strings.TrimSpace(h[7:])
			}
		}

		if tokenStr != "" {
			claims := &auth.Claims{}
			tok, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
				return auth.JwtKey, nil
			})
			if err == nil && tok.Valid && strings.ToLower(claims.Role) == "admin" {
				c.Next()
				return
			}
		}

		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": "Swagger disponível apenas para IPs internos ou admins autenticados",
		})
	}
}

func clientIP(c *gin.Context) string {
	if xff := c.GetHeader("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	if xri := c.GetHeader("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		return c.Request.RemoteAddr
	}
	return host
}

func isPrivateIP(ip string) bool {
	for _, prefix := range privateRanges {
		if strings.HasPrefix(ip, prefix) {
			return true
		}
	}
	return false
}
