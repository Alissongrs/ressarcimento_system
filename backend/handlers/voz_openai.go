package handlers

// Conversa por voz (app do celular, /m/): o celular grava a fala e manda para cá;
// a OpenAI transcreve (STT) e, na volta, transforma a resposta em voz (TTS).
// A chave da OpenAI fica só no servidor (OPENAI_API_KEY) — nada vai para o celular.
//
//   POST /api/v1/voz/openai/transcrever  multipart "audio" (webm/ogg/mp4/m4a/wav, até 15 MB) → {"texto": "..."}
//   POST /api/v1/voz/openai/falar {"texto": "..."} → audio/mpeg
//
// Modelos/voz configuráveis: OPENAI_STT_MODEL (gpt-4o-mini-transcribe), OPENAI_TTS_MODEL
// (gpt-4o-mini-tts), OPENAI_TTS_VOICE (coral). A voz do chat do SITE (edge-tts, voz_handler.go) continua igual.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const vozMaxAudio = 15 << 20

// vocabulário que ajuda a transcrição a acertar nomes do dia a dia
const vozPromptSTT = "Conversa de trabalho no SURE, sistema de ressarcimento de energia. Termos: SURE, ANEEL, Ouvidoria, " +
	"distribuidora, concessionária, UC, unidade consumidora, fatura, deferimento, indeferido, repasse, protocolo, " +
	"requisição, Claro, Enel, Light, CEMIG, Copel, CELESC, Equatorial, Energisa, CPFL, Coelba, pdf_pipeline."

// POST /voz/openai/transcrever
func VozTranscreverOpenAI(c *gin.Context) {
	if openAIKey() == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "voz indisponível: chave da OpenAI não configurada no servidor"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, vozMaxAudio+1<<20)
	fh, err := c.FormFile("audio")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "envie o áudio no campo 'audio'"})
		return
	}
	if fh.Size == 0 || fh.Size > vozMaxAudio {
		c.JSON(http.StatusBadRequest, gin.H{"error": "áudio vazio ou maior que 15 MB"})
		return
	}
	nome := filepath.Base(fh.Filename)
	switch strings.ToLower(filepath.Ext(nome)) {
	case ".webm", ".ogg", ".mp4", ".m4a", ".mp3", ".wav", ".mpeg", ".mpga":
	default:
		nome = "fala.webm"
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "não consegui ler o áudio"})
		return
	}
	defer f.Close()

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("model", vozEnv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe"))
	_ = w.WriteField("language", "pt")
	_ = w.WriteField("prompt", vozPromptSTT)
	_ = w.WriteField("response_format", "json")
	part, _ := w.CreateFormFile("file", nome)
	if _, err := io.Copy(part, f); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "não consegui ler o áudio"})
		return
	}
	_ = w.Close()

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, openAIBase()+"/v1/audio/transcriptions", &buf)
	req.Header.Set("Authorization", "Bearer "+openAIKey())
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "transcrição indisponível agora"})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"error": "a transcrição falhou (OpenAI " + resp.Status + ")"})
		return
	}
	var out struct {
		Text string `json:"text"`
	}
	_ = json.Unmarshal(body, &out)
	c.JSON(http.StatusOK, gin.H{"texto": strings.TrimSpace(out.Text)})
}

// POST /voz/openai/falar
func VozFalarOpenAI(c *gin.Context) {
	if openAIKey() == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "voz indisponível: chave da OpenAI não configurada no servidor"})
		return
	}
	var b struct {
		Texto string `json:"texto"`
	}
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Texto) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "texto obrigatório"})
		return
	}
	txt := strings.TrimSpace(b.Texto)
	if utf8.RuneCountInString(txt) > 3000 {
		txt = string([]rune(txt)[:3000])
	}
	payload, _ := json.Marshal(map[string]any{
		"model":           vozEnv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
		"voice":           vozEnv("OPENAI_TTS_VOICE", "coral"),
		"input":           txt,
		"instructions":    "Fale em português do Brasil, com sotaque brasileiro natural, tom cordial e profissional de uma colega de trabalho, ritmo de conversa (nem lento nem apressado).",
		"response_format": "mp3",
	})
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, openAIBase()+"/v1/audio/speech", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+openAIKey())
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "voz indisponível agora"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"error": "a voz falhou (OpenAI " + resp.Status + ")"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.DataFromReader(http.StatusOK, -1, "audio/mpeg", io.LimitReader(resp.Body, 20<<20), nil)
}
