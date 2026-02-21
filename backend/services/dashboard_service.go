package services

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"ressarcimento-backend/repositories"
)

type DashboardService struct {
	repo *repositories.DashboardRepo
}

func NewDashboardService(r *repositories.DashboardRepo) *DashboardService {
	return &DashboardService{repo: r}
}

type DashboardStats struct {
	TotalRequisicoes        int64            `json:"total_requisicoes"`
	TotalProcessos          int64            `json:"total_processos"`
	ValorTotalRessarcimento float64          `json:"valor_total_ressarcimento"`
	ValorEmCarteira         float64          `json:"valor_em_carteira,omitempty"`
	ProcessosEmCarteira     int64            `json:"processos_em_carteira,omitempty"`
	ProcessosCounts         map[string]int64 `json:"processos_counts"`
	StatusCounts            map[string]int64 `json:"status_counts"`
	Creditos                struct {
		SimplesTotal    float64 `json:"simples_total"`
		DobroTotal      float64 `json:"dobro_total"`
		TotalProcedente float64 `json:"total_procedente"`
	} `json:"creditos"`
	TempoMedioDiasPorEtapa []struct {
		Etapa string  `json:"etapa"`
		Dias  float64 `json:"dias"`
	} `json:"tempo_medio_dias_por_etapa"`
	AgingPorColuna map[string]int64         `json:"aging_por_coluna"`
	Tendencia30d   []map[string]interface{} `json:"tendencia_30d"`
	HeatmapSemana  []map[string]interface{} `json:"heatmap_semana"`

	// Campos adicionais para o Dashboard avançado
	Funil              []map[string]interface{} `json:"funil,omitempty"`
	ThroughputSemana   []map[string]interface{} `json:"throughput_semana,omitempty"`
	ThroughputMes      []map[string]interface{} `json:"throughput_mes,omitempty"`
	TopConcessionarias []map[string]interface{} `json:"top_concessionarias,omitempty"`
	TopClientes        []map[string]interface{} `json:"top_clientes,omitempty"`
	AgingBuckets       []map[string]interface{} `json:"aging_buckets,omitempty"`
	SLA                map[string]int64         `json:"sla,omitempty"`
	CanaisDist30d      []map[string]interface{} `json:"canais_dist_30d,omitempty"`
	WIPGestores        []map[string]interface{} `json:"wip_gestores,omitempty"`
	ValorHistogram     []map[string]interface{} `json:"valor_histogram,omitempty"`

	// Ajuda a diagnosticar no front (com debug=1) sem quebrar o dashboard
	Warnings []string `json:"warnings,omitempty"`
}

// GetStats agrega todos os blocos; se um bloco falhar, continua e adiciona warnings.
func (s *DashboardService) GetStats(ctx context.Context, debug bool, f repositories.DashFilters) (DashboardStats, error) {
	var out DashboardStats

	// Total de Requisições
	if v, err := s.repo.TotalRequisicoes(ctx); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("total_requisicoes: %v", err))
	} else {
		out.TotalRequisicoes = v
	}

	// Total de Processos
	if v, err := s.repo.TotalProcessos(ctx); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("total_processos: %v", err))
	} else {
		out.TotalProcessos = v
	}

	// Valor Estimado
	if v, err := s.repo.ValorTotalEstimado(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("valor_total_ressarcimento: %v", err))
	} else {
		out.ValorTotalRessarcimento = v
	}

	// Valor/Processos em carteira (Ativos + Deferidos)
	if c, err := s.repo.CarteiraTotals(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("carteira_totals: %v", err))
	} else {
		out.ValorEmCarteira = c.Valor
		out.ProcessosEmCarteira = c.Processos
	}

	// Processos por coluna (Kanban)
	if pc, err := s.repo.ProcessosCounts(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("processos_counts: %v", err))
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

	// Status das requisições
	if sc, err := s.repo.StatusCounts(ctx); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("status_counts: %v", err))
	} else {
		out.StatusCounts = map[string]int64{
			"pendente":   sc.Pendente,
			"em_analise": sc.EmAnalise,
			"aprovado":   sc.Aprovado,
			"rejeitado":  sc.Rejeitado,
		}
	}

	// Créditos
	if cr, err := s.repo.CreditosTotals(ctx); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("creditos: %v", err))
	} else {
		out.Creditos.SimplesTotal = cr.Simples
		out.Creditos.DobroTotal = cr.Dobro
		out.Creditos.TotalProcedente = cr.Simples + cr.Dobro
	}

	// Tempo médio por etapa
	if tm, err := s.repo.TempoMedioPorEtapa(ctx); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("tempo_medio_dias_por_etapa: %v", err))
	} else {
		for _, r := range tm {
			out.TempoMedioDiasPorEtapa = append(out.TempoMedioDiasPorEtapa, struct {
				Etapa string  `json:"etapa"`
				Dias  float64 `json:"dias"`
			}{Etapa: r.Etapa, Dias: r.Dias})
		}
	}

	// Aging
	if ag, err := s.repo.Aging(ctx); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("aging_por_coluna: %v", err))
	} else {
		out.AgingPorColuna = map[string]int64{
			"0_7":     ag.B0_7,
			"8_15":    ag.B8_15,
			"16_30":   ag.B16_30,
			"31_mais": ag.B31Mais,
		}
	}

	// Tendência 30d
	if td, err := s.repo.Tendencia30d(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("tendencia_30d: %v", err))
	} else {
		for _, d := range td {
			out.Tendencia30d = append(out.Tendencia30d, map[string]interface{}{
				"dia":   d.Dia.Format("2006-01-02"),
				"total": d.Total,
			})
		}
	}

	// Heatmap semanal
	if hm, err := s.repo.HeatmapSemana(ctx, f); err != nil {
		out.Warnings = append(out.Warnings, fmt.Sprintf("heatmap_semana: %v", err))
	} else {
		for _, c := range hm {
			out.HeatmapSemana = append(out.HeatmapSemana, map[string]interface{}{
				"dow":   c.DOW, // 0=segunda ... 6=domingo
				"hora":  c.Hour,
				"total": c.Total,
			})
		}
	}

	// Funil por status (derivado do status_counts)
	out.Funil = []map[string]interface{}{
		{"label": "Pendente", "total": out.StatusCounts["pendente"]},
		{"label": "Em Análise", "total": out.StatusCounts["em_analise"]},
		{"label": "Aprovado", "total": out.StatusCounts["aprovado"]},
		{"label": "Rejeitado", "total": out.StatusCounts["rejeitado"]},
	}

	// Throughput
	if rows, err := s.repo.ThroughputSemana(ctx, 12); err == nil {
		for _, r := range rows {
			out.ThroughputSemana = append(out.ThroughputSemana, map[string]interface{}{"label": r.Label, "total": r.Total})
		}
	} else {
		out.Warnings = append(out.Warnings, fmt.Sprintf("throughput_semana: %v", err))
	}
	if rows, err := s.repo.ThroughputMes(ctx, 12); err == nil {
		for _, r := range rows {
			out.ThroughputMes = append(out.ThroughputMes, map[string]interface{}{"label": r.Label, "total": r.Total})
		}
	}

	// Top Concessionárias / Clientes
	if rows, err := s.repo.TopConcessionariasValor(ctx, 10); err == nil {
		for _, r := range rows {
			out.TopConcessionarias = append(out.TopConcessionarias, map[string]interface{}{"label": r.Label, "total": r.Total})
		}
	} else {
		out.Warnings = append(out.Warnings, fmt.Sprintf("top_concessionarias: %v", err))
	}
	if rows, err := s.repo.TopClientesValor(ctx, 10); err == nil {
		for _, r := range rows {
			out.TopClientes = append(out.TopClientes, map[string]interface{}{"label": r.Label, "total": r.Total})
		}
	} else {
		out.Warnings = append(out.Warnings, fmt.Sprintf("top_clientes: %v", err))
	}

	// Aging buckets em formato de array
	if ag, err := s.repo.Aging(ctx); err == nil {
		out.AgingBuckets = []map[string]interface{}{
			{"label": "0–7", "total": ag.B0_7},
			{"label": "8–15", "total": ag.B8_15},
			{"label": "16–30", "total": ag.B16_30},
			{"label": "31+", "total": ag.B31Mais},
		}
	}

	// SLA (aproximação em 30 dias, limite 7 dias)
	if on, late, err := s.repo.SLAResumo30d(ctx, 7, f); err == nil {
		out.SLA = map[string]int64{"on_time": on, "late": late}
	} else {
		out.Warnings = append(out.Warnings, fmt.Sprintf("sla: %v", err))
	}

	// Canais 30d
	if rows, err := s.repo.CanaisDistribuicao30d(ctx); err == nil {
		for _, r := range rows {
			out.CanaisDist30d = append(out.CanaisDist30d, map[string]interface{}{"label": r.Label, "total": r.Total})
		}
	}

	// WIP por gestor
	if rows, err := s.repo.WIPPorGestor(ctx, 10, f); err == nil {
		for _, r := range rows {
			out.WIPGestores = append(out.WIPGestores, map[string]interface{}{"label": r.Label, "total": r.Total})
		}
	}

	// Histograma de valor
	if rows, err := s.repo.ValorHistogram(ctx); err == nil {
		for _, r := range rows {
			out.ValorHistogram = append(out.ValorHistogram, map[string]interface{}{"label": r.Label, "total": r.Total})
		}
	}

	// Se debug habilitado e houve warnings, não quebramos; devolvemos warnings para ver no front
	return out, nil
}

func (s *DashboardService) MovimentacoesPeriodo(ctx context.Context, ini, fim time.Time) ([]map[string]interface{}, error) {
	rows, err := s.repo.MovimentacoesPeriodo(ctx, ini, fim)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]interface{}, 0, len(rows))
	for _, r := range rows {
		out = append(out, map[string]interface{}{
			"data_movimentacao": r.DataMov.Format(time.RFC3339),
			"id_requisicao":     r.IDRequisicao,
			"usuario_nome":      nullStr(r.UsuarioNome),
			"etapa_anterior":    nullStr(r.EtapaAnterior),
			"etapa_nova":        nullStr(r.EtapaNova),
			"comentario":        nullStr(r.Comentario),
		})
	}
	return out, nil
}

func nullStr(ns sql.NullString) string {
	if ns.Valid {
		return ns.String
	}
	return ""
}
