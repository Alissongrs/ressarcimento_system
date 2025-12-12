package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// AdminMiddleware permite acesso para usuários com role 'admin' ou 'gestor'.
// Deve ser usado depois do AuthMiddleware.
func AdminMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Flag populada pelo AuthMiddleware
		if v, ok := c.Get("isAdmin"); ok {
			if b, ok2 := v.(bool); ok2 && b {
				c.Next()
				return
			}
		}
		// Fallback: role ou userTipoConta direto (permite gestor)
		if v, ok := c.Get("role"); ok {
			if s, ok2 := v.(string); ok2 {
				rs := strings.ToLower(strings.TrimSpace(s))
				if rs == "admin" || rs == "gestor" {
					c.Next()
					return
				}
			}
		}
		if v, ok := c.Get("userTipoConta"); ok {
			if s, ok2 := v.(string); ok2 {
				rs := strings.ToLower(strings.TrimSpace(s))
				if rs == "admin" || rs == "gestor" {
					c.Next()
					return
				}
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Acesso permitido para administradores ou gestores."})
	}
}
