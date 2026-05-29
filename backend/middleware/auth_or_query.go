// middleware/auth_or_query_token.go
package middleware

import (
	"fmt"
	"net/http"
	"strings"

	"ressarcimento-backend/auth"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func AuthOrQueryToken() gin.HandlerFunc {
	return func(c *gin.Context) {
		var tokenString string

		// 1) Cookie auth_token (HttpOnly — prioridade máxima)
		if cook, err := c.Cookie("auth_token"); err == nil {
			tokenString = strings.TrimSpace(cook)
		}

		// 2) Authorization: Bearer <token>
		if tokenString == "" {
			authHeader := strings.TrimSpace(c.GetHeader("Authorization"))
			if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
				tokenString = strings.TrimSpace(authHeader[7:])
			}
		}

		// 3) ?token= mantido para SSE legacy (EventSource sem withCredentials)
		if tokenString == "" {
			tokenString = strings.TrimSpace(c.Query("token"))
		}

		tokenString = strings.Trim(tokenString, " '\"")

		if tokenString == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "token_missing",
				"msg":   "Use cookie auth_token ou Authorization: Bearer <token>.",
			})
			return
		}

		// 4) Valida JWT HS256 com a mesma chave que assina no /login
		claims := &auth.Claims{} // suas claims estendem jwt.RegisteredClaims
		tok, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return auth.JwtKey, nil
		})
		if err != nil || !tok.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error":   "invalid_token",
				"details": errToString(err),
			})
			return
		}

		// 6) Propaga contexto do usuário
		userName := strings.TrimSpace(firstNonEmpty(claims.Nome, claims.UserName))
		role := strings.ToLower(strings.TrimSpace(firstNonEmpty(claims.Role, claims.TipoConta)))
		if role == "" {
			role = "solicitante"
		}
		userTipo := strings.TrimSpace(claims.TipoConta)
		if userTipo == "" {
			userTipo = role
		}

		c.Set("userID", claims.UserID)
		c.Set("userName", userName)
		c.Set("userTipoConta", userTipo)
		c.Set("role", role)
		c.Set("isAdmin", role == "admin")

		c.Next()
	}
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func errToString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
