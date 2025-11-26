package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
)

// PerguntaIAHandler chama a API do agente de IA rodando no Docker.
func PerguntaIAHandler(c *gin.Context) {
	// 1. O struct agora espera receber um JSON com a chave "question".
	var input struct {
		Question string `json:"question"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo da requisição inválido. Certifique-se de enviar um JSON com a chave 'question'."})
		return
	}

	// 2. Prepara a requisição para a API do agente Docker
	agentURL := "http://localhost:8000/query"

	// Cria o corpo da requisição para o agente usando o mesmo campo recebido.
	requestBody, _ := json.Marshal(map[string]string{
		"question": input.Question,
	})

	req, err := http.NewRequest("POST", agentURL, bytes.NewBuffer(requestBody))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar requisição para o agente.", "details": err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")

	// 3. Executa a requisição
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Não foi possível se comunicar com o agente de IA.", "details": err.Error()})
		return
	}
	defer resp.Body.Close()

	// 4. Ler e processar a resposta do agente
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao ler a resposta do agente.", "details": err.Error()})
		return
	}

	// Se o agente retornar um erro (status code diferente de 200), repassamos a resposta de erro dele.
	if resp.StatusCode != http.StatusOK {
		c.Data(resp.StatusCode, "application/json", responseBody)
		return
	}

	// 5. Extrair e retornar a resposta final e amigável
	var agentResponse struct {
		FinalAnswer string `json:"final_answer"`
	}
	if err := json.Unmarshal(responseBody, &agentResponse); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao processar a resposta do agente.", "details": err.Error()})
		return
	}

	// Retorna a resposta limpa para o frontend
	c.JSON(http.StatusOK, gin.H{"resposta": agentResponse.FinalAnswer})
}
