package handlers

// Análise completa de fatura usando o prompt v19 (auditor F01-F05 com JSON
// estruturado). Diferente do /auditar (prompt curto de veredito), este envia
// o prompt canônico completo (~60k tokens) e devolve o output detalhado.
//
//   POST /api/v1/faturas/:id/analisar-v19  → openai gpt-4.1-mini (env OPENAI_MODEL)

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

const promptV19Path = "data/prompt_confirmar_v19.txt"

var (
	promptV19Cache     string
	promptV19CacheMu   sync.RWMutex
	promptV19CacheStat time.Time
)

// carregaPromptV19 lê o arquivo de disco 1x + recarrega quando mtime mudou.
// Evita ler ~235KB do disco em toda request.
func carregaPromptV19() (string, error) {
	// resolve path relativo ao binário
	path := promptV19Path
	if _, err := os.Stat(path); err != nil {
		// tenta subir uma pasta (execução via `go run` a partir de subdir)
		alt := filepath.Join("..", promptV19Path)
		if _, e2 := os.Stat(alt); e2 == nil {
			path = alt
		} else {
			return "", fmt.Errorf("prompt v19 não encontrado em %s nem %s", promptV19Path, alt)
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	promptV19CacheMu.RLock()
	if promptV19Cache != "" && info.ModTime().Equal(promptV19CacheStat) {
		s := promptV19Cache
		promptV19CacheMu.RUnlock()
		return s, nil
	}
	promptV19CacheMu.RUnlock()

	promptV19CacheMu.Lock()
	defer promptV19CacheMu.Unlock()
	// double-checked
	if promptV19Cache != "" && info.ModTime().Equal(promptV19CacheStat) {
		return promptV19Cache, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	promptV19Cache = string(b)
	promptV19CacheStat = info.ModTime()
	return promptV19Cache, nil
}

// modeloAnaliseV19 escolhe o modelo pelo env (mesma variável dos outros handlers).
func modeloAnaliseV19() string {
	m := strings.TrimSpace(os.Getenv("OPENAI_MODEL"))
	if m == "" {
		m = "gpt-4.1-mini"
	}
	return m
}

// AnalisarFaturaComPromptV19 — POST /api/v1/faturas/:id/analisar-v19
//
// Executa a auditoria completa da fatura usando o prompt canônico v19. O
// resultado é gravado em FATURA_REANALISES (mesma tabela do /auditar), com
// modelo="prompt_v19:<modelo_openai>" pra facilitar o filtro.
func AnalisarFaturaComPromptV19(c *gin.Context) {
	id := c.Param("id")
	fat, err := carregarFaturaCompactaT(id, c.Query("fonte"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "fatura não encontrada"})
		return
	}

	// Enriquece o payload com a SÉRIE COMPLETA da UC (todos os meses no banco, não só
	// os 12 embutidos na fatura) + separa meses ANTERIORES e POSTERIORES ao mês de
	// referência. A regra "Validação F02 com meses posteriores" exige meses_posteriores_json.
	if codigoUC, _ := fat["codigo_uc"].(string); strings.TrimSpace(codigoUC) != "" {
		serie := carregarSerieHistorico(codigoUC)
		if len(serie) > 0 {
			fat["historico_serie_completa"] = serie
			refKey := mesRefParaYYYYMM(fmt.Sprintf("%v", fat["mes_referencia"]))
			if refKey != "" {
				anteriores := []map[string]any{}
				posteriores := []map[string]any{}
				for _, m := range serie {
					mk := mesRefParaYYYYMM(fmt.Sprintf("%v", m["mes"]))
					if mk == "" {
						continue
					}
					if mk > refKey {
						posteriores = append(posteriores, m)
					} else if mk < refKey {
						anteriores = append(anteriores, m)
					}
				}
				fat["meses_anteriores_json"] = anteriores
				fat["meses_posteriores_json"] = posteriores
			}
		}
	}

	system, err := carregaPromptV19()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "prompt v19 indisponível: " + err.Error()})
		return
	}

	// User content = payload da fatura + (opcional) contexto do apontamento
	var body struct {
		Apontamento string `json:"apontamento"`
	}
	_ = c.ShouldBindJSON(&body)

	payload, _ := json.Marshal(fat)
	userContent := "=== DADOS EXTRAÍDOS DA FATURA (JSON) ===\n" + string(payload)
	if strings.TrimSpace(body.Apontamento) != "" {
		userContent += "\n\n=== APONTAMENTO LEVANTADO PELO MOTOR SQL ===\n" + body.Apontamento
	}

	// Identifica e injeta o MAPA DE EXTRAÇÃO do layout desta distribuidora
	// (mesmo arquivo do pdf_pipeline, ia/map/). Assim a IA interpreta os campos
	// usando o vocabulário/particularidades daquele modelo de fatura.
	var mapaInfo mapaLayoutInfo
	if dist, _ := fat["distribuidora"].(string); strings.TrimSpace(dist) != "" {
		conteudo, mi := resolverMapaLayout(dist)
		mapaInfo = mi // sempre reporta (mesmo sem match) pra UI mostrar a distribuidora
		if conteudo != "" {
			const maxMapa = 40000 // ~10k tokens; evita estourar o contexto
			if len(conteudo) > maxMapa {
				conteudo = conteudo[:maxMapa] + "\n…(mapa truncado)"
			}
			userContent += "\n\n=== MAPEAMENTO DO LAYOUT DESTA DISTRIBUIDORA" +
				" (arquivo: " + mi.Mapa
			if mi.Filial != "" {
				userContent += ", filial: " + mi.Filial
			}
			userContent += ") ===\n" +
				"Use o vocabulário, os nomes de campos e as particularidades deste modelo de " +
				"fatura pra localizar e interpretar corretamente os valores. Este é o gabarito " +
				"de extração da distribuidora.\n" + conteudo
		}
	}

	modelo := modeloAnaliseV19()
	// Timeout maior porque o prompt é grande (~60k tokens de system)
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()

	resposta, err := chamarOpenAIChat(ctx, modelo, system,
		[]map[string]string{{"role": "user", "content": userContent}})
	if err != nil {
		// Timeout ou erro da OpenAI
		if errors.Is(err, context.DeadlineExceeded) {
			c.JSON(http.StatusGatewayTimeout, gin.H{"error": "openai timeout: análise levou mais de 5 min"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	// Grava em FATURA_REANALISES pra ficar auditável junto com o /auditar
	uid, uname := usuarioIA(c)
	if database.GormDB_App != nil {
		if sqlDB, e := database.GormDB_App.DB(); e == nil {
			// Extrai a "decisão" da resposta (o prompt v19 termina com JSON)
			decisao := extrairDecisaoV19(resposta)
			_, _ = sqlDB.Exec(`INSERT INTO FATURA_REANALISES
				(fatura_id, modelo, justificativa, recomendacao, resposta_crua, confianca_final, pdf_anexado, usuario_id, usuario_nome, criado_em)
				VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?, NOW())`,
				id, "prompt_v19:"+modelo, truncarIA(resposta, 8000), resposta, extrairConfiancaV19(resposta), uid, uname)
			_ = decisao
		}
	}

	// Veredito: só é confiável se a decisão foi realmente interpretada. Quando
	// não (parse falho/resposta estranha), devolvemos null pra UI mostrar
	// "não foi possível interpretar" em vez de um falso "⛔ não apontado".
	vered := extrairVeredictoV19(resposta)
	dados := extrairDadosEstruturadosV19(resposta)
	interpretado := decisaoValidaV19(vered.Decisao)
	var veredResp *veredictoV19
	if interpretado {
		veredResp = &vered
	}

	c.JSON(http.StatusOK, gin.H{
		"resposta":     resposta,
		"modelo":       "prompt_v19:" + modelo,
		"veredito":     veredResp, // null quando não interpretado
		"dados":        dados,
		"mapa_layout":  mapaInfo,
		"interpretado": interpretado,
		"parse_ok":     dados != nil,
	})
}

// objetosBalanceadosJSON varre a string e devolve todos os trechos {...}
// balanceados de nível superior, IGNORANDO chaves dentro de strings JSON
// (respeita aspas e escapes). Resolve o bug de "{" dentro de "observacao".
func objetosBalanceadosJSON(s string) []string {
	out := []string{}
	depth, start := 0, -1
	inStr, esc := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			if depth > 0 {
				depth--
				if depth == 0 && start >= 0 {
					out = append(out, s[start:i+1])
					start = -1
				}
			}
		}
	}
	return out
}

// extrairDadosEstruturadosV19 recupera o bloco JSON estruturado da resposta do
// prompt v19 (que termina com um JSON). Robusto a: chaves dentro de strings,
// múltiplos blocos (ex.: exemplo + real), cercas ```json/```JSON, truncamento.
// Estratégia: prefere a cerca ```json; senão pega o ÚLTIMO objeto balanceado
// que dê Unmarshal e seja substancial. Devolve nil se nada parsear.
func extrairDadosEstruturadosV19(resposta string) map[string]any {
	tryParse := func(raw string) map[string]any {
		var m map[string]any
		if json.Unmarshal([]byte(strings.TrimSpace(raw)), &m) == nil && len(m) > 3 {
			return m
		}
		return nil
	}

	// 1) cerca ```json (case-insensitive, tolera espaço). Pega a última cerca.
	low := strings.ToLower(resposta)
	if i := strings.LastIndex(low, "```json"); i >= 0 {
		rest := resposta[i+len("```json"):]
		if j := strings.Index(rest, "```"); j >= 0 {
			if m := tryParse(rest[:j]); m != nil {
				return m
			}
		}
	}

	// 2) objetos balanceados (string-aware) — o real costuma ser o último.
	objs := objetosBalanceadosJSON(resposta)
	for k := len(objs) - 1; k >= 0; k-- {
		if m := tryParse(objs[k]); m != nil {
			return m
		}
	}
	return nil
}

// veredictoV19 é o resumo estruturado extraído da resposta do prompt v19:
// se o caso é apontado (CONFIRMADO) e o ressarcimento estimado em R$.
type veredictoV19 struct {
	Apontado             bool    `json:"apontado"`
	Decisao              string  `json:"decisao"`
	RessarcimentoEstimado float64 `json:"ressarcimento_estimado"`
	PercentualRess       float64 `json:"percentual_ressarcimento"`
	Confianca            int     `json:"confianca"`
}

var (
	reV19Decisao = regexp.MustCompile(`(?i)decis[a\x{00e3}]o[_ ]?final["'\s:]*["']?\s*(CONFIRMADO|REFUTADO|INCONCLUSIVO)`)
	reV19Valor   = regexp.MustCompile(`(?i)valor\s+estimado\s+simples["'\s:]*R?\$?\s*([\d.]+,\d{2}|\d[\d.]*)`)
	reV19Total   = regexp.MustCompile(`(?i)total_estimado_rs["'\s:]*R?\$?\s*([\d.]+,\d{2}|\d[\d.]*)`)
	reV19Pct     = regexp.MustCompile(`(?i)percentual_ressarcimento["'\s:]*([\d.]+,?\d*)\s*%?`)
)

// parseBRNumberV19 converte "22.320,59" (BR) ou "22320.59" (US) em float.
func parseBRNumberV19(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if strings.Contains(s, ",") { // formato BR: '.' é milhar, ',' é decimal
		s = strings.ReplaceAll(s, ".", "")
		s = strings.ReplaceAll(s, ",", ".")
	}
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func extrairVeredictoV19(resposta string) veredictoV19 {
	v := veredictoV19{}
	if m := reV19Decisao.FindStringSubmatch(resposta); m != nil {
		v.Decisao = strings.ToUpper(m[1])
	} else {
		v.Decisao = strings.ToUpper(extrairDecisaoV19(resposta))
	}
	v.Apontado = v.Decisao == "CONFIRMADO"
	if m := reV19Valor.FindStringSubmatch(resposta); m != nil {
		v.RessarcimentoEstimado = parseBRNumberV19(m[1])
	} else if m := reV19Total.FindStringSubmatch(resposta); m != nil {
		v.RessarcimentoEstimado = parseBRNumberV19(m[1])
	}
	if m := reV19Pct.FindStringSubmatch(resposta); m != nil {
		v.PercentualRess = parseBRNumberV19(m[1])
	}
	v.Confianca = extrairConfiancaV19(resposta)
	// Coerência com o prompt: REFUTADO/INCONCLUSIVO → ressarcimento = 0.
	if v.Decisao != "CONFIRMADO" {
		v.RessarcimentoEstimado = 0
	}
	return v
}

// reV19DecisaoJSON tolera `"decisao"`/`"decisao_final"` com ou sem espaço,
// quebra de linha e maiúsculas/minúsculas no valor.
var reV19DecisaoJSON = regexp.MustCompile(`(?i)"decisao(?:_final)?"\s*:\s*"\s*(CONFIRMADO|REFUTADO|INCONCLUSIVO)`)

// extrairDecisaoV19 procura o campo "decisao"/"decisao_final" no JSON da resposta.
func extrairDecisaoV19(resposta string) string {
	if m := reV19DecisaoJSON.FindStringSubmatch(resposta); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

// decisaoValidaV19 diz se a decisão é uma das 3 esperadas (i.e., a resposta foi
// realmente interpretada). Usado pra distinguir "sem erro" de "não interpretado".
func decisaoValidaV19(d string) bool {
	switch strings.ToUpper(strings.TrimSpace(d)) {
	case "CONFIRMADO", "REFUTADO", "INCONCLUSIVO":
		return true
	}
	return false
}

// extrairConfiancaV19 devolve 30/60/90 baseado no texto (compat com /auditar).
func extrairConfiancaV19(resposta string) int {
	low := strings.ToLower(resposta)
	if strings.Contains(low, "confianca_alta") || strings.Contains(low, "\"confianca\": \"alta\"") {
		return 90
	}
	if strings.Contains(low, "confianca_media") || strings.Contains(low, "\"confianca\": \"media\"") {
		return 60
	}
	if strings.Contains(low, "confianca_baixa") || strings.Contains(low, "\"confianca\": \"baixa\"") {
		return 30
	}
	return 0
}
