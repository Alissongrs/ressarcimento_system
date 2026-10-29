package handlers

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
)

// VarrerEmailsRecepcaoHandler godoc
// @Summary      Varredura do Agente de Recepção sobre e-mails não vinculados
// @Description  Percorre e-mails recebidos que não bateram com nenhum processo (FT_EMAILS_PROCESSO
//
//	com id_processo NULL) e sugere vínculo ou sinaliza revisão manual. Nunca cria
//	requisição/processo e nunca vincula sozinho — só cria alertas para confirmação humana.
//
// @Tags         Agente de Recepção
// @Produce      json
// @Param        limit query int false "máximo de e-mails a processar (padrão 200, máx 500)"
// @Success      200 {object} services.VarreduraResultado
// @Failure      500 {object} map[string]string
// @Router       /api/v1/agente-recepcao/varredura-emails [post]
func VarrerEmailsRecepcaoHandler(c *gin.Context) {
	limit := 0
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()

	res, err := services.VarrerEmailsNaoVinculados(ctx, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha na varredura: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}
