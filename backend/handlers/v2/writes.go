package v2

import (
	"database/sql"
	"math"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// FT_DEFERIMENTOS — POST /api/v2/processos/:id/deferimento  (cria/atualiza)
// ============================================================================

type DeferimentoRequest struct {
	AprovacaoID      *int     `json:"aprovacao_id"`      // opcional
	InstanciaID      *int     `json:"instancia_id"`      // opcional
	DataProcedencia  *string  `json:"data_procedencia"`  // opcional, YYYY-MM-DD
	CreditoSimples   *float64 `json:"credito_simples"`   // opcional
	CreditoDobro     *float64 `json:"credito_dobro"`     // opcional
	DataCreditoDobro *string  `json:"data_credito_dobro"`// opcional
	Observacoes      *string  `json:"observacoes"`       // opcional (persistida em FT_DEFERIMENTOS.observacao)
}

// SalvarDeferimento — POST /api/v2/processos/:id/deferimento
// Idempotente por id_processo (UNIQUE).
// NÃO movimenta o processo automaticamente — a movimentação (etapa/status/aprovação)
// é manual via /movimentar pelo usuário.
func SalvarDeferimento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	if !ensureProcesso(c, db, id) {
		return
	}

	var req DeferimentoRequest
	if !bindJSON(c, &req) {
		return
	}
	// Todos os campos são opcionais — salva o que tem. Aprovação fica pro Encerramento.

	tx, err := db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer func() { _ = tx.Rollback() }()

	// COALESCE(VALUES(x), x) preserva o valor existente quando o payload não trouxe
	// aquele campo (nil no request → NULL bindado). Especialmente crítico para
	// id_aprovacao/id_instancia — o form não envia esses; se sobrescrever com NULL,
	// destrói a marcação de Deferido que o /movimentar acabou de fazer.
	// observacao: FT_DEFERIMENTOS.observacao (coluna adicionada via migração).
	if _, err := tx.ExecContext(c.Request.Context(), `
INSERT INTO FT_DEFERIMENTOS (
  id_processo, id_aprovacao, id_instancia,
  data_procedencia, credito_simples, credito_dobro, data_credito_dobro, observacao
) VALUES (?,?,?,?,?,?,?,?)
ON DUPLICATE KEY UPDATE
  id_aprovacao       = COALESCE(VALUES(id_aprovacao),       id_aprovacao),
  id_instancia       = COALESCE(VALUES(id_instancia),       id_instancia),
  data_procedencia   = COALESCE(VALUES(data_procedencia),   data_procedencia),
  credito_simples    = COALESCE(VALUES(credito_simples),    credito_simples),
  credito_dobro      = COALESCE(VALUES(credito_dobro),      credito_dobro),
  data_credito_dobro = COALESCE(VALUES(data_credito_dobro), data_credito_dobro),
  observacao         = COALESCE(VALUES(observacao),         observacao)`,
		id, req.AprovacaoID, req.InstanciaID,
		req.DataProcedencia,
		req.CreditoSimples, req.CreditoDobro, req.DataCreditoDobro, req.Observacoes,
	); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	// Movimentação (etapa/status) é manual — NÃO toca esses campos.
	// Sync de valores + aprovação em FT_PROCESSOS: usar COALESCE(?, coluna) pra
	// preservar quando o payload não trouxe o campo (evita zerar aprov marcada
	// pelo /movimentar).
	if _, err := tx.ExecContext(c.Request.Context(), `
UPDATE FT_PROCESSOS SET
  credito_simples    = COALESCE(?, credito_simples),
  credito_dobro      = COALESCE(?, credito_dobro),
  data_credito_dobro = COALESCE(?, data_credito_dobro),
  data_procedencia   = COALESCE(?, data_procedencia),
  id_aprovacao_atual = COALESCE(?, id_aprovacao_atual),
  ultima_atualizacao = CURRENT_TIMESTAMP
WHERE id_processo = ?`,
		req.CreditoSimples, req.CreditoDobro, req.DataCreditoDobro,
		req.DataProcedencia, req.AprovacaoID, id,
	); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "sync valores em FT_PROCESSOS: "+err.Error(), nil)
		return
	}

	// Recalcula o repasse (= crédito × percentual) sempre que o deferimento é salvo.
	// O front (TabDeferimento) NÃO envia repasse — só o crédito — então o backend é a
	// fonte de verdade do repasse. Sem isso, editar o crédito (simples ou dobro) não
	// atualizava repasse_simples/repasse_dobro na FT_DEFERIMENTOS (ficava preso no valor
	// antigo). recomputeRepasse resolve o % (override do processo OU DM_EMPRESA_PERCENTUAL
	// na data de procedência) e só age quando há percentual conhecido (não zera à toa).
	if err := recomputeRepasse(c, tx, id); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "recalculo do repasse: "+err.Error(), nil)
		return
	}

	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}

	// Retorna o que ficou
	GetDeferimento(c)
}

// ============================================================================
// FT_FATURAMENTO — POST cria, PUT atualiza, DELETE remove (N por processo)
// ============================================================================

type FaturamentoItemRequest struct {
	IDFormaDevolucao    *int     `json:"id_forma_devolucao"`
	DataDevolucao       *string  `json:"data_devolucao"`
	DataEnvioFinanceiro *string  `json:"data_envio_financeiro"` // por item — herdado do fluxo legado
	Valor               *float64 `json:"valor"`
	Referencia          *string  `json:"referencia"` // "Simples" | "Dobro" | "Simples e Dobro"
}

type FaturamentoRequest struct {
	NumeroNF               string                   `json:"numero_nf"`
	SerieNF                string                   `json:"serie_nf"`
	DataEmissao            *string                  `json:"data_emissao"`
	DataEnvioDistribuidora *string                  `json:"data_envio_distribuidora"`
	DataEnvioFinanceiro    *string                  `json:"data_envio_financeiro"` // alias moderno
	DataVencimento         *string                  `json:"data_vencimento"`
	DataPagamento          *string                  `json:"data_pagamento"`
	ValorFaturado          *float64                 `json:"valor"`
	StatusNF               string                   `json:"status_nf"`
	Observacoes            string                   `json:"observacoes"`
	Itens                  []FaturamentoItemRequest `json:"itens"`
}

// dataEnvio resolve o "envio ao financeiro" — usa o alias moderno se veio,
// senão cai no campo legado data_envio_distribuidora.
func (r *FaturamentoRequest) dataEnvio() *string {
	if r.DataEnvioFinanceiro != nil {
		return r.DataEnvioFinanceiro
	}
	return r.DataEnvioDistribuidora
}

func (r *FaturamentoRequest) statusOrDefault() string {
	if r.StatusNF == "" {
		if r.DataEmissao != nil && *r.DataEmissao != "" {
			return "enviada"
		}
		return "em_emissao"
	}
	return r.StatusNF
}

// gravarItensFaturamento apaga e regrava a lista de itens de devolução de um
// faturamento (rebuild), transacional. É idempotente e usado tanto no POST
// (após INSERT) quanto no PUT.
func gravarItensFaturamento(c *gin.Context, tx *sql.Tx, idFat int64, itens []FaturamentoItemRequest) error {
	if _, err := tx.ExecContext(c.Request.Context(),
		"DELETE FROM FT_FATURAMENTO_ITEM WHERE id_faturamento = ?", idFat); err != nil {
		return err
	}
	for _, it := range itens {
		if _, err := tx.ExecContext(c.Request.Context(), `
INSERT INTO FT_FATURAMENTO_ITEM
    (id_faturamento, id_forma_devolucao, data_devolucao, valor, referencia, data_envio_financeiro)
VALUES (?,?,?,?,?,?)`, idFat, it.IDFormaDevolucao, it.DataDevolucao, it.Valor, it.Referencia,
			it.DataEnvioFinanceiro); err != nil {
			return err
		}
	}
	return nil
}

// CriarFaturamento — POST /api/v2/processos/:id/faturamento
// autoPersistRepasse calcula e grava repasse_simples/dobro na FT_DEFERIMENTOS a partir
// do crédito × percentual — override do processo (percentual_repasse) OU a vigência da
// empresa (DM_EMPRESA_PERCENTUAL) aplicável na data de procedência. Espelha o
// calcularGanho do front (empresaPercentualService.js). Só PREENCHE onde está NULL —
// nunca sobrescreve entrada manual. Best-effort: falhas não abortam a finalização.
// calcRepasse aplica a fórmula canônica de repasse: credito × percentual / 100.
// Espelha o calcularGanho do front (empresaPercentualService.js). Extraída para ser testável (P1-7).
func calcRepasse(credito, pct float64) float64 {
	return credito * pct / 100.0
}

func autoPersistRepasse(c *gin.Context, tx *sql.Tx, idProcesso int) {
	ctx := c.Request.Context()
	var creditoS, creditoD, override sql.NullFloat64
	var codEmpresa sql.NullInt64
	var ref sql.NullString
	if err := tx.QueryRowContext(ctx, `
		SELECT d.credito_simples, d.credito_dobro,
		       COALESCE(DATE_FORMAT(d.data_procedencia,'%Y-%m-%d'), CURDATE()),
		       p.cod_empresa, p.percentual_repasse
		  FROM FT_DEFERIMENTOS d
		  JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
		 WHERE d.id_processo = ?`, idProcesso).
		Scan(&creditoS, &creditoD, &ref, &codEmpresa, &override); err != nil {
		return
	}
	cs, cd := creditoS.Float64, creditoD.Float64
	if cs <= 0 && cd <= 0 {
		return
	}
	var pctS, pctD float64
	if override.Valid && override.Float64 > 0 {
		pctS, pctD = override.Float64, override.Float64
	} else if codEmpresa.Valid {
		var ps, pd sql.NullFloat64
		_ = tx.QueryRowContext(ctx, `
			SELECT percentual_simples, percentual_dobro
			  FROM DM_EMPRESA_PERCENTUAL
			 WHERE cod_empresa = ? AND ativo = 1
			   AND data_vigencia_inicio <= ?
			   AND (data_vigencia_fim IS NULL OR data_vigencia_fim >= ?)
			 ORDER BY data_vigencia_inicio DESC LIMIT 1`,
			codEmpresa.Int64, ref.String, ref.String).Scan(&ps, &pd)
		pctS, pctD = ps.Float64, pd.Float64
	}
	if pctS <= 0 && pctD <= 0 {
		return
	}
	_, _ = tx.ExecContext(ctx, `
		UPDATE FT_DEFERIMENTOS
		   SET repasse_simples = COALESCE(repasse_simples, ?),
		       repasse_dobro   = COALESCE(repasse_dobro,   ?)
		 WHERE id_processo = ?`,
		calcRepasse(cs, pctS), calcRepasse(cd, pctD), idProcesso)
}

// syncDeferimentoFromFull propaga os campos financeiros editados no PUT /processos/:id/full
// para FT_DEFERIMENTOS — a tabela que a lista/detalhe LÊ (def_raw em processos_repo.go).
// Sem isso, crédito/repasse editados gravavam só em FT_PROCESSOS e "sumiam" no reload.
//   A) espelha credito_simples/dobro, data_procedencia, data_credito_dobro e repasse (se manual);
//   B) se o repasse NÃO veio manual e houve mudança financeira, recalcula repasse = crédito × %.
// Só age quando algum campo financeiro veio no payload.
func syncDeferimentoFromFull(c *gin.Context, tx *sql.Tx, id int, r ProcessoFullRequest) error {
	ctx := c.Request.Context()
	financeiro := r.CreditoSimples != nil || r.CreditoDobro != nil ||
		r.RepasseSimples != nil || r.RepasseDobro != nil ||
		r.DataProcedencia != nil || r.DataCreditoDobro != nil || r.PercentualRepasse != nil
	if !financeiro {
		return nil
	}
	// garante a linha de deferimento (id_processo é UNIQUE)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO FT_DEFERIMENTOS (id_processo) VALUES (?)
		 ON DUPLICATE KEY UPDATE id_processo = id_processo`, id); err != nil {
		return err
	}
	// A) espelha só os campos enviados (não zera o que não veio)
	setD := []string{}
	argD := []interface{}{}
	addD := func(col string, v interface{}) { setD = append(setD, col+" = ?"); argD = append(argD, v) }
	if r.CreditoSimples != nil {
		addD("credito_simples", *r.CreditoSimples)
	}
	if r.CreditoDobro != nil {
		addD("credito_dobro", *r.CreditoDobro)
	}
	if r.DataProcedencia != nil {
		addD("data_procedencia", nullableStr(*r.DataProcedencia))
	}
	if r.DataCreditoDobro != nil {
		addD("data_credito_dobro", nullableStr(*r.DataCreditoDobro))
	}
	repasseManual := r.RepasseSimples != nil || r.RepasseDobro != nil
	if r.RepasseSimples != nil {
		addD("repasse_simples", *r.RepasseSimples)
	}
	if r.RepasseDobro != nil {
		addD("repasse_dobro", *r.RepasseDobro)
	}
	if len(setD) > 0 {
		q := "UPDATE FT_DEFERIMENTOS SET " + strings.Join(setD, ", ") + " WHERE id_processo = ?"
		if _, err := tx.ExecContext(ctx, q, append(argD, id)...); err != nil {
			return err
		}
	}
	// B) recalcula repasse = crédito × percentual (SOBRESCREVE) quando não veio repasse manual
	if !repasseManual {
		return recomputeRepasse(c, tx, id)
	}
	return nil
}

// recomputeRepasse recalcula repasse_simples/dobro = crédito × percentual e SOBRESCREVE
// em FT_DEFERIMENTOS — igual ao calcularGanho do front (empresaPercentualService.js).
// Difere de autoPersistRepasse (que só preenche NULL): aqui a edição do crédito atualiza o
// repasse. Mesma resolução de %: override do processo OU DM_EMPRESA_PERCENTUAL na data.
func recomputeRepasse(c *gin.Context, tx *sql.Tx, idProcesso int) error {
	ctx := c.Request.Context()
	var creditoS, creditoD, override sql.NullFloat64
	var codEmpresa sql.NullInt64
	var ref sql.NullString
	if err := tx.QueryRowContext(ctx, `
		SELECT d.credito_simples, d.credito_dobro,
		       COALESCE(DATE_FORMAT(d.data_procedencia,'%Y-%m-%d'), CURDATE()),
		       p.cod_empresa, p.percentual_repasse
		  FROM FT_DEFERIMENTOS d
		  JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
		 WHERE d.id_processo = ?`, idProcesso).
		Scan(&creditoS, &creditoD, &ref, &codEmpresa, &override); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	cs, cd := creditoS.Float64, creditoD.Float64
	var pctS, pctD float64
	if override.Valid && override.Float64 > 0 {
		pctS, pctD = override.Float64, override.Float64
	} else if codEmpresa.Valid {
		var ps, pd sql.NullFloat64
		_ = tx.QueryRowContext(ctx, `
			SELECT percentual_simples, percentual_dobro
			  FROM DM_EMPRESA_PERCENTUAL
			 WHERE cod_empresa = ? AND ativo = 1
			   AND data_vigencia_inicio <= ?
			   AND (data_vigencia_fim IS NULL OR data_vigencia_fim >= ?)
			 ORDER BY data_vigencia_inicio DESC LIMIT 1`,
			codEmpresa.Int64, ref.String, ref.String).Scan(&ps, &pd)
		pctS, pctD = ps.Float64, pd.Float64
	}
	// sem percentual conhecido → não mexe (evita zerar repasse existente)
	if pctS <= 0 && pctD <= 0 {
		return nil
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE FT_DEFERIMENTOS
		   SET repasse_simples = ?, repasse_dobro = ?
		 WHERE id_processo = ?`,
		calcRepasse(cs, pctS), calcRepasse(cd, pctD), idProcesso)
	return err
}

func CriarFaturamento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	if !ensureProcesso(c, db, id) {
		return
	}

	var req FaturamentoRequest
	if !bindJSON(c, &req) {
		return
	}

	tx, err := db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(c.Request.Context(), `
INSERT INTO FT_FATURAMENTO (
  id_processo, numero_nf, serie_nf,
  data_emissao, data_envio_financeiro, data_vencimento, data_pagamento,
  valor, status_nf, observacoes
) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		id, nullableStr(req.NumeroNF), nullableStr(req.SerieNF),
		req.DataEmissao, req.dataEnvio(), req.DataVencimento, req.DataPagamento,
		req.ValorFaturado, req.statusOrDefault(), nullableStr(req.Observacoes))
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	newID, _ := res.LastInsertId()
	if err := gravarItensFaturamento(c, tx, newID, req.Itens); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "itens: "+err.Error(), nil)
		return
	}
	// Finalização: calcula e persiste o repasse (crédito × percentual) na FT_DEFERIMENTOS
	// se ainda não houver — resolve o "repasse só no front" em processos finalizados.
	autoPersistRepasse(c, tx, id)
	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id_faturamento": newID})
}

// AtualizarFaturamento — PUT /api/v2/faturamento/:id
func AtualizarFaturamento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	var req FaturamentoRequest
	if !bindJSON(c, &req) {
		return
	}

	tx, err := db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(c.Request.Context(), `
UPDATE FT_FATURAMENTO SET
  numero_nf = ?, serie_nf = ?,
  data_emissao = ?, data_envio_financeiro = ?, data_vencimento = ?, data_pagamento = ?,
  valor = ?, status_nf = ?, observacoes = ?
WHERE id_faturamento = ?`,
		nullableStr(req.NumeroNF), nullableStr(req.SerieNF),
		req.DataEmissao, req.dataEnvio(), req.DataVencimento, req.DataPagamento,
		req.ValorFaturado, req.statusOrDefault(), nullableStr(req.Observacoes), id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	_ = res
	// RowsAffected() conta linhas ALTERADAS (0 quando os valores não mudaram, ex.: só os itens
	// de devolução foram editados) — não serve pra detectar existência. Confere de fato.
	var existeFat int
	if err := tx.QueryRowContext(c.Request.Context(),
		"SELECT 1 FROM FT_FATURAMENTO WHERE id_faturamento = ?", id).Scan(&existeFat); err == sql.ErrNoRows {
		apiError(c, http.StatusNotFound, "FATURAMENTO_NAO_ENCONTRADO", "Faturamento não existe", nil)
		return
	} else if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if err := gravarItensFaturamento(c, tx, int64(id), req.Itens); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "itens: "+err.Error(), nil)
		return
	}
	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"id_faturamento": id})
}

// DeletarFaturamento — DELETE /api/v2/faturamento/:id
func DeletarFaturamento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	res, err := db.ExecContext(c.Request.Context(),
		"DELETE FROM FT_FATURAMENTO WHERE id_faturamento = ?", id)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		apiError(c, http.StatusNotFound, "FATURAMENTO_NAO_ENCONTRADO",
			"Faturamento não existe", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// ============================================================================
// Repasse — POST/PUT/DELETE. O repasse ao cliente é a data de pagamento da NF
// (FT_FATURAMENTO.data_pagamento) + o split repasse_simples/dobro. A leitura
// (GetRepasses) lista uma linha por NF, com id_repasse = id_faturamento — então a
// escrita TEM que usar a mesma tabela/id. (Antes gravava em FT_FLUXO_RESSARCIMENTO
// com esse id e alterava o fluxo de OUTRO processo.)
// ============================================================================

type RepasseRequest struct {
	DataRepasse *string `json:"data_devolucao"`
	Observacoes string  `json:"observacoes"`
	// Split do repasse — gravado em FT_DEFERIMENTOS (que a tela lê) e espelhado em
	// FT_PROCESSOS. Valores manuais; nil = não mexe.
	RepasseSimples *float64 `json:"repasse_simples"`
	RepasseDobro   *float64 `json:"repasse_dobro"`
	// Valor único da tela ("Repasse"): repartido em simples/dobro por repartirRepasse.
	RepasseTotal *float64 `json:"repasse_total"`
}

// repartirRepasse divide o valor único entre simples e dobro: vai todo para o lado
// que tem crédito; com os dois lados, mantém a proporção do repasse atual (ou, sem
// ele, a dos créditos).
func repartirRepasse(c *gin.Context, tx *sql.Tx, idProcesso int64, total float64) (float64, float64, error) {
	var cs, cd, rs, rd sql.NullFloat64
	err := tx.QueryRowContext(c.Request.Context(), `
SELECT COALESCE(d.credito_simples, p.credito_simples), COALESCE(d.credito_dobro, p.credito_dobro),
       COALESCE(d.repasse_simples, p.repasse_simples), COALESCE(d.repasse_dobro, p.repasse_dobro)
FROM FT_PROCESSOS p LEFT JOIN FT_DEFERIMENTOS d ON d.id_processo = p.id_processo
WHERE p.id_processo = ?`, idProcesso).Scan(&cs, &cd, &rs, &rd)
	if err != nil && err != sql.ErrNoRows {
		return 0, 0, err
	}
	switch {
	case cd.Float64 > 0 && cs.Float64 <= 0:
		return 0, total, nil
	case cs.Float64 <= 0 || cd.Float64 <= 0:
		return total, 0, nil
	}
	ps, pd := rs.Float64, rd.Float64
	if ps+pd <= 0 {
		ps, pd = cs.Float64, cd.Float64
	}
	simples := math.Round(total*ps/(ps+pd)*100) / 100
	return simples, math.Round((total-simples)*100) / 100, nil
}

// gravarRepasseSplit grava o split nas duas tabelas onde o repasse vive
// (FT_DEFERIMENTOS e FT_PROCESSOS). COALESCE preserva o campo que não veio.
func gravarRepasseSplit(c *gin.Context, tx *sql.Tx, idProcesso int64, req RepasseRequest) error {
	if req.RepasseTotal != nil && req.RepasseSimples == nil && req.RepasseDobro == nil {
		s, d, err := repartirRepasse(c, tx, idProcesso, *req.RepasseTotal)
		if err != nil {
			return err
		}
		req.RepasseSimples, req.RepasseDobro = &s, &d
	}
	if req.RepasseSimples == nil && req.RepasseDobro == nil {
		return nil
	}
	ctx := c.Request.Context()
	if _, err := tx.ExecContext(ctx, `
INSERT INTO FT_DEFERIMENTOS (id_processo, repasse_simples, repasse_dobro)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE
  repasse_simples = COALESCE(VALUES(repasse_simples), repasse_simples),
  repasse_dobro   = COALESCE(VALUES(repasse_dobro),   repasse_dobro)`,
		idProcesso, req.RepasseSimples, req.RepasseDobro); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
UPDATE FT_PROCESSOS SET
  repasse_simples = COALESCE(?, repasse_simples),
  repasse_dobro   = COALESCE(?, repasse_dobro)
WHERE id_processo = ?`,
		req.RepasseSimples, req.RepasseDobro, idProcesso)
	return err
}

// gravarPagamentoNF grava a data de pagamento (e observações) numa NF do processo.
func gravarPagamentoNF(c *gin.Context, tx *sql.Tx, idFaturamento int64, req RepasseRequest) error {
	_, err := tx.ExecContext(c.Request.Context(), `
UPDATE FT_FATURAMENTO SET
  data_pagamento = ?, observacoes = COALESCE(?, observacoes)
WHERE id_faturamento = ?`,
		req.DataRepasse, nullableStr(req.Observacoes), idFaturamento)
	return err
}

// CriarRepasse — POST /api/v2/processos/:id/repasse
// Sem id de NF: grava o split e, se veio data, marca o pagamento na NF mais recente
// do processo ainda sem data de pagamento.
func CriarRepasse(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	if !ensureProcesso(c, db, id) {
		return
	}
	var req RepasseRequest
	if !bindJSON(c, &req) {
		return
	}
	ctx := c.Request.Context()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer tx.Rollback()

	var idFat int64
	if req.DataRepasse != nil && *req.DataRepasse != "" {
		err := tx.QueryRowContext(ctx, `
SELECT id_faturamento FROM FT_FATURAMENTO
WHERE id_processo = ? AND data_pagamento IS NULL
ORDER BY created_at DESC, id_faturamento DESC LIMIT 1`, id).Scan(&idFat)
		if err == sql.ErrNoRows {
			apiError(c, http.StatusBadRequest, "SEM_NF",
				"Cadastre a NF na etapa Faturamento antes de informar a data do repasse.", nil)
			return
		} else if err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
			return
		}
		if err := gravarPagamentoNF(c, tx, idFat, req); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
			return
		}
	}
	if err := gravarRepasseSplit(c, tx, int64(id), req); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "split: "+err.Error(), nil)
		return
	}
	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id_repasse": idFat})
}

// AtualizarRepasse — PUT /api/v2/repasse/:id  (id = id_faturamento, como na leitura)
func AtualizarRepasse(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	var req RepasseRequest
	if !bindJSON(c, &req) {
		return
	}
	ctx := c.Request.Context()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer tx.Rollback()

	var idProc int64
	if err := tx.QueryRowContext(ctx,
		"SELECT id_processo FROM FT_FATURAMENTO WHERE id_faturamento = ?", id).Scan(&idProc); err == sql.ErrNoRows {
		apiError(c, http.StatusNotFound, "REPASSE_NAO_ENCONTRADO", "Repasse não existe", nil)
		return
	} else if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if err := gravarPagamentoNF(c, tx, int64(id), req); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if err := gravarRepasseSplit(c, tx, idProc, req); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "split: "+err.Error(), nil)
		return
	}
	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"id_repasse": id})
}

// DeletarRepasse — DELETE /api/v2/repasse/:id  (id = id_faturamento)
// Remove só o pagamento (data_pagamento); a NF continua no Faturamento.
func DeletarRepasse(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	var existe int
	if err := db.QueryRowContext(c.Request.Context(),
		"SELECT 1 FROM FT_FATURAMENTO WHERE id_faturamento = ?", id).Scan(&existe); err == sql.ErrNoRows {
		apiError(c, http.StatusNotFound, "REPASSE_NAO_ENCONTRADO", "Repasse não existe", nil)
		return
	} else if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	if _, err := db.ExecContext(c.Request.Context(),
		"UPDATE FT_FATURAMENTO SET data_pagamento = NULL WHERE id_faturamento = ?", id); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// ============================================================================
// FT_ENCERRAMENTO — POST cria/atualiza + finaliza processo
// ============================================================================

type EncerramentoRequest struct {
	DataEncerramento  string `json:"data_encerramento"`
	Motivo            string `json:"motivo"` // enum
	AprovacaoFinalID  int    `json:"aprovacao_final_id"`
	ParecerFinal      string `json:"parecer_final"`
}

var motivosValidos = map[string]bool{
	"repasse_concluido":       true,
	"acordo_extrajudicial":    true,
	"indeferido_sem_recurso":  true,
	"cancelado_cliente":       true,
	"outro":                   true,
}

// SalvarEncerramento — POST /api/v2/processos/:id/encerramento
//
// Idempotente por id_processo. Também sincroniza FT_PROCESSOS:
//   - id_etapa_atual=6 (Encerramento)
//   - id_status_atual=7 (Encerrado)
//   - id_aprovacao_atual=aprovacao_final_id
func SalvarEncerramento(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	if !ensureProcesso(c, db, id) {
		return
	}

	var req EncerramentoRequest
	if !bindJSON(c, &req) {
		return
	}
	if req.DataEncerramento == "" || req.Motivo == "" || req.AprovacaoFinalID == 0 {
		apiError(c, http.StatusBadRequest, "CAMPO_OBRIGATORIO",
			"data_encerramento, motivo, aprovacao_final_id são obrigatórios", nil)
		return
	}
	if !motivosValidos[req.Motivo] {
		apiError(c, http.StatusBadRequest, "VALOR_INVALIDO",
			"motivo deve ser um de: repasse_concluido / acordo_extrajudicial / indeferido_sem_recurso / cancelado_cliente / outro",
			gin.H{"motivo": req.Motivo})
		return
	}

	tx, err := db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(c.Request.Context(), `
INSERT INTO FT_ENCERRAMENTO (
  id_processo, data_encerramento, motivo, id_aprovacao_final, parecer_final
) VALUES (?,?,?,?,?)
ON DUPLICATE KEY UPDATE
  data_encerramento = VALUES(data_encerramento),
  motivo = VALUES(motivo),
  id_aprovacao_final = VALUES(id_aprovacao_final),
  parecer_final = VALUES(parecer_final)`,
		id, req.DataEncerramento, req.Motivo, req.AprovacaoFinalID, nullableStr(req.ParecerFinal),
	); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	// Sincroniza FT_PROCESSOS pra Encerramento/Encerrado/aprovação
	if _, err := tx.ExecContext(c.Request.Context(), `
UPDATE FT_PROCESSOS SET
  id_etapa_atual = 6,
  id_status_atual = 7,
  id_aprovacao_atual = ?,
  id_instancia_atual = NULL,
  ultima_atualizacao = CURRENT_TIMESTAMP
WHERE id_processo = ?`, req.AprovacaoFinalID, id); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "sync processo: "+err.Error(), nil)
		return
	}

	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}

	GetEncerramento(c)
}

// ============================================================================
// Edição do comentário de uma movimentação do histórico + auditoria
// ============================================================================

type EditarComentarioRequest struct {
	Comentario string `json:"comentario"`
	Observacao string `json:"observacao"` // justificativa da alteração (obrigatória)
}

// EditarComentarioHistorico — PUT /api/v2/historico/:id/comentario
// Edita SÓ o comentário escrito na movimentação (o conteúdo de e-mail não é editável) e
// registra a alteração em FT_AUDIT_EDICAO (valor anterior/novo, observação e quem editou).
func EditarComentarioHistorico(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	var req EditarComentarioRequest
	if !bindJSON(c, &req) {
		return
	}
	if strings.TrimSpace(req.Observacao) == "" {
		apiError(c, http.StatusBadRequest, "CAMPO_OBRIGATORIO",
			"observacao é obrigatória (justificativa da alteração)", nil)
		return
	}

	idUser := resolverUsuarioV2(c, db)

	tx, err := db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer func() { _ = tx.Rollback() }()

	var anterior sql.NullString
	err = tx.QueryRowContext(c.Request.Context(),
		"SELECT comentario FROM FT_HISTORICO_MOVIMENTACOES WHERE id_historico = ?", id).Scan(&anterior)
	if err == sql.ErrNoRows {
		apiError(c, http.StatusNotFound, "HISTORICO_NAO_ENCONTRADO", "movimentação não existe", nil)
		return
	} else if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	if _, err := tx.ExecContext(c.Request.Context(),
		"UPDATE FT_HISTORICO_MOVIMENTACOES SET comentario = ? WHERE id_historico = ?",
		nullableStr(req.Comentario), id); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}

	if _, err := tx.ExecContext(c.Request.Context(), `
INSERT INTO FT_AUDIT_EDICAO (entidade, id_entidade, campo, valor_anterior, valor_novo, observacao, id_usuario)
VALUES ('historico', ?, 'comentario', ?, ?, ?, ?)`,
		id, anterior, req.Comentario, req.Observacao, nilUser(idUser)); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "audit: "+err.Error(), nil)
		return
	}

	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id_historico": id})
}

// ============================================================================
// Edição completa do processo — PUT /api/v2/processos/:id/full
// Patch: só grava os campos enviados (ponteiros). Espelha em FT_REQUISICOES os
// campos que também vivem lá (cliente/uc/concessionaria/cnpj/endereco/protocolo/link).
// ============================================================================

type ProcessoFullRequest struct {
	Uc                    *string  `json:"uc"`
	Cliente               *string  `json:"cliente"`
	Concessionaria        *string  `json:"concessionaria"`
	IdResponsavel         *int     `json:"id_responsavel"`
	Relevancia            *bool    `json:"relevancia"`
	RessarcimentoEstimado *float64 `json:"ressarcimento_estimado"`
	IdInstanciaAtual      *int     `json:"id_instancia_atual"`
	IdEtapaAtual          *int     `json:"id_etapa_atual"`
	IdStatusAtual         *int     `json:"id_status_atual"`
	IdAprovacaoAtual      *int     `json:"id_aprovacao_atual"`
	IdTipoIrreg           *int     `json:"id_tipo_irregularidade"`
	IdSubtipoIrreg        *int     `json:"id_subtipo_irregularidade"`
	PeriodosIrreg         *string  `json:"periodos_irregularidade"`
	DescricaoIrreg        *string  `json:"descricao_irregularidade"`
	CodEmpresa            *int     `json:"cod_empresa"`
	DataProcedencia       *string  `json:"data_procedencia"`
	CreditoSimples        *float64 `json:"credito_simples"`
	CreditoDobro          *float64 `json:"credito_dobro"`
	DataCreditoDobro      *string  `json:"data_credito_dobro"`
	RepasseSimples        *float64 `json:"repasse_simples"`
	RepasseDobro          *float64 `json:"repasse_dobro"`
	PercentualRepasse     *float64 `json:"percentual_repasse"`
	Suspenso              *bool    `json:"suspenso"`
	// vivem em FT_REQUISICOES
	Cnpj             *string `json:"cnpj"`
	EnderecoCompleto *string `json:"endereco_completo"`
	NumeroProtocolo  *string `json:"numero_protocolo"`
	LinkFatura       *string `json:"link_fatura"`
}

func AtualizarProcessoCompleto(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}
	if !ensureProcesso(c, db, id) {
		return
	}
	var r ProcessoFullRequest
	if !bindJSON(c, &r) {
		return
	}

	// monta SET dinâmico só com o que veio
	setP := []string{}
	argP := []interface{}{}
	add := func(col string, v interface{}) { setP = append(setP, col+" = ?"); argP = append(argP, v) }
	if r.Uc != nil {
		add("uc", *r.Uc)
	}
	if r.Cliente != nil {
		add("cliente", *r.Cliente)
	}
	if r.Concessionaria != nil {
		add("concessionaria", *r.Concessionaria)
	}
	if r.IdResponsavel != nil {
		add("id_responsavel", *r.IdResponsavel)
	}
	if r.Relevancia != nil {
		add("relevancia", boolToInt(*r.Relevancia))
	}
	if r.RessarcimentoEstimado != nil {
		add("ressarcimento_estimado", *r.RessarcimentoEstimado)
	}
	if r.IdInstanciaAtual != nil {
		add("id_instancia_atual", nilZeroInt(*r.IdInstanciaAtual))
	}
	if r.IdEtapaAtual != nil {
		add("id_etapa_atual", *r.IdEtapaAtual)
	}
	if r.IdStatusAtual != nil {
		add("id_status_atual", *r.IdStatusAtual)
	}
	if r.IdAprovacaoAtual != nil {
		add("id_aprovacao_atual", nilZeroInt(*r.IdAprovacaoAtual))
	}
	if r.IdTipoIrreg != nil {
		add("id_tipo_irregularidade", nilZeroInt(*r.IdTipoIrreg))
	}
	if r.IdSubtipoIrreg != nil {
		add("id_subtipo_irregularidade", nilZeroInt(*r.IdSubtipoIrreg))
	}
	if r.PeriodosIrreg != nil {
		add("periodos_irregularidade", normalizarPeriodosStore(*r.PeriodosIrreg))
	}
	if r.DescricaoIrreg != nil {
		add("descricao_irregularidade", *r.DescricaoIrreg)
	}
	if r.CodEmpresa != nil {
		add("cod_empresa", nilZeroInt(*r.CodEmpresa))
	}
	if r.DataProcedencia != nil {
		add("data_procedencia", nullableStr(*r.DataProcedencia))
	}
	if r.CreditoSimples != nil {
		add("credito_simples", *r.CreditoSimples)
	}
	if r.CreditoDobro != nil {
		add("credito_dobro", *r.CreditoDobro)
	}
	if r.DataCreditoDobro != nil {
		add("data_credito_dobro", nullableStr(*r.DataCreditoDobro))
	}
	if r.RepasseSimples != nil {
		add("repasse_simples", *r.RepasseSimples)
	}
	if r.RepasseDobro != nil {
		add("repasse_dobro", *r.RepasseDobro)
	}
	if r.PercentualRepasse != nil {
		add("percentual_repasse", *r.PercentualRepasse)
	}
	if r.Suspenso != nil {
		add("suspenso", boolToInt(*r.Suspenso))
	}

	tx, err := db.BeginTx(c.Request.Context(), nil)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if len(setP) > 0 {
		q := "UPDATE FT_PROCESSOS SET " + strings.Join(setP, ", ") + ", ultima_atualizacao=NOW() WHERE id_processo = ?"
		if _, err := tx.ExecContext(c.Request.Context(), q, append(argP, id)...); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "processo: "+err.Error(), nil)
			return
		}
	}

	// espelho em FT_REQUISICOES (id_requisicao = id_processo)
	setR := []string{}
	argR := []interface{}{}
	addR := func(col string, v interface{}) { setR = append(setR, col+" = ?"); argR = append(argR, v) }
	if r.Uc != nil {
		addR("uc", *r.Uc)
	}
	if r.Cliente != nil {
		addR("cliente", *r.Cliente)
	}
	if r.Concessionaria != nil {
		addR("concessionaria", *r.Concessionaria)
	}
	if r.RessarcimentoEstimado != nil {
		addR("ressarcimento_estimado", *r.RessarcimentoEstimado)
	}
	if r.Cnpj != nil {
		addR("cnpj", nullableStr(*r.Cnpj))
	}
	if r.EnderecoCompleto != nil {
		addR("endereco_completo", nullableStr(*r.EnderecoCompleto))
	}
	if r.NumeroProtocolo != nil {
		addR("numero_protocolo", nullableStr(*r.NumeroProtocolo))
	}
	if r.LinkFatura != nil {
		addR("link_fatura", nullableStr(*r.LinkFatura))
	}
	if r.PeriodosIrreg != nil {
		addR("periodos_irregularidade", normalizarPeriodosStore(*r.PeriodosIrreg))
	}
	if r.DescricaoIrreg != nil {
		addR("descricao_irregularidade", *r.DescricaoIrreg)
	}
	if r.IdTipoIrreg != nil {
		addR("id_tipo_irregularidade", nilZeroInt(*r.IdTipoIrreg))
	}
	if r.IdSubtipoIrreg != nil {
		addR("id_subtipo_irregularidade", nilZeroInt(*r.IdSubtipoIrreg))
	}
	if len(setR) > 0 {
		q := "UPDATE FT_REQUISICOES SET " + strings.Join(setR, ", ") + " WHERE id_requisicao = ?"
		if _, err := tx.ExecContext(c.Request.Context(), q, append(argR, id)...); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "requisicao: "+err.Error(), nil)
			return
		}
	}

	// A+B: espelha os campos financeiros em FT_DEFERIMENTOS (tabela que a tela LÊ, via
	// def_raw em processos_repo.go) e recalcula repasse = crédito × percentual quando o
	// repasse não veio manual. Corrige o bug "edição não persiste": o /full gravava só em
	// FT_PROCESSOS/FT_REQUISICOES, então crédito/repasse editados sumiam no reload.
	if err := syncDeferimentoFromFull(c, tx, id, r); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "deferimento: "+err.Error(), nil)
		return
	}

	if err := tx.Commit(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "commit: "+err.Error(), nil)
		return
	}
	det, err := loadProcessoDetalhes(c.Request.Context(), db, id)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": true, "id_processo": id})
		return
	}
	c.JSON(http.StatusOK, det)
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
func nilZeroInt(v int) interface{} {
	if v == 0 {
		return nil
	}
	return v
}
