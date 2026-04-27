package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const promptTestModel = "gpt-5.4-nano"

// TestarPromptHandler testa um prompt customizado com uma fatura opcional.
// POST /api/v1/ia/testar-prompt
// Body: { prompt: string, images: [{base64: string, mime: string}] }
func TestarPromptHandler(c *gin.Context) {
	var input struct {
		Prompt string            `json:"prompt"`
		Images []faturaImageItem `json:"images"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	if strings.TrimSpace(input.Prompt) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "prompt não pode ser vazio"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var resposta string
	var err error

	imgs := make([]faturaImageItem, 0, len(input.Images))
	for _, img := range input.Images {
		if img.Base64 == "" {
			continue
		}
		mime := img.Mime
		if mime == "" {
			mime = "image/jpeg"
		}
		imgs = append(imgs, faturaImageItem{Base64: img.Base64, Mime: mime})
	}

	if len(imgs) > 0 {
		resposta, err = callPromptTestVision(ctx, input.Prompt, imgs)
	} else {
		resposta, err = callPromptTestText(ctx, input.Prompt)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"resposta": resposta})
}

func callPromptTestText(ctx context.Context, prompt string) (string, error) {
	type oaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}

	msgs := []oaiMsg{
		{Role: "system", Content: prompt},
		{Role: "user", Content: "Execute o prompt acima. Nenhuma fatura foi anexada."},
	}

	reqBody := map[string]interface{}{
		"model":                          promptTestModel,
		"messages":                       msgs,
		aisureTokensKey(promptTestModel): 4096,
	}
	if aisureSupportsTemperature(promptTestModel) {
		reqBody["temperature"] = 0.3
	}

	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	res, retryErr := doOpenAIWithRetry(ctx, payload)
	if retryErr != nil {
		return "", retryErr
	}
	if res.status != http.StatusOK {
		return "", fmt.Errorf("openai status %d: %s", res.status, string(res.body))
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(res.body, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("sem resposta do modelo")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func callPromptTestVision(ctx context.Context, prompt string, images []faturaImageItem) (string, error) {
	type imgURL struct {
		URL    string `json:"url"`
		Detail string `json:"detail"`
	}
	type contentPart struct {
		Type     string  `json:"type"`
		Text     string  `json:"text,omitempty"`
		ImageURL *imgURL `json:"image_url,omitempty"`
	}
	type msgFlex struct {
		Role    string      `json:"role"`
		Content interface{} `json:"content"`
	}

	parts := make([]contentPart, 0, len(images)+1)
	parts = append(parts, contentPart{Type: "text", Text: "Fatura anexada — aplique o prompt do sistema a esta fatura:"})
	for _, img := range images {
		mime := img.Mime
		if mime == "" {
			mime = "image/jpeg"
		}
		parts = append(parts, contentPart{
			Type:     "image_url",
			ImageURL: &imgURL{URL: "data:" + mime + ";base64," + img.Base64, Detail: "high"},
		})
	}

	msgs := []msgFlex{
		{Role: "system", Content: prompt},
		{Role: "user", Content: parts},
	}

	reqBody := map[string]interface{}{
		"model":                          promptTestModel,
		"messages":                       msgs,
		aisureTokensKey(promptTestModel): 10000,
	}
	if aisureSupportsTemperature(promptTestModel) {
		reqBody["temperature"] = 0.3
	}

	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}

	res, retryErr := doOpenAIWithRetry(ctx, payload)
	if retryErr != nil {
		return "", retryErr
	}
	if res.status != http.StatusOK {
		return "", fmt.Errorf("openai vision status %d: %s", res.status, string(res.body))
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(res.body, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("sem resposta do modelo")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}
