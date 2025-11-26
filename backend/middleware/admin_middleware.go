package middleware

import (
	"github.com/gin-gonic/gin"
	"net/http"
)

// AdminMiddleware permite acesso apenas para usuários com role 'admin'.
// Deve ser usado depois do AuthMiddleware.
func AdminMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if v, ok := c.Get("isAdmin"); ok {
			if b, ok2 := v.(bool); ok2 && b {
				c.Next()
				return
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Acesso permitido apenas para administradores."})
	}
}
