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
// Estratégia: monta contexto a partir de queries seguras (read-only) e envia
// para a IA gerar a resposta em português.
// ─────────────────────────────────────────────────────────────────────────────

type processoChatRequest struct {
	Question string       `json:"question"`
	History  []aisureMsg  `json:"history"`
}

type processoChatResponse struct {
	Answer  string            `json:"answer"`
	Context map[string]any    `json:"context,omitempty"`
}

var reProcessoID = regexp.MustCompile(`(?i)(?:proc(?:esso)?[-\s#]?0*|#\s*0*)(\d+)`)
var reUCNum     = regexp.MustCompile(`\bUC\s*(\d{5,12})\b`)

const processoChatSystemPrompt = `Você é o assistente SURE (Sistema Unificado de Ressarcimento de Energia).
Responda SOMENTE com base nos dados fornecidos no contexto abaixo.
Seja direto, objetivo e use formatação Markdown quando útil (listas, negrito).
Não invente processos ou valores. Se não souber, diga claramente.
Datas no formato DD/MM/AAAA. Valores em Reais com vírgula decimal.
Contexto do sistema:`

// ChatProcessosHandler responde perguntas sobre processos usando dados do DB + OpenAI.
func ChatProcessosHandler(c *gin.Context) {
	var req processoChatRequest
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Question) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "question obrigatória"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	// Monta contexto a partir do banco
	dbCtx, ctxData := buildProcessosContext(req.Question)

	sysPrompt := processoChatSystemPrompt + "\n\n" + dbCtx

	answer, err := callAisureOpenAI(ctx, req.History, req.Question, "", sysPrompt)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "IA indisponível: " + err.Error()})
		return
	}

	// Salva no log
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

// buildProcessosContext constrói um texto de contexto + mapa de dados para a IA.
func buildProcessosContext(question string) (string, map[string]any) {
	db := database.DB_App
	ctxData := map[string]any{}
	var parts []string

	// ── 1. Totais por etapa ───────────────────────────────────────────────────
	{
		rows, err := db.Query(`
			SELECT e.etapa, COUNT(*) AS total
			  FROM FT_PROCESSOS p
			  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
			 GROUP BY e.etapa
			 ORDER BY total DESC`)
		if err == nil {
			defer rows.Close()
			type row struct {
				Etapa string
				Total int
			}
			var etapas []row
			for rows.Next() {
				var r row
				if rows.Scan(&r.Etapa, &r.Total) == nil {
					etapas = append(etapas, r)
				}
			}
			rows.Close()
			if len(etapas) > 0 {
				var sb strings.Builder
				sb.WriteString("## Processos por Etapa\n")
				for _, e := range etapas {
					sb.WriteString(fmt.Sprintf("- %s: %d processo(s)\n", e.Etapa, e.Total))
				}
				parts = append(parts, sb.String())
				ctxData["por_etapa"] = etapas
			}
		}
	}

	// ── 2. Totais financeiros ─────────────────────────────────────────────────
	{
		type fin struct {
			Total   int
			ValPend float64
			ValDef  float64
		}
		var f fin
		err := db.QueryRow(`
			SELECT
			  COUNT(p.id_processo),
			  COALESCE(SUM(CASE WHEN fr.valor IS NULL OR fr.valor = 0 THEN 0 END), 0) AS val_pendente,
			  COALESCE(SUM(COALESCE(fr.valor, 0)), 0) AS val_deferido
			FROM FT_PROCESSOS p
			LEFT JOIN (
			  SELECT x.id_processo, x.valor
			    FROM FT_DEFERIMENTOS x
			    JOIN (SELECT id_processo, MAX(created_at) mx FROM FT_DEFERIMENTOS GROUP BY id_processo) u
			         ON u.id_processo = x.id_processo AND u.mx = x.created_at
			) fr ON fr.id_processo = p.id_processo
		`).Scan(&f.Total, &f.ValPend, &f.ValDef)
		if err == nil {
			parts = append(parts, fmt.Sprintf(
				"## Totais\n- Total de processos ativos: %d\n- Valor total deferido (ressarcimento): R$ %.2f\n",
				f.Total, f.ValDef,
			))
			ctxData["totais_financeiros"] = f
		}
	}

	// ── 3. Processos sem movimentação há 30+ dias ─────────────────────────────
	{
		rows, err := db.Query(`
			SELECT p.id_processo,
			       COALESCE(r.uc,'') AS uc,
			       COALESCE(r.cliente,'') AS cliente,
			       COALESCE(e.etapa,'') AS etapa,
			       COALESCE(DATE_FORMAT(MAX(h.created_at),'%d/%m/%Y'), 'nunca') AS ultima_mov
			  FROM FT_PROCESSOS p
			  JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
			  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
			  LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = p.id_processo
			 GROUP BY p.id_processo, r.uc, r.cliente, e.etapa
			HAVING MAX(h.created_at) < DATE_SUB(NOW(), INTERVAL 30 DAY)
			    OR MAX(h.created_at) IS NULL
			 ORDER BY MAX(h.created_at) ASC
			 LIMIT 20`)
		if err == nil {
			defer rows.Close()
			type pRow struct {
				ID       int
				UC       string
				Cliente  string
				Etapa    string
				UltimaMov string
			}
			var parados []pRow
			for rows.Next() {
				var r pRow
				if rows.Scan(&r.ID, &r.UC, &r.Cliente, &r.Etapa, &r.UltimaMov) == nil {
					parados = append(parados, r)
				}
			}
			rows.Close()
			if len(parados) > 0 {
				var sb strings.Builder
				sb.WriteString("## Processos Parados (sem movimentação há 30+ dias)\n")
				for _, p := range parados {
					sb.WriteString(fmt.Sprintf("- PROC-%03d | UC %s | %s | Etapa: %s | Última mov: %s\n",
						p.ID, p.UC, p.Cliente, p.Etapa, p.UltimaMov))
				}
				parts = append(parts, sb.String())
				ctxData["parados"] = parados
			}
		}
	}

	// ── 4. Processos recentes (últimos 7 dias) ────────────────────────────────
	{
		rows, err := db.Query(`
			SELECT p.id_processo,
			       COALESCE(r.uc,'') AS uc,
			       COALESCE(r.cliente,'') AS cliente,
			       COALESCE(e.etapa,'') AS etapa,
			       COALESCE(DATE_FORMAT(r.data_criacao,'%d/%m/%Y'),'') AS criado_em
			  FROM FT_PROCESSOS p
			  JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
			  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
			 WHERE r.data_criacao >= DATE_SUB(NOW(), INTERVAL 7 DAY)
			 ORDER BY r.data_criacao DESC
			 LIMIT 15`)
		if err == nil {
			defer rows.Close()
			type rec struct {
				ID       int
				UC       string
				Cliente  string
				Etapa    string
				CriadoEm string
			}
			var recentes []rec
			for rows.Next() {
				var r rec
				if rows.Scan(&r.ID, &r.UC, &r.Cliente, &r.Etapa, &r.CriadoEm) == nil {
					recentes = append(recentes, r)
				}
			}
			rows.Close()
			if len(recentes) > 0 {
				var sb strings.Builder
				sb.WriteString("## Processos Criados nos Últimos 7 Dias\n")
				for _, r := range recentes {
					sb.WriteString(fmt.Sprintf("- PROC-%03d | UC %s | %s | Etapa: %s | Criado: %s\n",
						r.ID, r.UC, r.Cliente, r.Etapa, r.CriadoEm))
				}
				parts = append(parts, sb.String())
				ctxData["recentes"] = recentes
			}
		}
	}

	// ── 5. Se pergunta menciona processo específico ───────────────────────────
	if m := reProcessoID.FindStringSubmatch(question); len(m) >= 2 {
		pid, _ := strconv.Atoi(m[1])
		if pid > 0 {
			detail := fetchProcessoDetail(pid)
			if detail != "" {
				parts = append(parts, detail)
			}
		}
	}

	// ── 6. Se pergunta menciona UC específica ─────────────────────────────────
	if m := reUCNum.FindStringSubmatch(strings.ToUpper(question)); len(m) >= 2 {
		uc := m[1]
		detail := fetchProcessosByUC(uc)
		if detail != "" {
			parts = append(parts, detail)
		}
	}

	// ── 7. Alertas vencendo hoje / vencidos ───────────────────────────────────
	{
		rows, err := db.Query(`
			SELECT mensagem, DATE_FORMAT(data_alerta,'%d/%m/%Y') AS data_alerta
			  FROM FT_ALERTAS
			 WHERE lido = 0
			   AND data_alerta IS NOT NULL
			   AND DATE(data_alerta) <= CURDATE()
			 ORDER BY data_alerta ASC
			 LIMIT 10`)
		if err == nil {
			defer rows.Close()
			var alertas []string
			for rows.Next() {
				var msg, dt string
				if rows.Scan(&msg, &dt) == nil {
					alertas = append(alertas, fmt.Sprintf("- [%s] %s", dt, msg))
				}
			}
			rows.Close()
			if len(alertas) > 0 {
				parts = append(parts, "## Alertas Vencidos ou Vencendo Hoje\n"+strings.Join(alertas, "\n"))
				ctxData["alertas_vencidos"] = alertas
			}
		}
	}

	// ── 8. Estatísticas rápidas ───────────────────────────────────────────────
	{
		var totalAlertas, movHoje, procCriados30d int
		_ = db.QueryRow(`SELECT COUNT(*) FROM FT_ALERTAS WHERE lido=0`).Scan(&totalAlertas)
		_ = db.QueryRow(`SELECT COUNT(*) FROM FT_HISTORICO_MOVIMENTACOES WHERE DATE(created_at)=CURDATE()`).Scan(&movHoje)
		_ = db.QueryRow(`SELECT COUNT(*) FROM FT_REQUISICOES WHERE data_criacao >= DATE_SUB(NOW(), INTERVAL 30 DAY)`).Scan(&procCriados30d)

		parts = append(parts, fmt.Sprintf(
			"## Estatísticas Rápidas\n- Alertas não lidos: %d\n- Movimentações hoje: %d\n- Processos criados nos últimos 30 dias: %d\n",
			totalAlertas, movHoje, procCriados30d,
		))
	}

	// ── 9. Ressarcimento mensal (últimos 12 meses) — para gráfico ─────────────
	{
		rows, err := db.Query(`
			SELECT DATE_FORMAT(created_at, '%m/%Y') AS mes,
			       DATE_FORMAT(created_at, '%Y-%m') AS mes_ord,
			       COALESCE(SUM(valor), 0) AS valor
			  FROM FT_DEFERIMENTOS
			 WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
			   AND valor > 0
			 GROUP BY mes, mes_ord
			 ORDER BY mes_ord ASC`)
		if err == nil {
			defer rows.Close()
			type mesVal struct {
				Mes   string  `json:"mes"`
				Valor float64 `json:"valor"`
			}
			var serie []mesVal
			for rows.Next() {
				var m mesVal
				var ord string
				if rows.Scan(&m.Mes, &ord, &m.Valor) == nil {
					serie = append(serie, m)
				}
			}
			rows.Close()
			if len(serie) > 0 {
				ctxData["ressarcimento_mensal"] = serie
				var sb strings.Builder
				sb.WriteString("## Ressarcimento Mensal (últimos 12 meses)\n")
				for _, s := range serie {
					sb.WriteString(fmt.Sprintf("- %s: R$ %.2f\n", s.Mes, s.Valor))
				}
				parts = append(parts, sb.String())
			}
		}
	}

	// ── 10. Top clientes por número de processos ──────────────────────────────
	{
		rows, err := db.Query(`
			SELECT COALESCE(r.cliente, 'Sem nome') AS cliente, COUNT(*) AS total
			  FROM FT_REQUISICOES r
			  JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
			 WHERE r.cliente IS NOT NULL AND r.cliente != ''
			 GROUP BY r.cliente
			 ORDER BY total DESC
			 LIMIT 8`)
		if err == nil {
			defer rows.Close()
			type clienteRow struct {
				Cliente string `json:"cliente"`
				Total   int    `json:"total"`
			}
			var clientes []clienteRow
			for rows.Next() {
				var c clienteRow
				if rows.Scan(&c.Cliente, &c.Total) == nil {
					clientes = append(clientes, c)
				}
			}
			rows.Close()
			if len(clientes) > 0 {
				ctxData["por_cliente"] = clientes
				var sb strings.Builder
				sb.WriteString("## Top Clientes por Processos\n")
				for _, c := range clientes {
					sb.WriteString(fmt.Sprintf("- %s: %d processo(s)\n", c.Cliente, c.Total))
				}
				parts = append(parts, sb.String())
			}
		}
	}

	// ── 11. Média de movimentações por etapa ──────────────────────────────────
	{
		rows, err := db.Query(`
			SELECT e.etapa,
			       ROUND(AVG(cnt), 1) AS media,
			       MAX(cnt) AS maximo
			  FROM (
			    SELECT p.id_processo,
			           e2.etapa,
			           COUNT(h.id_historico) AS cnt
			      FROM FT_PROCESSOS p
			      JOIN DM_ETAPAS_PROCESSO e2 ON e2.id_etapa_processo = p.id_etapa_processo
			      LEFT JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_requisicao = p.id_processo
			     GROUP BY p.id_processo, e2.etapa
			  ) t
			  JOIN DM_ETAPAS_PROCESSO e ON e.etapa = t.etapa
			 GROUP BY e.etapa
			 ORDER BY media DESC`)
		if err == nil {
			defer rows.Close()
			type movRow struct {
				Etapa  string  `json:"etapa"`
				Media  float64 `json:"media"`
				Maximo int     `json:"maximo"`
			}
			var movs []movRow
			for rows.Next() {
				var m movRow
				if rows.Scan(&m.Etapa, &m.Media, &m.Maximo) == nil {
					movs = append(movs, m)
				}
			}
			rows.Close()
			if len(movs) > 0 {
				ctxData["media_movimentacoes"] = movs
			}
		}
	}

	// ── 12. Tempo médio em dias por etapa ─────────────────────────────────────
	{
		rows, err := db.Query(`
			SELECT e.etapa,
			       ROUND(AVG(DATEDIFF(NOW(), COALESCE(ult.ultima_mov, r.data_criacao))), 0) AS media_dias
			  FROM FT_PROCESSOS p
			  JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
			  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
			  LEFT JOIN (
			    SELECT id_requisicao, MAX(created_at) AS ultima_mov
			      FROM FT_HISTORICO_MOVIMENTACOES
			     GROUP BY id_requisicao
			  ) ult ON ult.id_requisicao = p.id_processo
			 GROUP BY e.etapa
			 ORDER BY media_dias DESC`)
		if err == nil {
			defer rows.Close()
			type tempoRow struct {
				Etapa     string  `json:"etapa"`
				MediaDias float64 `json:"media_dias"`
			}
			var tempos []tempoRow
			for rows.Next() {
				var t tempoRow
				if rows.Scan(&t.Etapa, &t.MediaDias) == nil {
					tempos = append(tempos, t)
				}
			}
			rows.Close()
			if len(tempos) > 0 {
				ctxData["tempo_por_etapa"] = tempos
			}
		}
	}

	// ── 13. Por concessionária ────────────────────────────────────────────────
	{
		rows, err := db.Query(`
			SELECT COALESCE(r.concessionaria, 'Não informada') AS concessionaria,
			       COUNT(*) AS total,
			       COALESCE(SUM(d.valor), 0) AS valor_total
			  FROM FT_REQUISICOES r
			  JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
			  LEFT JOIN (
			    SELECT x.id_processo, x.valor
			      FROM FT_DEFERIMENTOS x
			      JOIN (SELECT id_processo, MAX(created_at) mx FROM FT_DEFERIMENTOS GROUP BY id_processo) u
			           ON u.id_processo = x.id_processo AND u.mx = x.created_at
			  ) d ON d.id_processo = p.id_processo
			 WHERE r.concessionaria IS NOT NULL AND r.concessionaria != ''
			 GROUP BY r.concessionaria
			 ORDER BY total DESC
			 LIMIT 8`)
		if err == nil {
			defer rows.Close()
			type concRow struct {
				Concessionaria string  `json:"concessionaria"`
				Total          int     `json:"total"`
				ValorTotal     float64 `json:"valor_total"`
			}
			var concs []concRow
			for rows.Next() {
				var c concRow
				if rows.Scan(&c.Concessionaria, &c.Total, &c.ValorTotal) == nil {
					concs = append(concs, c)
				}
			}
			rows.Close()
			if len(concs) > 0 {
				ctxData["por_concessionaria"] = concs
			}
		}
	}

	// ── 14. Evolução mensal de abertura de processos ──────────────────────────
	{
		rows, err := db.Query(`
			SELECT DATE_FORMAT(data_criacao, '%m/%Y') AS mes,
			       DATE_FORMAT(data_criacao, '%Y-%m') AS mes_ord,
			       COUNT(*) AS total
			  FROM FT_REQUISICOES
			 WHERE data_criacao >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
			 GROUP BY mes, mes_ord
			 ORDER BY mes_ord ASC`)
		if err == nil {
			defer rows.Close()
			type mesTotal struct {
				Mes   string `json:"mes"`
				Total int    `json:"total"`
			}
			var serie []mesTotal
			for rows.Next() {
				var m mesTotal
				var ord string
				if rows.Scan(&m.Mes, &ord, &m.Total) == nil {
					serie = append(serie, m)
				}
			}
			rows.Close()
			if len(serie) > 0 {
				ctxData["abertura_mensal"] = serie
			}
		}
	}

	return strings.Join(parts, "\n\n"), ctxData
}

// fetchProcessoDetail busca detalhes de um processo específico pelo ID.
func fetchProcessoDetail(pid int) string {
	db := database.DB_App
	type detail struct {
		ID         int
		UC         string
		Cliente    string
		Concession string
		Etapa      string
		SubEtapa   string
		CriadoEm  string
		UltimaMov string
		ValorDef  float64
		Comentario string
	}
	var d detail
	err := db.QueryRow(`
		SELECT p.id_processo,
		       COALESCE(r.uc,'') AS uc,
		       COALESCE(r.cliente,'') AS cliente,
		       COALESCE(r.concessionaria,'') AS concessionaria,
		       COALESCE(e.etapa,'') AS etapa,
		       COALESCE(h_last.sub_etapa,'') AS sub_etapa,
		       COALESCE(DATE_FORMAT(r.data_criacao,'%d/%m/%Y'),'') AS criado_em,
		       COALESCE(DATE_FORMAT(h_last.created_at,'%d/%m/%Y'),'nunca') AS ultima_mov,
		       COALESCE(fr.valor, 0) AS valor_deferido,
		       COALESCE(h_last.comentario,'') AS comentario
		  FROM FT_PROCESSOS p
		  JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		  LEFT JOIN (
		    SELECT h.id_requisicao, h.sub_etapa, h.created_at, h.comentario
		      FROM FT_HISTORICO_MOVIMENTACOES h
		      JOIN (SELECT id_requisicao, MAX(created_at) mx FROM FT_HISTORICO_MOVIMENTACOES GROUP BY id_requisicao) u
		           ON u.id_requisicao = h.id_requisicao AND u.mx = h.created_at
		  ) h_last ON h_last.id_requisicao = p.id_processo
		  LEFT JOIN (
		    SELECT x.id_processo, x.valor
		      FROM FT_DEFERIMENTOS x
		      JOIN (SELECT id_processo, MAX(created_at) mx FROM FT_DEFERIMENTOS GROUP BY id_processo) u
		           ON u.id_processo = x.id_processo AND u.mx = x.created_at
		  ) fr ON fr.id_processo = p.id_processo
		 WHERE p.id_processo = ?`, pid,
	).Scan(&d.ID, &d.UC, &d.Cliente, &d.Concession, &d.Etapa, &d.SubEtapa, &d.CriadoEm, &d.UltimaMov, &d.ValorDef, &d.Comentario)
	if err != nil {
		return ""
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Detalhes PROC-%03d\n", d.ID))
	sb.WriteString(fmt.Sprintf("- UC: %s\n- Cliente: %s\n- Concessionária: %s\n", d.UC, d.Cliente, d.Concession))
	sb.WriteString(fmt.Sprintf("- Etapa: %s | Sub-etapa: %s\n", d.Etapa, d.SubEtapa))
	sb.WriteString(fmt.Sprintf("- Criado em: %s | Última movimentação: %s\n", d.CriadoEm, d.UltimaMov))
	if d.ValorDef > 0 {
		sb.WriteString(fmt.Sprintf("- Valor deferido: R$ %.2f\n", d.ValorDef))
	}
	if d.Comentario != "" {
		sb.WriteString(fmt.Sprintf("- Último comentário: %s\n", d.Comentario))
	}

	// Histórico de movimentações
	rows, err := db.Query(`
		SELECT COALESCE(etapa_nova,'') AS etapa,
		       COALESCE(sub_etapa,'') AS sub,
		       DATE_FORMAT(created_at,'%d/%m/%Y') AS dt,
		       COALESCE(u.nome,'') AS usuario
		  FROM FT_HISTORICO_MOVIMENTACOES h
		  LEFT JOIN DM_USUARIOS u ON u.id_usuario = h.id_usuario
		 WHERE h.id_requisicao = ?
		 ORDER BY h.created_at DESC
		 LIMIT 8`, pid)
	if err == nil {
		defer rows.Close()
		sb.WriteString("- Histórico recente:\n")
		for rows.Next() {
			var etapa, sub, dt, user string
			if rows.Scan(&etapa, &sub, &dt, &user) == nil {
				sb.WriteString(fmt.Sprintf("  - %s: %s %s (por %s)\n", dt, etapa, sub, user))
			}
		}
		rows.Close()
	}

	return sb.String()
}

// fetchProcessosByUC busca processos de uma UC específica.
func fetchProcessosByUC(uc string) string {
	db := database.DB_App
	rows, err := db.Query(`
		SELECT p.id_processo,
		       COALESCE(r.cliente,'') AS cliente,
		       COALESCE(e.etapa,'') AS etapa,
		       COALESCE(DATE_FORMAT(r.data_criacao,'%d/%m/%Y'),'') AS criado_em
		  FROM FT_PROCESSOS p
		  JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
		  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
		 WHERE r.uc = ?
		 ORDER BY r.data_criacao DESC
		 LIMIT 10`, uc)
	if err != nil {
		return ""
	}
	defer rows.Close()

	var sb strings.Builder
	count := 0
	for rows.Next() {
		var id int
		var cliente, etapa, criadoEm string
		if rows.Scan(&id, &cliente, &etapa, &criadoEm) == nil {
			if count == 0 {
				sb.WriteString(fmt.Sprintf("## Processos da UC %s\n", uc))
			}
			sb.WriteString(fmt.Sprintf("- PROC-%03d | %s | Etapa: %s | Criado: %s\n", id, cliente, etapa, criadoEm))
			count++
		}
	}
	if count == 0 {
		return fmt.Sprintf("## UC %s\nNenhum processo encontrado para esta UC.\n", uc)
	}
	return sb.String()
}

// GET /api/v1/chat/processos/contexto — retorna o contexto atual (para debug/preview)
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

// Garante que a tabela AI_CHAT_LOG existe (compatibilidade)
func init() {
	// já é criada pelo migrations, apenas referência
	_ = json.Marshal // suppress import warning
}
