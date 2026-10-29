// backend/repositories/dashboard_repo.go
package repositories

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"gorm.io/gorm"
)

// DashFilters controla filtros globais do Dashboard aplicados nas consultas.
// Por padrão (valores zero), suspensos são excluídos e relevância não é exigida.
type DashFilters struct {
	IncluirSuspensos bool
	ApenasRelevantes bool
	Ini              *time.Time
	Fim              *time.Time
	Cliente          string
	Concessionaria   string
	GestorID         *int64
}

// movHumana: movimentação feita por uma pessoa (alias h). Fora: usuário "sistema" (999 / NULL) e e-mails
// anexados ou ações automáticas — senão um lote de e-mails conta como "movimentação" e esconde processo parado.
const movHumana = ` h.id_usuario_gestor IS NOT NULL AND h.id_usuario_gestor <> 999 AND COALESCE(h.tipo_movimentacao,'') NOT IN ('EMAIL','E-mail','auto') `

type DashboardRepo struct {
	db *gorm.DB
}

func NewDashboardRepo(db *gorm.DB) *DashboardRepo { return &DashboardRepo{db: db} }

// === Tipos de retorno usados pelo service ===
type ProcCounts struct {
	Ativos, Deferidos, Fluxo, Faturamento, Concluidos, Indeferidos int64
}
type StatusCounts struct {
	Pendente, EmAnalise, Aprovado, Rejeitado int64
}
type TempoMedioEtapaRow struct {
	Etapa string
	Dias  float64
}
type TendenciaRow struct {
	Dia   time.Time
	Total int64
}
type HeatCell struct {
	DOW, Hour, Total int64
}
type AgingBuckets struct {
	B0_7, B8_15, B16_30, B31Mais int64
}
type CreditosTotal struct {
	Simples float64
	Dobro   float64
}

type CarteiraTotals struct {
	Valor     float64
	Processos int64
}

// Auxiliares para novos blocos
type SeriesRow struct {
	Label string
	Total int64
}
type SeriesRowF struct {
	Label string
	Total float64
}
type ColunaValorRow struct {
	ColID int64
	Total float64
}

// ============== Totais simples =================

func (r *DashboardRepo) TotalRequisicoes(ctx context.Context) (int64, error) {
	return r.TotalRequisicoesFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) TotalRequisicoesFiltered(ctx context.Context, f DashFilters) (int64, error) {
	q := `SELECT COUNT(*) FROM FT_REQUISICOES WHERE 1=1`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	if strings.TrimSpace(f.Concessionaria) != "" {
		q += " AND concessionaria LIKE ?"
		args = append(args, "%"+strings.TrimSpace(f.Concessionaria)+"%")
	}
	if strings.TrimSpace(f.Cliente) != "" {
		q += " AND COALESCE(NULLIF(cliente,''), NULLIF(razao_social_fatura,'')) LIKE ?"
		args = append(args, "%"+strings.TrimSpace(f.Cliente)+"%")
	}
	var n sql.NullInt64
	res := r.db.Raw( q, args...).Scan(&n)
	return n.Int64, res.Error
}

func (r *DashboardRepo) TotalProcessos(ctx context.Context) (int64, error) {
	return r.TotalProcessosFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) TotalProcessosFiltered(ctx context.Context, f DashFilters) (int64, error) {
	q := `
    SELECT COUNT(*)
      FROM FT_PROCESSOS p
 LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
     WHERE 1=1`
	args := []any{}
	if !f.IncluirSuspensos {
		q += " AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */"
	}
	if f.ApenasRelevantes {
		q += " AND COALESCE(p.relevancia,0)=1"
	}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var n sql.NullInt64
	res := r.db.Raw( q, args...).Scan(&n)
	if res.Error == nil && n.Valid {
		return n.Int64, nil
	}
	return r.TotalRequisicoesFiltered(ctx, f)
}

func (r *DashboardRepo) ValorTotalEstimado(ctx context.Context, f DashFilters) (float64, error) {
	// Soma valor estimado, com possibilidade de filtrar por suspenso/relevância via join com processos
	// Regra de ligaÃ§ão: FT_REQUISICOES.id_requisicao = FT_PROCESSOS.id_processo
	q := `
        SELECT COALESCE(SUM(r.ressarcimento_estimado),0) AS tot
          FROM FT_REQUISICOES r
          LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
         WHERE 1=1`
	args := []any{}
	if !f.IncluirSuspensos {
		q += " AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */"
	}
	if f.ApenasRelevantes {
		q += " AND COALESCE(p.relevancia,0)=1"
	}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var v sql.NullFloat64
	res := r.db.Raw( q, args...).Scan(&v)
	return v.Float64, res.Error
}

// Valor em carteira = Ativos (ressarcimento estimado) + Deferidos (credito simples+dobro), exclui suspensos por padrÃÂ£o.
func (r *DashboardRepo) CarteiraTotals(ctx context.Context, f DashFilters) (CarteiraTotals, error) {
	// TODO V2: refactor de nome_coluna/id_coluna/DM_KANBAN_COLUNAS:
	//   'Ativos'    = pré-deferimento sem indeferimento (id_aprovacao_atual IS NULL/<>2) e etapa em (1,2,3)
	//   'Deferidos' = pós-deferimento (id_aprovacao_atual=1) e etapa em (4,5)  -- 6=Encerramento já é "Concluído"
	//   Suspensos (id_status_atual=5) ficam fora.
	qValor := "SELECT\n" +
		"  COALESCE((\n" +
		"    SELECT SUM(COALESCE(ressarcimento_estimado, 0))\n" +
		"    FROM FT_PROCESSOS\n" +
		"    WHERE (id_etapa_atual IN (1,2) OR (id_etapa_atual = 3 AND COALESCE(id_aprovacao_atual,0) <> 1)) /* Ativos: pré-deferimento */\n" +
		"      AND COALESCE(id_aprovacao_atual,0) <> 2\n" +
		"      AND COALESCE(id_status_atual,0) <> 5\n" +
		"  ), 0)\n" +
		"  +\n" +
		"  COALESCE((\n" +
		"    SELECT SUM(COALESCE(credito_simples, 0) + COALESCE(credito_dobro, 0))\n" +
		"    FROM FT_PROCESSOS\n" +
		"    WHERE id_etapa_atual IN (3,4,5) /* Deferidos (Conciliação já deferida, Faturamento, Repasse): vale o crédito */\n" +
		"      AND id_aprovacao_atual = 1\n" +
		"      AND COALESCE(id_status_atual,0) <> 5\n" +
		"  ), 0) AS valor_em_carteira"
	qCount := "SELECT COUNT(DISTINCT id_processo) AS qtd_processos_em_carteira\n" +
		"FROM FT_PROCESSOS\n" +
		"WHERE id_processo IS NOT NULL\n" +
		"  AND ( (id_etapa_atual IN (1,2,3) AND COALESCE(id_aprovacao_atual,0)<>2) /* Ativos */\n" +
		"     OR (id_etapa_atual IN (4,5) AND id_aprovacao_atual=1)                 /* Deferidos */ )\n" +
		"  AND COALESCE(id_status_atual,0) <> 5 /* TODO V2: era suspenso<>1 */"

	var valor sql.NullFloat64
	if res := r.db.Raw( qValor).Scan(&valor); res.Error != nil {
		return CarteiraTotals{}, res.Error
	}
	var processos sql.NullInt64
	if res := r.db.Raw( qCount).Scan(&processos); res.Error != nil {
		return CarteiraTotals{}, res.Error
	}
	return CarteiraTotals{Valor: valor.Float64, Processos: processos.Int64}, nil
}

// ============== Pipeline por coluna =================
// Regra: usar coluna_kanban se presente; caso contrário,
// derivar por etapa/status/passo (cobrindo â€œfinalizado/encerrado/pago/creditadoâ€).
//
// IMPORTANTE: se coluna_kanban for TEXTO ("Ativos", "Fluxo"...), mapeamos para IDs 1..6.
// Se for numérico (ou string numérica), usamos o número.
func (r *DashboardRepo) ProcessosCounts(ctx context.Context, f DashFilters) (ProcCounts, error) {
	q := `
        SELECT
          SUM(CASE
            WHEN p.id_aprovacao_atual = 2 /* TODO V2: era id_etapa_processo=11 (Indeferido legacy) */   THEN 0
            WHEN p.id_status_atual = 5 /* TODO V2: era suspenso=1 */ THEN 0
            WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 1            THEN 1 ELSE 0 END) AS ativos,
          SUM(CASE WHEN COALESCE(p.id_aprovacao_atual,0) <> 2 /* TODO V2: era id_etapa_processo!=11 */ AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */
                        AND (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 2 THEN 1 ELSE 0 END) AS deferidos,
          SUM(CASE WHEN COALESCE(p.id_aprovacao_atual,0) <> 2 /* TODO V2: era id_etapa_processo!=11 */ AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */
                        AND (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 3 THEN 1 ELSE 0 END) AS fluxo,
          SUM(CASE WHEN COALESCE(p.id_aprovacao_atual,0) <> 2 /* TODO V2: era id_etapa_processo!=11 */ AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */
                        AND (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 4 THEN 1 ELSE 0 END) AS faturamento,
          SUM(CASE WHEN COALESCE(p.id_aprovacao_atual,0) <> 2 /* TODO V2: era id_etapa_processo!=11 */ AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */
                        AND (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 5 THEN 1 ELSE 0 END) AS concluidos,
          SUM(CASE WHEN p.id_aprovacao_atual = 2 /* TODO V2: era id_etapa_processo=11 (Indeferido legacy) */  THEN 1 ELSE 0 END) AS indeferidos
        FROM FT_PROCESSOS p
        LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
        WHERE 1=1
    `
	args := []any{}

	if !f.IncluirSuspensos {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */", 1)
	}
	if f.ApenasRelevantes {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND COALESCE(p.relevancia,0)=1", 1)
	}
	if f.Ini != nil && f.Fim != nil {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND DATE(r.data_criacao) BETWEEN ? AND ?", 1)
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}

	var out ProcCounts
	err := r.db.Raw(q, args...).Row().Scan(
		&out.Ativos, &out.Deferidos, &out.Fluxo, &out.Faturamento, &out.Concluidos, &out.Indeferidos,
	)
	return out, err
}

// Valor estimado por coluna de Kanban (com mesmas regras do ProcessosCounts)
func (r *DashboardRepo) ValorEstimadoPorColuna(ctx context.Context, f DashFilters) ([]ColunaValorRow, error) {
	q := `
        SELECT
          CASE
            WHEN p.id_aprovacao_atual = 2 /* TODO V2: era id_etapa_processo=11 (Indeferido legacy) */          THEN 6
            WHEN p.id_status_atual = 5 /* TODO V2: era suspenso=1 */        THEN 99
            WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 5                   THEN 5
            WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 4                   THEN 4
            WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 3                   THEN 3
            WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 2                   THEN 2
            WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 6                   THEN 6
            WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 99                  THEN 99
            ELSE                                        1
          END AS col_id,
          COALESCE(SUM(r.ressarcimento_estimado), 0) AS total
        FROM FT_PROCESSOS p
        LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
        WHERE 1=1
        GROUP BY col_id
        ORDER BY col_id;
    `
	args := []any{}

	if !f.IncluirSuspensos {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */", 1)
	}
	if f.ApenasRelevantes {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND COALESCE(p.relevancia,0)=1", 1)
	}
	if f.Ini != nil && f.Fim != nil {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND DATE(r.data_criacao) BETWEEN ? AND ?", 1)
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}

	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ColunaValorRow{}
	for rows.Next() {
		var row ColunaValorRow
		if err := rows.Scan(&row.ColID, &row.Total); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Total de ressarcimento com base na data_envio_financeiro (apenas processos em Fluxo)
func (r *DashboardRepo) RessarcimentoPorEnvioFinanceiro(ctx context.Context, f DashFilters) (float64, error) {
	sub := `
        SELECT DISTINCT fr.id_processo
        FROM FT_FLUXO_RESSARCIMENTO fr
        WHERE fr.data_envio_financeiro IS NOT NULL
    `
	q := `
        SELECT COALESCE(SUM(COALESCE(d.repasse_simples,0) + COALESCE(d.repasse_dobro,0)),0) AS total
        FROM FT_DEFERIMENTOS d
        JOIN (` + sub + `) fx ON fx.id_processo = d.id_processo
    `
	args := []any{}

	if f.Ini != nil && f.Fim != nil {
		sub = strings.Replace(sub, "WHERE fr.data_envio_financeiro IS NOT NULL", "WHERE fr.data_envio_financeiro IS NOT NULL AND DATE(fr.data_envio_financeiro) BETWEEN ? AND ?", 1)
		q = `
        SELECT COALESCE(SUM(COALESCE(d.repasse_simples,0) + COALESCE(d.repasse_dobro,0)),0) AS total
        FROM FT_DEFERIMENTOS d
        JOIN (` + sub + `) fx ON fx.id_processo = d.id_processo
    `
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}

	var total sql.NullFloat64
	res := r.db.Raw( q, args...).Scan(&total)
	return total.Float64, res.Error
}

// ============== Status counts (triagem da requisiÃ§ão) =================
func (r *DashboardRepo) StatusCounts(ctx context.Context) (StatusCounts, error) {
	return r.StatusCountsFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) StatusCountsFiltered(ctx context.Context, f DashFilters) (StatusCounts, error) {
	q := `
	SELECT
	  SUM(CASE WHEN r.id_status = 1 THEN 1 ELSE 0 END) AS pendente,
	  SUM(CASE WHEN r.id_status = 2 THEN 1 ELSE 0 END) AS em_analise,
	  SUM(CASE WHEN r.id_status = 3 THEN 1 ELSE 0 END) AS aprovado,
	  SUM(CASE WHEN r.id_status = 4 THEN 1 ELSE 0 END) AS rejeitado
	FROM FT_REQUISICOES r
	WHERE 1=1`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var out StatusCounts
	err := r.db.Raw( q, args...).Row().Scan(
		&out.Pendente, &out.EmAnalise, &out.Aprovado, &out.Rejeitado,
	)
	return out, err
}

// ============== Créditos (simples/dobro) =================
func (r *DashboardRepo) CreditosTotals(ctx context.Context) (CreditosTotal, error) {
	return r.CreditosTotalsFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) CreditosTotalsFiltered(ctx context.Context, f DashFilters) (CreditosTotal, error) {
	q := `
	SELECT
	  COALESCE(SUM(d.credito_simples),0) AS simples,
	  COALESCE(SUM(d.credito_dobro),0)   AS dobro
	FROM FT_DEFERIMENTOS d
	LEFT JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
	LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	WHERE COALESCE(p.id_aprovacao_atual,0) <> 2 /* indeferido não tem crédito (mesma regra dos Resultados) */
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var out CreditosTotal
	var s, d sql.NullFloat64
	err := r.db.Raw( q, args...).Row().Scan(&s, &d)
	out.Simples = s.Float64
	out.Dobro = d.Float64
	return out, err
}

// ============== Tempo médio por etapa =================
// Dwell time por etapa: tempo até a PRÓXIMA movimentaÃ§ão.
// Remove rótulos genéricos tipo "Histórico" para não poluir o ranking.
func (r *DashboardRepo) TempoMedioPorEtapa(ctx context.Context) ([]TempoMedioEtapaRow, error) {
	return r.TempoMedioPorEtapaFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) TempoMedioPorEtapaFiltered(ctx context.Context, f DashFilters) ([]TempoMedioEtapaRow, error) {
	// Só as trocas de etapa contam: o tempo na etapa vai da entrada nela até a próxima troca (ou até hoje, se o
	// processo ainda está nela e não está suspenso). Encerramento é a etapa final — não tem "tempo na etapa".
	q := `
	WITH trocas AS (
	  SELECT
	    h.id_processo,
	    h.id_etapa_nova,
	    h.data_movimentacao,
	    LEAD(h.data_movimentacao) OVER (PARTITION BY h.id_processo ORDER BY h.data_movimentacao, h.id_historico) AS prox_data
	  FROM FT_HISTORICO_MOVIMENTACOES h
	  WHERE h.data_movimentacao IS NOT NULL
	    AND h.id_etapa_nova IS NOT NULL
	    AND h.id_etapa_nova <> COALESCE(h.id_etapa_anterior, -1)
	),
	dwell AS (
	  SELECT
	    e.nome AS etapa,
	    t.data_movimentacao,
	    TIMESTAMPDIFF(HOUR, t.data_movimentacao, COALESCE(t.prox_data, NOW()))/24.0 AS dias
	  FROM trocas t
	  JOIN DM_ETAPAS e ON e.id_etapa = t.id_etapa_nova
	  JOIN FT_PROCESSOS p ON p.id_processo = t.id_processo
	  WHERE t.id_etapa_nova <> 6
	    AND (t.prox_data IS NOT NULL OR (p.id_etapa_atual = t.id_etapa_nova AND COALESCE(p.id_status_atual,0) <> 5))
	)
	SELECT etapa, AVG(dias) AS dias
	FROM dwell
	WHERE 1=1
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(data_movimentacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	q += " GROUP BY etapa HAVING etapa <> '' AND LOWER(etapa) NOT REGEXP '^hist' ORDER BY dias DESC LIMIT 20;"
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TempoMedioEtapaRow
	for rows.Next() {
		var rrow TempoMedioEtapaRow
		if err := rows.Scan(&rrow.Etapa, &rrow.Dias); err != nil {
			return nil, err
		}
		out = append(out, rrow)
	}
	return out, rows.Err()
}

// ============== Aging por coluna (dias sem movimentar) =================
func (r *DashboardRepo) Aging(ctx context.Context) (AgingBuckets, error) {
	return r.AgingFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) AgingFiltered(ctx context.Context, f DashFilters) (AgingBuckets, error) {
	// Aging só conta processos ATIVOS na operação:
	// exclui Concluídos (id_coluna=5), Indeferidos (id_coluna=6 legacy ou id_etapa_atual=11)
	// e Suspensos (id_coluna=99 ou suspenso=1).
	q := `
	WITH ult AS (
	  SELECT h.id_processo,
	         MAX(h.data_movimentacao) AS ult
	  FROM FT_HISTORICO_MOVIMENTACOES h
	  WHERE ` + movHumana + `
	  GROUP BY h.id_processo
	),
	age AS (
	  SELECT
	    DATEDIFF(CURDATE(), DATE(ult.ult)) AS dias,
	    ult.ult
	  FROM ult
	  INNER JOIN FT_PROCESSOS p ON p.id_processo = ult.id_processo
	  WHERE COALESCE(p.id_status_atual,0) <> 5 /* TODO V2: era suspenso=0 */
	    AND COALESCE(p.id_aprovacao_atual,0) <> 2 /* TODO V2: era id_etapa_processo<>11 */
	    AND COALESCE((CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */, 1) NOT IN (5, 6, 99)
	)
	SELECT
	  SUM(dias BETWEEN 0 AND 7)        AS b0_7,
	  SUM(dias BETWEEN 8 AND 15)       AS b8_15,
	  SUM(dias BETWEEN 16 AND 30)      AS b16_30,
	  SUM(dias >= 31)                  AS b31mais
	FROM age
	WHERE 1=1
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(ult) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var out AgingBuckets
	err := r.db.Raw(q, args...).Row().Scan(
		&out.B0_7, &out.B8_15, &out.B16_30, &out.B31Mais,
	)
	return out, err
}

// ============== Tendência (30d) =================
func (r *DashboardRepo) Tendencia30d(ctx context.Context, f DashFilters) ([]TendenciaRow, error) {
	q := `
	SELECT DATE(h.data_movimentacao) AS d, COUNT(*) AS tot
	  FROM FT_HISTORICO_MOVIMENTACOES h
	LEFT JOIN FT_PROCESSOS p     ON p.id_processo = h.id_processo
	LEFT JOIN FT_REQUISICOES rqs ON rqs.id_requisicao = h.id_processo
	 WHERE ` + movHumana
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(h.data_movimentacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q += " AND h.data_movimentacao >= CURDATE() - INTERVAL 30 DAY"
	}
	if !f.IncluirSuspensos {
		q += " AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */"
	}
	if f.ApenasRelevantes {
		q += " AND COALESCE(p.relevancia,0)=1"
	}
	if f.GestorID != nil {
		q += " AND p.id_responsavel = ?"
		args = append(args, *f.GestorID)
	}
	if strings.TrimSpace(f.Concessionaria) != "" {
		q += " AND rqs.concessionaria LIKE ?"
		args = append(args, "%"+strings.TrimSpace(f.Concessionaria)+"%")
	}
	if strings.TrimSpace(f.Cliente) != "" {
		q += " AND COALESCE(NULLIF(rqs.cliente,''), NULLIF(rqs.razao_social_fatura,'')) LIKE ?"
		args = append(args, "%"+strings.TrimSpace(f.Cliente)+"%")
	}
	q += " GROUP BY DATE(h.data_movimentacao) ORDER BY d"
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TendenciaRow
	for rows.Next() {
		var tr TendenciaRow
		if err := rows.Scan(&tr.Dia, &tr.Total); err != nil {
			return nil, err
		}
		out = append(out, tr)
	}
	return out, rows.Err()
}

// ============== Heatmap semana (dow x hora) =================
func (r *DashboardRepo) HeatmapSemana(ctx context.Context, f DashFilters) ([]HeatCell, error) {
	q := `
	SELECT WEEKDAY(h.data_movimentacao) AS dow,
	       HOUR(h.data_movimentacao)     AS hr,
	       COUNT(*)                      AS tot
	  FROM FT_HISTORICO_MOVIMENTACOES h
	LEFT JOIN FT_PROCESSOS p     ON p.id_processo = h.id_processo
	LEFT JOIN FT_REQUISICOES rqs ON rqs.id_requisicao = h.id_processo
	 WHERE 1=1`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(h.data_movimentacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q += " AND h.data_movimentacao >= CURDATE() - INTERVAL 7 DAY"
	}
	if !f.IncluirSuspensos {
		q += " AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */"
	}
	if f.ApenasRelevantes {
		q += " AND COALESCE(p.relevancia,0)=1"
	}
	if f.GestorID != nil {
		q += " AND p.id_responsavel = ?"
		args = append(args, *f.GestorID)
	}
	if strings.TrimSpace(f.Concessionaria) != "" {
		q += " AND rqs.concessionaria LIKE ?"
		args = append(args, "%"+strings.TrimSpace(f.Concessionaria)+"%")
	}
	if strings.TrimSpace(f.Cliente) != "" {
		q += " AND COALESCE(NULLIF(rqs.cliente,''), NULLIF(rqs.razao_social_fatura,'')) LIKE ?"
		args = append(args, "%"+strings.TrimSpace(f.Cliente)+"%")
	}
	q += " GROUP BY WEEKDAY(h.data_movimentacao), HOUR(h.data_movimentacao) ORDER BY dow, hr"
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HeatCell
	for rows.Next() {
		var c HeatCell
		if err := rows.Scan(&c.DOW, &c.Hour, &c.Total); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ============== MovimentaÃ§ões por período =================
type MovPeriodoRow struct {
	DataMov       time.Time
	IDRequisicao  int64
	UsuarioNome   sql.NullString
	EtapaAnterior sql.NullString
	EtapaNova     sql.NullString
	Comentario    sql.NullString
}

func (r *DashboardRepo) MovimentacoesPeriodo(ctx context.Context, ini, fim time.Time) ([]MovPeriodoRow, error) {
	q := `
    SELECT
      h.data_movimentacao,
      h.id_processo,
      COALESCE(u.nome_usuario, '') AS usuario_nome,
      (SELECT nome FROM DM_ETAPAS WHERE id_etapa = h.id_etapa_anterior),
      (SELECT nome FROM DM_ETAPAS WHERE id_etapa = h.id_etapa_nova),
      h.comentario
    FROM FT_HISTORICO_MOVIMENTACOES h
    LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
    WHERE DATE(h.data_movimentacao) BETWEEN ? AND ?
    ORDER BY h.data_movimentacao DESC, h.id_processo DESC
    LIMIT 5000;
    `
	rows, err := r.db.Raw( q, ini.Format("2006-01-02"), fim.Format("2006-01-02")).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MovPeriodoRow
	for rows.Next() {
		var m MovPeriodoRow
		if err := rows.Scan(&m.DataMov, &m.IDRequisicao, &m.UsuarioNome, &m.EtapaAnterior, &m.EtapaNova, &m.Comentario); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ============== Throughput (semana / mês) =================
func (r *DashboardRepo) ThroughputSemana(ctx context.Context, limit int) ([]SeriesRow, error) {
	return r.ThroughputSemanaFiltered(ctx, limit, DashFilters{})
}

func (r *DashboardRepo) ThroughputSemanaFiltered(ctx context.Context, limit int, f DashFilters) ([]SeriesRow, error) {
	q := `
      SELECT DATE_FORMAT(data_criacao, '%x-W%v') AS lbl, COUNT(*) AS tot
      FROM FT_REQUISICOES
      WHERE 1=1
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q += " AND data_criacao >= CURDATE() - INTERVAL 180 DAY"
	}
	q += " GROUP BY DATE_FORMAT(data_criacao, '%x-W%v') ORDER BY MIN(data_criacao) DESC LIMIT ?;"
	args = append(args, limit)
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRow
	for rows.Next() {
		var s SeriesRow
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *DashboardRepo) ThroughputMes(ctx context.Context, limit int) ([]SeriesRow, error) {
	return r.ThroughputMesFiltered(ctx, limit, DashFilters{})
}

func (r *DashboardRepo) ThroughputMesFiltered(ctx context.Context, limit int, f DashFilters) ([]SeriesRow, error) {
	q := `
      SELECT DATE_FORMAT(data_criacao, '%Y-%m') AS lbl, COUNT(*) AS tot
      FROM FT_REQUISICOES
      WHERE 1=1
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q += " AND data_criacao >= CURDATE() - INTERVAL 365 DAY"
	}
	q += " GROUP BY DATE_FORMAT(data_criacao, '%Y-%m') ORDER BY MIN(data_criacao) DESC LIMIT ?;"
	args = append(args, limit)
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRow
	for rows.Next() {
		var s SeriesRow
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== Top Concessionárias / Clientes por valor estimado =================
func (r *DashboardRepo) TopConcessionariasValor(ctx context.Context, limit int) ([]SeriesRowF, error) {
	return r.TopConcessionariasValorFiltered(ctx, limit, DashFilters{})
}

func (r *DashboardRepo) TopConcessionariasValorFiltered(ctx context.Context, limit int, f DashFilters) ([]SeriesRowF, error) {
	q := `
      SELECT concessionaria AS lbl, COALESCE(SUM(ressarcimento_estimado),0) AS tot
      FROM FT_REQUISICOES
      WHERE COALESCE(id_status,0) <> 4 /* rejeitada não entra */
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	q += " GROUP BY concessionaria ORDER BY tot DESC LIMIT ?;"
	args = append(args, limit)
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRowF
	for rows.Next() {
		var s SeriesRowF
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *DashboardRepo) TopClientesValor(ctx context.Context, limit int) ([]SeriesRowF, error) {
	return r.TopClientesValorFiltered(ctx, limit, DashFilters{})
}

func (r *DashboardRepo) TopClientesValorFiltered(ctx context.Context, limit int, f DashFilters) ([]SeriesRowF, error) {
	q := `
      SELECT COALESCE(NULLIF(p.cliente,''), NULLIF(rq.cliente,''), NULLIF(rq.razao_social_fatura,''), 'N/A') AS lbl,
             COALESCE(SUM(rq.ressarcimento_estimado),0) AS tot
      FROM FT_REQUISICOES rq
      LEFT JOIN FT_PROCESSOS p ON p.id_processo = rq.id_requisicao /* nome oficial do cliente fica no processo */
      WHERE COALESCE(rq.id_status,0) <> 4 /* rejeitada não entra */
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(rq.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	q += " GROUP BY lbl ORDER BY tot DESC LIMIT ?;"
	args = append(args, limit)
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRowF
	for rows.Next() {
		var s SeriesRowF
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== Canais (últimos 30 dias) =================
func (r *DashboardRepo) CanaisDistribuicao30d(ctx context.Context) ([]SeriesRow, error) {
	return r.CanaisDistribuicao30dFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) CanaisDistribuicao30dFiltered(ctx context.Context, f DashFilters) ([]SeriesRow, error) {
	q := `
      SELECT LOWER(TRIM(dc.nome)) AS lbl, COUNT(*) AS tot
      FROM FT_HISTORICO_CANAIS hc
      JOIN DM_CANAIS_COMUNICACAO dc ON dc.id_canal = hc.id_canal
      JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_historico = hc.id_historico
      WHERE 1=1
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(h.data_movimentacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q += " AND h.data_movimentacao >= NOW() - INTERVAL 30 DAY"
	}
	q += " GROUP BY LOWER(TRIM(dc.nome)) ORDER BY tot DESC;"
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRow
	for rows.Next() {
		var s SeriesRow
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== WIP por gestor (processos em andamento por responsável) =================
func (r *DashboardRepo) WIPPorGestor(ctx context.Context, limit int, f DashFilters) ([]SeriesRow, error) {
	q := `
      SELECT COALESCE(u.nome_usuario, CONCAT('ID ', p.id_responsavel)) AS lbl, COUNT(*) AS tot
      FROM FT_PROCESSOS p
      LEFT JOIN DM_USUARIO u ON u.id_usuario = p.id_responsavel
      LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
      WHERE 1=1
        AND p.id_responsavel IS NOT NULL AND p.id_responsavel <> 999
        AND COALESCE(p.id_aprovacao_atual,0) <> 2 AND COALESCE(p.id_etapa_atual,1) <> 6
      GROUP BY COALESCE(u.nome_usuario, CONCAT('ID ', p.id_responsavel))
      ORDER BY tot DESC
      LIMIT ?;
    `
	args := []any{}
	if !f.IncluirSuspensos {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */", 1)
	}
	if f.ApenasRelevantes {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND COALESCE(p.relevancia,0)=1", 1)
	}
	if f.Ini != nil && f.Fim != nil {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND DATE(r.data_criacao) BETWEEN ? AND ?", 1)
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	args = append(args, limit)
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRow
	for rows.Next() {
		var s SeriesRow
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== Histograma de valor estimado (buckets) =================
func (r *DashboardRepo) ValorHistogram(ctx context.Context) ([]SeriesRow, error) {
	return r.ValorHistogramFiltered(ctx, DashFilters{})
}

func (r *DashboardRepo) ValorHistogramFiltered(ctx context.Context, f DashFilters) ([]SeriesRow, error) {
	q := `
      SELECT bucket, COUNT(*) AS tot
      FROM (
        SELECT CASE
          WHEN ressarcimento_estimado IS NULL OR ressarcimento_estimado < 0 THEN 'N/A'
          WHEN ressarcimento_estimado < 5000 THEN '0-5k'
          WHEN ressarcimento_estimado < 10000 THEN '5-10k'
          WHEN ressarcimento_estimado < 50000 THEN '10-50k'
          WHEN ressarcimento_estimado < 100000 THEN '50-100k'
          ELSE '100k+'
        END AS bucket
        FROM FT_REQUISICOES
        WHERE 1=1 AND COALESCE(id_status,0) <> 4 /* rejeitada não entra */
      ) t
      GROUP BY bucket
      ORDER BY CASE bucket
        WHEN '0-5k' THEN 1
        WHEN '5-10k' THEN 2
        WHEN '10-50k' THEN 3
        WHEN '50-100k' THEN 4
        WHEN '100k+' THEN 5
        ELSE 6
      END;
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q = strings.Replace(q, "WHERE 1=1", "WHERE 1=1 AND DATE(data_criacao) BETWEEN ? AND ?", 1)
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRow
	for rows.Next() {
		var s SeriesRow
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== SLA (últimos 30 dias; limite em dias) =================
func (r *DashboardRepo) SLAResumo30d(ctx context.Context, limiteDias int, f DashFilters) (onTime, late int64, err error) {
	q := `
      WITH ids AS (
        SELECT p.id_processo
          FROM FT_PROCESSOS p
     LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
         WHERE 1=1
      ), mov AS (
        SELECT h.id_processo,
               h.data_movimentacao,
               LAG(h.data_movimentacao) OVER (PARTITION BY h.id_processo ORDER BY h.data_movimentacao) AS prev_mov
          FROM FT_HISTORICO_MOVIMENTACOES h
          JOIN ids i ON i.id_processo = h.id_processo AND ` + movHumana + `
         WHERE 1=1
      ), dif AS (
        SELECT TIMESTAMPDIFF(DAY, prev_mov, data_movimentacao) AS dd
          FROM mov WHERE prev_mov IS NOT NULL
      )
      SELECT SUM(dd <= ?) AS on_time,
             SUM(dd  > ?) AS late
        FROM dif;`
	args := []any{limiteDias, limiteDias}
	if !f.IncluirSuspensos {
		q = strings.Replace(q, "WHERE 1=1\n      ), mov", "WHERE 1=1 AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */\n      ), mov", 1)
	}
	if f.ApenasRelevantes {
		q = strings.Replace(q, "WHERE 1=1\n      ), mov", "WHERE 1=1 AND COALESCE(p.relevancia,0)=1\n      ), mov", 1)
	}
	if f.GestorID != nil {
		q = strings.Replace(q, "WHERE 1=1\n      ), mov", "WHERE 1=1 AND p.id_responsavel = ?\n      ), mov", 1)
		args = append(args, *f.GestorID)
	}
	if strings.TrimSpace(f.Concessionaria) != "" {
		q = strings.Replace(q, "WHERE 1=1\n      ), mov", "WHERE 1=1 AND r.concessionaria LIKE ?\n      ), mov", 1)
		args = append(args, "%"+strings.TrimSpace(f.Concessionaria)+"%")
	}
	if strings.TrimSpace(f.Cliente) != "" {
		q = strings.Replace(q, "WHERE 1=1\n      ), mov", "WHERE 1=1 AND COALESCE(NULLIF(r.cliente,''), NULLIF(r.razao_social_fatura,'')) LIKE ?\n      ), mov", 1)
		args = append(args, "%"+strings.TrimSpace(f.Cliente)+"%")
	}
	if f.Ini != nil && f.Fim != nil {
		q = strings.Replace(q, "WHERE 1=1\n      ), dif", "WHERE 1=1 AND DATE(h.data_movimentacao) BETWEEN ? AND ?\n      ), dif", 1)
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q = strings.Replace(q, "WHERE 1=1\n      ), dif", "WHERE 1=1 AND h.data_movimentacao >= NOW() - INTERVAL 30 DAY\n      ), dif", 1)
	}
	var on, lt sql.NullInt64
	scanErr := r.db.Raw( q, args...).Row().Scan(&on, &lt)
	if scanErr != nil {
		return 0, 0, scanErr
	}
	return on.Int64, lt.Int64, nil
}

// ============== Repasse por concessionária =================
func (r *DashboardRepo) RepassePorConcessionaria(ctx context.Context, f DashFilters, concessionarias []string) ([]SeriesRowF, error) {
	q := `
      SELECT r.concessionaria AS lbl,
             COALESCE(SUM(COALESCE(d.repasse_simples,0) + COALESCE(d.repasse_dobro,0)),0) AS tot
      FROM FT_DEFERIMENTOS d
      JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
      JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
      WHERE 1=1
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	if len(concessionarias) > 0 {
		placeholders := strings.Repeat("?,", len(concessionarias))
		placeholders = strings.TrimRight(placeholders, ",")
		q += " AND r.concessionaria IN (" + placeholders + ")"
		for _, c := range concessionarias {
			args = append(args, c)
		}
	}
	q += " GROUP BY r.concessionaria ORDER BY tot DESC;"
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRowF
	for rows.Next() {
		var s SeriesRowF
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== Tempo médio de conclusão por concessionária =================
func (r *DashboardRepo) TempoMedioConclusaoPorConcessionaria(ctx context.Context, f DashFilters, concessionarias []string) ([]SeriesRowF, error) {
	q := `
      WITH concl AS (
        SELECT h.id_processo,
               MAX(h.data_movimentacao) AS data_conc
        FROM FT_HISTORICO_MOVIMENTACOES h
        WHERE h.id_etapa_nova = 6
        GROUP BY h.id_processo
      )
      SELECT r.concessionaria AS lbl,
             AVG(DATEDIFF(concl.data_conc, r.data_criacao)) AS dias
      FROM concl
      JOIN FT_REQUISICOES r  ON r.id_requisicao = concl.id_processo
      JOIN FT_PROCESSOS p    ON p.id_processo   = concl.id_processo
      WHERE r.concessionaria IS NOT NULL AND r.concessionaria <> ''
        AND (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ NOT IN (99)
        AND COALESCE(p.id_status_atual,0) <> 5 /* TODO V2: era suspenso=0 */
        AND p.id_aprovacao_atual = 1 /* só deferidos: indeferido encerrado não é "conclusão" */
        AND r.data_criacao >= '2024-01-01' /* requisições legadas (desde 2016) distorcem a média */
    `
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(concl.data_conc) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	if len(concessionarias) > 0 {
		placeholders := strings.Repeat("?,", len(concessionarias))
		placeholders = strings.TrimRight(placeholders, ",")
		q += " AND r.concessionaria IN (" + placeholders + ")"
		for _, c := range concessionarias {
			args = append(args, c)
		}
	}
	q += " GROUP BY r.concessionaria ORDER BY dias DESC;"
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRowF
	for rows.Next() {
		var s SeriesRowF
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== Composicao do Kanban =================
func (r *DashboardRepo) KanbanComposicao(ctx context.Context, f DashFilters, concessionarias []string) ([]SeriesRow, error) {
	q := `
      SELECT
        CASE
          WHEN p.id_aprovacao_atual = 2 /* TODO V2: era id_etapa_processo=11 (Indeferido legacy) */        THEN 'Indeferidos'
          WHEN p.id_status_atual = 5 /* TODO V2: era suspenso=1 */      THEN 'Suspensos'
          WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 5                 THEN 'Concluídos'
          WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 4                 THEN 'Faturamento'
          WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 3                 THEN 'Repasse'
          WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 2                 THEN 'Deferidos'
          WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 1                 THEN 'Ativos'
          WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 6                 THEN 'Indeferidos'
          WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ = 99               THEN 'Suspensos'
          ELSE                                      'Ativos'
        END AS lbl,
        COUNT(*) AS tot
      FROM FT_PROCESSOS p
      LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
      WHERE COALESCE(p.descartado,0)=0
    `
	args := []any{}
	if !f.IncluirSuspensos {
		q = strings.Replace(q, "WHERE COALESCE(p.descartado,0)=0", "WHERE COALESCE(p.descartado,0)=0 AND COALESCE(p.id_status_atual,0)<>5 /* TODO V2: era suspenso=0 (NOT suspenso) */", 1)
	}
	if f.ApenasRelevantes {
		q = strings.Replace(q, "WHERE COALESCE(p.descartado,0)=0", "WHERE COALESCE(p.descartado,0)=0 AND COALESCE(p.relevancia,0)=1", 1)
	}
	if f.Ini != nil && f.Fim != nil {
		q = strings.Replace(q, "WHERE COALESCE(p.descartado,0)=0", "WHERE COALESCE(p.descartado,0)=0 AND DATE(r.data_criacao) BETWEEN ? AND ?", 1)
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	if len(concessionarias) > 0 {
		placeholders := strings.Repeat("?,", len(concessionarias))
		placeholders = strings.TrimRight(placeholders, ",")
		q += " AND r.concessionaria IN (" + placeholders + ")"
		for _, c := range concessionarias {
			args = append(args, c)
		}
	}
	q += " GROUP BY lbl ORDER BY tot DESC;"
	rows, err := r.db.Raw( q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SeriesRow
	for rows.Next() {
		var s SeriesRow
		if err := rows.Scan(&s.Label, &s.Total); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ============== Taxa de sucesso por tipo de irregularidade =================
type SucessoTipoRow struct {
	Tipo    string
	Total   int64
	Sucesso int64
	TaxaPct float64
}

func (r *DashboardRepo) TaxaSucessoPorTipo(ctx context.Context, f DashFilters) ([]SucessoTipoRow, error) {
	q := `
	SELECT
	  COALESCE(NULLIF(p.nome_tipo_irregularidade,''), 'Sem tipo') AS tipo,
	  COUNT(*) AS total,
	  SUM(CASE WHEN p.id_aprovacao_atual = 1 THEN 1 ELSE 0 END) AS sucesso,
	  ROUND(100.0 * SUM(CASE WHEN p.id_aprovacao_atual = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS taxa_pct
	FROM FT_PROCESSOS p
	LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	WHERE p.id_aprovacao_atual IN (1, 2) /* só decididos: em andamento não é sucesso nem fracasso */
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	q += " GROUP BY p.nome_tipo_irregularidade HAVING total >= 2 ORDER BY taxa_pct DESC LIMIT 20;"
	rows, err := r.db.Raw(q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SucessoTipoRow
	for rows.Next() {
		var row SucessoTipoRow
		if err := rows.Scan(&row.Tipo, &row.Total, &row.Sucesso, &row.TaxaPct); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ============== Ticket médio =================
func (r *DashboardRepo) TicketMedio(ctx context.Context, f DashFilters) (float64, error) {
	q := `
	SELECT COALESCE(AVG(COALESCE(credito_simples,0) + COALESCE(credito_dobro,0)), 0) AS ticket
	FROM FT_PROCESSOS p
	LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	WHERE (COALESCE(credito_simples,0) + COALESCE(credito_dobro,0)) > 0
	  AND (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ NOT IN (6, 99)
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var v sql.NullFloat64
	res := r.db.Raw(q, args...).Scan(&v)
	return v.Float64, res.Error
}

// ============== Taxa de processos Aneel =================
func (r *DashboardRepo) TaxaAneel(ctx context.Context, f DashFilters) (int64, int64, error) {
	qAneel := `
	SELECT COUNT(*)
	FROM FT_PROCESSOS p
	LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	WHERE (p.id_instancia_atual = 3
	       OR EXISTS (SELECT 1 FROM FT_HISTORICO_MOVIMENTACOES h WHERE h.id_processo = p.id_processo AND h.id_instancia_nova = 3))
	  AND (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ NOT IN (6, 99)
	`
	qTotal := `
	SELECT COUNT(*)
	FROM FT_PROCESSOS p
	LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	WHERE (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ NOT IN (6, 99)
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		qAneel += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		qTotal += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var comAneel, total sql.NullInt64
	if res := r.db.Raw(qAneel, args...).Scan(&comAneel); res.Error != nil {
		return 0, 0, res.Error
	}
	if res := r.db.Raw(qTotal, args...).Scan(&total); res.Error != nil {
		return 0, 0, res.Error
	}
	return comAneel.Int64, total.Int64, nil
}

// ============== Backlog (>60 dias sem movimentação, sub_etapa <> Aguardando retorno) =================
// Considera apenas processos ATIVOS na operação — exclui Concluídos, Indeferidos e Suspensos.
func (r *DashboardRepo) BacklogCount(ctx context.Context) (int64, error) {
	q := `
	SELECT COUNT(DISTINCT p.id_processo)
	FROM FT_PROCESSOS p
	LEFT JOIN (
	  SELECT h.id_processo, MAX(h.data_movimentacao) AS ult_mov
	  FROM FT_HISTORICO_MOVIMENTACOES h
	  WHERE ` + movHumana + `
	  GROUP BY h.id_processo
	) ult ON ult.id_processo = p.id_processo
	WHERE COALESCE(p.id_status_atual,0) <> 5 /* TODO V2: era suspenso=0 */
	  AND COALESCE(p.id_aprovacao_atual,0) <> 2 /* TODO V2: era id_etapa_processo<>11 */
	  AND COALESCE((CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */, 1) NOT IN (5, 6, 99)
	  AND COALESCE((SELECT nome FROM DM_STATUS_PROCESSO WHERE id_status = p.id_status_atual), '') <> 'Aguardando retorno'
	  AND (ult.ult_mov IS NULL OR DATEDIFF(CURDATE(), DATE(ult.ult_mov)) > 60)
	`
	var n sql.NullInt64
	res := r.db.Raw(q).Scan(&n)
	return n.Int64, res.Error
}

// ============== Resultados Ressarcimento (Gerado / Faturado / Caixa) =================
type ResultadosRessarcimentoRow struct {
	Gerado   float64
	Faturado float64
	Caixa    float64
}

func (r *DashboardRepo) ResultadosRessarcimento(ctx context.Context, f DashFilters) (ResultadosRessarcimentoRow, error) {
	q := `
	SELECT
	  COALESCE(SUM(CASE WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2 */ IN (2,3,4,5) THEN COALESCE(credito_simples,0)+COALESCE(credito_dobro,0) ELSE 0 END), 0) AS gerado,
	  COALESCE(SUM(CASE WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2 */ = 4 THEN COALESCE(credito_simples,0)+COALESCE(credito_dobro,0) ELSE 0 END), 0) AS faturado,
	  COALESCE(SUM(CASE WHEN (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2 */ = 5 THEN COALESCE(credito_simples,0)+COALESCE(credito_dobro,0) ELSE 0 END), 0) AS caixa
	FROM FT_PROCESSOS p
	LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	WHERE 1=1
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	var out ResultadosRessarcimentoRow
	err := r.db.Raw(q, args...).Row().Scan(&out.Gerado, &out.Faturado, &out.Caixa)
	return out, err
}

// ============== Resultados por cliente (simples + dobro) =================
type ResultadoClienteRow struct {
	Cliente string
	Simples float64
	Dobro   float64
	Total   float64
}

func (r *DashboardRepo) ResultadosPorCliente(ctx context.Context, f DashFilters, limit int) ([]ResultadoClienteRow, error) {
	q := `
	SELECT
	  COALESCE(NULLIF(p.cliente,''), 'Sem cliente') AS cliente,
	  COALESCE(SUM(p.credito_simples), 0) AS simples,
	  COALESCE(SUM(p.credito_dobro), 0) AS dobro,
	  COALESCE(SUM(COALESCE(p.credito_simples,0) + COALESCE(p.credito_dobro,0)), 0) AS total
	FROM FT_PROCESSOS p
	LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	WHERE (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ NOT IN (1, 6, 99)
	  AND (COALESCE(p.credito_simples,0) + COALESCE(p.credito_dobro,0)) > 0
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	q += " GROUP BY p.cliente ORDER BY total DESC LIMIT ?;"
	args = append(args, limit)
	rows, err := r.db.Raw(q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ResultadoClienteRow
	for rows.Next() {
		var row ResultadoClienteRow
		if err := rows.Scan(&row.Cliente, &row.Simples, &row.Dobro, &row.Total); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ============== % Sucesso primeira análise (deferidos apenas pela Distribuidora) =================
func (r *DashboardRepo) SucessoPrimeiraAnalise(ctx context.Context, f DashFilters) (int64, int64, error) {
	q := `
	WITH deferidos AS (
	  SELECT DISTINCT p.id_processo
	  FROM FT_PROCESSOS p
	  LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = p.id_processo
	  WHERE (CASE WHEN p.id_aprovacao_atual=2 THEN 6 WHEN p.id_status_atual=5 THEN 99 WHEN p.id_etapa_atual=6 THEN 5 WHEN p.id_etapa_atual=5 THEN 3 WHEN p.id_etapa_atual=4 THEN 4 WHEN p.id_aprovacao_atual=1 THEN 2 ELSE 1 END) /* TODO V2: id_coluna derivado */ NOT IN (1, 6, 99)
	  %FILTRO_DATA%
	),
	passou_outra_etapa AS (
	  SELECT DISTINCT h.id_processo
	  FROM FT_HISTORICO_MOVIMENTACOES h
	  INNER JOIN deferidos d ON d.id_processo = h.id_processo
	  WHERE h.id_instancia_nova IN (2, 3, 4) /* saiu da Distribuidora (instância 1) */
	)
	SELECT
	  COUNT(DISTINCT d.id_processo) AS total_deferidos,
	  COUNT(DISTINCT d.id_processo) - COUNT(DISTINCT p.id_processo) AS apenas_distribuidora
	FROM deferidos d
	LEFT JOIN passou_outra_etapa p ON p.id_processo = d.id_processo
	`
	filtroData := ""
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		filtroData = " AND DATE(r.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	q = strings.ReplaceAll(q, "%FILTRO_DATA%", filtroData)
	var total, apenasDistrib sql.NullInt64
	err := r.db.Raw(q, args...).Row().Scan(&total, &apenasDistrib)
	return apenasDistrib.Int64, total.Int64, err
}

// ============== Taxa de sucesso por concessionária =================
type SucessoConcRow struct {
	Concessionaria string
	Total          int64
	Deferidos      int64
	TaxaPct        float64
}

func (r *DashboardRepo) TaxaSucessoPorConcessionaria(ctx context.Context, f DashFilters) ([]SucessoConcRow, error) {
	q := `
	SELECT
	  p.concessionaria,
	  COUNT(*) AS total,
	  SUM(CASE WHEN p.id_aprovacao_atual = 1 THEN 1 ELSE 0 END) AS deferidos,
	  ROUND(100.0 * SUM(CASE WHEN p.id_aprovacao_atual = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS taxa_pct
	FROM FT_PROCESSOS p
	LEFT JOIN FT_REQUISICOES rq ON rq.id_requisicao = p.id_processo
	WHERE p.concessionaria IS NOT NULL AND p.concessionaria <> ''
	  AND p.id_aprovacao_atual IN (1, 2) /* só decididos: deferidos / (deferidos + indeferidos) */
	`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(rq.data_criacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	}
	// as de maior volume (com pelo menos 5 decididos): 2 ou 3 processos davam 100% e tomavam o topo
	q += " GROUP BY p.concessionaria HAVING total >= 5 ORDER BY total DESC LIMIT 12;"

	rows, err := r.db.Raw(q, args...).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SucessoConcRow
	for rows.Next() {
		var row SucessoConcRow
		if err := rows.Scan(&row.Concessionaria, &row.Total, &row.Deferidos, &row.TaxaPct); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}












