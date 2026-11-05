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
	"log"
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
	audio, err := io.ReadAll(f)
	f.Close()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "não consegui ler o áudio"})
		return
	}

	// modelo configurado primeiro; se a chave não tiver acesso a ele (403/404), tenta o próximo
	modelos := vozModelos(vozEnv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe"), "gpt-4o-transcribe", "whisper-1")
	ultimoErro := ""
	for _, modelo := range modelos {
		var buf bytes.Buffer
		w := multipart.NewWriter(&buf)
		_ = w.WriteField("model", modelo)
		_ = w.WriteField("language", "pt")
		_ = w.WriteField("prompt", vozPromptSTT)
		_ = w.WriteField("response_format", "json")
		part, _ := w.CreateFormFile("file", nome)
		_, _ = part.Write(audio)
		_ = w.Close()

		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, openAIBase()+"/v1/audio/transcriptions", &buf)
		req.Header.Set("Authorization", "Bearer "+openAIKey())
		req.Header.Set("Content-Type", w.FormDataContentType())
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			c.JSON(http.StatusBadGateway, gin.H{"error": "transcrição indisponível agora"})
			return
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		cancel()
		if resp.StatusCode == http.StatusOK {
			var out struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(body, &out)
			c.JSON(http.StatusOK, gin.H{"texto": strings.TrimSpace(out.Text), "modelo": modelo})
			return
		}
		ultimoErro = "a transcrição falhou (OpenAI " + resp.Status + ", modelo " + modelo + ")" + vozMotivo(body)
		log.Printf("[voz] transcrição %s: %s", modelo, ultimoErro)
		if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusNotFound {
			break
		}
	}
	c.JSON(http.StatusBadGateway, gin.H{"error": ultimoErro})
}

// lista sem repetidos, na ordem
func vozModelos(ms ...string) []string {
	var out []string
	visto := map[string]bool{}
	for _, m := range ms {
		m = strings.TrimSpace(m)
		if m != "" && !visto[m] {
			visto[m] = true
			out = append(out, m)
		}
	}
	return out
}

// motivo que a OpenAI devolve no erro (ex.: "Project does not have access to model …")
func vozMotivo(body []byte) string {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &e) != nil || strings.TrimSpace(e.Error.Message) == "" {
		return ""
	}
	m := strings.TrimSpace(e.Error.Message)
	if utf8.RuneCountInString(m) > 220 {
		m = string([]rune(m)[:220]) + "…"
	}
	return ": " + m
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
	ultimoErro := ""
	for _, modelo := range vozModelos(vozEnv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"), "tts-1") {
		corpo := map[string]any{
			"model":           modelo,
			"voice":           vozEnv("OPENAI_TTS_VOICE", "coral"),
			"input":           txt,
			"response_format": "mp3",
		}
		if strings.HasPrefix(modelo, "gpt-") {
			corpo["instructions"] = "Fale em português do Brasil, com sotaque brasileiro natural, tom cordial e profissional de uma colega de trabalho, ritmo de conversa (nem lento nem apressado)."
		} else if corpo["voice"] == "coral" {
			corpo["voice"] = "nova" // tts-1 não tem a coral
		}
		payload, _ := json.Marshal(corpo)
		ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, openAIBase()+"/v1/audio/speech", bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+openAIKey())
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			c.JSON(http.StatusBadGateway, gin.H{"error": "voz indisponível agora"})
			return
		}
		if resp.StatusCode == http.StatusOK {
			defer cancel()
			defer resp.Body.Close()
			c.Header("Cache-Control", "no-store")
			c.DataFromReader(http.StatusOK, -1, "audio/mpeg", io.LimitReader(resp.Body, 20<<20), nil)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		cancel()
		ultimoErro = "a voz falhou (OpenAI " + resp.Status + ", modelo " + modelo + ")" + vozMotivo(body)
		log.Printf("[voz] fala %s: %s", modelo, ultimoErro)
		if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusNotFound {
			break
		}
	}
	c.JSON(http.StatusBadGateway, gin.H{"error": ultimoErro})
}
