package utils

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
)

// BindAndValidate faz ShouldBindJSON + validação e escreve 400 formatado.
// Retorna true se houve erro (caller deve fazer return).
func BindAndValidate(c *gin.Context, obj any) bool {
	if err := c.ShouldBindJSON(obj); err != nil {
		var ve validator.ValidationErrors
		if errors.As(err, &ve) {
			parts := make([]string, 0, len(ve))
			for _, fe := range ve {
				parts = append(parts, fieldMsg(fe))
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": strings.Join(parts, "; ")})
		} else {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Dados de entrada inválidos"})
		}
		return true
	}
	return false
}

func fieldMsg(fe validator.FieldError) string {
	f := strings.ToLower(fe.Field())
	switch fe.Tag() {
	case "required":
		return f + " é obrigatório"
	case "email":
		return f + " deve ser um e-mail válido"
	case "min":
		return f + " deve ter pelo menos " + fe.Param() + " caracteres"
	case "max":
		return f + " deve ter no máximo " + fe.Param() + " caracteres"
	case "oneof":
		return f + " deve ser um de: " + fe.Param()
	default:
		return f + " inválido"
	}
}
