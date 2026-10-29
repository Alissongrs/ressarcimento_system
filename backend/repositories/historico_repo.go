package repositories

import (
	"context"
	"database/sql"
	"time"

	"gorm.io/gorm"
)

// HistoricoRow representa uma linha de histórico já com o CSV de canais agregado.
// V2: campos status/etapa que eram TEXTO viraram FKs em FT_HISTORICO_MOVIMENTACOES.
// Mantemos as colunas Go como sql.NullString por retrocompat — agora vêm dos nomes em DM_*.
type HistoricoRow struct {
	IDHistorico         int64
	IDRequisicao        int64 // V2: id_processo
	IDUsuarioGestor     sql.NullInt64
	UsuarioNome         sql.NullString
	StatusAnterior      sql.NullString
	StatusNovo          sql.NullString
	EtapaAnterior       sql.NullString
	EtapaNova           sql.NullString
	SubEtapa            sql.NullString // TODO V2: coluna sub_etapa não existe mais no histórico V2; valor virá vazio
	RelevanciaAnterior  sql.NullBool   // TODO V2: relevância não é mais registrada no histórico V2
	RelevanciaNova      sql.NullBool   // TODO V2: idem
	Comentario          sql.NullString
	JustificativaAtraso sql.NullString
	DataMovimentacao    time.Time
	CanaisCSV           sql.NullString
}

type HistoricoRepo struct {
	db *gorm.DB
}

func NewHistoricoRepo(db *gorm.DB) *HistoricoRepo {
	return &HistoricoRepo{db: db}
}

// GetByRequisicaoID retorna o histórico completo (com canais agregados) de uma requisição/processo.
// V2: id_requisicao virou id_processo; status/etapa viraram FK (resolvidos via DM_*).
func (r *HistoricoRepo) GetByRequisicaoID(ctx context.Context, idRequisicao int64) ([]HistoricoRow, error) {
	const q = `
SELECT
  h.id_historico,
  h.id_processo,
  h.id_usuario_gestor,
  u.nome_usuario AS usuario_nome,
  sa.nome  AS status_anterior,
  sn.nome  AS status_novo,
  ea.nome  AS etapa_anterior,
  en.nome  AS etapa_nova,
  NULL     AS sub_etapa,            -- TODO V2: histórico V2 não tem sub_etapa (virou id_status_*)
  NULL     AS relevancia_anterior,  -- TODO V2: relevância removida do histórico V2
  NULL     AS relevancia_nova,      -- TODO V2: idem
  h.comentario,
  h.justificativa_atraso,
  h.data_movimentacao,
  GROUP_CONCAT(LOWER(TRIM(dc.nome)) ORDER BY dc.nome SEPARATOR ',') AS canais_csv
FROM FT_HISTORICO_MOVIMENTACOES h
LEFT JOIN DM_USUARIO u           ON u.id_usuario  = h.id_usuario_gestor
LEFT JOIN DM_ETAPAS ea           ON ea.id_etapa   = h.id_etapa_anterior
LEFT JOIN DM_ETAPAS en           ON en.id_etapa   = h.id_etapa_nova
LEFT JOIN DM_STATUS_PROCESSO sa  ON sa.id_status  = h.id_status_anterior
LEFT JOIN DM_STATUS_PROCESSO sn  ON sn.id_status  = h.id_status_novo
LEFT JOIN FT_HISTORICO_CANAIS hc ON hc.id_historico = h.id_historico
LEFT JOIN DM_CANAIS_COMUNICACAO dc ON dc.id_canal = hc.id_canal
WHERE h.id_processo = ?
GROUP BY
  h.id_historico, h.id_processo, h.id_usuario_gestor, u.nome_usuario,
  sa.nome, sn.nome, ea.nome, en.nome,
  h.comentario, h.justificativa_atraso, h.data_movimentacao
ORDER BY h.data_movimentacao DESC, h.id_historico DESC;
`
	rows, err := r.db.Raw(q, idRequisicao).Rows()
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

// UltimasDatasMovimentacaoMap retorna um mapa id_processo -> MAX(data_movimentacao).
// Útil para enriquecer cards/kanban sem depender de uma VIEW.
func (r *HistoricoRepo) UltimasDatasMovimentacaoMap(ctx context.Context) (map[int64]time.Time, error) {
	const q = `
SELECT id_processo, MAX(data_movimentacao) AS dt
FROM FT_HISTORICO_MOVIMENTACOES
GROUP BY id_processo;
`
	rows, err := r.db.Raw(q).Rows()
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

// EnsureViewUltimoHistorico cria (ou recria) a VIEW VW_ULTIMO_HISTORICO, que traz a última data por processo.
func (r *HistoricoRepo) EnsureViewUltimoHistorico(ctx context.Context) error {
	const createView = `
CREATE OR REPLACE VIEW VW_ULTIMO_HISTORICO AS
SELECT
  h.id_processo,
  MAX(h.data_movimentacao) AS data_movimentacao
FROM FT_HISTORICO_MOVIMENTACOES h
GROUP BY h.id_processo;
`
	res := r.db.Exec(createView)
	return res.Error
}
