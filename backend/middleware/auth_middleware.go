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
		var tokenString string

		// 1) Cookie auth_token (HttpOnly — prioridade máxima)
		if cook, err := c.Cookie("auth_token"); err == nil {
			tokenString = strings.TrimSpace(cook)
		}

		// 2) Authorization: Bearer <token> (clientes API / dev cross-origin)
		if tokenString == "" {
			authHeader := strings.TrimSpace(c.GetHeader("Authorization"))
			if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
				tokenString = strings.TrimSpace(authHeader[len("Bearer "):])
			}
		}

		// 3) ?token= mantido apenas como último recurso para SSE legacy
		if tokenString == "" && allowQueryAlways {
			tokenString = strings.TrimSpace(c.Query("token"))
		}

		if tokenString == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Token ausente. Use cookie auth_token ou Authorization: Bearer <token>.",
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
