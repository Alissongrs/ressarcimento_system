package handlers

import (
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
)

// GetProcessosComPrazo retorna processos em "Aguardando retorno" com prazo calculado
// por instância (Distribuidora/Ouvidoria: dias úteis; ANEEL/SMA: dias corridos).
// GetProcessosComPrazo godoc
// @Summary      Processos com prazo
// @Tags         Processos
// @Produce      json
// @Success      200  {array}   map[string]any
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/processos/prazos [get]
func GetProcessosComPrazo(c *gin.Context) {
	limit := 300
	if v := strings.TrimSpace(c.DefaultQuery("limit", "300")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	list, err := services.CalcularProcessosComPrazo([]int{3}) // 3 = Aguardando retorno
	if err != nil {
		log.Printf("GetProcessosComPrazo error: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro na consulta de prazos"})
		return
	}
	if len(list) > limit {
		list = list[:limit]
	}

	type outItem struct {
		ID             int     `json:"id_processo"`
		Etapa          string  `json:"etapa"`
		SubEtapa       string  `json:"sub_etapa"`
		Instancia      string  `json:"instancia"`
		PrazoDias      int     `json:"prazo_dias"`
		PrazoUteis     bool    `json:"prazo_dias_uteis"`
		DiasDecorridos int     `json:"dias_decorridos"`
		DiasRestantes  float64 `json:"dias_restantes"`
		HorasRestantes float64 `json:"horas_restantes"`
		Atrasado       bool    `json:"atrasado"`
		DataBase       string  `json:"data_base"`
		DataBaseUnix   int64   `json:"data_base_unix"`
		UC             string  `json:"uc"`
		Cliente        string  `json:"cliente"`
		Concessionaria string  `json:"concessionaria"`
	}

	out := make([]outItem, 0, len(list))
	for _, p := range list {
		out = append(out, outItem{
			ID:             p.IDProcesso,
			Etapa:          p.Etapa,
			SubEtapa:       p.SubEtapa,
			Instancia:      p.Instancia,
			PrazoDias:      p.PrazoDias,
			PrazoUteis:     p.PrazoUteis,
			DiasDecorridos: p.DiasDecorridos,
			DiasRestantes:  float64(p.PrazoDias - p.DiasDecorridos),
			HorasRestantes: float64(p.PrazoDias-p.DiasDecorridos) * 24,
			Atrasado:       p.Atrasado,
			DataBase:       p.DataBase.Format(time.RFC3339),
			DataBaseUnix:   p.DataBase.Unix(),
			UC:             strings.TrimSpace(p.UC),
			Cliente:        strings.TrimSpace(p.Cliente),
			Concessionaria: strings.TrimSpace(p.Concessionaria),
		})
	}

	if _, err := services.CriarAlertasDePrazoVencido(list); err != nil {
		log.Printf("GetProcessosComPrazo: erro ao criar alertas de prazo: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"rows": out, "count": len(out)})
}
