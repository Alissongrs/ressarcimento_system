package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"ressarcimento-backend/database"
	"time"

	"github.com/gin-gonic/gin"
)

// ScoreData contém os 10 features para o Score de Progressão
type ScoreData struct {
	NumMovimentacoes           int     `json:"num_movimentacoes"`
	NumAnexos                  int     `json:"num_anexos"`
	ValorEstimado              float64 `json:"valor_estimado"`
	DiasEmProcessamento        int     `json:"dias_em_processamento"`
	PassouDistribuidora        int     `json:"passou_distribuidora"`
	IDTipoIrregularidade       int     `json:"id_tipo_irregularidade"`
	IDSubtipoIrregularidade    int     `json:"id_subtipo_irregularidade"`
	TemDescricao               int     `json:"tem_descricao"`
	TemLinkFatura              int     `json:"tem_link_fatura"`
	TemPeriodos                int     `json:"tem_periodos"`
}

// ScoreResponse é a resposta do modelo de Score
type ScoreResponse struct {
	Score      float64 `json:"score"`
	Label      string  `json:"label"`
	Percentual float64 `json:"percentual"`
	Prediction int     `json:"prediction"`
	Erro       string  `json:"erro,omitempty"`
	Timestamp  int64   `json:"timestamp"`
}

// callScoreAPI faz uma requisição para o endpoint /predict/score
func callScoreAPI(payload ScoreData) (map[string]interface{}, error) {
	// Detecta URL do agente: Docker (LLAMA_AGENT_URL) ou localhost para dev
	llamaURL := os.Getenv("LLAMA_AGENT_URL")
	if llamaURL == "" {
		llamaURL = "http://localhost:8000" // dev local
	}
	url := llamaURL + "/predict/score"

	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("erro ao serializar payload: %w", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonBytes))
	if err != nil {
		return nil, fmt.Errorf("erro ao criar request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("erro ao chamar Score API: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("erro ao ler resposta: %w", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("erro ao deserializar resposta: %w", err)
	}

	return result, nil
}

// ScoreProcessoHandler retorna o Score de Progressão para um processo específico
func ScoreProcessoHandler(c *gin.Context) {
	processoID := c.Param("id")

	// 1. Consulta os 10 features do processo no banco
	var data ScoreData
	query := `
	SELECT
		-- Feature 1: Numero de movimentacoes
		COALESCE(COUNT(DISTINCT hm.id_historico), 0) as num_movimentacoes,
		-- Feature 2: Numero de anexos
		COALESCE((SELECT COUNT(DISTINCT id_anexo) FROM FT_ANEXOS WHERE id_requisicao = p.id_requisicao), 0) as num_anexos,
		-- Feature 3: Valor estimado
		COALESCE(p.ressarcimento_estimado, 0) as valor_estimado,
		-- Feature 4: Dias em processamento
		COALESCE(DATEDIFF(NOW(), p.data_criacao), 0) as dias_em_processamento,
		-- Feature 5: Passou na distribuidora
		CASE
			WHEN MAX(hm.etapa_nova) = 'Distribuidora' OR MAX(hm.etapa_anterior) = 'Distribuidora' THEN 1
			ELSE 0
		END as passou_distribuidora,
		-- Feature 6: Tipo de irregularidade
		COALESCE(p.id_tipo_irregularidade, 0) as id_tipo_irregularidade,
		-- Feature 7: Subtipo de irregularidade
		COALESCE(p.id_subtipo_irregularidade, 0) as id_subtipo_irregularidade,
		-- Feature 8: Tem descricao
		CASE WHEN COALESCE(p.descricao_irregularidade, '') != '' THEN 1 ELSE 0 END as tem_descricao,
		-- Feature 9: Tem link de fatura
		CASE WHEN COALESCE(p.link_fatura, '') != '' THEN 1 ELSE 0 END as tem_link_fatura,
		-- Feature 10: Tem periodos
		CASE WHEN COALESCE(p.periodos_irregularidade, '') != '' THEN 1 ELSE 0 END as tem_periodos
	FROM FT_REQUISICOES p
	LEFT JOIN FT_HISTORICO_MOVIMENTACOES hm ON p.id_requisicao = hm.id_requisicao
	WHERE p.id_requisicao = ?
	GROUP BY p.id_requisicao, p.ressarcimento_estimado,
	         p.data_criacao, p.id_tipo_irregularidade, p.id_subtipo_irregularidade,
	         p.descricao_irregularidade, p.link_fatura, p.periodos_irregularidade
	`

	err := database.GormDB_App.Raw(query, processoID).Scan(&data).Error
	if err != nil {
		c.JSON(400, gin.H{
			"erro":   "Processo não encontrado ou erro ao consultar banco",
			"detail": err.Error(),
		})
		return
	}

	// 2. Chama o endpoint /predict/score
	result, err := callScoreAPI(data)
	if err != nil {
		// Se ML API falhar, retorna erro mas não causa 500
		c.JSON(200, ScoreResponse{
			Score:     0,
			Label:     "",
			Percentual: 0,
			Erro:      err.Error(),
			Timestamp: time.Now().Unix(),
		})
		return
	}

	// 3. Prepara resposta
	response := ScoreResponse{
		Timestamp: time.Now().Unix(),
	}

	// Extrai valores da resposta
	if val, ok := result["score"].(float64); ok {
		response.Score = val
	}
	if val, ok := result["label"].(string); ok {
		response.Label = val
	}
	if val, ok := result["percentual"].(float64); ok {
		response.Percentual = val
	}
	if val, ok := result["prediction"].(float64); ok {
		response.Prediction = int(val)
	}
	if val, ok := result["erro"].(string); ok {
		response.Erro = val
	}

	c.JSON(200, response)
}
