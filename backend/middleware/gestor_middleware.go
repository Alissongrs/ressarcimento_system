package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// GestorMiddleware verifica se o usuário autenticado é gestor ou admin.
// Deve ser usado DEPOIS do AuthMiddleware.
func GestorMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Verifica primeiro a role
		if v, ok := c.Get("role"); ok {
			if r, ok2 := v.(string); ok2 {
				lr := strings.ToLower(strings.TrimSpace(r))
				if lr == "gestor" || lr == "admin" {
					c.Next()
					return
				}
			}
		}
		// Fallback: userTipoConta
		if v, ok := c.Get("userTipoConta"); ok {
			if t, ok2 := v.(string); ok2 {
				lt := strings.ToLower(strings.TrimSpace(t))
				if lt == "gestor" || lt == "admin" {
					c.Next()
					return
				}
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Acesso negado. Recurso disponível apenas para gestores/admins."})
	}
}
