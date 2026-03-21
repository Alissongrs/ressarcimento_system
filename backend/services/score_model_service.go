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

	resp, err := http.Post(url, "application/json", nil)
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
