package repositories

import (
	"context"
	"database/sql"
	"time"

	"ressarcimento-backend/models"
)

type ProcessosRepository interface {
	ListarKanbanFast(ctx context.Context) ([]models.ProcessoKanban, error)
	ListarSuspensos(ctx context.Context, limit, offset int) ([]models.ProcessoKanban, error)
}

type ProcessosRepo struct {
	DB *sql.DB
}

func NewProcessosRepo(db *sql.DB) *ProcessosRepo {
	return &ProcessosRepo{DB: db}
}

const sqlKanbanFast = `
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
ORDER BY kc.ordem, COALESCE(vh.data_movimentacao, p.ultima_atualizacao) DESC;
`

func (r *ProcessosRepo) ListarKanbanFast(ctx context.Context) ([]models.ProcessoKanban, error) {
	rows, err := r.DB.QueryContext(ctx, sqlKanbanFast)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.ProcessoKanban, 0, 256)

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

		out = append(out, models.ProcessoKanban{
			ColunaKanban:    coluna,
			ID:              id,
			IdColunaKanban:  idColuna,
			IdEtapaProcesso: idEtapa,
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
	rows, err := r.DB.QueryContext(ctx, sqlSuspensos, limit, offset)
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

		out = append(out, models.ProcessoKanban{
			ColunaKanban:    coluna,
			ID:              id,
			IdColunaKanban:  idColuna,
			IdEtapaProcesso: idEtapa,
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
