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

// ScoreData contém as features estáticas (definidas na criação) para o Score de Progressão.
// Features temporais (num_movimentacoes, num_anexos, passou_distribuidora) foram removidas
// por causarem data leakage — acumulam ao longo do tempo e não refletem o estado em Ativos.
type ScoreData struct {
	ValorEstimado           float64 `db:"valor_estimado"            json:"valor_estimado"`
	DiasEmProcessamento     int     `db:"dias_em_processamento"     json:"dias_em_processamento"`
	IDTipoIrregularidade    int     `db:"id_tipo_irregularidade"    json:"id_tipo_irregularidade"`
	IDSubtipoIrregularidade int     `db:"id_subtipo_irregularidade" json:"id_subtipo_irregularidade"`
	TemDescricao            int     `db:"tem_descricao"             json:"tem_descricao"`
	TemLinkFatura           int     `db:"tem_link_fatura"           json:"tem_link_fatura"`
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

	client := &http.Client{Timeout: 30 * time.Second}
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

const scoreCacheTTL = 24 * time.Hour

// scoreFromCache tenta retornar um score salvo no banco se ainda válido.
func scoreFromCache(processoID string) (*ScoreResponse, bool) {
	var cached struct {
		Score       float64
		Label       string
		Percentual  float64
		CalculadoEm time.Time
	}
	err := database.GormDB_App.Raw(`
		SELECT score, label, percentual, calculado_em
		FROM FT_SCORE_PROGRESSAO
		WHERE id_requisicao = ?`, processoID).Scan(&cached).Error
	if err != nil || cached.CalculadoEm.IsZero() {
		return nil, false
	}
	if time.Since(cached.CalculadoEm) > scoreCacheTTL {
		return nil, false
	}
	return &ScoreResponse{
		Score:      cached.Score,
		Label:      cached.Label,
		Percentual: cached.Percentual,
		Timestamp:  cached.CalculadoEm.Unix(),
	}, true
}

// saveScoreCache persiste o score calculado no banco (INSERT ou UPDATE).
func saveScoreCache(processoID string, r ScoreResponse) {
	database.GormDB_App.Exec(`
		INSERT INTO FT_SCORE_PROGRESSAO (id_requisicao, score, label, percentual, calculado_em, modelo_versao)
		VALUES (?, ?, ?, ?, NOW(), '1.0')
		ON DUPLICATE KEY UPDATE
		  score = VALUES(score),
		  label = VALUES(label),
		  percentual = VALUES(percentual),
		  calculado_em = NOW()`,
		processoID, r.Score, r.Label, r.Percentual)

	// Sincroniza percentual em FT_PROCESSOS para consultas diretas sem JOIN
	database.GormDB_App.Exec(
		`UPDATE FT_PROCESSOS SET score_percentual = ? WHERE id_processo = ?`,
		r.Percentual, processoID)
}

// InvalidateScoreCache remove o cache de score de um processo (chamado ao mover de Ativos).
func InvalidateScoreCache(processoID any) {
	database.GormDB_App.Exec(
		`DELETE FROM FT_SCORE_PROGRESSAO WHERE id_requisicao = ?`, processoID)
	database.GormDB_App.Exec(
		`UPDATE FT_PROCESSOS SET score_percentual = NULL WHERE id_processo = ?`, processoID)
}

// RegistrarTrainingLog grava o resultado real quando um processo sai de Ativos.
// colunaDestino IN (3,4,5) = avançou; (6,99) = não avançou.
func RegistrarTrainingLog(processoID any, colunaDestino int, features ScoreData) {
	avancou := 0
	if colunaDestino == 3 || colunaDestino == 4 || colunaDestino == 5 {
		avancou = 1
	}
	featJSON, err := json.Marshal(features)
	if err != nil {
		return
	}
	database.GormDB_App.Exec(`
		INSERT INTO FT_SCORE_TRAINING_LOG (id_requisicao, avancou, features_json)
		VALUES (?, ?, ?)`,
		processoID, avancou, string(featJSON))
}

// ScoreProcessoHandler retorna o Score de Progressão para um processo específico
func ScoreProcessoHandler(c *gin.Context) {
	processoID := c.Param("id")

	// 1. Verifica cache no banco (evita chamar Python se score ainda é válido)
	if cached, ok := scoreFromCache(processoID); ok {
		c.JSON(200, cached)
		return
	}

	// 2. Consulta os 10 features do processo no banco
	var data ScoreData
	const query = `
	SELECT
		COALESCE(p.ressarcimento_estimado, 0)                                         AS valor_estimado,
		COALESCE(DATEDIFF(NOW(), p.data_criacao), 0)                                  AS dias_em_processamento,
		COALESCE(p.id_tipo_irregularidade, 0)                                         AS id_tipo_irregularidade,
		COALESCE(p.id_subtipo_irregularidade, 0)                                      AS id_subtipo_irregularidade,
		CASE WHEN COALESCE(p.descricao_irregularidade, '') != '' THEN 1 ELSE 0 END    AS tem_descricao,
		CASE WHEN COALESCE(p.link_fatura, '') != '' THEN 1 ELSE 0 END                 AS tem_link_fatura
	FROM FT_REQUISICOES p
	WHERE p.id_requisicao = ?`

	row := database.GormDB_App.Raw(query, processoID).Row()
	if err := row.Scan(
		&data.ValorEstimado,
		&data.DiasEmProcessamento,
		&data.IDTipoIrregularidade,
		&data.IDSubtipoIrregularidade,
		&data.TemDescricao,
		&data.TemLinkFatura,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"erro": "Erro ao consultar banco"})
		return
	}

	// 3. Chama o Python
	result, err := callScoreAPI(data)
	if err != nil {
		c.JSON(200, ScoreResponse{
			Erro:      err.Error(),
			Timestamp: time.Now().Unix(),
		})
		return
	}

	// 4. Monta resposta
	response := ScoreResponse{Timestamp: time.Now().Unix()}
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

	// 5. Salva no cache (assíncrono para não atrasar a resposta)
	if response.Erro == "" {
		go saveScoreCache(processoID, response)
	}

	c.JSON(200, response)
}

// PrecalcularScoresHandler calcula e armazena o score de todos os processos em Ativos
// que ainda não têm cache válido. Roda em background e retorna imediatamente.
// POST /api/v1/admin/score/precalcular
func PrecalcularScoresHandler(c *gin.Context) {
	const qAtivos = `
		SELECT r.id_requisicao
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN FT_SCORE_PROGRESSAO sp ON sp.id_requisicao = r.id_requisicao
			AND sp.calculado_em > DATE_SUB(NOW(), INTERVAL 24 HOUR)
		WHERE p.id_coluna = 1
		  AND sp.id_requisicao IS NULL`

	rows, err := database.GormDB_App.Raw(qAtivos).Rows()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"erro": "Erro ao consultar processos"})
		return
	}

	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	total := len(ids)
	if total == 0 {
		c.JSON(200, gin.H{"ok": true, "mensagem": "Todos os scores já estão atualizados.", "total": 0})
		return
	}

	// Processa em background com concorrência limitada (5 por vez)
	go func(reqIDs []int64) {
		sem := make(chan struct{}, 5)
		for _, rid := range reqIDs {
			sem <- struct{}{}
			go func(id int64) {
				defer func() { <-sem }()

				var data ScoreData
				const q = `
				SELECT
					COALESCE(p.ressarcimento_estimado, 0),
					COALESCE(DATEDIFF(NOW(), p.data_criacao), 0),
					COALESCE(p.id_tipo_irregularidade, 0),
					COALESCE(p.id_subtipo_irregularidade, 0),
					CASE WHEN COALESCE(p.descricao_irregularidade, '') != '' THEN 1 ELSE 0 END,
					CASE WHEN COALESCE(p.link_fatura, '') != '' THEN 1 ELSE 0 END
				FROM FT_REQUISICOES p
				WHERE p.id_requisicao = ?`

				row2 := database.GormDB_App.Raw(q, id).Row()
				if err := row2.Scan(
					&data.ValorEstimado,
					&data.DiasEmProcessamento,
					&data.IDTipoIrregularidade,
					&data.IDSubtipoIrregularidade,
					&data.TemDescricao,
					&data.TemLinkFatura,
				); err != nil {
					return
				}
				result, err := callScoreAPI(data)
				if err != nil {
					return
				}
				resp := ScoreResponse{}
				if v, ok := result["score"].(float64); ok { resp.Score = v }
				if v, ok := result["label"].(string); ok { resp.Label = v }
				if v, ok := result["percentual"].(float64); ok { resp.Percentual = v }
				if v, ok := result["erro"].(string); ok { resp.Erro = v }
				if resp.Erro == "" {
					saveScoreCache(fmt.Sprintf("%d", id), resp)
				}
			}(rid)
		}
		// Aguarda todos terminarem
		for i := 0; i < cap(sem); i++ {
			sem <- struct{}{}
		}
	}(ids)

	c.JSON(http.StatusAccepted, gin.H{
		"ok":      true,
		"mensagem": fmt.Sprintf("Calculando scores de %d processos em background.", total),
		"total":   total,
	})
}
