package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

/* ─── cache de arquivos de texto (TTL 60s) ───────────────────────── */

type txtCache struct {
	mu        sync.RWMutex
	value     string
	loadedAt  time.Time
}

func (c *txtCache) load(candidates []string) string {
	c.mu.RLock()
	if time.Since(c.loadedAt) < 60*time.Second {
		v := c.value
		c.mu.RUnlock()
		return v
	}
	c.mu.RUnlock()

	var text string
	for _, p := range candidates {
		if raw, err := os.ReadFile(p); err == nil {
			if t := strings.TrimSpace(string(raw)); t != "" {
				text = t
				break
			}
		}
	}
	c.mu.Lock()
	c.value = text
	c.loadedAt = time.Now()
	c.mu.Unlock()
	return text
}

var (
	aisureRulesCache    txtCache
	confirmarPromptCache txtCache
)

func loadAisureRules() string {
	return aisureRulesCache.load([]string{
		filepath.Join("data", "regras_aisure.txt"),
		filepath.Join("backend", "data", "regras_aisure.txt"),
	})
}

func loadConfirmarPrompt() string {
	return confirmarPromptCache.load([]string{
		filepath.Join("data", "prompt_confirmar.txt"),
		filepath.Join("backend", "data", "prompt_confirmar.txt"),
	})
}

/* ─── tipos ─────────────────────────────────────────────────────── */

type aisureMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type aisureAttachment struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type aisureChatReq struct {
	Question    string             `json:"question"`
	History     []aisureMsg        `json:"history"`
	Attachments []aisureAttachment `json:"attachments"`
}

type aisureChatResp struct {
	Answer string `json:"answer"`
	Model  string `json:"model"`
}

/* ─── system prompt ─────────────────────────────────────────────── */

const aisureSystemPrompt = `Você é o AISURE, assistente especializado em análise de anomalias em faturas de energia elétrica.
Você tem acesso a dados reais de cinco fichas de irregularidade (F01–F05) do banco de faturas.
Responda sempre em português brasileiro, de forma objetiva e técnica.
Quando o usuário perguntar sobre uma UC específica, analise os dados daquela UC nas fichas disponíveis.
Quando identificar anomalias, explique o tipo de irregularidade e sugira se vale abrir um processo de ressarcimento.
Se não houver dados suficientes no contexto, informe claramente.
Não invente dados — use apenas o que está no contexto fornecido.`

/* ─── regex para extrair UC da pergunta ─────────────────────────── */

var reUC = regexp.MustCompile(`\b\d{6,12}\b`)

/* ─── meta das fichas ───────────────────────────────────────────── */

type fichaCtxInfo struct {
	key    string
	nome   string
	filtro string
}

var fichasCtxList = []fichaCtxInfo{
	{"F01", "Divergência de Fórmula", " AND flag_f01 = 1"},
	{"F02", "Desvio de Média",        " AND flag_f02 = 1"},
	{"F03", "Acúmulo de Consumo",     " AND flag_f03 = 1"},
	{"F04", "Troca de Medidor",       " AND flag_f04 = 1"},
	{"F05", "Quebra de Leitura",      " AND flag_f05 = 1"},
}

/* ─── build contexto ─────────────────────────────────────────────── */

func buildAisureContext(question string) string {
	db := database.GormDB_App
	if db == nil {
		return "Banco local indisponível no momento."
	}
	sqlDB, err := db.DB()
	if err != nil {
		return "Erro ao conectar ao banco local."
	}

	ucMentions := reUC.FindAllString(question, -1)
	ucSet := make(map[string]struct{}, len(ucMentions))
	for _, u := range ucMentions {
		ucSet[u] = struct{}{}
	}

	var sb strings.Builder
	sb.WriteString("=== CONTEXTO DAS FICHAS DE ANOMALIA ===\n\n")

	for _, f := range fichasCtxList {
		var total int64
		_ = sqlDB.QueryRow("SELECT COUNT(*) FROM fichas_anomalias_cache WHERE 1=1" + f.filtro).Scan(&total)
		fmt.Fprintf(&sb, "## %s – %s (%d registros)\n", f.key, f.nome, total)

		if total == 0 {
			sb.WriteString("(sem registros)\n\n")
			continue
		}

		base := "SELECT * FROM fichas_anomalias_cache WHERE 1=1" + f.filtro

		if len(ucSet) > 0 {
			for uc := range ucSet {
				rows, err := sqlDB.Query(base+" AND UC LIKE ? LIMIT 10", "%"+uc+"%")
				if err != nil {
					continue
				}
				rowMaps, colNames := aisureScanRows(rows)
				_ = rows.Close()
				if len(rowMaps) == 0 {
					continue
				}
				fmt.Fprintf(&sb, "Registros para UC %s:\n", uc)
				sb.WriteString(aisureFormatRows(colNames, rowMaps))
			}
		} else {
			rows, err := sqlDB.Query(base + " LIMIT 5")
			if err == nil {
				rowMaps, colNames := aisureScanRows(rows)
				_ = rows.Close()
				if len(rowMaps) > 0 {
					sb.WriteString("Amostra (5 registros):\n")
					sb.WriteString(aisureFormatRows(colNames, rowMaps))
				}
			}
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

func aisureScanRows(rows *sql.Rows) ([]map[string]string, []string) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, nil
	}
	var result []map[string]string
	for rows.Next() {
		vals := make([]interface{}, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if rows.Scan(ptrs...) != nil {
			continue
		}
		row := make(map[string]string, len(cols))
		for i, col := range cols {
			v := vals[i]
			if v == nil {
				row[col] = "-"
			} else if b, ok := v.([]byte); ok {
				row[col] = string(b)
			} else {
				row[col] = fmt.Sprintf("%v", v)
			}
		}
		result = append(result, row)
	}
	return result, cols
}

func aisureFormatRows(cols []string, rows []map[string]string) string {
	if len(rows) == 0 || len(cols) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(strings.Join(cols, " | "))
	sb.WriteString("\n")
	for _, row := range rows {
		vals := make([]string, len(cols))
		for i, col := range cols {
			v := row[col]
			if len(v) > 30 {
				v = v[:30] + "…"
			}
			vals[i] = v
		}
		sb.WriteString(strings.Join(vals, " | "))
		sb.WriteString("\n")
	}
	return sb.String()
}

/* ─── chamada OpenAI ────────────────────────────────────────────── */

func aisureOpenAIModel() string {
	if v := strings.TrimSpace(os.Getenv("OPENAI_MODEL")); v != "" {
		return v
	}
	return "gpt-4o-mini"
}

func callAisureOpenAI(ctx context.Context, history []aisureMsg, question, ctxStr string, systemPromptOverride ...string) (string, error) {
	model := aisureOpenAIModel()

	type oaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}

	sysPrompt := aisureSystemPrompt
	if len(systemPromptOverride) > 0 && strings.TrimSpace(systemPromptOverride[0]) != "" {
		sysPrompt = systemPromptOverride[0]
	}

	msgs := make([]oaiMsg, 0, len(history)+3)
	msgs = append(msgs, oaiMsg{Role: "system", Content: sysPrompt})
	msgs = append(msgs, oaiMsg{Role: "system", Content: ctxStr})

	for _, h := range history {
		role := strings.ToLower(strings.TrimSpace(h.Role))
		if role != "user" && role != "assistant" {
			continue
		}
		msgs = append(msgs, oaiMsg{Role: role, Content: h.Content})
	}
	msgs = append(msgs, oaiMsg{Role: "user", Content: question})

	payload, err := json.Marshal(map[string]interface{}{
		"model":       model,
		"messages":    msgs,
		"temperature": 0.3,
		"max_tokens":  1024,
	})
	if err != nil {
		return "", err
	}

	res, retryErr := doOpenAIWithRetry(ctx, payload)
	if retryErr != nil {
		return "", fmt.Errorf("openai: %w", retryErr)
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

/* ─── Handler de confirmação por linha ──────────────────────────── */

type aisureConfirmarReq struct {
	UC           string            `json:"uc"`
	Fichas       string            `json:"fichas"`
	Detalhamento string            `json:"detalhamento"`
	RowData      map[string]string `json:"row_data"`
	FaturaText   string            `json:"fatura_text"` // texto extraído da fatura anexada
}

type aisureConfirmarResp struct {
	Confirmado bool   `json:"confirmado"`
	Analise    string `json:"analise"`
	Model      string `json:"model"`
}

// AisureConfirmarHandler godoc
// POST /api/v1/faturas/aisure/confirmar
func AisureConfirmarHandler(c *gin.Context) {
	var in aisureConfirmarReq
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.UC) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	// Busca histórico completo da UC — inclui leituras para verificação de F05
	var ucCtx strings.Builder
	if db := database.GormDB_Faturas; db != nil {
		if sqlDB, err := db.DB(); err == nil {
			rows, err := sqlDB.QueryContext(ctx,
				`SELECT Mes_Ref, NroMedidor,
				        KWH_Ponta, KWH_FPonta, KWH_Reservado, KWH_Total,
				        Leitura_Anterior_KWH_P,  Leitura_Atual_KWH_P,
				        Leitura_Anterior_KWH_FP, Leitura_Atual_KWH_FP,
				        Leitura_Anterior_KWH_R,  Leitura_Atual_KWH_R,
				        Constante_KWH_P, Constante_KWH_FP, Constante_KWH_R,
				        RS_Total_Fatura
				 FROM Faturas_Registradas_Cache
				 WHERE UC = ? ORDER BY Mes_Ref DESC LIMIT 24`, in.UC)
			if err == nil {
				defer rows.Close()
				ucCtx.WriteString("=== HISTÓRICO DE FATURAS DA UC " + in.UC + " (últimos 24 meses) ===\n")
				ucCtx.WriteString("Mes_Ref | Medidor | KWH_P | KWH_FP | KWH_R | KWH_Total | LeitAnt_P | LeitAtu_P | LeitAnt_FP | LeitAtu_FP | LeitAnt_R | LeitAtu_R | Const_P | Const_FP | Const_R | RS_Total\n")
				for rows.Next() {
					var mes, med, kp, kfp, kr, kt, lap, lcp, lafp, lcfp, lar, lcr, cp, cfp, cr, rs string
					if rows.Scan(&mes, &med, &kp, &kfp, &kr, &kt, &lap, &lcp, &lafp, &lcfp, &lar, &lcr, &cp, &cfp, &cr, &rs) == nil {
						fmt.Fprintf(&ucCtx, "%s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s\n",
							mes, med, kp, kfp, kr, kt, lap, lcp, lafp, lcfp, lar, lcr, cp, cfp, cr, rs)
					}
				}
			}
		}
	}

	// Monta contexto com dados da linha
	var rowCtx strings.Builder
	rowCtx.WriteString("=== DADOS DO SISTEMA PARA ESTA FATURA ===\n")
	rowCtx.WriteString(fmt.Sprintf("Fichas detectadas automaticamente: %s\n", in.Fichas))
	rowCtx.WriteString(fmt.Sprintf("Detalhamento automático: %s\n", in.Detalhamento))
	for k, v := range in.RowData {
		fmt.Fprintf(&rowCtx, "%s: %s\n", k, v)
	}

	ctxStr := rowCtx.String() + "\n" + ucCtx.String()

	// Se fatura foi anexada, inclui o texto extraído
	var question string
	if strings.TrimSpace(in.FaturaText) != "" {
		question = fmt.Sprintf(
			"Analise a fatura da UC %s abaixo e aplique as fichas F01 a F05 conforme as regras.\n\n"+
				"=== CONTEÚDO DA FATURA (extraído do documento) ===\n%s",
			in.UC, in.FaturaText,
		)
	} else {
		question = fmt.Sprintf(
			"Analise os dados da fatura da UC %s disponíveis no sistema e aplique as fichas F01 a F05.\n"+
				"Use o histórico de leituras e consumo para verificar cada ficha sinalizada.",
			in.UC,
		)
	}

	confirmarPrompt := loadConfirmarPrompt()
	answer, err := callAisureOpenAI(ctx, nil, question, ctxStr, confirmarPrompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao chamar IA: " + err.Error()})
		return
	}

	upper := strings.ToUpper(answer)
	confirmado := strings.Contains(upper, "CONFIRMADO") && !strings.Contains(upper, "NÃO CONFIRMADO") && !strings.Contains(upper, "NAO CONFIRMADO")

	c.JSON(http.StatusOK, aisureConfirmarResp{
		Confirmado: confirmado,
		Analise:    answer,
		Model:      aisureOpenAIModel(),
	})
}

/* ─── Handler HTTP ───────────────────────────────────────────────── */

// AisureChatHandler godoc
// POST /api/v1/faturas/aisure/chat
func AisureChatHandler(c *gin.Context) {
	var in aisureChatReq
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido"})
		return
	}
	in.Question = strings.TrimSpace(in.Question)
	if in.Question == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question obrigatório"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	fichasCtxStr := buildAisureContext(in.Question)

	// Injeta regras do arquivo regras_aisure.txt (invisível ao usuário)
	if rules := loadAisureRules(); rules != "" {
		fichasCtxStr = "=== REGRAS DE NEGÓCIO (aplicar sempre) ===\n\n" + rules + "\n\n" + fichasCtxStr
	}

	// Injeta texto dos anexos no contexto
	if len(in.Attachments) > 0 {
		var attachSb strings.Builder
		attachSb.WriteString("\n\n=== REGRAS / DOCUMENTOS ANEXADOS ===\n\n")
		for _, a := range in.Attachments {
			name := strings.TrimSpace(a.Name)
			text := strings.TrimSpace(a.Text)
			if text == "" {
				continue
			}
			if len(text) > 8000 {
				text = text[:8000] + "\n...[truncado]..."
			}
			attachSb.WriteString(fmt.Sprintf("--- %s ---\n%s\n\n", name, text))
		}
		fichasCtxStr += attachSb.String()
	}

	answer, err := callAisureOpenAI(ctx, in.History, in.Question, fichasCtxStr)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "falha ao chamar IA: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, aisureChatResp{
		Answer: answer,
		Model:  aisureOpenAIModel(),
	})
}
