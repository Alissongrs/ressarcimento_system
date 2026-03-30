package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// EmailExtractResult é a resposta estruturada do endpoint de extração por IA
type EmailExtractResult struct {
	TipoResposta    string   `json:"tipo_resposta"`
	Valor           *float64 `json:"valor"`
	Prazo           *string  `json:"prazo"`
	NumeroProtocolo *string  `json:"numero_protocolo"`
	Resumo          string   `json:"resumo"`
	Erro            string   `json:"erro,omitempty"`
}

// ExtrairDadosEmail extrai dados estruturados de um email via IA.
// POST /api/v1/processos/:id/historico/:histId/extrair-email
func ExtrairDadosEmail(c *gin.Context) {
	processoIDStr := c.Param("id")
	histIDStr := c.Param("hid")

	processoID, err := strconv.ParseInt(processoIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"erro": "id de processo inválido"})
		return
	}
	histID, err := strconv.ParseInt(histIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"erro": "id de histórico inválido"})
		return
	}

	// 1. Buscar comentario e tipo_movimentacao do histórico
	var comentario, tipoMov string
	row := queryRowGorm(database.GormDB_App, `
		SELECT COALESCE(comentario,''), COALESCE(tipo_movimentacao,'')
		FROM FT_HISTORICO_MOVIMENTACOES
		WHERE id_historico = ?
		  AND id_requisicao = ?`,
		histID, processoID,
	)
	if err := row.Scan(&comentario, &tipoMov); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"erro": "movimentação não encontrada"})
		return
	}
	if tipoMov != "EMAIL" {
		c.JSON(http.StatusBadRequest, gin.H{"erro": "movimentação não é do tipo EMAIL"})
		return
	}
	if comentario == "" {
		c.JSON(http.StatusOK, EmailExtractResult{
			TipoResposta: "outros",
			Resumo:       "Email sem conteúdo para análise.",
		})
		return
	}

	// 2. Chamar llama-agent
	llamaURL := os.Getenv("LLAMA_AGENT_URL")
	if llamaURL == "" {
		llamaURL = "http://localhost:8000"
	}

	payload, _ := json.Marshal(map[string]string{"email_html": comentario})
	req, err := http.NewRequest("POST", llamaURL+"/extract/email-data", bytes.NewBuffer(payload))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"erro": fmt.Sprintf("erro ao criar request: %v", err)})
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 180 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusOK, EmailExtractResult{
			TipoResposta: "outros",
			Resumo:       "Serviço de IA indisponível no momento.",
			Erro:         err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	// 3. Interpretar resposta
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusGatewayTimeout {
		c.JSON(http.StatusOK, EmailExtractResult{
			TipoResposta: "outros",
			Resumo:       "Tempo de resposta da IA excedido. Tente novamente.",
			Erro:         "timeout",
		})
		return
	}
	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusOK, EmailExtractResult{
			TipoResposta: "outros",
			Resumo:       "Erro ao processar email com IA.",
			Erro:         string(body),
		})
		return
	}

	var result EmailExtractResult
	if err := json.Unmarshal(body, &result); err != nil {
		c.JSON(http.StatusOK, EmailExtractResult{
			TipoResposta: "outros",
			Resumo:       "Resposta inválida da IA.",
			Erro:         err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, result)
}
