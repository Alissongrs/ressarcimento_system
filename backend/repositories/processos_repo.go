package repositories

import (
	"context"
	"database/sql"
	"time"

	"ressarcimento-backend/models"

	"gorm.io/gorm"
)

type ProcessosRepository interface {
	ListarKanbanFast(ctx context.Context, limit int, coluna string) ([]models.ProcessoKanban, error)
	ListarSuspensos(ctx context.Context, limit, offset int) ([]models.ProcessoKanban, error)
}

type ProcessosRepo struct {
	DB *gorm.DB
}

func NewProcessosRepo(db *gorm.DB) *ProcessosRepo {
	return &ProcessosRepo{DB: db}
}

const sqlKanbanFast = `
SELECT
  CASE
    WHEN p.id_etapa_processo = 10
      OR LOWER(TRIM(p.etapa)) IN ('concluido','concluídos','concluidos')
      OR LOWER(TRIM(COALESCE(p.nome_coluna,''))) IN ('concluido','concluídos','concluidos')
      OR p.id_coluna = 5
    THEN 'Concluídos'
    WHEN p.id_etapa_processo = 11 OR LOWER(TRIM(p.etapa)) IN ('indeferido','indeferidos') THEN 'Indeferidos'
    WHEN fat.has_faturamento = 1
      OR (
        fr.has_fluxo = 1
        AND (
          LOWER(TRIM(COALESCE(p.etapa,''))) LIKE 'enviado ao financeiro%'
          OR LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado ao financeiro%'
        )
        AND LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado%'
      )
    THEN 'Faturamento'
    WHEN fr.has_fluxo = 1 THEN 'Fluxo de Ressarcimento'
    WHEN def.has_defer_data = 1 THEN 'Deferidos'
    ELSE COALESCE(p.nome_coluna, 'Ativos')
  END AS coluna_kanban,
  CASE
    WHEN p.id_etapa_processo = 10
      OR LOWER(TRIM(p.etapa)) IN ('concluido','concluídos','concluidos')
      OR LOWER(TRIM(COALESCE(p.nome_coluna,''))) IN ('concluido','concluídos','concluidos')
      OR p.id_coluna = 5
    THEN 'Concluídos'
    WHEN p.id_etapa_processo = 11 OR LOWER(TRIM(p.etapa)) IN ('indeferido','indeferidos') THEN 'Indeferidos'
    WHEN fat.has_faturamento = 1
      OR (
        fr.has_fluxo = 1
        AND (
          LOWER(TRIM(COALESCE(p.etapa,''))) LIKE 'enviado ao financeiro%'
          OR LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado ao financeiro%'
        )
        AND LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado%'
      )
    THEN 'Faturamento'
    WHEN fr.has_fluxo = 1 THEN 'Fluxo de Ressarcimento'
    WHEN def.has_defer_data = 1 THEN 'Deferidos'
    ELSE COALESCE(p.nome_coluna, 'Ativos')
  END AS nome_coluna,
  CASE
    WHEN p.id_etapa_processo = 10
      OR LOWER(TRIM(p.etapa)) IN ('concluido','concluídos','concluidos')
      OR LOWER(TRIM(COALESCE(p.nome_coluna,''))) IN ('concluido','concluídos','concluidos')
      OR p.id_coluna = 5
    THEN 5
    WHEN p.id_etapa_processo = 11 OR LOWER(TRIM(p.etapa)) IN ('indeferido','indeferidos') THEN 6
    WHEN fat.has_faturamento = 1
      OR (
        fr.has_fluxo = 1
        AND (
          LOWER(TRIM(COALESCE(p.etapa,''))) LIKE 'enviado ao financeiro%'
          OR LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado ao financeiro%'
        )
        AND LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado%'
      )
    THEN 4
    WHEN fr.has_fluxo = 1 THEN 3
    WHEN def.has_defer_data = 1 THEN 2
    ELSE COALESCE(p.id_coluna, 1)
  END AS id_coluna,
  p.id_etapa_processo AS id_etapa_processo,
  p.etapa             AS etapa_nome,
  p.id_processo       AS id,
  r.uc                AS uc,
  r.cliente           AS cliente,
  r.concessionaria    AS concessionaria,
  r.ressarcimento_estimado AS valor_estimado,
  def_raw.credito_simples AS credito_simples,
  def_raw.credito_dobro   AS credito_dobro,
  DATE_FORMAT(def_raw.data_procedencia, '%Y-%m-%d')   AS data_simples,
  DATE_FORMAT(def_raw.data_credito_dobro, '%Y-%m-%d') AS data_dobro,
  def_raw.repasse_simples AS repasse_simples,
  def_raw.repasse_dobro   AS repasse_dobro,
  (SELECT COUNT(1)
     FROM FT_ALERTAS a
    WHERE a.id_processo = p.id_processo
      AND a.lido = 0) AS alertas_count,
  p.sub_etapa         AS sub_etapa,
  p.relevancia        AS relevancia,
  COALESCE(
    p.suspenso,
    CASE WHEN LOWER(COALESCE(p.sub_etapa,'')) = 'suspenso' THEN 1 ELSE 0 END
  ) AS suspenso,
  p.data_alerta        AS data_alerta,
  p.ultima_atualizacao AS ultima_atualizacao,
  vh.data_movimentacao AS data_ultima_movimentacao
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES r
  ON r.id_requisicao = p.id_processo
LEFT JOIN (
  SELECT
    id_processo,
    MAX(CASE
      WHEN data_procedencia IS NOT NULL OR data_credito_dobro IS NOT NULL
      THEN 1 ELSE 0 END) AS has_defer_data,
    MAX(CASE
      WHEN credito_simples IS NOT NULL OR credito_dobro IS NOT NULL
        OR repasse_simples IS NOT NULL OR repasse_dobro IS NOT NULL
        OR data_procedencia IS NOT NULL OR data_credito_dobro IS NOT NULL
      THEN 1 ELSE 0 END) AS has_defer
  FROM FT_DEFERIMENTOS
  GROUP BY id_processo
) def
  ON def.id_processo = p.id_processo
LEFT JOIN FT_DEFERIMENTOS def_raw
  ON def_raw.id_processo = p.id_processo
LEFT JOIN (
  SELECT
    id_processo,
    MAX(CASE
      WHEN valor IS NOT NULL
        OR data_devolucao IS NOT NULL
        OR data_envio_financeiro IS NOT NULL
        OR forma_devolucao IS NOT NULL
        OR simples = 1 OR dobro = 1 OR simples_dobro = 1
      THEN 1 ELSE 0 END) AS has_fluxo
  FROM FT_FLUXO_RESSARCIMENTO
  GROUP BY id_processo
) fr
  ON fr.id_processo = p.id_processo
LEFT JOIN (
  SELECT
    id_processo,
    MAX(CASE
      WHEN (numero_nf IS NOT NULL AND TRIM(numero_nf) <> '')
        OR data_emissao IS NOT NULL
        OR data_vencimento IS NOT NULL
        OR data_pagamento IS NOT NULL
        OR valor IS NOT NULL
      THEN 1 ELSE 0 END) AS has_faturamento
  FROM FT_FATURAMENTO
  GROUP BY id_processo
) fat
  ON fat.id_processo = p.id_processo
LEFT JOIN (
  SELECT
    id_requisicao,
    MAX(data_movimentacao) AS data_movimentacao
  FROM FT_HISTORICO_MOVIMENTACOES
  GROUP BY id_requisicao
) vh
  ON vh.id_requisicao = p.id_processo
ORDER BY
  CASE
    WHEN p.id_etapa_processo = 10
      OR LOWER(TRIM(p.etapa)) IN ('concluido','concluídos','concluidos')
      OR LOWER(TRIM(COALESCE(p.nome_coluna,''))) IN ('concluido','concluídos','concluidos')
      OR p.id_coluna = 5
    THEN 5
    WHEN p.id_etapa_processo = 11 OR LOWER(TRIM(p.etapa)) IN ('indeferido','indeferidos') THEN 6
    WHEN fat.has_faturamento = 1
      OR (
        fr.has_fluxo = 1
        AND (
          LOWER(TRIM(COALESCE(p.etapa,''))) LIKE 'enviado ao financeiro%'
          OR LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado ao financeiro%'
        )
        AND LOWER(TRIM(COALESCE(p.sub_etapa,''))) LIKE 'enviado%'
      )
    THEN 4
    WHEN fr.has_fluxo = 1 THEN 3
    WHEN def.has_defer_data = 1 THEN 2
    ELSE COALESCE(p.id_coluna, 1)
  END,
  p.ultima_atualizacao DESC
LIMIT ?;
`

func (r *ProcessosRepo) ListarKanbanFast(ctx context.Context, limit int, coluna string) ([]models.ProcessoKanban, error) {
	if limit <= 0 {
		limit = 100000
	}
	rows, err := r.DB.WithContext(ctx).Raw(sqlKanbanFast, limit).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.ProcessoKanban, 0, 256)

	for rows.Next() {
		var (
			coluna         string
			nomeColuna     sql.NullString
			idColuna       sql.NullInt64
			idEtapa        int
			etapaNome      sql.NullString
			id             int
			uc             sql.NullString
			cliente        sql.NullString
			concessionaria sql.NullString
			valor          sql.NullFloat64
			credSim        sql.NullFloat64
			credDob        sql.NullFloat64
			dataSimples    sql.NullString
			dataDobro      sql.NullString
			repSimples     sql.NullFloat64
			repDobro       sql.NullFloat64
			alertas        sql.NullInt64
			subEtapa       sql.NullString
			relevancia     sql.NullBool
			susp           sql.NullInt64
			dataAlerta     sql.NullTime
			ultAtual       sql.NullTime
			dataUltMov     sql.NullTime
		)

		if err := rows.Scan(
			&coluna,
			&nomeColuna,
			&idColuna,
			&idEtapa,
			&etapaNome,
			&id,
			&uc,
			&cliente,
			&concessionaria,
			&valor,
			&credSim,
			&credDob,
			&dataSimples,
			&dataDobro,
			&repSimples,
			&repDobro,
			&alertas,
			&subEtapa,
			&relevancia,
			&susp,
			&dataAlerta,
			&ultAtual,
			&dataUltMov,
		); err != nil {
			return nil, err
		}

		var (
			ucPtr, clientePtr, subPtr, concPtr *string
			ultAtualPtr, dataUltMovPtr         *time.Time
			dataAlertaPtr                      *time.Time
			nomeColPtr                         *string
			idColPtr                           *int
			dataSimplesPtr                     *string
			dataDobroPtr                       *string
		)
		if uc.Valid {
			v := uc.String
			ucPtr = &v
		}
		if cliente.Valid {
			v := cliente.String
			clientePtr = &v
		}
		if concessionaria.Valid {
			v := concessionaria.String
			concPtr = &v
		}
		if subEtapa.Valid {
			v := subEtapa.String
			subPtr = &v
		}

		if ultAtual.Valid {
			t := ultAtual.Time
			ultAtualPtr = &t
		}
		if dataUltMov.Valid {
			t := dataUltMov.Time
			dataUltMovPtr = &t
		}
		if dataAlerta.Valid {
			t := dataAlerta.Time
			dataAlertaPtr = &t
		}
		if nomeColuna.Valid {
			v := nomeColuna.String
			nomeColPtr = &v
		}
		if idColuna.Valid {
			v := int(idColuna.Int64)
			idColPtr = &v
		}
		if dataSimples.Valid {
			v := dataSimples.String
			dataSimplesPtr = &v
		}
		if dataDobro.Valid {
			v := dataDobro.String
			dataDobroPtr = &v
		}

		out = append(out, models.ProcessoKanban{
			ColunaKanban:    coluna,
			ID:              id,
			IdColuna:        idColPtr,
			IdEtapaProcesso: idEtapa,
			NomeColuna:      nomeColPtr,
			Etapa: func() *string {
				if etapaNome.Valid {
					v := etapaNome.String
					return &v
				}
				return nil
			}(),
			UC:             ucPtr,
			Cliente:        clientePtr,
			Concessionaria: concPtr,
			ValorEstimado: func() *float64 {
				if valor.Valid {
					v := valor.Float64
					return &v
				}
				return nil
			}(),
			CreditoSimples: func() *float64 {
				if credSim.Valid {
					v := credSim.Float64
					return &v
				}
				return nil
			}(),
			CreditoDobro: func() *float64 {
				if credDob.Valid {
					v := credDob.Float64
					return &v
				}
				return nil
			}(),
			DataSimples: dataSimplesPtr,
			DataDobro:   dataDobroPtr,
			RepasseSimples: func() *float64 {
				if repSimples.Valid {
					v := repSimples.Float64
					return &v
				}
				return nil
			}(),
			RepasseDobro: func() *float64 {
				if repDobro.Valid {
					v := repDobro.Float64
					return &v
				}
				return nil
			}(),
			AlertasCount: func() *int {
				if alertas.Valid {
					v := int(alertas.Int64)
					return &v
				}
				return nil
			}(),
			SubEtapa:               subPtr,
			Relevancia:             (relevancia.Valid && relevancia.Bool),
			Suspenso:               func() *bool { v := (susp.Valid && susp.Int64 != 0); return &v }(),
			DataAlerta:             dataAlertaPtr,
			UltimaAtualizacao:      ultAtualPtr,
			DataUltimaMovimentacao: dataUltMovPtr,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

const sqlSuspensos = `
SELECT
  kc.nome_coluna                    AS coluna_kanban,
  kc.id_coluna                      AS id_coluna_kanban,
  e.id_etapa_processo               AS id_etapa_processo,
  e.etapa                           AS etapa_nome,
  p.id_processo                     AS id,
  r.uc                              AS uc,
  r.cliente                         AS cliente,
  r.concessionaria                  AS concessionaria,
  r.ressarcimento_estimado          AS valor_estimado,
  def.credito_simples               AS credito_simples,
  def.credito_dobro                 AS credito_dobro,
  (SELECT COUNT(1)
     FROM FT_ALERTAS a
    WHERE a.id_processo = p.id_processo
      AND a.lido = 0)               AS alertas_count,
  p.sub_etapa                       AS sub_etapa,
  p.relevancia                      AS relevancia,
  COALESCE(p.suspenso, CASE WHEN LOWER(COALESCE(p.sub_etapa,'')) = 'suspenso' THEN 1 ELSE 0 END) AS suspenso,
  p.data_alerta                     AS data_alerta,
  p.ultima_atualizacao              AS ultima_atualizacao,
  vh.data_movimentacao              AS data_ultima_movimentacao
FROM FT_PROCESSOS p
JOIN DM_ETAPAS_PROCESSO   e   ON e.id_etapa_processo = p.id_etapa_processo
JOIN DM_KANBAN_COLUNAS    kc  ON kc.id_coluna        = e.id_coluna_kanban
LEFT JOIN FT_REQUISICOES  r   ON r.id_requisicao     = p.id_processo
LEFT JOIN FT_DEFERIMENTOS def ON def.id_processo     = p.id_processo
LEFT JOIN (
    SELECT id_requisicao, MAX(data_movimentacao) AS data_movimentacao
      FROM FT_HISTORICO_MOVIMENTACOES
     GROUP BY id_requisicao
) vh ON vh.id_requisicao = p.id_processo
WHERE COALESCE(p.suspenso,0)=1
ORDER BY COALESCE(vh.data_movimentacao, p.ultima_atualizacao) DESC
LIMIT ? OFFSET ?;
`

func (r *ProcessosRepo) ListarSuspensos(ctx context.Context, limit, offset int) ([]models.ProcessoKanban, error) {
	rows, err := r.DB.WithContext(ctx).Raw(sqlSuspensos, limit, offset).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.ProcessoKanban, 0, limit)

	for rows.Next() {
		var (
			coluna         string
			idColuna       int
			idEtapa        int
			etapaNome      sql.NullString
			id             int
			uc             sql.NullString
			cliente        sql.NullString
			concessionaria sql.NullString
			valor          sql.NullFloat64
			credSim        sql.NullFloat64
			credDob        sql.NullFloat64
			alertas        sql.NullInt64
			subEtapa       sql.NullString
			relevancia     sql.NullBool
			susp           sql.NullInt64
			dataAlerta     sql.NullTime
			ultAtual       sql.NullTime
			dataUltMov     sql.NullTime
		)

		if err := rows.Scan(
			&coluna,
			&idColuna,
			&idEtapa,
			&etapaNome,
			&id,
			&uc,
			&cliente,
			&concessionaria,
			&valor,
			&credSim,
			&credDob,
			&alertas,
			&subEtapa,
			&relevancia,
			&susp,
			&dataAlerta,
			&ultAtual,
			&dataUltMov,
		); err != nil {
			return nil, err
		}

		var (
			ucPtr, clientePtr, subPtr, concPtr *string
			ultAtualPtr, dataUltMovPtr         *time.Time
			dataAlertaPtr                      *time.Time
			nomeColPtr                         *string
			idColPtr                           *int
		)
		if uc.Valid {
			v := uc.String
			ucPtr = &v
		}
		if cliente.Valid {
			v := cliente.String
			clientePtr = &v
		}
		if concessionaria.Valid {
			v := concessionaria.String
			concPtr = &v
		}
		if subEtapa.Valid {
			v := subEtapa.String
			subPtr = &v
		}
		if ultAtual.Valid {
			t := ultAtual.Time
			ultAtualPtr = &t
		}
		if dataUltMov.Valid {
			t := dataUltMov.Time
			dataUltMovPtr = &t
		}
		if dataAlerta.Valid {
			t := dataAlerta.Time
			dataAlertaPtr = &t
		}
		if coluna != "" {
			v := coluna
			nomeColPtr = &v
		}
		idColPtr = &idColuna

		out = append(out, models.ProcessoKanban{
			ColunaKanban:    coluna,
			ID:              id,
			IdColuna:        idColPtr,
			IdEtapaProcesso: idEtapa,
			NomeColuna:      nomeColPtr,
			Etapa: func() *string {
				if etapaNome.Valid {
					v := etapaNome.String
					return &v
				}
				return nil
			}(),
			UC:             ucPtr,
			Cliente:        clientePtr,
			Concessionaria: concPtr,
			ValorEstimado: func() *float64 {
				if valor.Valid {
					v := valor.Float64
					return &v
				}
				return nil
			}(),
			CreditoSimples: func() *float64 {
				if credSim.Valid {
					v := credSim.Float64
					return &v
				}
				return nil
			}(),
			CreditoDobro: func() *float64 {
				if credDob.Valid {
					v := credDob.Float64
					return &v
				}
				return nil
			}(),
			AlertasCount: func() *int {
				if alertas.Valid {
					v := int(alertas.Int64)
					return &v
				}
				return nil
			}(),
			SubEtapa:               subPtr,
			Relevancia:             (relevancia.Valid && relevancia.Bool),
			Suspenso:               func() *bool { v := (susp.Valid && susp.Int64 != 0); return &v }(),
			DataAlerta:             dataAlertaPtr,
			UltimaAtualizacao:      ultAtualPtr,
			DataUltimaMovimentacao: dataUltMovPtr,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
