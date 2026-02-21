package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
	"ressarcimento-backend/repositories"
)

type RelatoriosMetricasResp struct {
	TotalRequisicoes                  int64                    `json:"total_requisicoes"`
	TotalProcessos                    int64                    `json:"total_processos"`
	ValorTotalRessarcimento           float64                  `json:"valor_total_ressarcimento"`
	CarteiraValor                     float64                  `json:"carteira_valor"`
	CarteiraProcessos                 int64                    `json:"carteira_processos"`
	ValorEmCarteira                   float64                  `json:"valor_em_carteira"`
	ProcessosEmCarteira               int64                    `json:"processos_em_carteira"`
	ProcessosCounts                   map[string]int64         `json:"processos_counts"`
	StatusCounts                      map[string]int64         `json:"status_counts"`
	ValorPorColuna                    []map[string]interface{} `json:"valor_por_coluna,omitempty"`
	RessarcimentoEnvioFinanceiroTotal float64                  `json:"ressarcimento_envio_financeiro_total,omitempty"`
	Creditos                          struct {
		SimplesTotal    float64 `json:"simples_total"`
		DobroTotal      float64 `json:"dobro_total"`
		TotalProcedente float64 `json:"total_procedente"`
	} `json:"creditos"`
	TempoMedioDiasPorEtapa []map[string]interface{} `json:"tempo_medio_dias_por_etapa,omitempty"`
	Tendencia30d           []map[string]interface{} `json:"tendencia_30d,omitempty"`
	AgingBuckets           map[string]int64         `json:"aging_buckets,omitempty"`
	TopConcessionarias     []map[string]interface{} `json:"top_concessionarias,omitempty"`
	TopClientes            []map[string]interface{} `json:"top_clientes,omitempty"`
	ThroughputSemana       []map[string]interface{} `json:"throughput_semana,omitempty"`
	ThroughputMes          []map[string]interface{} `json:"throughput_mes,omitempty"`
	CanaisDist30d          []map[string]interface{} `json:"canais_dist_30d,omitempty"`
	WIPGestores            []map[string]interface{} `json:"wip_gestores,omitempty"`
	ValorHistogram         []map[string]interface{} `json:"valor_histogram,omitempty"`
	SLA30d                 map[string]int64         `json:"sla_30d,omitempty"`
	TempoConclusaoConcs    []map[string]interface{} `json:"tempo_medio_conclusao_concessionaria,omitempty"`
	RepasseTotal           float64                  `json:"repasse_total,omitempty"`
	RepassePorConcs        []map[string]interface{} `json:"repasse_por_concessionaria,omitempty"`
	Warnings               []string                 `json:"warnings,omitempty"`
}

type KanbanComposicaoResp struct {
	Total    int64                    `json:"total"`
	Items    []map[string]interface{} `json:"items"`
	Warnings []string                 `json:"warnings,omitempty"`
}

func parseDateBR(value string) (*time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	t, err := time.ParseInLocation("02/01/2006", value, time.Local)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// GetKanbanComposicao godoc
// @Summary      Composição do Kanban
// @Tags         Relatorios
// @Param        data_ini         query  string  false  "Data inicial (DD/MM/YYYY)"
// @Param        data_fim         query  string  false  "Data final (DD/MM/YYYY)"
// @Param        concessionarias  query  string  false  "Lista separada por vírgula"
// @Produce      json
// @Success      200  {object}  KanbanComposicaoResp
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/relatorios/kanban-composicao [get]
// GET /api/v1/relatorios/kanban-composicao
func GetKanbanComposicao(c *gin.Context) {
	if database.GormDB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database nao configurado"})
		return
	}
	repo := repositories.NewDashboardRepo(database.GormDB_App)
	ctx := c.Request.Context()
	out := KanbanComposicaoResp{}

	f := repositories.DashFilters{}
	iniStr := c.Query("data_ini")
	fimStr := c.Query("data_fim")
	if iniStr != "" && fimStr != "" {
		if ini, err := parseDateBR(iniStr); err == nil {
			if fim, err := parseDateBR(fimStr); err == nil {
				f.Ini = ini
				f.Fim = fim
			} else {
				out.Warnings = append(out.Warnings, "data_fim_invalida")
			}
		} else {
			out.Warnings = append(out.Warnings, "data_ini_invalida")
		}
	}

	concsParam := strings.TrimSpace(c.Query("concessionarias"))
	var concs []string
	if concsParam != "" {
		for _, part := range strings.Split(concsParam, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				concs = append(concs, part)
			}
		}
	}

	rows, err := repo.KanbanComposicao(ctx, f, concs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao montar composicao do kanban"})
		return
	}

	var total int64
	for _, r := range rows {
		total += r.Total
	}
	out.Total = total
	for _, r := range rows {
		pct := 0.0
		if total > 0 {
			pct = (float64(r.Total) / float64(total)) * 100
		}
		out.Items = append(out.Items, map[string]interface{}{
			"label":   r.Label,
			"total":   r.Total,
			"percent": pct,
		})
	}

	c.JSON(http.StatusOK, out)
}

// GetRelatoriosMetricas godoc
// @Summary      Métricas de relatórios
// @Tags         Relatorios
// @Param        data_ini         query  string  false  "Data inicial (DD/MM/YYYY)"
// @Param        data_fim         query  string  false  "Data final (DD/MM/YYYY)"
// @Param        concessionarias  query  string  false  "Lista separada por vírgula"
// @Produce      json
// @Success      200  {object}  RelatoriosMetricasResp
// @Failure      500  {object}  map[string]any
// @Router       /api/v1/relatorios/metricas [get]
func GetRelatoriosMetricas(c *gin.Context) {
	if database.GormDB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database nao configurado"})
		return
	}
	repo := repositories.NewDashboardRepo(database.GormDB_App)
	ctx := c.Request.Context()

	var out RelatoriosMetricasResp
	f := repositories.DashFilters{}

	iniStr := c.Query("data_ini")
	fimStr := c.Query("data_fim")
	if iniStr != "" && fimStr != "" {
		if ini, err := parseDateBR(iniStr); err == nil {
			if fim, err := parseDateBR(fimStr); err == nil {
				f.Ini = ini
				f.Fim = fim
			} else {
				out.Warnings = append(out.Warnings, "data_fim_invalida")
			}
		} else {
			out.Warnings = append(out.Warnings, "data_ini_invalida")
		}
	}

	concsParam := strings.TrimSpace(c.Query("concessionarias"))
	var concs []string
	if concsParam != "" {
		for _, part := range strings.Split(concsParam, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				concs = append(concs, part)
			}
		}
	}

	if v, err := repo.TotalRequisicoesFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "total_requisicoes")
	} else {
		out.TotalRequisicoes = v
	}

	if v, err := repo.TotalProcessosFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "total_processos")
	} else {
		out.TotalProcessos = v
	}

	if v, err := repo.ValorTotalEstimado(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "valor_total_ressarcimento")
	} else {
		out.ValorTotalRessarcimento = v
	}

	if c, err := repo.CarteiraTotals(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "carteira_totals")
	} else {
		out.CarteiraValor = c.Valor
		out.CarteiraProcessos = c.Processos
		out.ValorEmCarteira = c.Valor
		out.ProcessosEmCarteira = c.Processos
	}

	if v, err := repo.RessarcimentoPorEnvioFinanceiro(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "ressarcimento_envio_financeiro_total")
	} else {
		out.RessarcimentoEnvioFinanceiroTotal = v
	}

	if rows, err := repo.ValorEstimadoPorColuna(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "valor_por_coluna")
	} else {
		colLabels := map[int64]string{
			1: "Ativos",
			2: "Deferidos",
			3: "Fluxo de Ressarcimento",
			4: "Faturamento",
			5: "Concluídos",
			6: "Indeferidos",
		}
		for _, r := range rows {
			label := colLabels[r.ColID]
			if label == "" {
				label = "Outros"
			}
			out.ValorPorColuna = append(out.ValorPorColuna, map[string]interface{}{
				"label": label,
				"total": r.Total,
			})
		}
	}

	if pc, err := repo.ProcessosCounts(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "processos_counts")
	} else {
		out.ProcessosCounts = map[string]int64{
			"ativos":              pc.Ativos,
			"deferidos":           pc.Deferidos,
			"fluxo_ressarcimento": pc.Fluxo,
			"faturamento":         pc.Faturamento,
			"concluidos":          pc.Concluidos,
			"indeferidos":         pc.Indeferidos,
		}
	}

	if sc, err := repo.StatusCountsFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "status_counts")
	} else {
		out.StatusCounts = map[string]int64{
			"pendente":   sc.Pendente,
			"em_analise": sc.EmAnalise,
			"aprovado":   sc.Aprovado,
			"rejeitado":  sc.Rejeitado,
		}
	}

	if cr, err := repo.CreditosTotalsFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "creditos")
	} else {
		out.Creditos.SimplesTotal = cr.Simples
		out.Creditos.DobroTotal = cr.Dobro
		out.Creditos.TotalProcedente = cr.Simples + cr.Dobro
	}

	if rows, err := repo.TempoMedioPorEtapaFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "tempo_medio_dias_por_etapa")
	} else {
		for _, r := range rows {
			out.TempoMedioDiasPorEtapa = append(out.TempoMedioDiasPorEtapa, map[string]interface{}{
				"etapa": r.Etapa,
				"dias":  r.Dias,
			})
		}
	}

	if rows, err := repo.Tendencia30d(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "tendencia_30d")
	} else {
		for _, r := range rows {
			out.Tendencia30d = append(out.Tendencia30d, map[string]interface{}{
				"dia":   r.Dia.Format("2006-01-02"),
				"total": r.Total,
			})
		}
	}

	if ab, err := repo.AgingFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "aging_buckets")
	} else {
		out.AgingBuckets = map[string]int64{
			"0_7":     ab.B0_7,
			"8_15":    ab.B8_15,
			"16_30":   ab.B16_30,
			"31_mais": ab.B31Mais,
		}
	}

	if rows, err := repo.TopConcessionariasValorFiltered(ctx, 8, f); err != nil {
		out.Warnings = append(out.Warnings, "top_concessionarias")
	} else {
		for _, r := range rows {
			out.TopConcessionarias = append(out.TopConcessionarias, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
	}

	if rows, err := repo.TopClientesValorFiltered(ctx, 8, f); err != nil {
		out.Warnings = append(out.Warnings, "top_clientes")
	} else {
		for _, r := range rows {
			out.TopClientes = append(out.TopClientes, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
	}

	if rows, err := repo.ThroughputSemanaFiltered(ctx, 16, f); err != nil {
		out.Warnings = append(out.Warnings, "throughput_semana")
	} else {
		for _, r := range rows {
			out.ThroughputSemana = append(out.ThroughputSemana, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
	}

	if rows, err := repo.ThroughputMesFiltered(ctx, 12, f); err != nil {
		out.Warnings = append(out.Warnings, "throughput_mes")
	} else {
		for _, r := range rows {
			out.ThroughputMes = append(out.ThroughputMes, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
	}

	if rows, err := repo.CanaisDistribuicao30dFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "canais_dist_30d")
	} else {
		for _, r := range rows {
			out.CanaisDist30d = append(out.CanaisDist30d, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
	}

	if rows, err := repo.WIPPorGestor(ctx, 10, f); err != nil {
		out.Warnings = append(out.Warnings, "wip_gestores")
	} else {
		for _, r := range rows {
			out.WIPGestores = append(out.WIPGestores, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
	}

	if rows, err := repo.ValorHistogramFiltered(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, "valor_histogram")
	} else {
		for _, r := range rows {
			out.ValorHistogram = append(out.ValorHistogram, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
	}

	if on, late, err := repo.SLAResumo30d(ctx, 7, f); err != nil {
		out.Warnings = append(out.Warnings, "sla_30d")
	} else {
		out.SLA30d = map[string]int64{
			"limite_dias": 7,
			"on_time":     on,
			"late":        late,
		}
	}

	if rows, err := repo.TempoMedioConclusaoPorConcessionaria(ctx, f, concs); err != nil {
		out.Warnings = append(out.Warnings, "tempo_medio_conclusao_concessionaria")
	} else {
		for _, r := range rows {
			out.TempoConclusaoConcs = append(out.TempoConclusaoConcs, map[string]interface{}{
				"label": r.Label,
				"dias":  r.Total,
			})
		}
	}

	if rows, err := repo.RepassePorConcessionaria(ctx, f, concs); err != nil {
		out.Warnings = append(out.Warnings, "repasse_total")
	} else {
		var total float64
		for _, r := range rows {
			total += r.Total
			out.RepassePorConcs = append(out.RepassePorConcs, map[string]interface{}{
				"label": r.Label,
				"total": r.Total,
			})
		}
		out.RepasseTotal = total
	}

	c.JSON(http.StatusOK, out)
}
