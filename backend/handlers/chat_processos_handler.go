package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ─── Chat Global de Processos ─────────────────────────────────────────────────
// POST /api/v1/chat/processos
// Responde perguntas sobre os processos do sistema usando dados reais do banco.
// Estratégia: detecta a intenção da pergunta e monta um contexto direcionado
// (KPIs, funil, listas relevantes, detalhes por entity reference). A IA gera
// a resposta em PT-BR a partir desse contexto.
// ─────────────────────────────────────────────────────────────────────────────

type processoChatRequest struct {
	Question string      `json:"question"`
	History  []aisureMsg `json:"history"`
}

type processoChatResponse struct {
	Answer  string         `json:"answer"`
	Context map[string]any `json:"context,omitempty"`
}

var reProcessoID = regexp.MustCompile(`(?i)(?:proc(?:esso)?[-\s#]?0*|#\s*0*)(\d+)`)
var reUCNum = regexp.MustCompile(`\bUC\s*(\d{5,12})\b`)

// META_MENSAL_RESSARCIMENTO em R$ — espelha a meta hardcoded no dashboard
const metaMensalRessarcimento = 417000.0

const processoChatSystemPrompt = `Você é o assistente SURE (Sistema Unificado de Ressarcimento de Energia).
Seu papel: responder perguntas sobre processos, requisições, prazos, métricas e indicadores
do sistema usando EXCLUSIVAMENTE os dados fornecidos no CONTEXTO abaixo.

Regras:
- Seja direto, objetivo e use Markdown quando útil (listas, **negrito**, tabelas).
- Não invente processos, valores ou datas que não estejam no contexto.
- Se a informação solicitada não está no contexto, diga "Não tenho esse dado disponível" e sugira reformular.
- Datas no formato DD/MM/AAAA. Valores em Reais com vírgula decimal (ex: R$ 1.234,56).
- Quando responder sobre vários processos, agrupe por etapa, concessionária ou cliente quando fizer sentido.
- Quando relevante, ofereça um próximo passo prático (ex: "consulte a aba Métricas para gráficos").

Vocabulário do sistema:
- Etapas: Distribuidora → Ouvidoria → ANEEL → SMA (caminho normal).
- Colunas Kanban: Ativos (1), Deferidos (2), Fluxo de Ressarcimento (3), Faturamento (4), Concluídos (5), Indeferidos legacy (6), Suspensos legacy (99).
- id_etapa_processo = 11 → Indeferido (moderno).
- "Travados" = sem movimentação há +30 dias, excluindo Concluídos/Indeferidos/Suspensos.
- Backlog = +60 dias sem movimentação, sub_etapa <> "Aguardando retorno".
- Meta mensal de ressarcimento: R$ 417.000.

CONTEXTO ATUAL:`

// ChatProcessosHandler responde perguntas sobre processos usando dados do DB + IA.
func ChatProcessosHandler(c *gin.Context) {
	var req processoChatRequest
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Question) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question obrigatória"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	dbCtx, ctxData := buildProcessosContext(req.Question)
	sysPrompt := processoChatSystemPrompt + "\n\n" + dbCtx

	answer, err := callAisureOpenAI(ctx, req.History, req.Question, "", sysPrompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "IA indisponível: " + err.Error()})
		return
	}

	if v, ok := c.Get("userID"); ok {
		if uid, ok2 := v.(int64); ok2 && uid > 0 {
			_, _ = execGorm(database.GormDB_App,
				`INSERT INTO AI_CHAT_LOG (user_id, question, answer, sources, model) VALUES (?,?,?,?,?)`,
				uid, req.Question, answer, "[]", aisureOpenAIModel(),
			)
		}
	}

	c.JSON(http.StatusOK, processoChatResponse{Answer: answer, Context: ctxData})
}

// ── Detector de intenção ─────────────────────────────────────────────────────

type intent struct {
	Stuck            bool   // travados, parados, sem movimentação
	Recent           bool   // recentes, novos, criados
	Deadlines        bool   // vencidos, atrasados, prazos
	Financials       bool   // ressarcimento, valor, caixa, meta
	Stages           bool   // etapas, fluxo
	Backlog          bool   // backlog
	Suspensos        bool   // suspensos
	Concluidos       bool   // concluídos
	Concessionaria   string // nome detectado
	Cliente          string // nome detectado
}

func detectIntent(question string) intent {
	q := strings.ToLower(question)
	it := intent{}
	if strings.Contains(q, "trava") || strings.Contains(q, "parad") || strings.Contains(q, "sem mov") {
		it.Stuck = true
	}
	if strings.Contains(q, "recent") || strings.Contains(q, "nov") || strings.Contains(q, "criad") || strings.Contains(q, "última") {
		it.Recent = true
	}
	if strings.Contains(q, "vencid") || strings.Contains(q, "atras") || strings.Contains(q, "prazo") || strings.Contains(q, "sla") {
		it.Deadlines = true
	}
	if strings.Contains(q, "ressarc") || strings.Contains(q, "valor") || strings.Contains(q, "caixa") || strings.Contains(q, "meta") || strings.Contains(q, "deferimento") || strings.Contains(q, "crédito") || strings.Contains(q, "faturad") {
		it.Financials = true
	}
	if strings.Contains(q, "etapa") || strings.Contains(q, "kanban") || strings.Contains(q, "fluxo") || strings.Contains(q, "funil") {
		it.Stages = true
	}
	if strings.Contains(q, "backlog") {
		it.Backlog = true
	}
	if strings.Contains(q, "suspens") {
		it.Suspensos = true
	}
	if strings.Contains(q, "conclu") || strings.Contains(q, "finaliz") || strings.Contains(q, "encerrad") {
		it.Concluidos = true
	}

	// Detecta concessionária mencionada
	concList := []string{"cemig", "enel", "cpfl", "edp", "neoenergia", "light", "celpe", "coelba", "elektro", "copel", "celesc", "energisa", "equatorial", "amazonas", "rge", "eletropaulo"}
	for _, name := range concList {
		if strings.Contains(q, name) {
			it.Concessionaria = name
			break
		}
	}

	// Detecta cliente — patterns como "cliente X", "do X", após preposições
	if m := regexp.MustCompile(`(?i)cliente\s+([a-záéíóúâêôãõçñ\s]{3,40})`).FindStringSubmatch(question); len(m) >= 2 {
		it.Cliente = strings.TrimSpace(m[1])
	}

	return it
}

// ── Builder de contexto ──────────────────────────────────────────────────────

// buildProcessosContext constrói o contexto enviado à IA.
// Sempre inclui um Resumo Executivo no topo + funil + KPIs operacionais.
// Adiciona blocos específicos baseado na intenção detectada na pergunta.
func buildProcessosContext(question string) (string, map[string]any) {
	db := database.DB_App
	ctxData := map[string]any{}
	var parts []string

	it := detectIntent(question)

	// ── Resumo Executivo (sempre) ──
	if s := buildExecutiveSummary(ctxData); s != "" {
		parts = append(parts, s)
	}

	// ── Funil de conversão (sempre) ──
	if s := buildFunnel(ctxData); s != "" {
		parts = append(parts, s)
	}

	// ── Estatísticas rápidas (sempre, compacto) ──
	if s := buildQuickStats(ctxData); s != "" {
		parts = append(parts, s)
	}

	// ── Por intenção ──
	if it.Stages {
		if s := buildStagesBreakdown(ctxData); s != "" {
			parts = append(parts, s)
		}
		if s := buildTempoPorEtapa(ctxData); s != "" {
			parts = append(parts, s)
		}
	}

	if it.Stuck || it.Backlog {
		if s := buildStuck(ctxData, 20); s != "" {
			parts = append(parts, s)
		}
	}

	if it.Recent {
		if s := buildRecent(ctxData, 15); s != "" {
			parts = append(parts, s)
		}
	}

	if it.Deadlines {
		if s := buildDeadlines(ctxData, 20); s != "" {
			parts = append(parts, s)
		}
	}

	if it.Financials {
		if s := buildTopConcessionarias(ctxData, 8); s != "" {
			parts = append(parts, s)
		}
		if s := buildTopClientes(ctxData, 8); s != "" {
			parts = append(parts, s)
		}
	}

	// ── Entity references na pergunta ──
	if m := reProcessoID.FindStringSubmatch(question); len(m) >= 2 {
		if pid, _ := strconv.Atoi(m[1]); pid > 0 {
			if d := fetchProcessoDetail(pid); d != "" {
				parts = append(parts, d)
			}
		}
	}
	if m := reUCNum.FindStringSubmatch(strings.ToUpper(question)); len(m) >= 2 {
		if d := fetchProcessosByUC(m[1]); d != "" {
			parts = append(parts, d)
		}
	}
	if it.Concessionaria != "" {
		if d := fetchProcessosByConcessionaria(it.Concessionaria); d != "" {
			parts = append(parts, d)
		}
	}
	if it.Cliente != "" {
		if d := fetchProcessosByCliente(it.Cliente); d != "" {
			parts = append(parts, d)
		}
	}

	_ = db // fallback
	return strings.Join(parts, "\n\n"), ctxData
}

// ── Helpers de contexto ──────────────────────────────────────────────────────

// buildExecutiveSummary: KPIs principais do dashboard (carteira, ativos, vencidos, meta).
func buildExecutiveSummary(ctxData map[string]any) string {
	db := database.DB_App
	var sb strings.Builder
	sb.WriteString("## Resumo Executivo\n")

	// Total de processos por categoria (Kanban)
	var ativos, deferidos, fluxo, faturamento, concluidos, indeferidos, suspensos int
	_ = db.QueryRow(`
		SELECT
		  SUM(CASE WHEN p.id_etapa_processo<>11 AND COALESCE(p.suspenso,0)=0 AND p.id_coluna=1 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN p.id_etapa_processo<>11 AND COALESCE(p.suspenso,0)=0 AND p.id_coluna=2 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN p.id_etapa_processo<>11 AND COALESCE(p.suspenso,0)=0 AND p.id_coluna=3 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN p.id_etapa_processo<>11 AND COALESCE(p.suspenso,0)=0 AND p.id_coluna=4 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN p.id_etapa_processo<>11 AND COALESCE(p.suspenso,0)=0 AND p.id_coluna=5 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN p.id_etapa_processo=11 OR p.id_coluna=6 THEN 1 ELSE 0 END),
		  SUM(CASE WHEN COALESCE(p.suspenso,0)=1 OR p.id_coluna=99 THEN 1 ELSE 0 END)
		FROM FT_PROCESSOS p`,
	).Scan(&ativos, &deferidos, &fluxo, &faturamento, &concluidos, &indeferidos, &suspensos)

	totalCarteira := ativos + deferidos + fluxo + faturamento
	ctxData["counts"] = map[string]int{
		"ativos": ativos, "deferidos": deferidos, "fluxo": fluxo, "faturamento": faturamento,
		"concluidos": concluidos, "indeferidos": indeferidos, "suspensos": suspensos,
		"total_carteira": totalCarteira,
	}

	// Valor em carteira (estimado dos ativos + deferidos)
	var valorCarteira float64
	_ = db.QueryRow(`
		SELECT COALESCE(SUM(r.ressarcimento_estimado), 0)
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		WHERE p.id_etapa_processo <> 11
		  AND COALESCE(p.suspenso, 0) = 0
		  AND p.id_coluna IN (1,2,3,4)`,
	).Scan(&valorCarteira)

	// Receita do mês (envio_financeiro / fluxo_ressarcimento aprovado este mês)
	var receitaMes float64
	_ = db.QueryRow(`
		SELECT COALESCE(SUM(p.valor_fluxo), 0)
		FROM FT_PROCESSOS p
		WHERE YEAR(p.data_envio_financeiro) = YEAR(CURDATE())
		  AND MONTH(p.data_envio_financeiro) = MONTH(CURDATE())`,
	).Scan(&receitaMes)

	pctMeta := 0.0
	if metaMensalRessarcimento > 0 {
		pctMeta = (receitaMes / metaMensalRessarcimento) * 100
	}

	// Travados +30d (excluindo concluídos/indeferidos/suspensos)
	var travados30 int
	_ = db.QueryRow(`
		SELECT COUNT(*)
		FROM (
		  SELECT MAX(h.data_movimentacao) AS ult
		  FROM FT_HISTORICO_MOVIMENTACOES h
		  GROUP BY h.id_requisicao
		) t
		JOIN FT_PROCESSOS p ON p.id_processo = (
		  SELECT h2.id_requisicao FROM FT_HISTORICO_MOVIMENTACOES h2
		  WHERE h2.data_movimentacao = t.ult LIMIT 1
		)
		WHERE COALESCE(p.suspenso, 0) = 0
		  AND COALESCE(p.id_etapa_processo, 0) <> 11
		  AND COALESCE(p.id_coluna, 1) NOT IN (5,6,99)
		  AND DATEDIFF(CURDATE(), DATE(t.ult)) >= 31`,
	).Scan(&travados30)

	sb.WriteString(fmt.Sprintf("- **Carteira ativa:** %d processos somando R$ %s\n",
		totalCarteira, chatFmtBRL(valorCarteira)))
	sb.WriteString(fmt.Sprintf("- **Composição:** Ativos %d · Deferidos %d · Fluxo %d · Faturamento %d\n",
		ativos, deferidos, fluxo, faturamento))
	sb.WriteString(fmt.Sprintf("- **Receita do mês corrente:** R$ %s (%.1f%% da meta de R$ %s)\n",
		chatFmtBRL(receitaMes), pctMeta, chatFmtBRL(metaMensalRessarcimento)))
	sb.WriteString(fmt.Sprintf("- **Concluídos:** %d · **Indeferidos:** %d · **Suspensos:** %d\n",
		concluidos, indeferidos, suspensos))
	sb.WriteString(fmt.Sprintf("- **Processos travados +30 dias:** %d (sem movimentação, excluindo finalizados)\n",
		travados30))

	ctxData["valor_carteira"] = valorCarteira
	ctxData["receita_mes"] = receitaMes
	ctxData["meta_mensal"] = metaMensalRessarcimento
	ctxData["meta_pct"] = pctMeta
	ctxData["travados_30d"] = travados30

	return sb.String()
}

// buildFunnel: jornada Ativos → Deferidos → Fluxo → Faturamento → Caixa
func buildFunnel(ctxData map[string]any) string {
	counts, ok := ctxData["counts"].(map[string]int)
	if !ok {
		return ""
	}
	ativos := counts["ativos"]
	deferidos := counts["deferidos"]
	fluxo := counts["fluxo"]
	faturamento := counts["faturamento"]
	caixa := counts["concluidos"]

	pct := func(n, base int) string {
		if base <= 0 {
			return "—"
		}
		return fmt.Sprintf("%.1f%%", float64(n)/float64(base)*100)
	}

	var sb strings.Builder
	sb.WriteString("## Funil de Conversão\n")
	sb.WriteString(fmt.Sprintf("- **Ativos** %d → **Deferidos** %d (%s convertem)\n", ativos, deferidos, pct(deferidos, ativos)))
	sb.WriteString(fmt.Sprintf("- **Deferidos** %d → **Fluxo** %d (%s)\n", deferidos, fluxo, pct(fluxo, deferidos)))
	sb.WriteString(fmt.Sprintf("- **Fluxo** %d → **Faturamento** %d (%s)\n", fluxo, faturamento, pct(faturamento, fluxo)))
	sb.WriteString(fmt.Sprintf("- **Faturamento** %d → **Caixa** %d (%s)\n", faturamento, caixa, pct(caixa, faturamento)))
	return sb.String()
}

// buildQuickStats: alertas, movimentações hoje, criados últimos 30d, requisições pendentes.
func buildQuickStats(ctxData map[string]any) string {
	db := database.DB_App
	var alertas, movHoje, criados30, reqsPendentes int
	_ = db.QueryRow(`SELECT COUNT(*) FROM FT_ALERTAS WHERE lido=0`).Scan(&alertas)
	_ = db.QueryRow(`SELECT COUNT(*) FROM FT_HISTORICO_MOVIMENTACOES WHERE DATE(data_movimentacao)=CURDATE()`).Scan(&movHoje)
	_ = db.QueryRow(`SELECT COUNT(*) FROM FT_REQUISICOES WHERE data_criacao >= DATE_SUB(NOW(), INTERVAL 30 DAY)`).Scan(&criados30)
	_ = db.QueryRow(`SELECT COUNT(*) FROM FT_REQUISICOES WHERE LOWER(COALESCE(status,'')) IN ('nova requisição','pendente','triagem','em triagem')`).Scan(&reqsPendentes)

	var sb strings.Builder
	sb.WriteString("## Estatísticas Operacionais\n")
	sb.WriteString(fmt.Sprintf("- Alertas não lidos: %d\n", alertas))
	sb.WriteString(fmt.Sprintf("- Movimentações registradas hoje: %d\n", movHoje))
	sb.WriteString(fmt.Sprintf("- Processos/requisições criados nos últimos 30 dias: %d\n", criados30))
	sb.WriteString(fmt.Sprintf("- Requisições pendentes de triagem: %d\n", reqsPendentes))

	ctxData["alertas_nao_lidos"] = alertas
	ctxData["mov_hoje"] = movHoje
	ctxData["criados_30d"] = criados30
	ctxData["reqs_pendentes"] = reqsPendentes
	return sb.String()
}

// buildStagesBreakdown: distribuição por etapa.
func buildStagesBreakdown(ctxData map[string]any) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT COALESCE(e.etapa, '(sem etapa)') AS etapa, COUNT(*) AS total
		FROM FT_PROCESSOS p
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		WHERE COALESCE(p.suspenso, 0) = 0
		  AND COALESCE(p.id_coluna, 1) NOT IN (5,6,99)
		  AND COALESCE(p.id_etapa_processo, 0) <> 11
		GROUP BY etapa
		ORDER BY total DESC`)
	if err != nil {
		return ""
	}
	defer rows.Close()
	type r struct {
		Etapa string
		Total int
	}
	var list []r
	for rows.Next() {
		var x r
		if rows.Scan(&x.Etapa, &x.Total) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("## Distribuição por Etapa (apenas processos ativos)\n")
	for _, x := range list {
		sb.WriteString(fmt.Sprintf("- %s: %d processo(s)\n", x.Etapa, x.Total))
	}
	ctxData["por_etapa"] = list
	return sb.String()
}

// buildTempoPorEtapa: tempo médio em dias parado em cada etapa.
func buildTempoPorEtapa(ctxData map[string]any) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT COALESCE(e.etapa,'(sem etapa)') AS etapa,
		       ROUND(AVG(DATEDIFF(NOW(), COALESCE(ult.ult, r.data_criacao))), 1) AS media_dias
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		LEFT JOIN (
		  SELECT id_requisicao, MAX(data_movimentacao) AS ult
		  FROM FT_HISTORICO_MOVIMENTACOES
		  GROUP BY id_requisicao
		) ult ON ult.id_requisicao = p.id_processo
		WHERE COALESCE(p.suspenso, 0) = 0
		  AND COALESCE(p.id_coluna, 1) NOT IN (5,6,99)
		  AND COALESCE(p.id_etapa_processo, 0) <> 11
		GROUP BY etapa
		ORDER BY media_dias DESC`)
	if err != nil {
		return ""
	}
	defer rows.Close()
	type r struct {
		Etapa string
		Dias  float64
	}
	var list []r
	for rows.Next() {
		var x r
		if rows.Scan(&x.Etapa, &x.Dias) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("## Tempo Médio Parado por Etapa\n")
	for _, x := range list {
		sb.WriteString(fmt.Sprintf("- %s: %.1f dias em média\n", x.Etapa, x.Dias))
	}
	ctxData["tempo_por_etapa"] = list
	return sb.String()
}

// buildStuck: processos travados (+30 dias sem mov, excluindo finalizados).
func buildStuck(ctxData map[string]any, limit int) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT p.id_processo,
		       COALESCE(r.uc,'') AS uc,
		       COALESCE(r.cliente,'') AS cliente,
		       COALESCE(r.concessionaria,'') AS concessionaria,
		       COALESCE(e.etapa,'') AS etapa,
		       COALESCE(p.sub_etapa,'') AS sub_etapa,
		       COALESCE(DATE_FORMAT(MAX(h.data_movimentacao),'%d/%m/%Y'), '(nenhuma)') AS ultima_mov,
		       DATEDIFF(NOW(), COALESCE(MAX(h.data_movimentacao), r.data_criacao)) AS dias_sem
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = p.id_processo
		WHERE COALESCE(p.suspenso, 0) = 0
		  AND COALESCE(p.id_coluna, 1) NOT IN (5,6,99)
		  AND COALESCE(p.id_etapa_processo, 0) <> 11
		GROUP BY p.id_processo, r.uc, r.cliente, r.concessionaria, e.etapa, p.sub_etapa, r.data_criacao
		HAVING dias_sem >= 30
		ORDER BY dias_sem DESC
		LIMIT ?`, limit)
	if err != nil {
		return ""
	}
	defer rows.Close()
	type stuck struct {
		ID             int
		UC             string
		Cliente        string
		Concessionaria string
		Etapa          string
		SubEtapa       string
		UltimaMov      string
		DiasSem        int
	}
	var list []stuck
	for rows.Next() {
		var s stuck
		if rows.Scan(&s.ID, &s.UC, &s.Cliente, &s.Concessionaria, &s.Etapa, &s.SubEtapa, &s.UltimaMov, &s.DiasSem) == nil {
			list = append(list, s)
		}
	}
	if len(list) == 0 {
		return "## Processos Travados\nNenhum processo travado há +30 dias no momento.\n"
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Processos Travados (+30 dias sem movimentação) — top %d\n", len(list)))
	for _, s := range list {
		sb.WriteString(fmt.Sprintf("- **PROC-%03d** | UC %s | %s | %s | %s/%s | %d dias parado (última: %s)\n",
			s.ID, s.UC, s.Cliente, s.Concessionaria, s.Etapa, s.SubEtapa, s.DiasSem, s.UltimaMov))
	}
	ctxData["travados_lista"] = list
	return sb.String()
}

// buildRecent: últimos N processos criados.
func buildRecent(ctxData map[string]any, limit int) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT p.id_processo,
		       COALESCE(r.uc,''),
		       COALESCE(r.cliente,''),
		       COALESCE(r.concessionaria,''),
		       COALESCE(e.etapa,''),
		       DATE_FORMAT(r.data_criacao,'%d/%m/%Y')
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		WHERE r.data_criacao >= DATE_SUB(NOW(), INTERVAL 14 DAY)
		ORDER BY r.data_criacao DESC
		LIMIT ?`, limit)
	if err != nil {
		return ""
	}
	defer rows.Close()
	type rec struct{ ID int; UC, Cliente, Conc, Etapa, Data string }
	var list []rec
	for rows.Next() {
		var x rec
		if rows.Scan(&x.ID, &x.UC, &x.Cliente, &x.Conc, &x.Etapa, &x.Data) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Processos Recentes (últimos 14 dias) — %d\n", len(list)))
	for _, x := range list {
		sb.WriteString(fmt.Sprintf("- **PROC-%03d** | UC %s | %s | %s | Etapa: %s | Criado: %s\n",
			x.ID, x.UC, x.Cliente, x.Conc, x.Etapa, x.Data))
	}
	ctxData["recentes"] = list
	return sb.String()
}

// buildDeadlines: alertas/prazos vencendo ou vencidos.
func buildDeadlines(ctxData map[string]any, limit int) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT a.mensagem,
		       DATE_FORMAT(a.data_alerta,'%d/%m/%Y') AS dt,
		       a.processo_id
		FROM FT_ALERTAS a
		WHERE a.lido = 0
		  AND a.data_alerta IS NOT NULL
		  AND DATE(a.data_alerta) <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)
		ORDER BY a.data_alerta ASC
		LIMIT ?`, limit)
	if err != nil {
		return ""
	}
	defer rows.Close()
	type al struct{ Mensagem, Data string; PID int64 }
	var list []al
	for rows.Next() {
		var x al
		if rows.Scan(&x.Mensagem, &x.Data, &x.PID) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return "## Prazos Vencidos / Próximos\nNenhum alerta vencido ou vencendo nos próximos 3 dias.\n"
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Prazos Vencidos / Próximos 3 dias — %d alertas\n", len(list)))
	for _, x := range list {
		if x.PID > 0 {
			sb.WriteString(fmt.Sprintf("- [%s] PROC-%d — %s\n", x.Data, x.PID, x.Mensagem))
		} else {
			sb.WriteString(fmt.Sprintf("- [%s] %s\n", x.Data, x.Mensagem))
		}
	}
	ctxData["deadlines"] = list
	return sb.String()
}

// buildTopConcessionarias: ranking por valor estimado em carteira.
func buildTopConcessionarias(ctxData map[string]any, limit int) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT COALESCE(r.concessionaria,'(sem nome)') AS conc,
		       COUNT(*) AS total,
		       COALESCE(SUM(r.ressarcimento_estimado), 0) AS valor
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		WHERE COALESCE(p.suspenso, 0) = 0
		  AND COALESCE(p.id_coluna, 1) NOT IN (5,6,99)
		  AND COALESCE(p.id_etapa_processo, 0) <> 11
		  AND r.concessionaria IS NOT NULL AND r.concessionaria <> ''
		GROUP BY r.concessionaria
		ORDER BY valor DESC, total DESC
		LIMIT ?`, limit)
	if err != nil {
		return ""
	}
	defer rows.Close()
	type c struct{ Conc string; Total int; Valor float64 }
	var list []c
	for rows.Next() {
		var x c
		if rows.Scan(&x.Conc, &x.Total, &x.Valor) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Top %d Concessionárias (por valor em carteira)\n", len(list)))
	for _, x := range list {
		sb.WriteString(fmt.Sprintf("- %s: %d processos · R$ %s\n", x.Conc, x.Total, chatFmtBRL(x.Valor)))
	}
	ctxData["top_concs"] = list
	return sb.String()
}

// buildTopClientes
func buildTopClientes(ctxData map[string]any, limit int) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT COALESCE(r.cliente,'(sem nome)') AS cli,
		       COUNT(*) AS total,
		       COALESCE(SUM(r.ressarcimento_estimado), 0) AS valor
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		WHERE COALESCE(p.suspenso, 0) = 0
		  AND COALESCE(p.id_coluna, 1) NOT IN (5,6,99)
		  AND COALESCE(p.id_etapa_processo, 0) <> 11
		  AND r.cliente IS NOT NULL AND r.cliente <> ''
		GROUP BY r.cliente
		ORDER BY valor DESC, total DESC
		LIMIT ?`, limit)
	if err != nil {
		return ""
	}
	defer rows.Close()
	type c struct{ Cliente string; Total int; Valor float64 }
	var list []c
	for rows.Next() {
		var x c
		if rows.Scan(&x.Cliente, &x.Total, &x.Valor) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Top %d Clientes (por valor em carteira)\n", len(list)))
	for _, x := range list {
		sb.WriteString(fmt.Sprintf("- %s: %d processos · R$ %s\n", x.Cliente, x.Total, chatFmtBRL(x.Valor)))
	}
	ctxData["top_clientes"] = list
	return sb.String()
}

// fetchProcessoDetail: detalhes de um processo específico (com histórico).
func fetchProcessoDetail(pid int) string {
	db := database.DB_App
	type detail struct {
		ID             int
		UC             string
		Cliente        string
		Concessionaria string
		Etapa          string
		SubEtapa       string
		Coluna         int
		CriadoEm       string
		UltimaMov      string
		ValorEstimado  float64
		CredSimples    float64
		CredDobro      float64
		Suspenso       int
	}
	var d detail
	err := db.QueryRow(`
		SELECT p.id_processo,
		       COALESCE(r.uc,''),
		       COALESCE(r.cliente,''),
		       COALESCE(r.concessionaria,''),
		       COALESCE(e.etapa,''),
		       COALESCE(p.sub_etapa,''),
		       COALESCE(p.id_coluna, 0),
		       COALESCE(DATE_FORMAT(r.data_criacao,'%d/%m/%Y'), ''),
		       COALESCE(DATE_FORMAT(MAX(h.data_movimentacao),'%d/%m/%Y'), '(nenhuma)'),
		       COALESCE(r.ressarcimento_estimado, 0),
		       COALESCE(p.credito_simples, 0),
		       COALESCE(p.credito_dobro, 0),
		       COALESCE(p.suspenso, 0)
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = p.id_processo
		WHERE p.id_processo = ?
		GROUP BY p.id_processo, r.uc, r.cliente, r.concessionaria, e.etapa, p.sub_etapa, p.id_coluna, r.data_criacao, r.ressarcimento_estimado, p.credito_simples, p.credito_dobro, p.suspenso`,
		pid).Scan(&d.ID, &d.UC, &d.Cliente, &d.Concessionaria, &d.Etapa, &d.SubEtapa,
		&d.Coluna, &d.CriadoEm, &d.UltimaMov, &d.ValorEstimado, &d.CredSimples, &d.CredDobro, &d.Suspenso)
	if err != nil {
		return fmt.Sprintf("## Processo %d\nNão localizado no sistema.\n", pid)
	}

	colunaLabel := map[int]string{
		1: "Ativos", 2: "Deferidos", 3: "Fluxo de Ressarcimento",
		4: "Faturamento", 5: "Concluídos", 6: "Indeferidos", 99: "Suspensos",
	}[d.Coluna]
	if colunaLabel == "" {
		colunaLabel = "Não classificado"
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Detalhes PROC-%03d\n", d.ID))
	sb.WriteString(fmt.Sprintf("- **UC:** %s · **Cliente:** %s · **Concessionária:** %s\n", d.UC, d.Cliente, d.Concessionaria))
	sb.WriteString(fmt.Sprintf("- **Coluna Kanban:** %s · **Etapa:** %s · **Sub-etapa:** %s\n", colunaLabel, d.Etapa, d.SubEtapa))
	sb.WriteString(fmt.Sprintf("- **Criado em:** %s · **Última movimentação:** %s\n", d.CriadoEm, d.UltimaMov))
	sb.WriteString(fmt.Sprintf("- **Valor estimado:** R$ %s\n", chatFmtBRL(d.ValorEstimado)))
	if d.CredSimples > 0 {
		sb.WriteString(fmt.Sprintf("- **Crédito simples deferido:** R$ %s\n", chatFmtBRL(d.CredSimples)))
	}
	if d.CredDobro > 0 {
		sb.WriteString(fmt.Sprintf("- **Crédito em dobro deferido:** R$ %s\n", chatFmtBRL(d.CredDobro)))
	}
	if d.Suspenso == 1 {
		sb.WriteString("- ⚠️ **Suspenso**\n")
	}

	// Histórico recente (top 8)
	rows, err := db.Query(`
		SELECT COALESCE(h.etapa_nova,''),
		       COALESCE(h.sub_etapa,''),
		       DATE_FORMAT(h.data_movimentacao,'%d/%m/%Y') AS dt,
		       COALESCE(u.nome_usuario,'(sistema)') AS usuario,
		       COALESCE(h.comentario,'')
		FROM FT_HISTORICO_MOVIMENTACOES h
		LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
		WHERE h.id_requisicao = ?
		ORDER BY h.data_movimentacao DESC
		LIMIT 8`, pid)
	if err == nil {
		defer rows.Close()
		hasHist := false
		for rows.Next() {
			var etapa, sub, dt, user, com string
			if rows.Scan(&etapa, &sub, &dt, &user, &com) == nil {
				if !hasHist {
					sb.WriteString("\n**Histórico recente:**\n")
					hasHist = true
				}
				sb.WriteString(fmt.Sprintf("- %s | %s/%s | por %s", dt, etapa, sub, user))
				if com != "" && len(com) < 200 {
					sb.WriteString(fmt.Sprintf(" — %q", com))
				}
				sb.WriteString("\n")
			}
		}
	}
	return sb.String()
}

// fetchProcessosByUC: lista processos vinculados a uma UC.
func fetchProcessosByUC(uc string) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT p.id_processo, COALESCE(r.cliente,''), COALESCE(r.concessionaria,''),
		       COALESCE(e.etapa,''), DATE_FORMAT(r.data_criacao,'%d/%m/%Y'),
		       COALESCE(r.ressarcimento_estimado, 0)
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		WHERE r.uc = ?
		ORDER BY r.data_criacao DESC
		LIMIT 15`, uc)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var sb strings.Builder
	count := 0
	for rows.Next() {
		var id int
		var cli, conc, et, dt string
		var val float64
		if rows.Scan(&id, &cli, &conc, &et, &dt, &val) == nil {
			if count == 0 {
				sb.WriteString(fmt.Sprintf("## Processos da UC %s\n", uc))
			}
			sb.WriteString(fmt.Sprintf("- **PROC-%03d** | %s | %s | Etapa: %s | Criado: %s | R$ %s\n",
				id, cli, conc, et, dt, chatFmtBRL(val)))
			count++
		}
	}
	if count == 0 {
		return fmt.Sprintf("## UC %s\nNenhum processo encontrado para esta UC.\n", uc)
	}
	return sb.String()
}

// fetchProcessosByConcessionaria: filtra por nome da concessionária.
func fetchProcessosByConcessionaria(name string) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT p.id_processo, COALESCE(r.uc,''), COALESCE(r.cliente,''),
		       COALESCE(e.etapa,''), COALESCE(p.sub_etapa,''),
		       COALESCE(r.ressarcimento_estimado, 0)
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		WHERE LOWER(r.concessionaria) LIKE ?
		  AND COALESCE(p.suspenso, 0) = 0
		  AND COALESCE(p.id_coluna, 1) NOT IN (5,6,99)
		  AND COALESCE(p.id_etapa_processo, 0) <> 11
		ORDER BY r.ressarcimento_estimado DESC
		LIMIT 25`, "%"+strings.ToLower(name)+"%")
	if err != nil {
		return ""
	}
	defer rows.Close()
	type row struct{ ID int; UC, Cliente, Etapa, Sub string; Valor float64 }
	var list []row
	for rows.Next() {
		var x row
		if rows.Scan(&x.ID, &x.UC, &x.Cliente, &x.Etapa, &x.Sub, &x.Valor) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return fmt.Sprintf("## Concessionária: %s\nNenhum processo ativo encontrado.\n", name)
	}
	var sb strings.Builder
	var total float64
	sb.WriteString(fmt.Sprintf("## Concessionária: %s — %d processos ativos (top 25)\n", name, len(list)))
	for _, x := range list {
		sb.WriteString(fmt.Sprintf("- **PROC-%03d** | UC %s | %s | %s/%s | R$ %s\n",
			x.ID, x.UC, x.Cliente, x.Etapa, x.Sub, chatFmtBRL(x.Valor)))
		total += x.Valor
	}
	sb.WriteString(fmt.Sprintf("\n**Total estimado (mostrados):** R$ %s\n", chatFmtBRL(total)))
	return sb.String()
}

// fetchProcessosByCliente: filtra por nome do cliente.
func fetchProcessosByCliente(name string) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT p.id_processo, COALESCE(r.uc,''), COALESCE(r.concessionaria,''),
		       COALESCE(e.etapa,''), COALESCE(p.sub_etapa,''),
		       COALESCE(r.ressarcimento_estimado, 0)
		FROM FT_PROCESSOS p
		JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		WHERE LOWER(r.cliente) LIKE ?
		ORDER BY r.ressarcimento_estimado DESC
		LIMIT 25`, "%"+strings.ToLower(name)+"%")
	if err != nil {
		return ""
	}
	defer rows.Close()
	type row struct{ ID int; UC, Conc, Etapa, Sub string; Valor float64 }
	var list []row
	for rows.Next() {
		var x row
		if rows.Scan(&x.ID, &x.UC, &x.Conc, &x.Etapa, &x.Sub, &x.Valor) == nil {
			list = append(list, x)
		}
	}
	if len(list) == 0 {
		return fmt.Sprintf("## Cliente: %s\nNenhum processo encontrado.\n", name)
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Cliente: %s — %d processos\n", name, len(list)))
	for _, x := range list {
		sb.WriteString(fmt.Sprintf("- **PROC-%03d** | UC %s | %s | %s/%s | R$ %s\n",
			x.ID, x.UC, x.Conc, x.Etapa, x.Sub, chatFmtBRL(x.Valor)))
	}
	return sb.String()
}

// chatFmtBRL formata float em padrão R$ brasileiro (sem o "R$" prefix).
func chatFmtBRL(v float64) string {
	// Formata com 2 casas decimais
	s := fmt.Sprintf("%.2f", v)
	// Separa parte inteira e decimal
	parts := strings.SplitN(s, ".", 2)
	intPart := parts[0]
	decPart := ""
	if len(parts) == 2 {
		decPart = parts[1]
	}
	// Adiciona separadores de milhar
	negative := false
	if strings.HasPrefix(intPart, "-") {
		negative = true
		intPart = intPart[1:]
	}
	var rev []byte
	for i, ch := range []byte(intPart) {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			rev = append(rev, '.')
		}
		rev = append(rev, ch)
	}
	out := string(rev)
	if decPart != "" {
		out += "," + decPart
	}
	if negative {
		out = "-" + out
	}
	return out
}

// GET /api/v1/chat/processos/contexto — retorna o contexto atual (debug/preview)
func ChatProcessosContextoHandler(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		q = "resumo geral"
	}
	ctx, ctxData := buildProcessosContext(q)
	c.JSON(http.StatusOK, gin.H{
		"context_text": ctx,
		"context_data": ctxData,
	})
}

// init: garante que AI_CHAT_LOG existe (na verdade migração faz isso, só silencia warning).
func init() {
	_ = json.Marshal
}
