package handlers

/*import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/models"
	"ressarcimento-backend/services"
)

type ProcessosHandler struct {
	svc services.ProcessosService
}

func NewProcessosHandler(s services.ProcessosService) *ProcessosHandler {
	return &ProcessosHandler{svc: s}
}

func (h *ProcessosHandler) KanbanFast(c *gin.Context) {
	itens, err := h.svc.ListarKanbanFast(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Normaliza possíveis divergências ("Indeferidos" -> "Indeferido", etc.)
	normalize := func(col string) string {
		col = strings.TrimSpace(col)
		switch col {
		case "Indeferidos":
			return "Indeferido"
		default:
			return col
		}
	}

	resp := map[string][]models.ProcessoKanbanDTO{}
	for _, it := range itens {
		col := normalize(it.ColunaKanban)
		resp[col] = append(resp[col], it.ToDTO())
	}

	c.JSON(http.StatusOK, gin.H{"colunas": resp})
}
*/
