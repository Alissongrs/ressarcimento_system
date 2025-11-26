// backend/middleware/auth.go
package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"ressarcimento-backend/auth"
)

func buildAuth(allowQueryAlways bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 1) Authorization: Bearer <token>
		authHeader := strings.TrimSpace(c.GetHeader("Authorization"))
		var tokenString string
		if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			tokenString = strings.TrimSpace(authHeader[len("Bearer "):])
		}

		// 2) Fallback: ?token=
		// - Se allowQueryAlways = true, sempre aceita.
		// - Se false, aceita só para SSE (EventSource não manda Authorization)
		if tokenString == "" {
			accept := strings.ToLower(c.GetHeader("Accept"))
			path := c.Request.URL.Path
			isSSE := strings.Contains(accept, "text/event-stream") ||
				strings.HasPrefix(path, "/api/events") ||
				strings.HasPrefix(path, "/api/sse") ||
				strings.HasPrefix(path, "/api/alertas/stream") ||
				strings.HasSuffix(path, "/events")

			if allowQueryAlways || isSSE {
				if qs := strings.TrimSpace(c.Query("token")); qs != "" {
					tokenString = qs
				}
			}
		}

		if tokenString == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Token ausente. Use Authorization: Bearer <token> ou ?token= para SSE.",
			})
			return
		}

		// 3) Valida JWT
		claims := &auth.Claims{}
		token, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (interface{}, error) {
			return auth.JwtKey, nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Token inválido ou expirado"})
			return
		}

		// 4) Normaliza userName/role
		userName := strings.TrimSpace(claims.Nome)
		if userName == "" {
			userName = strings.TrimSpace(claims.UserName)
		}
		role := strings.ToLower(strings.TrimSpace(claims.Role))
		if role == "" {
			role = strings.ToLower(strings.TrimSpace(claims.TipoConta))
		}
		if role == "" {
			role = "solicitante"
		}

		// 5) Injeta no contexto (fallback: userTipoConta herda role quando vazio)
		c.Set("userID", claims.UserID)
		c.Set("userName", userName)
		userTipo := strings.TrimSpace(claims.TipoConta)
		if userTipo == "" {
			userTipo = role
		}
		c.Set("userTipoConta", userTipo)
		c.Set("role", role)
		c.Set("isAdmin", role == "admin")

		c.Next()
	}
}

// Uso geral (API comum). ?token= só funciona para SSE.
func AuthMiddleware() gin.HandlerFunc {
	return buildAuth(false)
}
