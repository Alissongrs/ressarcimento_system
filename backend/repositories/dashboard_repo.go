// backend/repositories/dashboard_repo.go
package repositories

import (
	"context"
	"database/sql"
	"strings"
	"time"
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

type DashboardRepo struct {
	db *sql.DB
}

func NewDashboardRepo(db *sql.DB) *DashboardRepo { return &DashboardRepo{db: db} }

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

// Auxiliares para novos blocos
type SeriesRow struct {
	Label string
	Total int64
}
type SeriesRowF struct {
	Label string
	Total float64
}

// ============== Totais simples =================

func (r *DashboardRepo) TotalRequisicoes(ctx context.Context) (int64, error) {
	var n sql.NullInt64
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM FT_REQUISICOES`).Scan(&n)
	return n.Int64, err
}

func (r *DashboardRepo) TotalProcessos(ctx context.Context) (int64, error) {
	// Se não houver FT_PROCESSOS, mantém 1:1 com requisições
	var n sql.NullInt64
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM FT_PROCESSOS`).Scan(&n)
	if err == nil && n.Valid {
		return n.Int64, nil
	}
	return r.TotalRequisicoes(ctx)
}

func (r *DashboardRepo) ValorTotalEstimado(ctx context.Context, f DashFilters) (float64, error) {
	// Soma valor estimado, com possibilidade de filtrar por suspenso/relevância via join com processos
	// Regra de ligação: FT_REQUISICOES.id_requisicao = FT_PROCESSOS.id_processo
	q := `
        SELECT COALESCE(SUM(r.ressarcimento_estimado),0) AS tot
          FROM FT_REQUISICOES r
          LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
         WHERE 1=1`
	args := []any{}
	if !f.IncluirSuspensos {
		q += " AND COALESCE(p.suspenso,0)=0"
	}
	if f.ApenasRelevantes {
		q += " AND COALESCE(p.relevancia,0)=1"
	}
	var v sql.NullFloat64
	err := r.db.QueryRowContext(ctx, q, args...).Scan(&v)
	return v.Float64, err
}

// ============== Pipeline por coluna =================
// Regra: usar coluna_kanban se presente; caso contrário,
// derivar por etapa/status/passo (cobrindo “finalizado/encerrado/pago/creditado”).
func (r *DashboardRepo) ProcessosCounts(ctx context.Context, f DashFilters) (ProcCounts, error) {
	q := `
        WITH base AS (
          SELECT
            COALESCE(
              coluna_kanban,
              CASE
		        /* CONCLUÍDOS / FINALIZADOS / ENCERRADOS / PAGOS / CREDITADOS */
		        WHEN LOWER(COALESCE(etapa,''))   REGEXP 'conclu|finaliz|encerr|pago|credit'
		          OR LOWER(COALESCE(status,''))  REGEXP 'conclu|finaliz|encerr|pago|credit'
		          OR LOWER(COALESCE(passo,''))   REGEXP 'conclu|finaliz|encerr|pago|credit' THEN 5
		        /* INDEFERIDOS / IMPROCEDENTES */
		        WHEN LOWER(COALESCE(etapa,''))   REGEXP 'indefer|improced'
		          OR LOWER(COALESCE(status,''))  REGEXP 'indefer|improced' THEN 6
		        /* FATURAMENTO */
		        WHEN LOWER(COALESCE(etapa,''))   REGEXP 'fatur'
		          OR LOWER(COALESCE(status,''))  REGEXP 'fatur' THEN 4
		        /* FLUXO DE RESSARCIMENTO */
		        WHEN LOWER(COALESCE(etapa,''))   REGEXP 'fluxo|ressarc'
		          OR LOWER(COALESCE(status,''))  REGEXP 'fluxo|ressarc' THEN 3
        /* DEFERIDOS / PROCEDENTES / APROVADOS */
        WHEN LOWER(COALESCE(etapa,''))   REGEXP 'deferid|proced|aprov'
          OR LOWER(COALESCE(status,''))  REGEXP 'deferid|proced|aprov' THEN 2
		        /* DEFAULT → ATIVOS */
		        ELSE 1
		      END
		    ) AS col_id
          FROM FT_PROCESSOS
          WHERE COALESCE(descartado,0)=0
        )
        SELECT
          SUM(col_id=1) AS ativos,
          SUM(col_id=2) AS deferidos,
          SUM(col_id=3) AS fluxo,
          SUM(col_id=4) AS faturamento,
          SUM(col_id=5) AS concluidos,
          SUM(col_id=6) AS indeferidos
        FROM base;
    `
	// aplica filtros na CTE base
	if !f.IncluirSuspensos {
		q = strings.Replace(q, "WHERE COALESCE(descartado,0)=0", "WHERE COALESCE(descartado,0)=0 AND COALESCE(suspenso,0)=0", 1)
	}
	if f.ApenasRelevantes {
		q = strings.Replace(q, "FROM FT_PROCESSOS\n          WHERE", "FROM FT_PROCESSOS\n          WHERE COALESCE(relevancia,0)=1 AND", 1)
	}
	var out ProcCounts
	err := r.db.QueryRowContext(ctx, q).Scan(
		&out.Ativos, &out.Deferidos, &out.Fluxo, &out.Faturamento, &out.Concluidos, &out.Indeferidos,
	)
	return out, err
}

// ============== Status counts (triagem da requisição) =================
func (r *DashboardRepo) StatusCounts(ctx context.Context) (StatusCounts, error) {
	q := `
	SELECT
  SUM(LOWER(COALESCE(status,'')) REGEXP 'nova requis') AS pendente,
	  SUM(LOWER(COALESCE(status,'')) REGEXP 'analis|triag') AS em_analise,
	  SUM(LOWER(COALESCE(status,'')) REGEXP 'aprov|proced') AS aprovado,
	  SUM(LOWER(COALESCE(status,'')) REGEXP 'rejeit|improced') AS rejeitado
	FROM FT_REQUISICOES;
	`
	var out StatusCounts
	err := r.db.QueryRowContext(ctx, q).Scan(
		&out.Pendente, &out.EmAnalise, &out.Aprovado, &out.Rejeitado,
	)
	return out, err
}

// ============== Créditos (simples/dobro) =================
func (r *DashboardRepo) CreditosTotals(ctx context.Context) (CreditosTotal, error) {
	q := `
	SELECT
	  COALESCE(SUM(credito_simples),0) AS simples,
	  COALESCE(SUM(credito_dobro),0)   AS dobro
	FROM FT_DEFERIMENTOS;
	`
	var out CreditosTotal
	var s, d sql.NullFloat64
	err := r.db.QueryRowContext(ctx, q).Scan(&s, &d)
	out.Simples = s.Float64
	out.Dobro = d.Float64
	return out, err
}

// ============== Tempo médio por etapa =================
// Dwell time por etapa: tempo até a PRÓXIMA movimentação.
// Remove rótulos genéricos tipo "Histórico" para não poluir o ranking.
func (r *DashboardRepo) TempoMedioPorEtapa(ctx context.Context) ([]TempoMedioEtapaRow, error) {
	q := `
	WITH movs AS (
	  SELECT
	    id_requisicao,
	    data_movimentacao,
	    COALESCE(NULLIF(etapa_nova,''), etapa_anterior) AS etapa,
	    LEAD(data_movimentacao) OVER (PARTITION BY id_requisicao ORDER BY data_movimentacao) AS prox_data
	  FROM FT_HISTORICO_MOVIMENTACOES
	  WHERE data_movimentacao IS NOT NULL
	),
	dwell AS (
	  SELECT
	    etapa,
	    TIMESTAMPDIFF(HOUR, data_movimentacao, prox_data)/24.0 AS dias
	  FROM movs
	  WHERE prox_data IS NOT NULL AND etapa IS NOT NULL
	)
	SELECT etapa, AVG(dias) AS dias
	FROM dwell
	GROUP BY etapa
	HAVING etapa <> '' AND LOWER(etapa) NOT REGEXP '^hist'
	ORDER BY dias DESC
	LIMIT 20;
	`
	rows, err := r.db.QueryContext(ctx, q)
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
	// pega última movimentação por processo e calcula dias parados
	q := `
	WITH ult AS (
	  SELECT id_requisicao,
	         MAX(data_movimentacao) AS ult
	  FROM FT_HISTORICO_MOVIMENTACOES
	  GROUP BY id_requisicao
	),
	age AS (
	  SELECT
	    DATEDIFF(CURDATE(), DATE(ult)) AS dias
	  FROM ult
	)
	SELECT
	  SUM(dias BETWEEN 0 AND 7)        AS b0_7,
	  SUM(dias BETWEEN 8 AND 15)       AS b8_15,
	  SUM(dias BETWEEN 16 AND 30)      AS b16_30,
	  SUM(dias >= 31)                  AS b31mais
	FROM age;
	`
	var out AgingBuckets
	err := r.db.QueryRowContext(ctx, q).Scan(
		&out.B0_7, &out.B8_15, &out.B16_30, &out.B31Mais,
	)
	return out, err
}

// ============== Tendência (30d) =================
func (r *DashboardRepo) Tendencia30d(ctx context.Context, f DashFilters) ([]TendenciaRow, error) {
	q := `
	SELECT DATE(h.data_movimentacao) AS d, COUNT(*) AS tot
	  FROM FT_HISTORICO_MOVIMENTACOES h
	LEFT JOIN FT_PROCESSOS p     ON p.id_processo = h.id_requisicao
	LEFT JOIN FT_REQUISICOES rqs ON rqs.id_requisicao = h.id_requisicao
	 WHERE 1=1`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(h.data_movimentacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q += " AND h.data_movimentacao >= CURDATE() - INTERVAL 30 DAY"
	}
	if !f.IncluirSuspensos {
		q += " AND COALESCE(p.suspenso,0)=0"
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
	rows, err := r.db.QueryContext(ctx, q, args...)
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
	LEFT JOIN FT_PROCESSOS p     ON p.id_processo = h.id_requisicao
	LEFT JOIN FT_REQUISICOES rqs ON rqs.id_requisicao = h.id_requisicao
	 WHERE 1=1`
	args := []any{}
	if f.Ini != nil && f.Fim != nil {
		q += " AND DATE(h.data_movimentacao) BETWEEN ? AND ?"
		args = append(args, f.Ini.Format("2006-01-02"), f.Fim.Format("2006-01-02"))
	} else {
		q += " AND h.data_movimentacao >= CURDATE() - INTERVAL 7 DAY"
	}
	if !f.IncluirSuspensos {
		q += " AND COALESCE(p.suspenso,0)=0"
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
	rows, err := r.db.QueryContext(ctx, q, args...)
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

// ============== Movimentações por período =================
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
      h.id_requisicao,
      COALESCE(u.nome_usuario, '') AS usuario_nome,
      h.etapa_anterior,
      h.etapa_nova,
      h.comentario
    FROM FT_HISTORICO_MOVIMENTACOES h
    LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
    WHERE DATE(h.data_movimentacao) BETWEEN ? AND ?
    ORDER BY h.data_movimentacao DESC, h.id_requisicao DESC
    LIMIT 5000;
    `
	rows, err := r.db.QueryContext(ctx, q, ini.Format("2006-01-02"), fim.Format("2006-01-02"))
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
	q := `
      SELECT DATE_FORMAT(data_criacao, '%x-W%v') AS lbl, COUNT(*) AS tot
      FROM FT_REQUISICOES
      WHERE data_criacao >= CURDATE() - INTERVAL 180 DAY
      GROUP BY DATE_FORMAT(data_criacao, '%x-W%v')
      ORDER BY MIN(data_criacao) DESC
      LIMIT ?;
    `
	rows, err := r.db.QueryContext(ctx, q, limit)
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
	q := `
      SELECT DATE_FORMAT(data_criacao, '%Y-%m') AS lbl, COUNT(*) AS tot
      FROM FT_REQUISICOES
      WHERE data_criacao >= CURDATE() - INTERVAL 365 DAY
      GROUP BY DATE_FORMAT(data_criacao, '%Y-%m')
      ORDER BY MIN(data_criacao) DESC
      LIMIT ?;
    `
	rows, err := r.db.QueryContext(ctx, q, limit)
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
	q := `
      SELECT concessionaria AS lbl, COALESCE(SUM(ressarcimento_estimado),0) AS tot
      FROM FT_REQUISICOES
      GROUP BY concessionaria
      ORDER BY tot DESC
      LIMIT ?;
    `
	rows, err := r.db.QueryContext(ctx, q, limit)
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
	q := `
      SELECT COALESCE(NULLIF(cliente,''), NULLIF(razao_social_fatura,''), 'N/A') AS lbl,
             COALESCE(SUM(ressarcimento_estimado),0) AS tot
      FROM FT_REQUISICOES
      GROUP BY COALESCE(NULLIF(cliente,''), NULLIF(razao_social_fatura,''), 'N/A')
      ORDER BY tot DESC
      LIMIT ?;
    `
	rows, err := r.db.QueryContext(ctx, q, limit)
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
	q := `
      SELECT LOWER(TRIM(dc.nome)) AS lbl, COUNT(*) AS tot
      FROM FT_HISTORICO_CANAIS hc
      JOIN DM_CANAIS_COMUNICACAO dc ON dc.id_canal = hc.id_canal
      JOIN FT_HISTORICO_MOVIMENTACOES h ON h.id_historico = hc.id_historico
      WHERE h.data_movimentacao >= NOW() - INTERVAL 30 DAY
      GROUP BY LOWER(TRIM(dc.nome))
      ORDER BY tot DESC;
    `
	rows, err := r.db.QueryContext(ctx, q)
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
      WHERE COALESCE(p.descartado,0)=0
    GROUP BY COALESCE(u.nome_usuario, CONCAT('ID ', p.id_responsavel))
      ORDER BY tot DESC
      LIMIT ?;
    `
	// filtros
	if !f.IncluirSuspensos {
		q = strings.Replace(q, "WHERE COALESCE(p.descartado,0)=0", "WHERE COALESCE(p.descartado,0)=0 AND COALESCE(p.suspenso,0)=0", 1)
	}
	if f.ApenasRelevantes {
		q = strings.Replace(q, "WHERE COALESCE(p.descartado,0)=0", "WHERE COALESCE(p.descartado,0)=0 AND COALESCE(p.relevancia,0)=1", 1)
	}
	rows, err := r.db.QueryContext(ctx, q, limit)
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
	rows, err := r.db.QueryContext(ctx, q)
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
        SELECT h.id_requisicao,
               h.data_movimentacao,
               LAG(h.data_movimentacao) OVER (PARTITION BY h.id_requisicao ORDER BY h.data_movimentacao) AS prev_mov
          FROM FT_HISTORICO_MOVIMENTACOES h
          JOIN ids i ON i.id_processo = h.id_requisicao
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
		q = strings.Replace(q, "WHERE 1=1\n      ), mov", "WHERE 1=1 AND COALESCE(p.suspenso,0)=0\n      ), mov", 1)
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
	err = r.db.QueryRowContext(ctx, q, args...).Scan(&on, &lt)
	if err != nil {
		return 0, 0, err
	}
	return on.Int64, lt.Int64, nil
}
