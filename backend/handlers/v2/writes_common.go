package v2

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/empresas"
)

// ─── Resolver usuário do contexto (cache em memória) ───────────────────────
//
// O login (auth_handler) autentica DIRETO contra DM_USUARIO, então c.Get("userID")
// (claims.UserID) JÁ é o DM_USUARIO.id_usuario. Ainda assim aceitamos o mapeamento
// legado por id_usuario_origem (ambientes antigos com banco v1 separado). Cacheamos
// em memória pra evitar 1 SELECT a cada request.

var (
	userMapMu sync.RWMutex
	userMap   = map[int64]int{} // userID (claims) -> id_usuario (v2)
)

// resolverUsuarioV2 retorna o id_usuario v2 do usuário logado, ou 0 se não houver mapeamento.
// Retornar 0 NÃO é erro — só significa "anonimizar" o autor da movimentação no v2.
func resolverUsuarioV2(c *gin.Context, db *sql.DB) int {
	raw, exists := c.Get("userID")
	if !exists {
		return 0
	}
	var origemID int64
	switch v := raw.(type) {
	case int:
		origemID = int64(v)
	case int64:
		origemID = v
	case float64:
		origemID = int64(v)
	case uint:
		origemID = int64(v)
	case uint64:
		origemID = int64(v)
	default:
		return 0
	}
	if origemID == 0 {
		return 0
	}

	userMapMu.RLock()
	cached, ok := userMap[origemID]
	userMapMu.RUnlock()
	if ok {
		return cached
	}

	// claims.UserID já é o id_usuario do DM_USUARIO (login autentica contra ele).
	// Match direto por id_usuario e, como fallback legado, por id_usuario_origem.
	// ORDER prioriza o match direto quando ambos existirem.
	var idV2 int
	err := db.QueryRowContext(c.Request.Context(),
		"SELECT id_usuario FROM DM_USUARIO WHERE id_usuario = ? OR id_usuario_origem = ? ORDER BY (id_usuario = ?) DESC LIMIT 1",
		origemID, origemID, origemID).Scan(&idV2)
	if err != nil {
		idV2 = 0 // não encontrado — cacheia o "não encontrado" como 0
	}
	userMapMu.Lock()
	userMap[origemID] = idV2
	userMapMu.Unlock()
	return idV2
}

// ─── Snapshot atual do processo (pra movimentar) ───────────────────────────

type processoSnapshot struct {
	IDEtapaAtual     int
	IDInstanciaAtual sql.NullInt64
	IDStatusAtual    int
	IDAprovacaoAtual sql.NullInt64
}

func loadSnapshot(ctx context.Context, db *sql.DB, idProcesso int) (*processoSnapshot, error) {
	var s processoSnapshot
	err := db.QueryRowContext(ctx, `
SELECT id_etapa_atual, id_instancia_atual, id_status_atual, id_aprovacao_atual
  FROM FT_PROCESSOS WHERE id_processo = ?`, idProcesso).Scan(
		&s.IDEtapaAtual, &s.IDInstanciaAtual, &s.IDStatusAtual, &s.IDAprovacaoAtual)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// criarProcessoDeRequisicao cria a linha em FT_PROCESSOS a partir da requisição de mesmo id,
// no estado inicial Distribuidora(1) · Reclamação(1) · Aguardando retorno(3). É o passo
// "Criar processo" da triagem (aprovar já NÃO cria o processo). Retorna true se criou a linha.
// INSERT ... SELECT simples (origem qualificada com r.), sem ON DUPLICATE, então não há
// ambiguidade de coluna nem risco de rebobinar um processo já existente.
func criarProcessoDeRequisicao(ctx context.Context, db *sql.DB, idProcesso int) bool {
	res, err := db.ExecContext(ctx, `
INSERT INTO FT_PROCESSOS
  (id_processo, id_instancia_atual, id_etapa_atual, id_status_atual,
   relevancia, uc, cliente, concessionaria, ressarcimento_estimado,
   periodos_irregularidade, descricao_irregularidade,
   id_tipo_irregularidade, id_subtipo_irregularidade,
   data_criacao, ultima_atualizacao)
SELECT r.id_requisicao, 1, 1, 3,
       0, r.uc, r.cliente, r.concessionaria, r.ressarcimento_estimado,
       r.periodos_irregularidade, r.descricao_irregularidade,
       r.id_tipo_irregularidade, r.id_subtipo_irregularidade,
       COALESCE(r.data_criacao, NOW()), NOW()
  FROM FT_REQUISICOES r WHERE r.id_requisicao = ?`, idProcesso)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		// Gera o codigo_publico (PR-<ano do período>-<id 6 dígitos>) — o INSERT acima
		// não gerava, e o processo saía sem código.
		gerarCodigoPublicoProcesso(ctx, db, idProcesso)
		// Resolve o cod_empresa (numeração do app / DM_EMPRESA_PERCENTUAL) pelo nome
		// do cliente — sem ele o processo não casa com o percentual da empresa.
		resolverCodEmpresaProcesso(ctx, db, idProcesso)
	}
	return n > 0
}

// resolverCodEmpresaProcesso preenche FT_PROCESSOS.cod_empresa pelo cadastro (DM_EMPRESA_PERCENTUAL,
// numeração do app, ex.: MCDONALDS=1019 — é ela que o front usa p/ achar o percentual S/D) e grava
// o NOME OFICIAL do cliente no processo e na requisição. Antes só casava nome idêntico e mantinha o
// nome digitado ("CLARO SA", "VIA SA", "SER EDUCACIONAL S A" ficavam sem código e com nome torto —
// padronização de 23/10/2026). Sem casamento único (empresa sem cadastro), não mexe.
func resolverCodEmpresaProcesso(ctx context.Context, db *sql.DB, idProcesso int) {
	var cliente sql.NullString
	var cod sql.NullInt64
	if e := db.QueryRowContext(ctx,
		"SELECT cliente, cod_empresa FROM FT_PROCESSOS WHERE id_processo = ?", idProcesso).Scan(&cliente, &cod); e != nil {
		return
	}
	codOf, nomeOf, ok := empresas.Canonico(ctx, db, cliente.String)
	if !ok || (cod.Valid && cod.Int64 > 0 && cod.Int64 != codOf) {
		return // sem cadastro, ou já tem outro código definido à mão
	}
	_, _ = db.ExecContext(ctx,
		"UPDATE FT_PROCESSOS SET cod_empresa = ?, cliente = ? WHERE id_processo = ?", codOf, nomeOf, idProcesso)
	_, _ = db.ExecContext(ctx,
		"UPDATE FT_REQUISICOES SET cliente = ? WHERE id_requisicao = ?", nomeOf, idProcesso)
}

// gerarCodigoPublicoProcesso preenche FT_PROCESSOS.codigo_publico no formato
// "PR-<ano>-<id 6 dígitos>", onde <ano> vem do período de irregularidade da
// requisição (1º período); se ausente, usa o ano corrente. Só grava se estiver vazio.
func gerarCodigoPublicoProcesso(ctx context.Context, db *sql.DB, idProcesso int) {
	var periodos sql.NullString
	_ = db.QueryRowContext(ctx,
		"SELECT periodos_irregularidade FROM FT_REQUISICOES WHERE id_requisicao = ?", idProcesso).Scan(&periodos)
	ano := anoDoPeriodo(periodos.String)
	if ano == 0 {
		ano = time.Now().Year()
	}
	codigo := fmt.Sprintf("PR-%d-%06d", ano, idProcesso)
	_, _ = db.ExecContext(ctx,
		"UPDATE FT_PROCESSOS SET codigo_publico = ? WHERE id_processo = ? AND (codigo_publico IS NULL OR codigo_publico = '')",
		codigo, idProcesso)
}

// anoDoPeriodo extrai o ano do 1º item de periodos_irregularidade
// (JSON [{"ano": 2026 | "2026", "mes": ...}]). Retorna 0 se não achar.
func anoDoPeriodo(js string) int {
	js = strings.TrimSpace(js)
	if js == "" || js == "null" || js == "[]" {
		return 0
	}
	var itens []map[string]interface{}
	if json.Unmarshal([]byte(js), &itens) != nil || len(itens) == 0 {
		return 0
	}
	switch v := itens[0]["ano"].(type) {
	case float64:
		return int(v)
	case string:
		if n, e := strconv.Atoi(strings.TrimSpace(v)); e == nil {
			return n
		}
	}
	return 0
}

// ─── Validação de transição de etapa ───────────────────────────────────────
//
// Regra: transição só pode ir pra etapa adjacente (diff 1) ou ficar na mesma.
// Ordem canônica: 1=Reclamação 2=Contestação 3=Conciliação 4=Faturamento 5=Repasse 6=Encerramento.
// Exceções permitidas:
//   - Qualquer etapa pode IR PARA Encerramento (id=6) se aprovacao_id for fornecido (indeferimento a qualquer momento)
//   - Encerramento NÃO pode voltar (terminal).

var (
	ErrEtapaPularNaoPermitido = errors.New("ETAPA_INVALIDA")
	ErrEncerramentoSemAprov   = errors.New("APROVACAO_OBRIGATORIA")
	ErrEtapaTerminal          = errors.New("ETAPA_TERMINAL")
)

func validarTransicao(atual, alvo int, aprovacaoID *int) error {
	if atual == 6 && alvo != 6 {
		return ErrEtapaTerminal
	}
	if alvo == 6 {
		if aprovacaoID == nil || *aprovacaoID == 0 {
			return ErrEncerramentoSemAprov
		}
		return nil
	}
	// Conciliação (etapa 3) é sempre acessível — é um desfecho deferido; ao entrar,
	// a aprovação é congelada em Deferido (forçada no handler). Não exige adjacência.
	if alvo == 3 {
		return nil
	}
	diff := alvo - atual
	if diff < 0 {
		diff = -diff
	}
	if diff > 1 {
		return ErrEtapaPularNaoPermitido
	}
	return nil
}

// ─── Sincroniza PROCESSO depois de mudança em estado ───────────────────────

// updateProcessoFromMovimentar atualiza id_etapa_atual / id_instancia_atual / id_status_atual /
// id_aprovacao_atual / data_ultima_movimentacao do PROCESSO.
func updateProcessoFromMovimentar(ctx context.Context, db *sql.DB, idProcesso, etapaID int,
	instanciaID *int, statusID int, aprovacaoID *int) error {
	args := []interface{}{etapaID, nilInt2(instanciaID), statusID, nilInt2(aprovacaoID), idProcesso}
	_, err := db.ExecContext(ctx, `
UPDATE FT_PROCESSOS SET
  id_etapa_atual = ?,
  id_instancia_atual = ?,
  id_status_atual = ?,
  id_aprovacao_atual = ?,
  ultima_atualizacao = CURRENT_TIMESTAMP
WHERE id_processo = ?`, args...)
	return err
}

// nilInt2 converte *int → interface{} (nil quando nulo/zero) para args do sql.
func nilInt2(p *int) interface{} {
	if p == nil || *p == 0 {
		return nil
	}
	return *p
}

// ─── Bind body com erro padronizado ────────────────────────────────────────

func bindJSON(c *gin.Context, dst interface{}) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		apiError(c, http.StatusBadRequest, "BODY_INVALIDO",
			"Body JSON inválido: "+err.Error(), nil)
		return false
	}
	return true
}

// ─── Validar existência do processo ────────────────────────────────────────

func processoExiste(ctx context.Context, db *sql.DB, idProcesso int) (bool, error) {
	var n int
	err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM FT_PROCESSOS WHERE id_processo = ?", idProcesso).Scan(&n)
	return n > 0, err
}

// ─── Helper de erro 404 quando processo não existe ─────────────────────────

func ensureProcesso(c *gin.Context, db *sql.DB, idProcesso int) bool {
	ok, err := processoExiste(c.Request.Context(), db, idProcesso)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return false
	}
	if !ok {
		apiError(c, http.StatusNotFound, "PROCESSO_NAO_ENCONTRADO",
			fmt.Sprintf("Processo %d não existe", idProcesso), nil)
		return false
	}
	return true
}
