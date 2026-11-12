package services

// ─────────────────────────────────────────────────────────────────────────────
// Status do processo: UM caminho só (melhoria 3, 12/11/2026).
//
// Regra: FT_HISTORICO_MOVIMENTACOES é a fonte da verdade; FT_PROCESSOS (etapa,
// instância, status, aprovação "atuais") é o espelho que a lista e o Kanban leem.
// Toda mudança de status passa por MudarStatusProcesso, que grava a movimentação
// e atualiza o espelho NA MESMA TRANSAÇÃO. Assim os dois não se separam mais.
//
// Para o estoque que já estava separado (e para pegar qualquer caminho esquecido),
// ListarDivergencias compara os dois e CorrigirDivergencia conserta um por um,
// sempre com backup em FT_STATUS_RECONCILIACAO. ChecarDivergenciasStatus roda
// todo dia e avisa os administradores enquanto houver diferença.
// ─────────────────────────────────────────────────────────────────────────────

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

// EstadoProcesso é o conjunto de campos "atuais" de FT_PROCESSOS que o histórico espelha.
// Ponteiro nil = "não mexer" (mantém o valor atual); para instância/aprovação, 0 = NULL.
type EstadoProcesso struct {
	Etapa     *int
	Instancia *int
	Status    *int
	Aprovacao *int
}

type estadoLido struct {
	Etapa, Instancia, Status, Aprovacao sql.NullInt64
	Suspenso                            int
}

func lerEstado(ctx context.Context, tx *sql.Tx, id int) (estadoLido, error) {
	var e estadoLido
	err := tx.QueryRowContext(ctx, `
SELECT id_etapa_atual, id_instancia_atual, id_status_atual, id_aprovacao_atual, COALESCE(suspenso,0)
  FROM FT_PROCESSOS WHERE id_processo = ? FOR UPDATE`, id).
		Scan(&e.Etapa, &e.Instancia, &e.Status, &e.Aprovacao, &e.Suspenso)
	return e, err
}

func nullIntPtr(p *int, atual sql.NullInt64) interface{} {
	if p == nil {
		if atual.Valid {
			return atual.Int64
		}
		return nil
	}
	if *p == 0 {
		return nil
	}
	return *p
}

func nullUser(idUser int) interface{} {
	if idUser <= 0 {
		return nil
	}
	return idUser
}

// MudarStatusProcesso grava a movimentação (anterior → novo) em FT_HISTORICO_MOVIMENTACOES e
// atualiza FT_PROCESSOS, na transação recebida. Se nada muda, não grava nada e devolve 0.
// Devolve o id da linha do histórico. tipo: 'movimentacao', 'admin', 'encerramento'…
func MudarStatusProcesso(ctx context.Context, tx *sql.Tx, id int, novo EstadoProcesso, idUser int, tipo, comentario string) (int64, error) {
	atual, err := lerEstado(ctx, tx, id)
	if err != nil {
		return 0, err
	}
	etapa := nullIntPtr(novo.Etapa, atual.Etapa)
	inst := nullIntPtr(novo.Instancia, atual.Instancia)
	status := nullIntPtr(novo.Status, atual.Status)
	aprov := nullIntPtr(novo.Aprovacao, atual.Aprovacao)
	if iguais(etapa, atual.Etapa) && iguais(inst, atual.Instancia) && iguais(status, atual.Status) && iguais(aprov, atual.Aprovacao) {
		return 0, nil
	}
	if strings.TrimSpace(tipo) == "" {
		tipo = "movimentacao"
	}
	res, err := tx.ExecContext(ctx, `
INSERT INTO FT_HISTORICO_MOVIMENTACOES
  (id_processo, id_usuario_gestor,
   id_etapa_anterior, id_etapa_nova, id_instancia_anterior, id_instancia_nova,
   id_status_anterior, id_status_novo, id_aprovacao_anterior, id_aprovacao_nova,
   comentario, data_movimentacao, tipo_movimentacao)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
		id, nullUser(idUser),
		nullOf(atual.Etapa), etapa, nullOf(atual.Instancia), inst,
		nullOf(atual.Status), status, nullOf(atual.Aprovacao), aprov,
		comentario, tipo)
	if err != nil {
		return 0, err
	}
	idHist, _ := res.LastInsertId()
	if _, err := tx.ExecContext(ctx, `
UPDATE FT_PROCESSOS
   SET id_etapa_atual = ?, id_instancia_atual = ?, id_status_atual = ?, id_aprovacao_atual = ?,
       data_movimentacao = NOW(), ultima_atualizacao = NOW()
 WHERE id_processo = ?`, etapa, inst, status, aprov, id); err != nil {
		return 0, err
	}
	return idHist, nil
}

func nullOf(n sql.NullInt64) interface{} {
	if n.Valid {
		return n.Int64
	}
	return nil
}

func iguais(v interface{}, n sql.NullInt64) bool {
	switch x := v.(type) {
	case nil:
		return !n.Valid
	case int:
		return n.Valid && n.Int64 == int64(x)
	case int64:
		return n.Valid && n.Int64 == x
	}
	return false
}

// ── Divergências FT_PROCESSOS × histórico ───────────────────────────────────

// Divergencia é um processo cujo espelho não bate com a última movimentação que
// trazia status/etapa. Só compara campo preenchido dos dois lados: movimentações
// antigas (importadas do sistema anterior) trazem status sem etapa, e isso não é erro.
type Divergencia struct {
	IDProcesso     int       `json:"id_processo"`
	Codigo         string    `json:"codigo"`
	Cliente        string    `json:"cliente"`
	Suspenso       bool      `json:"suspenso"`
	FTStatus       *int      `json:"ft_status"`
	FTStatusNome   string    `json:"ft_status_nome"`
	FTEtapa        *int      `json:"ft_etapa"`
	FTEtapaNome    string    `json:"ft_etapa_nome"`
	FTData         time.Time `json:"ft_data"` // quando FT_PROCESSOS mudou pela última vez
	HistID         int64     `json:"hist_id"`
	HistStatus     *int      `json:"hist_status"`
	HistStatusNome string    `json:"hist_status_nome"`
	HistEtapa      *int      `json:"hist_etapa"`
	HistEtapaNome  string    `json:"hist_etapa_nome"`
	HistInstancia  *int      `json:"hist_instancia"`
	HistData       time.Time `json:"hist_data"`
	HistTipo       string    `json:"hist_tipo"`
	HistComentario string    `json:"hist_comentario"`
	Sugestao       string    `json:"sugestao"` // "historico" = registrar no histórico o estado do processo; "processo" = atualizar o processo pelo histórico
	Motivo         string    `json:"motivo"`
}

const sqlDivergencias = `
WITH ult AS (
  SELECT h.id_processo, h.id_historico, h.id_status_novo, h.id_etapa_nova, h.id_instancia_nova,
         h.data_movimentacao, COALESCE(h.tipo_movimentacao,'') tipo, COALESCE(h.comentario,'') comentario,
         ROW_NUMBER() OVER (PARTITION BY h.id_processo ORDER BY h.data_movimentacao DESC, h.id_historico DESC) rn
    FROM FT_HISTORICO_MOVIMENTACOES h
   WHERE h.id_status_novo IS NOT NULL OR h.id_etapa_nova IS NOT NULL)
SELECT p.id_processo, COALESCE(p.codigo_publico,''), COALESCE(p.cliente,''), COALESCE(p.suspenso,0),
       p.id_status_atual, COALESCE(sp.nome,''), p.id_etapa_atual, COALESCE(ep.nome,''),
       COALESCE(GREATEST(COALESCE(p.data_movimentacao, p.ultima_atualizacao), COALESCE(p.ultima_atualizacao, p.data_movimentacao)), NOW()),
       u.id_historico, u.id_status_novo, COALESCE(sh.nome,''), u.id_etapa_nova, COALESCE(eh.nome,''), u.id_instancia_nova,
       u.data_movimentacao, u.tipo, LEFT(u.comentario, 160)
  FROM FT_PROCESSOS p
  JOIN ult u ON u.id_processo = p.id_processo AND u.rn = 1
  LEFT JOIN DM_STATUS_PROCESSO sp ON sp.id_status = p.id_status_atual
  LEFT JOIN DM_STATUS_PROCESSO sh ON sh.id_status = u.id_status_novo
  LEFT JOIN DM_ETAPAS ep ON ep.id_etapa = p.id_etapa_atual
  LEFT JOIN DM_ETAPAS eh ON eh.id_etapa = u.id_etapa_nova
 WHERE (u.id_status_novo IS NOT NULL AND p.id_status_atual IS NOT NULL AND u.id_status_novo <> p.id_status_atual)
    OR (u.id_etapa_nova  IS NOT NULL AND p.id_etapa_atual  IS NOT NULL AND u.id_etapa_nova  <> p.id_etapa_atual)
 ORDER BY u.data_movimentacao DESC`

// ListarDivergencias devolve os processos cujo espelho não bate com o histórico.
func ListarDivergencias(ctx context.Context, db *sql.DB) ([]Divergencia, error) {
	rows, err := db.QueryContext(ctx, sqlDivergencias)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Divergencia{}
	for rows.Next() {
		var d Divergencia
		var susp int
		var fts, fte, hs, he, hi sql.NullInt64
		if err := rows.Scan(&d.IDProcesso, &d.Codigo, &d.Cliente, &susp, &fts, &d.FTStatusNome, &fte, &d.FTEtapaNome, &d.FTData,
			&d.HistID, &hs, &d.HistStatusNome, &he, &d.HistEtapaNome, &hi, &d.HistData, &d.HistTipo, &d.HistComentario); err != nil {
			return nil, err
		}
		d.Suspenso = susp == 1
		d.FTStatus, d.FTEtapa, d.HistStatus, d.HistEtapa, d.HistInstancia = intPtr(fts), intPtr(fte), intPtr(hs), intPtr(he), intPtr(hi)
		d.Sugestao, d.Motivo = sugerirDirecao(d)
		out = append(out, d)
	}
	return out, rows.Err()
}

func intPtr(n sql.NullInt64) *int {
	if !n.Valid {
		return nil
	}
	v := int(n.Int64)
	return &v
}

// sugerirDirecao decide, pelas datas, qual lado está desatualizado:
//   - o processo mudou DEPOIS da última movimentação → alguém gravou status sem passar pelo
//     histórico: a correção é REGISTRAR no histórico o estado do processo ("historico");
//   - a movimentação é mais nova → o espelho ficou para trás: ATUALIZAR o processo ("processo").
//   - suspenso: o espelho preserva a suspensão de propósito; registrar no histórico.
func sugerirDirecao(d Divergencia) (string, string) {
	if d.Suspenso {
		return "historico", "processo suspenso: o espelho guarda a suspensão; registrar no histórico"
	}
	if d.FTData.After(d.HistData.Add(time.Second)) {
		return "historico", fmt.Sprintf("o processo mudou em %s, depois da última movimentação (%s): faltou gravar no histórico",
			d.FTData.Format("02/01/2006 15:04"), d.HistData.Format("02/01/2006 15:04"))
	}
	return "processo", fmt.Sprintf("a última movimentação (%s) é mais nova que o processo (%s): o espelho ficou para trás",
		d.HistData.Format("02/01/2006 15:04"), d.FTData.Format("02/01/2006 15:04"))
}

// CorrigirDivergencia aplica a correção de UM processo na direção pedida, com backup do
// estado anterior em FT_STATUS_RECONCILIACAO (o que era, o que ficou, quem, quando).
//   - "historico": insere no histórico uma movimentação com o estado atual do processo
//     (tipo 'reconciliacao'); FT_PROCESSOS não muda.
//   - "processo": copia etapa/instância/status da última movimentação para FT_PROCESSOS,
//     passando por MudarStatusProcesso (fica registrado no histórico também).
func CorrigirDivergencia(ctx context.Context, db *sql.DB, idProcesso int, direcao string, idUser int) error {
	todas, err := ListarDivergencias(ctx, db)
	if err != nil {
		return err
	}
	var d *Divergencia
	for i := range todas {
		if todas[i].IDProcesso == idProcesso {
			d = &todas[i]
			break
		}
	}
	if d == nil {
		return errors.New("processo não está divergente (já foi corrigido?)")
	}
	if direcao != "historico" && direcao != "processo" {
		return errors.New("direção inválida: use 'historico' ou 'processo'")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	antes, _ := json.Marshal(d)
	var idHist int64
	if direcao == "historico" {
		atual, err := lerEstado(ctx, tx, idProcesso)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `
INSERT INTO FT_HISTORICO_MOVIMENTACOES
  (id_processo, id_usuario_gestor, id_etapa_anterior, id_etapa_nova, id_instancia_anterior, id_instancia_nova,
   id_status_anterior, id_status_novo, id_aprovacao_anterior, id_aprovacao_nova, comentario, data_movimentacao, tipo_movimentacao)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'reconciliacao')`,
			idProcesso, nullUser(idUser),
			nullOf(d.histEtapaNull()), nullOf(atual.Etapa), nullOf(d.histInstNull()), nullOf(atual.Instancia),
			nullOf(d.histStatusNull()), nullOf(atual.Status), nil, nullOf(atual.Aprovacao),
			fmt.Sprintf("Reconciliação: estado do processo (%s / %s) registrado no histórico, que estava sem esta movimentação. %s",
				d.FTStatusNome, d.FTEtapaNome, d.Motivo))
		if err != nil {
			return err
		}
		idHist, _ = res.LastInsertId()
		// a movimentação de reconciliação passa a ser a última: data_movimentacao acompanha
		if _, err := tx.ExecContext(ctx, `UPDATE FT_PROCESSOS SET data_movimentacao = NOW() WHERE id_processo = ?`, idProcesso); err != nil {
			return err
		}
	} else {
		novo := EstadoProcesso{Etapa: d.HistEtapa, Status: d.HistStatus}
		if d.HistInstancia != nil {
			novo.Instancia = d.HistInstancia
		}
		idHist, err = MudarStatusProcesso(ctx, tx, idProcesso, novo, idUser, "reconciliacao",
			fmt.Sprintf("Reconciliação: processo atualizado pela última movimentação (%s / %s). %s", d.HistStatusNome, d.HistEtapaNome, d.Motivo))
		if err != nil {
			return err
		}
	}
	depois := map[string]interface{}{"direcao": direcao, "id_historico": idHist}
	dj, _ := json.Marshal(depois)
	if _, err := tx.ExecContext(ctx, `
INSERT INTO FT_STATUS_RECONCILIACAO (id_processo, direcao, antes_json, depois_json, id_usuario, criado_em)
VALUES (?, ?, ?, ?, ?, NOW())`, idProcesso, direcao, string(antes), string(dj), nullUser(idUser)); err != nil {
		return err
	}
	return tx.Commit()
}

func (d *Divergencia) histEtapaNull() sql.NullInt64  { return toNull(d.HistEtapa) }
func (d *Divergencia) histStatusNull() sql.NullInt64 { return toNull(d.HistStatus) }
func (d *Divergencia) histInstNull() sql.NullInt64   { return toNull(d.HistInstancia) }
func toNull(p *int) sql.NullInt64 {
	if p == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: int64(*p), Valid: true}
}

// ChecarDivergenciasStatus — rotina diária: conta as divergências e, se houver, avisa os
// administradores uma vez por dia (FT_ALERTAS), apontando para Tarefas do sistema.
func ChecarDivergenciasStatus() {
	db := getAppDB()
	if db == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	lista, err := ListarDivergencias(ctx, db)
	if err != nil {
		log.Printf("[status-reconciliacao] erro ao listar divergências: %v", err)
		return
	}
	log.Printf("[status-reconciliacao] %d processo(s) com status diferente do histórico", len(lista))
	if len(lista) == 0 {
		return
	}
	rows, err := db.QueryContext(ctx, `SELECT id_usuario FROM DM_USUARIO WHERE perfil = 'admin' AND usuario_ativo = 1`)
	if err != nil {
		return
	}
	var admins []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			admins = append(admins, id)
		}
	}
	rows.Close()
	msg := fmt.Sprintf("%d processo(s) com status diferente do histórico. Confira em Tarefas do sistema → Status × histórico.", len(lista))
	for _, uid := range admins {
		var n int
		_ = db.QueryRowContext(ctx, `SELECT COUNT(1) FROM FT_ALERTAS WHERE id_usuario = ? AND DATE(data_criacao) = CURRENT_DATE AND mensagem LIKE '%status diferente do histórico%'`, uid).Scan(&n)
		if n > 0 {
			continue
		}
		_, _ = db.ExecContext(ctx, `INSERT INTO FT_ALERTAS (id_usuario, id_processo, mensagem, lido, acknowledged, data_criacao, data_alerta)
VALUES (?, ?, ?, 0, 0, NOW(), CURRENT_DATE)`, uid, lista[0].IDProcesso, msg)
	}
}
