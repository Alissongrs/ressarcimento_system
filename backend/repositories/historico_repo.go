package repositories

import (
	"context"
	"database/sql"
	"time"
)

// HistoricoRow representa uma linha de histórico já com o CSV de canais agregado.
type HistoricoRow struct {
	IDHistorico         int64
	IDRequisicao        int64
	IDUsuarioGestor     sql.NullInt64
	UsuarioNome         sql.NullString
	StatusAnterior      sql.NullString
	StatusNovo          sql.NullString
	EtapaAnterior       sql.NullString
	EtapaNova           sql.NullString
	SubEtapa            sql.NullString
	RelevanciaAnterior  sql.NullBool
	RelevanciaNova      sql.NullBool
	Comentario          sql.NullString
	JustificativaAtraso sql.NullString
	DataMovimentacao    time.Time
	CanaisCSV           sql.NullString
}

type HistoricoRepo struct {
	db *sql.DB
}

func NewHistoricoRepo(db *sql.DB) *HistoricoRepo {
	return &HistoricoRepo{db: db}
}

// GetByRequisicaoID retorna o histórico completo (com canais agregados) de uma requisição/processo.
func (r *HistoricoRepo) GetByRequisicaoID(ctx context.Context, idRequisicao int64) ([]HistoricoRow, error) {
	const q = `
SELECT
  h.id_historico,
  h.id_requisicao,
  h.id_usuario_gestor,
  u.nome_usuario AS usuario_nome,
  h.status_anterior,
  h.status_novo,
  h.etapa_anterior,
  h.etapa_nova,
  h.sub_etapa,
  h.relevancia_anterior,
  h.relevancia_nova,
  h.comentario,
  h.justificativa_atraso,
  h.data_movimentacao,
  GROUP_CONCAT(LOWER(TRIM(dc.nome)) ORDER BY dc.nome SEPARATOR ',') AS canais_csv
FROM FT_HISTORICO_MOVIMENTACOES h
LEFT JOIN DM_USUARIO u          ON u.id_usuario = h.id_usuario_gestor
LEFT JOIN FT_HISTORICO_CANAIS hc ON hc.id_historico = h.id_historico
LEFT JOIN DM_CANAIS_COMUNICACAO dc ON dc.id_canal = hc.id_canal
WHERE h.id_requisicao = ?
GROUP BY
  h.id_historico, h.id_requisicao, h.id_usuario_gestor, u.nome_usuario,
  h.status_anterior, h.status_novo,
  h.etapa_anterior, h.etapa_nova, h.sub_etapa,
  h.relevancia_anterior, h.relevancia_nova,
  h.comentario, h.justificativa_atraso, h.data_movimentacao
ORDER BY h.data_movimentacao DESC, h.id_historico DESC;
`
	rows, err := r.db.QueryContext(ctx, q, idRequisicao)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]HistoricoRow, 0, 64)
	for rows.Next() {
		var h HistoricoRow
		if err := rows.Scan(
			&h.IDHistorico,
			&h.IDRequisicao,
			&h.IDUsuarioGestor,
			&h.UsuarioNome,
			&h.StatusAnterior,
			&h.StatusNovo,
			&h.EtapaAnterior,
			&h.EtapaNova,
			&h.SubEtapa,
			&h.RelevanciaAnterior,
			&h.RelevanciaNova,
			&h.Comentario,
			&h.JustificativaAtraso,
			&h.DataMovimentacao,
			&h.CanaisCSV,
		); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// UltimasDatasMovimentacaoMap retorna um mapa id_requisicao -> MAX(data_movimentacao).
// Útil para enriquecer cards/kanban sem depender de uma VIEW.
func (r *HistoricoRepo) UltimasDatasMovimentacaoMap(ctx context.Context) (map[int64]time.Time, error) {
	const q = `
SELECT id_requisicao, MAX(data_movimentacao) AS dt
FROM FT_HISTORICO_MOVIMENTACOES
GROUP BY id_requisicao;
`
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[int64]time.Time, 256)
	for rows.Next() {
		var id int64
		var dt sql.NullTime
		if err := rows.Scan(&id, &dt); err != nil {
			return nil, err
		}
		if dt.Valid {
			out[id] = dt.Time
		}
	}
	return out, rows.Err()
}

// EnsureViewUltimoHistorico cria (ou recria) a VIEW VW_ULTIMO_HISTORICO, que traz a última data por requisição.
// Se preferir não usar VIEW, troque no seu SELECT pelo subselect equivalente (veja comentário no topo do arquivo).
func (r *HistoricoRepo) EnsureViewUltimoHistorico(ctx context.Context) error {
	const createView = `
CREATE OR REPLACE VIEW VW_ULTIMO_HISTORICO AS
SELECT
  h.id_requisicao,
  MAX(h.data_movimentacao) AS data_movimentacao
FROM FT_HISTORICO_MOVIMENTACOES h
GROUP BY h.id_requisicao;
`
	_, err := r.db.ExecContext(ctx, createView)
	return err
}
