package services

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

func llamaAgentURL() string {
	if url := os.Getenv("LLAMA_AGENT_URL"); url != "" {
		return url
	}
	return "http://localhost:8000"
}

// AtualizarScoreModel dispara o retreino via endpoint da API Python
func AtualizarScoreModel() error {
	url := llamaAgentURL() + "/train/score"

	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return fmt.Errorf("[Score Model] Erro ao criar request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token := os.Getenv("TRAIN_API_TOKEN"); token != "" {
		req.Header.Set("X-Train-Token", token)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("[Score Model] Erro ao chamar /train/score: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("[Score Model] Status %d: %s", resp.StatusCode, string(body))
	}

	fmt.Printf("[Score Model] Retreino iniciado às %s — %s\n",
		time.Now().Format("15:04:05"), string(body))
	return nil
}

// AtualizarScoreModelAsync executa em background (goroutine)
func AtualizarScoreModelAsync() {
	go func() {
		if err := AtualizarScoreModel(); err != nil {
			fmt.Printf("[Score Model] Erro assíncrono: %v\n", err)
		}
	}()
}
