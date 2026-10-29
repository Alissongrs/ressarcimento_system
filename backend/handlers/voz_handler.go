package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// Voz do chat do SURE — POST /api/v1/voz/falar {"texto": "..."} → audio/mpeg
//
// Usa o edge-tts (github.com/rany2/edge-tts, instalado na imagem do backend), que gera
// vozes NEURAIS da Microsoft — muito mais naturais e fluidas que a voz do navegador, e
// a fala sai num áudio único (sem as pausas frase-a-frase do Google). Sem chave/custo.
// Voz feminina por padrão (pt-BR-FranciscaNeural; alternativa: pt-BR-ThalitaMultilingualNeural).
// Configurável: TTS_VOZ, TTS_VELOCIDADE (ex.: "+6%"), PYTHON_PATH.
// Se falhar, o front cai sozinho para a voz do navegador.
// ============================================================================

func vozEnv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

// Áudios prontos ficam em memória por alguns minutos e são servidos por URL do PRÓPRIO
// site (/api/v1/voz/audio/:id). Assim o navegador toca sem precisar de "blob:" na
// Content-Security-Policy (media-src cai no default-src 'self'). O id é aleatório (128 bits)
// e expira — não dá para adivinhar nem reaproveitar depois.
var (
	vozCacheMu sync.Mutex
	vozCache   = map[string]vozItem{}
)

type vozItem struct {
	audio  []byte
	expira time.Time
}

func guardarAudio(audio []byte) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	agora := time.Now()
	vozCacheMu.Lock()
	for k, v := range vozCache { // limpeza preguiçosa
		if agora.After(v.expira) {
			delete(vozCache, k)
		}
	}
	vozCache[id] = vozItem{audio: audio, expira: agora.Add(5 * time.Minute)}
	vozCacheMu.Unlock()
	return id
}

// AudioVoz — GET /api/v1/voz/audio/:id → audio/mpeg (gerado antes por POST /voz/falar?url=1)
func AudioVoz(c *gin.Context) {
	vozCacheMu.Lock()
	it, ok := vozCache[c.Param("id")]
	vozCacheMu.Unlock()
	if !ok || time.Now().After(it.expira) {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Cache-Control", "private, max-age=300")
	c.Data(http.StatusOK, "audio/mpeg", it.audio)
}

// FalarVoz — POST /api/v1/voz/falar
func FalarVoz(c *gin.Context) {
	var b struct {
		Texto  string `json:"texto"`
		Estilo string `json:"estilo"` // "sure" (padrão, Francisca) | "robo" (estilo Ultron)
	}
	if err := c.ShouldBindJSON(&b); err != nil || strings.TrimSpace(b.Texto) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "texto obrigatório"})
		return
	}
	txt := strings.Join(strings.Fields(b.Texto), " ")
	if utf8.RuneCountInString(txt) > 1500 { // fala longa (tabelas) não faz sentido em voz
		txt = string([]rune(txt)[:1500])
	}

	tmp, err := os.CreateTemp("", "sure_voz_*.mp3")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	saida := tmp.Name()
	tmp.Close()
	defer os.Remove(saida)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 40*time.Second)
	defer cancel()
	py := vozEnv("PYTHON_PATH", "python3")
	// argumentos separados (sem shell) — o texto do usuário nunca é interpretado como comando
	voz, rate, pitch := vozEnv("TTS_VOZ", "pt-BR-FranciscaNeural"), vozEnv("TTS_VELOCIDADE", "+6%"), "+0Hz"
	robo := b.Estilo == "robo"
	if robo {
		// estilo "Ultron": voz masculina genérica, mais lenta e grave (o efeito metálico vem depois)
		voz, rate, pitch = vozEnv("TTS_VOZ_ROBO", "pt-BR-AntonioNeural"), "-8%", "-12Hz"
	}
	cmd := exec.CommandContext(ctx, py, "-m", "edge_tts",
		"--voice", voz,
		"--rate="+rate,
		"--pitch="+pitch,
		"--text", txt,
		"--write-media", saida)
	if out, err := cmd.CombinedOutput(); err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": "não consegui gerar a voz", "motivo": msg})
		return
	}
	if robo {
		aplicarEfeitoRobo(ctx, saida) // se o ffmpeg não existir/falhar, fica a voz sem efeito
	}
	audio, err := os.ReadFile(filepath.Clean(saida))
	if err != nil || len(audio) == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"error": "não consegui gerar a voz"})
		return
	}
	// ?url=1 → devolve só o endereço do áudio (o front toca por URL do próprio site)
	if c.Query("url") == "1" {
		c.JSON(http.StatusOK, gin.H{"url": "/api/v1/voz/audio/" + guardarAudio(audio)})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Data(http.StatusOK, "audio/mpeg", audio) // tipo explícito (a imagem slim não mapeia .mp3)
}

// aplicarEfeitoRobo deixa a voz com timbre de IA de cinema (grave, metálica e com leve eco),
// usando o ffmpeg da imagem. Sobrescreve o MP3 só se der certo.
func aplicarEfeitoRobo(ctx context.Context, arquivo string) {
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		return
	}
	saida := arquivo + ".robo.mp3"
	defer os.Remove(saida)
	filtro := "asetrate=24000*0.9,aresample=24000,atempo=1.11," + // mais grave sem ficar lenta
		"flanger=delay=1:depth=1.5:regen=20:speed=0.25," + // timbre metálico
		"aecho=0.7:0.5:12:0.25," + // leve "sala" eletrônica
		"bass=g=5,acompressor=threshold=-18dB:ratio=3,volume=1.3"
	cmd := exec.CommandContext(ctx, ff, "-y", "-loglevel", "error", "-i", arquivo, "-af", filtro, "-ar", "24000", "-b:a", "64k", saida)
	if cmd.Run() != nil {
		return
	}
	if dados, err := os.ReadFile(saida); err == nil && len(dados) > 0 {
		_ = os.WriteFile(arquivo, dados, 0o600)
	}
}
