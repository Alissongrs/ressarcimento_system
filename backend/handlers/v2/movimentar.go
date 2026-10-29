package v2

import (
	"context"
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// MovimentarRequest é o body do POST /api/v2/processos/:id/movimentar.
type MovimentarRequest struct {
	EtapaID             int    `json:"etapa_id"`
	InstanciaID         *int   `json:"instancia_id"`
	StatusID            int    `json:"status_id"`
	AprovacaoID         *int   `json:"aprovacao_id"`
	Comentario          string `json:"comentario"`
	JustificativaAtraso string `json:"justificativa_atraso"`
	CanalIDs            []int  `json:"canal_ids"` // FT_HISTORICO_CANAIS (N:N com DM_CANAIS_COMUNICACAO)
}

// Movimentar — POST /api/v2/processos/:id/movimentar
//
// 1. Lê snapshot atual
// 2. Valida transição (etapa adjacente ou Encerramento com aprovação)
// 3. Insere linha em FT_HISTORICO_MOVIMENTACOES (de/para)
// 4. Atualiza FT_PROCESSOS (campos *_atual + data_ultima_movimentacao)
// 5. Retorna detalhes do processo atualizado
func Movimentar(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	var req MovimentarRequest
	if !bindJSON(c, &req) {
		return
	}
	if req.EtapaID <= 0 || req.StatusID <= 0 {
		apiError(c, http.StatusBadRequest, "CAMPO_OBRIGATORIO",
			"etapa_id e status_id são obrigatórios", nil)
		return
	}

	// Snapshot atual. Se o processo ainda não existe, é o fluxo "Criar processo" da triagem:
	// cria a linha em FT_PROCESSOS a partir da requisição (id do processo = id da requisição) e segue.
	snap, err := loadSnapshot(c.Request.Context(), db, id)
	if err != nil {
		if !criarProcessoDeRequisicao(c.Request.Context(), db, id) {
			apiError(c, http.StatusNotFound, "PROCESSO_NAO_ENCONTRADO", err.Error(), nil)
			return
		}
		snap, err = loadSnapshot(c.Request.Context(), db, id)
		if err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "criar processo: "+err.Error(), nil)
			return
		}
	}

	idUserV2 := resolverUsuarioV2(c, db)

	if err := MovimentarCore(c.Request.Context(), db, id, req, idUserV2); err != nil {
		switch err {
		case ErrEtapaTerminal:
			apiError(c, http.StatusUnprocessableEntity, err.Error(), "Processo já está em Encerramento (etapa terminal)",
				gin.H{"etapa_atual": snap.IDEtapaAtual, "etapa_solicitada": req.EtapaID})
		case ErrEncerramentoSemAprov:
			apiError(c, http.StatusUnprocessableEntity, err.Error(), "Encerramento exige aprovação (Deferido ou Indeferido)",
				gin.H{"etapa_atual": snap.IDEtapaAtual, "etapa_solicitada": req.EtapaID})
		case ErrEtapaPularNaoPermitido:
			apiError(c, http.StatusUnprocessableEntity, err.Error(), "Não é permitido pular etapas (transição deve ser adjacente)",
				gin.H{"etapa_atual": snap.IDEtapaAtual, "etapa_solicitada": req.EtapaID})
		default:
			apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		}
		return
	}

	// Retorna snapshot atualizado (mesmo shape do GET /processos/:id)
	det, err := loadProcessoDetalhes(c.Request.Context(), db, id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "reload: "+err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, det)
}

// MovimentarCore é o NÚCLEO reutilizável da movimentação (sem gin), usado tanto
// pelo handler HTTP quanto pelo executor autônomo (op "movimentar"). Lê o snapshot
// atual, valida a transição (adjacência / Conciliação / Encerramento com aprovação)
// e, numa ÚNICA transação, grava a linha em FT_HISTORICO_MOVIMENTACOES (de→para) e
// atualiza FT_PROCESSOS. Assim status/etapa NUNCA dessincronizam do histórico — os
// dois são gravados juntos. idUser=0 grava id_usuario_gestor NULL.
func MovimentarCore(ctx context.Context, db *sql.DB, id int, req MovimentarRequest, idUser int) error {
	_, err := MovimentarCoreHist(ctx, db, id, req, idUser)
	return err
}

// MovimentarCoreHist é o MovimentarCore que também devolve o id da linha gravada em
// FT_HISTORICO_MOVIMENTACOES — o executor autônomo usa p/ registrar o backup (reverter).
func MovimentarCoreHist(ctx context.Context, db *sql.DB, id int, req MovimentarRequest, idUser int) (int64, error) {
	snap, err := loadSnapshot(ctx, db, id)
	if err != nil {
		return 0, err
	}

	// Conciliação (etapa 3): congela a aprovação em Deferido (id=1) — é o desfecho da etapa.
	if req.EtapaID == 3 {
		def := 1
		req.AprovacaoID = &def
	}

	if vErr := validarTransicao(snap.IDEtapaAtual, req.EtapaID, req.AprovacaoID); vErr != nil {
		return 0, vErr
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	// Insere FT_HISTORICO_MOVIMENTACOES — driver MySQL aceita sql.NullInt64 direto (resolve pra NULL quando inválido)
	res, err := tx.ExecContext(ctx, `
INSERT INTO FT_HISTORICO_MOVIMENTACOES (
  id_processo, id_usuario_gestor,
  id_etapa_anterior, id_instancia_anterior, id_status_anterior, id_aprovacao_anterior,
  id_etapa_nova, id_instancia_nova, id_status_novo, id_aprovacao_nova,
  tipo_movimentacao, comentario, justificativa_atraso
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id,
		nilUser(idUser),
		snap.IDEtapaAtual, snap.IDInstanciaAtual, snap.IDStatusAtual, snap.IDAprovacaoAtual,
		req.EtapaID, nilInt2(req.InstanciaID), req.StatusID, nilInt2(req.AprovacaoID),
		"manual", nullableStr(req.Comentario), nullableStr(req.JustificativaAtraso),
	)
	if err != nil {
		return 0, err
	}
	idHistorico, _ := res.LastInsertId()

	// Insere canais (N:N) — uma movimentação pode ter múltiplos canais
	if len(req.CanalIDs) > 0 {
		seen := map[int]bool{}
		for _, ch := range req.CanalIDs {
			if ch <= 0 || seen[ch] {
				continue
			}
			seen[ch] = true
			if _, err := tx.ExecContext(ctx,
				"INSERT IGNORE INTO FT_HISTORICO_CANAIS (id_historico, id_canal) VALUES (?, ?)",
				idHistorico, ch); err != nil {
				return 0, err
			}
		}
	}

	// Atualiza FT_PROCESSOS
	if _, err := tx.ExecContext(ctx, `
UPDATE FT_PROCESSOS SET
  id_etapa_atual = ?,
  id_instancia_atual = ?,
  id_status_atual = ?,
  id_aprovacao_atual = ?,
  ultima_atualizacao = CURRENT_TIMESTAMP
WHERE id_processo = ?`,
		req.EtapaID, nilInt2(req.InstanciaID), req.StatusID, nilInt2(req.AprovacaoID), id,
	); err != nil {
		return 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return idHistorico, nil
}

// nilUser converte 0 → NULL pra coluna id_usuario.
func nilUser(idV2 int) interface{} {
	if idV2 == 0 {
		return nil
	}
	return idV2
}
