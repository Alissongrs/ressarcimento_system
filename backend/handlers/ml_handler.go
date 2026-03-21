package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"ressarcimento-backend/database"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// MLPredictions representa o resultado das 3 predições ML para um processo
type MLPredictions struct {
	Credito   interface{} `json:"credito,omitempty"`
	Anomalia  interface{} `json:"anomalia,omitempty"`
	SLA       interface{} `json:"sla,omitempty"`
	Erro      string      `json:"erro,omitempty"`
	Timestamp int64       `json:"timestamp"`
}

// ProcessoMLData contém os dados necessários para as predições
type ProcessoMLData struct {
	DiasParaDeferimento float64 `json:"dias_para_deferimento"`
	ValorEstimado       float64 `json:"valor_estimado"`
	NumMovimentacoes    int     `json:"num_movimentacoes"`
	NumAnexos           int     `json:"num_anexos"`
	PassouAnalise       int     `json:"passou_analise"`
	Cliente             string  `json:"cliente"`
	DiasTotais          float64 `json:"dias_totais"`
}

// callMLAPI faz uma requisição HTTP para o serviço de ML e retorna a resposta
func callMLAPI(method string, endpoint string, payload interface{}) (map[string]interface{}, error) {
	url := fmt.Sprintf("http://localhost:8001%s", endpoint)

	var reqBody io.Reader
	if payload != nil {
		jsonBytes, err := json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("erro ao serializar payload: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBytes)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("erro ao criar request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("erro ao chamar ML API: %w", err)
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

// MLProcessoHandler retorna as predições ML para um processo específico
func MLProcessoHandler(c *gin.Context) {
	processoID := c.Param("id")

	// 1. Consulta dados do processo no banco
	var data ProcessoMLData
	query := `
	SELECT
		COALESCE(DATEDIFF(d.data_procedencia, p.data_criacao), 30) as dias_para_deferimento,
		COALESCE(p.ressarcimento_estimado, 0) as valor_estimado,
		COALESCE(COUNT(DISTINCT h.id_historico), 0) as num_movimentacoes,
		COALESCE(COUNT(DISTINCT a.id_anexo), 0) as num_anexos,
		CASE WHEN MAX(h.etapa_nova) = 'Distribuidora' OR MAX(h.etapa_anterior) = 'Distribuidora' THEN 1 ELSE 0 END as passou_analise,
		COALESCE(p.cliente, 'Desconhecido') as cliente,
		COALESCE(DATEDIFF(d.data_procedencia, p.data_criacao), 30) as dias_totais
	FROM FT_PROCESSOS p
	LEFT JOIN FT_DEFERIMENTOS d ON p.id_processo = d.id_processo
	LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON p.id_processo = h.id_requisicao
	LEFT JOIN FT_ANEXOS a ON p.id_processo = a.id_requisicao
	WHERE p.id_processo = ?
	GROUP BY p.id_processo
	`

	err := database.GormDB_App.Raw(query, processoID).Scan(&data).Error
	if err != nil {
		c.JSON(400, gin.H{
			"erro": "Processo não encontrado ou erro ao consultar banco",
			"detail": err.Error(),
		})
		return
	}

	// 2. Chama as 3 APIs de ML em paralelo usando goroutines
	var wg sync.WaitGroup
	creditoResult := make(chan map[string]interface{}, 1)
	anomaliaResult := make(chan map[string]interface{}, 1)
	slaResult := make(chan map[string]interface{}, 1)

	// Crédito
	wg.Add(1)
	go func() {
		defer wg.Done()
		creditoPayload := map[string]interface{}{
			"dias_para_deferimento": data.DiasParaDeferimento,
			"valor_estimado":        data.ValorEstimado,
			"num_movimentacoes":     data.NumMovimentacoes,
			"num_anexos":            data.NumAnexos,
			"passou_analise":        data.PassouAnalise,
		}
		result, err := callMLAPI("POST", "/predict/credito", creditoPayload)
		if err != nil {
			result = map[string]interface{}{"erro": err.Error()}
		}
		creditoResult <- result
	}()

	// Anomalia
	wg.Add(1)
	go func() {
		defer wg.Done()
		anomaliaPayload := map[string]interface{}{
			"valor_estimado":         data.ValorEstimado,
			"num_movimentacoes":      data.NumMovimentacoes,
			"num_anexos":             data.NumAnexos,
			"dias_para_deferimento":  data.DiasParaDeferimento,
			"cliente":                data.Cliente,
		}
		result, err := callMLAPI("POST", "/detect/anomaly", anomaliaPayload)
		if err != nil {
			result = map[string]interface{}{"erro": err.Error()}
		}
		anomaliaResult <- result
	}()

	// SLA
	wg.Add(1)
	go func() {
		defer wg.Done()
		slaPayload := map[string]interface{}{
			"num_movimentacoes_etapa": data.NumMovimentacoes,
			"tempo_medio_geral":       30.0, // valor padrão, poderia ser calculado
			"dias_totais":             data.DiasTotais,
		}
		result, err := callMLAPI("POST", "/predict/sla", slaPayload)
		if err != nil {
			result = map[string]interface{}{"erro": err.Error()}
		}
		slaResult <- result
	}()

	wg.Wait()

	// 3. Coleta resultados
	credito := <-creditoResult
	anomalia := <-anomaliaResult
	sla := <-slaResult

	predictions := MLPredictions{
		Credito:   credito,
		Anomalia:  anomalia,
		SLA:       sla,
		Timestamp: time.Now().Unix(),
	}

	c.JSON(200, predictions)
}

// MLStatusHandler verifica se o serviço de ML está online
func MLStatusHandler(c *gin.Context) {
	_, err := callMLAPI("GET", "/health", nil)
	if err != nil {
		c.JSON(503, gin.H{
			"status": "ml_unavailable",
			"erro":   err.Error(),
		})
		return
	}

	c.JSON(200, gin.H{
		"status": "ok",
		"ml_api": "online",
		"port":   8001,
	})
}
