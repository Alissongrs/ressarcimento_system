package handlers

// Análise do histórico completo de consumo de uma UC ("Analisar todas faturas").
// Percorre TODA a série mensal da UC, calcula de forma determinística os meses com
// desvio >= +100% da média (apontamentos) e pede ao modelo nano uma "Análise do
// gráfico de consumo" (texto curto). Números são determinísticos; o nano só narra.
//
//   POST /api/v1/faturas/:id/analisar-historico

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

type apontHistorico struct {
	Mes       string  `json:"mes"`
	Kwh       float64 `json:"kwh"`
	DesvioPct float64 `json:"desvio_pct"`
}

func AnalisarHistoricoUC(c *gin.Context) {
	id := c.Param("id")
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// O frontend PODE enviar média/série/apontamentos já calculados pelo modal
	// (mesma base do KPI/gráfico), garantindo que o texto bata com o que o
	// usuário vê. Se não vier, cai no cálculo pelo banco (compat).
	var body struct {
		Media        float64          `json:"media"`
		TotalMeses   int              `json:"total_meses"`
		Serie        json.RawMessage  `json:"serie"`
		Apontamentos []apontHistorico `json:"apontamentos"`
	}
	_ = c.ShouldBindJSON(&body)

	var media float64
	var n int
	var apont []apontHistorico
	var serieJSON []byte

	if body.Media > 0 && len(body.Serie) > 0 {
		// Fonte: modal (consistente com o KPI/gráfico).
		media = body.Media
		n = body.TotalMeses
		apont = body.Apontamentos
		serieJSON = body.Serie
	} else {
		// Fallback: calcula pelo banco.
		var codigoUC, mesRef string
		_ = sqlDB.QueryRow(
			"SELECT COALESCE(codigo_uc,''), COALESCE(mes_referencia,'') FROM FATURA_DADOS_EXTRAIDOS WHERE id = ?",
			id,
		).Scan(&codigoUC, &mesRef)
		if strings.TrimSpace(codigoUC) == "" {
			c.JSON(http.StatusNotFound, gin.H{"error": "UC (codigo_uc) não encontrada para a fatura"})
			return
		}
		serie := carregarSerieHistorico(codigoUC)
		if len(serie) < 3 {
			c.JSON(http.StatusOK, gin.H{
				"media": 0, "apontamentos": []apontHistorico{}, "total_meses": len(serie),
				"analise_grafico": "Análise do gráfico de consumo: histórico insuficiente (mínimo 3 meses com consumo).",
			})
			return
		}
		var soma float64
		for _, m := range serie {
			if k, ok := m["kwh"].(float64); ok && k > 0 {
				soma += k
				n++
			}
		}
		if n > 0 {
			media = soma / float64(n)
		}
		apont = []apontHistorico{}
		for _, m := range serie {
			k, _ := m["kwh"].(float64)
			if media > 0 && k >= 2*media {
				apont = append(apont, apontHistorico{
					Mes: fmt.Sprintf("%v", m["mes"]), Kwh: k,
					DesvioPct: (k - media) / media * 100,
				})
			}
		}
		serieJSON, _ = json.Marshal(serie)
	}
	if apont == nil {
		apont = []apontHistorico{}
	}

	// nano: narra a análise do gráfico (não recalcula números)
	apontJSON, _ := json.Marshal(apont)
	system := "Você é um auditor de faturas de energia elétrica. Recebe a SÉRIE MENSAL de " +
		"consumo (kWh) de uma unidade consumidora, a média histórica e a lista de meses " +
		"apontados (desvio >= +100% da média). Escreva UMA análise curta (2-3 frases) do " +
		"gráfico de consumo: diga se o consumo é estável, se houve pico(s) isolado(s), ou se " +
		"passou a operar dentro de uma NOVA média do cliente (novo patamar). Cite os meses " +
		"apontados. NÃO invente números — use apenas os fornecidos. Responda em português, " +
		"começando exatamente com 'Análise do gráfico de consumo:'."
	user := fmt.Sprintf("media_kwh=%.0f\nserie=%s\napontamentos_>=+100%%=%s", media, string(serieJSON), string(apontJSON))

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()
	analise, aerr := chamarOpenAIChat(ctx, modeloChat, system,
		[]map[string]string{{"role": "user", "content": user}})
	analise = strings.TrimSpace(sanitizarPTBR(analise))
	if aerr != nil || analise == "" {
		analise = analiseGraficoFallback(media, len(apont))
	}

	c.JSON(http.StatusOK, gin.H{
		"media":           media,
		"apontamentos":    apont,
		"total_meses":     n,
		"analise_grafico": analise,
		"modelo":          modeloChat,
	})
}

// analiseGraficoFallback gera a análise textual sem IA (quando o nano falha).
func analiseGraficoFallback(media float64, nApont int) string {
	if nApont > 0 {
		return fmt.Sprintf("Análise do gráfico de consumo: %d mês(es) com desvio >= +100%% sobre a média (~%.0f kWh) — apontamentos de desvio.", nApont, media)
	}
	return fmt.Sprintf("Análise do gráfico de consumo: consumo estável em torno de ~%.0f kWh, sem desvios >= +100%% da média.", media)
}
