package middleware

import (
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
//
// P2-9: usa c.ClientIP() do gin (que respeita SetTrustedProxies e, portanto, o IP REAL
// do cliente) em vez de ler X-Forwarded-For cru — que era spoofável (bastava enviar
// "X-Forwarded-For: 10.0.0.1" para se passar por IP interno e liberar o Swagger).
// Com trusted proxies configurados e o Caddy sobrescrevendo o XFF na borda, o IP não
// é mais forjável pelo cliente externo.
func SwaggerGuard() gin.HandlerFunc {
	return func(c *gin.Context) {
		if isPrivateIP(c.ClientIP()) {
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
			}, jwt.WithValidMethods([]string{"HS256"}))
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

func isPrivateIP(ip string) bool {
	for _, prefix := range privateRanges {
		if strings.HasPrefix(ip, prefix) {
			return true
		}
	}
	return false
}
