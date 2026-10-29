package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jung-kurt/gofpdf"
	"github.com/xuri/excelize/v2"

	"ressarcimento-backend/database"
	"ressarcimento-backend/procedit"
)

// solTabelasReversiveis — LIMITADOR da reversão: só restaura campos de PROCESSO.
var solTabelasReversiveis = map[string]bool{
	"FT_PROCESSOS":               true,
	"FT_DEFERIMENTOS":            true,
	"FT_HISTORICO_MOVIMENTACOES": true, // reverter = DELETE do histórico inserido
	"FT_ANEXOS":                  true, // reverter = DELETE do anexo inserido
	"FT_ENCERRAMENTO":            true, // reverter = DELETE do encerramento inserido (lote #16)
	"DM_META_REPASSE":            true, // reverter = restaura meta_mensal/meta_anual anterior
}

var solIdentOK = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ============================================================================
// Solicitacoes ao sistema — o usuario pede algo no chat (tag #sistema), cai numa
// fila (status 'pendente'); o gestor (Alisson) aprova na Home; o executor (Claude
// Code, via polling) pega os 'aprovado', executa e grava o resultado.
// Tabela FT_SOLICITACOES (auto-criada). Nada e' executado sem aprovacao do gestor.
// ============================================================================

func ensureSolicitacoesTable(sqlDB *sql.DB) {
	_, _ = sqlDB.Exec(`
CREATE TABLE IF NOT EXISTS FT_SOLICITACOES (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_usuario    BIGINT NULL,
  usuario_nome  VARCHAR(255) NULL,
  mensagem      TEXT NOT NULL,
  preview       TEXT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pendente',
  resultado     TEXT NULL,
  aprovado_por  VARCHAR(255) NULL,
  criado_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  aprovado_em   DATETIME NULL,
  executado_em  DATETIME NULL,
  acao_json     TEXT NULL,
  KEY k_status (status),
  KEY k_criado (criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	// colunas que podem faltar em tabelas criadas antes — garante (erro é ignorado se já existe).
	_, _ = sqlDB.Exec(`ALTER TABLE FT_SOLICITACOES ADD COLUMN acao_json TEXT NULL`)
	_, _ = sqlDB.Exec(`ALTER TABLE FT_SOLICITACOES ADD COLUMN feedback_solicitante VARCHAR(20) NULL`)
	_, _ = sqlDB.Exec(`ALTER TABLE FT_SOLICITACOES ADD COLUMN feedback_em DATETIME NULL`)
	// round-trip de confirmação: o worker, quando falta uma info do solicitante, grava
	// status='preciso_confirmar' + perguntas_json (perguntas em linguagem simples); a resposta
	// do solicitante volta em resposta_confirmacao e re-enfileira o pedido.
	_, _ = sqlDB.Exec(`ALTER TABLE FT_SOLICITACOES ADD COLUMN perguntas_json TEXT NULL`)
	_, _ = sqlDB.Exec(`ALTER TABLE FT_SOLICITACOES ADD COLUMN resposta_confirmacao TEXT NULL`)
	_, _ = sqlDB.Exec(`
CREATE TABLE IF NOT EXISTS FT_SOLICITACOES_ANEXOS (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_solicitacao BIGINT NOT NULL,
  nome           VARCHAR(255) NOT NULL,
  mime           VARCHAR(120) NULL,
  tamanho        INT NULL,
  conteudo       LONGBLOB NOT NULL,
  criado_em      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY k_solic (id_solicitacao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	// link do Google Drive (upload feito pelo cron do host via rclone; link público)
	_, _ = sqlDB.Exec(`ALTER TABLE FT_SOLICITACOES_ANEXOS ADD COLUMN drive_link VARCHAR(512) NULL`)
	_, _ = sqlDB.Exec(`ALTER TABLE FT_SOLICITACOES_ANEXOS ADD COLUMN drive_path VARCHAR(512) NULL`)
	// thread de conversa (correções que o solicitante pede ao rejeitar)
	_, _ = sqlDB.Exec(`
CREATE TABLE IF NOT EXISTS FT_SOLICITACOES_MSGS (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_solicitacao BIGINT NOT NULL,
  autor_nome     VARCHAR(255) NULL,
  mensagem       TEXT NOT NULL,
  criado_em      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY k_solic (id_solicitacao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

func solicDB(c *gin.Context) *sql.DB {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil || sqlDB == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return nil
	}
	ensureSolicitacoesTable(sqlDB)
	return sqlDB
}

// podeAlterar — TRAVA DE PERFIL. Só gestor/admin podem solicitar QUALQUER alteração
// de dados/registros. O perfil 'solicitante' (padrão) é READ-ONLY: pode pedir apenas
// consultas e relatórios, nunca uma escrita no banco. É imposto no servidor (não na UI),
// então vale mesmo se o solicitante chamar a API diretamente.
func podeAlterar(c *gin.Context) bool {
	get := func(k string) string {
		if v, ok := c.Get(k); ok {
			if s, ok2 := v.(string); ok2 {
				return strings.ToLower(strings.TrimSpace(s))
			}
		}
		return ""
	}
	r, t := get("role"), get("userTipoConta")
	return r == "gestor" || r == "admin" || t == "gestor" || t == "admin"
}

// perfilDoUsuario: "solicitante" quando o usuário não é gestor/admin (o worker lê esta
// coluna p/ aplicar a regra de valor); senão o próprio papel.
func perfilDoUsuario(c *gin.Context) string {
	if podeAlterar(c) {
		if v, ok := c.Get("role"); ok {
			if s, ok2 := v.(string); ok2 && s != "" {
				return strings.ToLower(s)
			}
		}
		return "gestor"
	}
	return "solicitante"
}

// marcarPerfilRelatorio: relatório pedido por SOLICITANTE leva params["perfil"]="solicitante"
// → o procedit tira estimativa/repasse/crédito do resultado (valor só de processo deferido).
func marcarPerfilRelatorio(c *gin.Context, acao *procedit.Acao) {
	if acao == nil || acao.Op != "relatorio" || podeAlterar(c) {
		return
	}
	if acao.Params == nil {
		acao.Params = map[string]string{}
	}
	acao.Params["perfil"] = "solicitante"
}

// CriarSolicitacao — POST /api/v1/solicitacoes  { "mensagem": "...", "preview": "..." }
// Qualquer usuario autenticado cria. Entra como 'pendente'.
func CriarSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	var body struct {
		Mensagem string `json:"mensagem"`
		Preview  string `json:"preview"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	body.Mensagem = strings.TrimSpace(body.Mensagem)
	if body.Mensagem == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mensagem obrigatória"})
		return
	}
	uid, uname := usuarioIA(c)

	// Mix A+B: interpreta o texto numa ação estruturada (quando possível) e guarda
	// o JSON + um preview. O executor usa o JSON → "aprovou = feito".
	preview := body.Preview
	var acaoJSON interface{}
	var acaoPtr *procedit.Acao
	if acao, prev, ok, _ := procedit.Montar(sqlDB, body.Mensagem); ok {
		acaoPtr = acao
		marcarPerfilRelatorio(c, acao)
		if b, e := json.Marshal(acao); e == nil {
			acaoJSON = string(b)
		}
		if strings.TrimSpace(preview) == "" {
			preview = prev
		}
	}

	// TRAVA DE PERFIL: solicitante é read-only. Se o pedido NÃO é consulta/relatório
	// e o usuário não é gestor/admin, bloqueia na origem — nem entra na fila.
	ehLeitura := procedit.EhLeitura(body.Mensagem, acaoPtr)
	if !ehLeitura && !podeAlterar(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Seu perfil permite apenas consultas e relatórios. Alterações no sistema precisam ser solicitadas por um gestor."})
		return
	}

	// Consultas/relatórios (só leitura) NÃO passam pela aprovação do gestor:
	//  - relatório da whitelist → 'aprovado' na hora (o executor roda em ~1 min);
	//  - consulta livre → direto p/ a fila do worker (status 'revisao'); o worker avalia o
	//    PESO e, se for pesada, devolve p/ 'pendente' (aprovação do gestor) com o motivo.
	// Qualquer alteração de dado continua 'pendente' (aprovação obrigatória).
	status, aprovPor, precisaAprovacao := "pendente", interface{}(nil), true
	if ehLeitura {
		precisaAprovacao = false
		if acaoPtr != nil {
			status, aprovPor = "aprovado", "automático (consulta)"
		} else {
			status = "revisao"
		}
	}
	// Pedido do PRÓPRIO aprovador (Alisson) não espera aprovação de ninguém: já entra aprovado
	// e é executado (whitelist pelo executor, tarefas conhecidas pelo run_jobs da VPS).
	if precisaAprovacao && ehAprovador(c) {
		status, aprovPor, precisaAprovacao = "aprovado", uname+" (pedido do próprio aprovador)", false
	}

	res, err := sqlDB.Exec(
		`INSERT INTO FT_SOLICITACOES (id_usuario, usuario_nome, mensagem, preview, status, criado_em, acao_json, aprovado_por, aprovado_em, perfil_solicitante)
		 VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, IF(? IS NULL, NULL, NOW()), ?)`,
		uid, uname, body.Mensagem, solNull(preview), status, acaoJSON, aprovPor, aprovPor, perfilDoUsuario(c))
	if err != nil && strings.Contains(err.Error(), "perfil_solicitante") {
		// coluna ainda não criada (migração aditiva não rodou) → grava sem ela, não derruba o pedido
		res, err = sqlDB.Exec(
			`INSERT INTO FT_SOLICITACOES (id_usuario, usuario_nome, mensagem, preview, status, criado_em, acao_json, aprovado_por, aprovado_em)
			 VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, IF(? IS NULL, NULL, NOW()))`,
			uid, uname, body.Mensagem, solNull(preview), status, acaoJSON, aprovPor, aprovPor)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	id, _ := res.LastInsertId()
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id, "status": status, "auto": acaoJSON != nil, "precisa_aprovacao": precisaAprovacao})
}

// InterpretarSolicitacao — POST /api/v1/solicitacoes/interpretar  { "mensagem": "..." }
// Preview do mix A+B: traduz o texto e devolve o "antes → depois" SEM gravar nada.
// Usado pelo chat p/ mostrar ao usuário antes da confirmação.
func InterpretarSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	var body struct {
		Mensagem string `json:"mensagem"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	msg := strings.TrimSpace(body.Mensagem)
	comando := procedit.EhComando(msg)
	acao, prev, ok, motivo := procedit.Montar(sqlDB, msg)
	if !ok {
		// não executa automático. Se É comando (ex.: mover etapa) → fila de revisão;
		// se não é comando → o chat trata como pergunta (Q&A).
		c.JSON(http.StatusOK, gin.H{"pode_executar": false, "comando": comando, "motivo": motivo, "leitura": procedit.EhLeitura(msg, nil)})
		return
	}
	c.JSON(http.StatusOK, gin.H{"pode_executar": true, "comando": true, "preview": prev, "op": acao.Op, "leitura": procedit.EhLeitura(msg, acao)})
}

// ListarSolicitacoes — GET /api/v1/solicitacoes?status=pendente
// status omitido = todas (ordem: mais recentes primeiro).
func ListarSolicitacoes(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	status := strings.TrimSpace(c.Query("status"))
	mine := c.Query("mine") // "1" = só os pedidos do próprio usuário (p/ o chat avisar quando ficar pronto)
	q := `SELECT id, id_usuario, usuario_nome, mensagem, preview, status, resultado,
	             aprovado_por, criado_em, aprovado_em, executado_em, COALESCE(feedback_solicitante,''),
	             COALESCE(perguntas_json,''),
	             COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('id', a.id, 'nome', a.nome, 'drive_link', a.drive_link))
	                         FROM FT_SOLICITACOES_ANEXOS a WHERE a.id_solicitacao = FT_SOLICITACOES.id), '[]'),
	             COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('autor', m.autor_nome, 'texto', m.mensagem, 'em', DATE_FORMAT(m.criado_em,'%Y-%m-%d %H:%i')))
	                         FROM (SELECT * FROM FT_SOLICITACOES_MSGS WHERE id_solicitacao = FT_SOLICITACOES.id ORDER BY id) m), '[]')
	        FROM FT_SOLICITACOES`
	conds := []string{}
	args := []interface{}{}
	if status != "" {
		conds = append(conds, "status = ?")
		args = append(args, status)
	}
	if mine == "1" || strings.EqualFold(mine, "true") {
		uid, _ := usuarioIA(c)
		conds = append(conds, "id_usuario = ?")
		args = append(args, uid)
	}
	if len(conds) > 0 {
		q += " WHERE " + strings.Join(conds, " AND ")
	}
	q += " ORDER BY criado_em DESC, id DESC LIMIT 500"
	rows, err := sqlDB.Query(q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id int64
		var idU sql.NullInt64
		var nome, msg, prev, st, resu, aprov, criado, aprovEm, execEm, fb, pergJSON, anexosJSON, convJSON sql.NullString
		if err := rows.Scan(&id, &idU, &nome, &msg, &prev, &st, &resu, &aprov, &criado, &aprovEm, &execEm, &fb, &pergJSON, &anexosJSON, &convJSON); err != nil {
			continue
		}
		var perguntas map[string]interface{}
		if pergJSON.Valid && strings.TrimSpace(pergJSON.String) != "" {
			_ = json.Unmarshal([]byte(pergJSON.String), &perguntas)
		}
		var anexos, conversa []interface{}
		if anexosJSON.Valid && anexosJSON.String != "" {
			_ = json.Unmarshal([]byte(anexosJSON.String), &anexos)
		}
		if convJSON.Valid && convJSON.String != "" {
			_ = json.Unmarshal([]byte(convJSON.String), &conversa)
		}
		if anexos == nil {
			anexos = []interface{}{}
		}
		if conversa == nil {
			conversa = []interface{}{}
		}
		out = append(out, gin.H{
			"id": id, "id_usuario": solInt(idU), "usuario_nome": solStr(nome), "mensagem": solStr(msg),
			"preview": solStr(prev), "status": solStr(st), "resultado": solStr(resu), "aprovado_por": solStr(aprov),
			"criado_em": solStr(criado), "aprovado_em": solStr(aprovEm), "executado_em": solStr(execEm),
			"feedback_solicitante": solStr(fb), "perguntas": perguntas, "anexos": anexos, "conversa": conversa,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// ehAprovador — aprovar solicitações é EXCLUSIVO do(s) aprovador(es) designado(s).
// Checa por E-MAIL (env SOLIC_APROVADORES) OU por ID de usuário (env SOLIC_APROVADORES_IDS,
// padrão "1" = Alisson). O id vem SEMPRE no contexto (middleware antigo), então funciona
// mesmo que o userEmail não tenha sido injetado no build atual.
func ehAprovador(c *gin.Context) bool {
	// por e-mail (se disponível)
	if v, ok := c.Get("userEmail"); ok {
		email := strings.ToLower(strings.TrimSpace(fmt.Sprint(v)))
		if email != "" {
			lista := strings.TrimSpace(os.Getenv("SOLIC_APROVADORES"))
			if lista == "" {
				lista = "alisson.rodrigues@amee.com.br"
			}
			for _, e := range strings.Split(lista, ",") {
				if email == strings.ToLower(strings.TrimSpace(e)) {
					return true
				}
			}
		}
	}
	// por id de usuário (sempre presente no contexto)
	if v, ok := c.Get("userID"); ok {
		if id, ok2 := v.(int64); ok2 {
			ids := strings.TrimSpace(os.Getenv("SOLIC_APROVADORES_IDS"))
			if ids == "" {
				ids = "1"
			}
			for _, s := range strings.Split(ids, ",") {
				if strings.TrimSpace(s) == fmt.Sprint(id) {
					return true
				}
			}
		}
	}
	return false
}

// SouAprovador — GET /api/v1/solicitacoes/sou-aprovador  → { "aprovador": bool }
// O front usa p/ mostrar/ocultar o painel e o botão "Aprovar" só para o aprovador.
func SouAprovador(c *gin.Context) {
	if solicDB(c) == nil {
		return
	}
	c.JSON(http.StatusOK, gin.H{"aprovador": ehAprovador(c)})
}

// AprovarSolicitacao — PUT /api/v1/solicitacoes/:id/aprovar  (EXCLUSIVO do aprovador designado)
func AprovarSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	if !ehAprovador(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "apenas o aprovador designado pode aprovar solicitações"})
		return
	}
	id := c.Param("id")
	_, uname := usuarioIA(c)
	r, err := sqlDB.Exec(
		`UPDATE FT_SOLICITACOES SET status='aprovado', aprovado_por=?, aprovado_em=NOW()
		  WHERE id=? AND status='pendente'`, uname, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "solicitação não está pendente"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": "aprovado"})
}

// RejeitarSolicitacao — DELETE /api/v1/solicitacoes/:id  (gestor deleta/rejeita)
func RejeitarSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	// delete definitivo (o gestor pediu "deletar o que foi pedido")
	r, err := sqlDB.Exec("DELETE FROM FT_SOLICITACOES WHERE id=?", id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	n, _ := r.RowsAffected()
	c.JSON(http.StatusOK, gin.H{"ok": true, "removidas": n})
}

// ResultadoSolicitacao — PUT /api/v1/solicitacoes/:id/resultado
// Usado pelo executor (Claude) p/ marcar 'executado'/'erro' e gravar o retorno.
func ResultadoSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	var body struct {
		Status    string      `json:"status"` // executado | erro | preciso_confirmar
		Resultado string      `json:"resultado"`
		Perguntas interface{} `json:"perguntas"` // só quando status=preciso_confirmar: {perguntas:[{texto,opcoes,permite_texto}]}
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	// preciso_confirmar: o worker precisa de uma info do solicitante. Guarda as perguntas
	// (linguagem simples) e sai da fila até o solicitante responder.
	if body.Status == "preciso_confirmar" {
		pj := ""
		if body.Perguntas != nil {
			if b, e := json.Marshal(body.Perguntas); e == nil {
				pj = string(b)
			}
		}
		if strings.TrimSpace(pj) == "" || pj == "null" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "perguntas obrigatórias para preciso_confirmar"})
			return
		}
		_, err := sqlDB.Exec(
			`UPDATE FT_SOLICITACOES SET status='preciso_confirmar', perguntas_json=?, resultado=?, executado_em=NOW() WHERE id=?`,
			pj, solNull(body.Resultado), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "status": "preciso_confirmar"})
		return
	}
	if body.Status != "executado" && body.Status != "erro" {
		body.Status = "executado"
	}
	_, err := sqlDB.Exec(
		`UPDATE FT_SOLICITACOES SET status=?, resultado=?, executado_em=NOW() WHERE id=?`,
		body.Status, body.Resultado, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetProtocolo — GET /api/v1/solicitacoes/:id/protocolo
// Mostra o que foi pedido (protocolo = id da solicitação) + o log de alterações
// (nome, horário, valor_antigo→valor_novo) + se ainda é reversível.
func GetProtocolo(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")

	var sid int64
	var nome, msg, st, resu, aprov, criado, aprovEm, execEm sql.NullString
	err := sqlDB.QueryRow(
		`SELECT id, usuario_nome, mensagem, status, resultado, aprovado_por, criado_em, aprovado_em, executado_em
		   FROM FT_SOLICITACOES WHERE id=?`, id).
		Scan(&sid, &nome, &msg, &st, &resu, &aprov, &criado, &aprovEm, &execEm)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "protocolo não encontrado"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// log de alterações do backup
	alt := []gin.H{}
	reversivel := 0
	rows, _ := sqlDB.Query(
		`SELECT usuario_nome, acao, tabela, coluna, valor_antigo, valor_novo, criado_em, revertido_em
		   FROM FT_EXECUTOR_BACKUP WHERE id_solicitacao=? ORDER BY id`, id)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var un, ac, tb, col, va, vn, cr, rev sql.NullString
			if err := rows.Scan(&un, &ac, &tb, &col, &va, &vn, &cr, &rev); err != nil {
				continue
			}
			if !rev.Valid && solTabelasReversiveis[solStr(tb)] {
				reversivel++
			}
			alt = append(alt, gin.H{
				"usuario_nome": solStr(un), "acao": solStr(ac), "tabela": solStr(tb),
				"coluna": solStr(col), "valor_antigo": solStr(va), "valor_novo": solStr(vn),
				"criado_em": solStr(cr), "revertido_em": solStr(rev),
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"protocolo": sid,
		"solicitacao": gin.H{
			"id": sid, "usuario_nome": solStr(nome), "mensagem": solStr(msg), "status": solStr(st),
			"resultado": solStr(resu), "aprovado_por": solStr(aprov), "criado_em": solStr(criado),
			"aprovado_em": solStr(aprovEm), "executado_em": solStr(execEm),
		},
		"alteracoes":     alt,
		"pode_reverter":  reversivel > 0,
		"qtd_reversivel": reversivel,
	})
}

// ReverterSolicitacao — POST /api/v1/solicitacoes/:id/reverter  (gestor/admin)
// Restaura valor_antigo de cada alteração do protocolo que ainda não foi revertida.
// Só mexe em tabelas de processo (limitador). Marca revertido_em e status='revertido'.
func ReverterSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	_, uname := usuarioIA(c)

	rows, err := sqlDB.Query(
		`SELECT id, tabela, pk_coluna, pk_valor, coluna, valor_antigo
		   FROM FT_EXECUTOR_BACKUP WHERE id_solicitacao=? AND revertido_em IS NULL`, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	type chg struct {
		bid                           int64
		tabela, pkCol, pkVal, col, va string
	}
	var changes []chg
	for rows.Next() {
		var ch chg
		var tb, pkc, pkv, col, va sql.NullString
		if err := rows.Scan(&ch.bid, &tb, &pkc, &pkv, &col, &va); err != nil {
			continue
		}
		ch.tabela, ch.pkCol, ch.pkVal, ch.col, ch.va = solStr(tb), solStr(pkc), solStr(pkv), solStr(col), solStr(va)
		changes = append(changes, ch)
	}
	rows.Close()

	if len(changes) == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "nada a reverter neste protocolo (sem alterações pendentes)"})
		return
	}

	revertidas := 0
	for _, ch := range changes {
		// LIMITADOR + validação de identificadores (vêm da nossa própria tabela, mas conferimos)
		if !solTabelasReversiveis[ch.tabela] || !solIdentOK.MatchString(ch.tabela) || !solIdentOK.MatchString(ch.pkCol) {
			continue
		}
		var q string
		var args []interface{}
		if ch.col == "__inserido__" {
			// linha inserida (ex.: histórico/anexo) → reverter = DELETE
			q = fmt.Sprintf("DELETE FROM `%s` WHERE `%s`=?", ch.tabela, ch.pkCol)
			args = []interface{}{ch.pkVal}
		} else {
			if !solIdentOK.MatchString(ch.col) {
				continue
			}
			var val interface{}
			if ch.va == "" || ch.va == "NULL" {
				val = nil
			} else {
				val = ch.va
			}
			q = fmt.Sprintf("UPDATE `%s` SET `%s`=? WHERE `%s`=?", ch.tabela, ch.col, ch.pkCol)
			args = []interface{}{val, ch.pkVal}
		}
		if _, err := sqlDB.Exec(q, args...); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("falha ao reverter %s: %v", ch.tabela, err)})
			return
		}
		_, _ = sqlDB.Exec("UPDATE FT_EXECUTOR_BACKUP SET revertido_em=NOW() WHERE id=?", ch.bid)
		revertidas++
	}

	_, _ = sqlDB.Exec(
		`UPDATE FT_SOLICITACOES
		    SET status='revertido',
		        resultado=CONCAT(COALESCE(resultado,''), ' | REVERTIDO por ', ?, ' em ', NOW())
		  WHERE id=?`, uname, id)

	c.JSON(http.StatusOK, gin.H{"ok": true, "status": "revertido", "campos_revertidos": revertidas})
}

// UploadAnexoSolicitacao — POST /api/v1/solicitacoes/:id/anexo  (multipart "arquivo")
// O solicitante anexa um arquivo ao próprio pedido.
func UploadAnexoSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	fh, err := c.FormFile("arquivo")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "arquivo ausente"})
		return
	}
	const maxBytes = 9 << 20 // ~9 MB
	if fh.Size > maxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "arquivo muito grande (máx. 9 MB)"})
		return
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	buf, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	nome := filepath.Base(fh.Filename)
	res, err := sqlDB.Exec(
		`INSERT INTO FT_SOLICITACOES_ANEXOS (id_solicitacao, nome, mime, tamanho, conteudo) VALUES (?,?,?,?,?)`,
		id, nome, fh.Header.Get("Content-Type"), len(buf), buf)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	aid, _ := res.LastInsertId()
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": aid, "nome": nome})
}

// CorrigirSolicitacao — POST /api/v1/solicitacoes/:id/corrigir  { "mensagem": "o que corrigir" }
// O SOLICITANTE rejeita o resultado e diz o que está errado/o que corrigir. Isso: grava a
// mensagem na conversa do pedido, anexa a correção ao texto do pedido, e RE-ENFILEIRA
// (volta para 'pendente', reinterpreta) para ser reprocessado com a correção.
func CorrigirSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	var body struct {
		Mensagem string `json:"mensagem"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	nota := strings.TrimSpace(body.Mensagem)
	if nota == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "descreva o que corrigir"})
		return
	}
	uid, uname := usuarioIA(c)

	// confere que o pedido é do próprio solicitante
	var dono sql.NullInt64
	var msgAtual sql.NullString
	if err := sqlDB.QueryRow("SELECT id_usuario, mensagem FROM FT_SOLICITACOES WHERE id=?", id).Scan(&dono, &msgAtual); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "pedido não encontrado"})
		return
	}
	if !dono.Valid || dono.Int64 != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "este pedido não é seu"})
		return
	}

	// TRAVA DE PERFIL: a correção não pode transformar um pedido em alteração de dados.
	// Reinterpreta o texto resultante (pedido + correção); se virar escrita e o usuário
	// não for gestor/admin, bloqueia antes de gravar qualquer coisa.
	if !podeAlterar(c) {
		combinada := msgAtual.String + "\n" + nota
		acaoC, _, _, _ := procedit.Montar(sqlDB, combinada)
		if !procedit.EhLeitura(combinada, acaoC) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Seu perfil permite apenas consultas e relatórios. Alterações no sistema precisam ser solicitadas por um gestor."})
			return
		}
	}

	_, _ = sqlDB.Exec(`INSERT INTO FT_SOLICITACOES_MSGS (id_solicitacao, autor_nome, mensagem) VALUES (?,?,?)`, id, uname, nota)
	_, _ = sqlDB.Exec(`UPDATE FT_SOLICITACOES
	    SET mensagem = CONCAT(mensagem, '\n\n[Correção de ', ?, ']: ', ?),
	        status='pendente', executado_em=NULL, acao_json=NULL,
	        aprovado_por=NULL, aprovado_em=NULL, -- correção = pedido NOVO: volta p/ a aprovação do gestor
	        feedback_solicitante=NULL, feedback_em=NULL
	  WHERE id=?`, uname, nota, id)

	// reinterpreta a mensagem já corrigida → acao_json atualizado
	var novaMsg sql.NullString
	_ = sqlDB.QueryRow("SELECT mensagem FROM FT_SOLICITACOES WHERE id=?", id).Scan(&novaMsg)
	var acaoJSON interface{}
	var acaoPtr *procedit.Acao
	if acao, _, ok, _ := procedit.Montar(sqlDB, novaMsg.String); ok {
		acaoPtr = acao
		marcarPerfilRelatorio(c, acao)
		if b, e := json.Marshal(acao); e == nil {
			acaoJSON = string(b)
		}
	}
	// Mesma regra da criação (CriarSolicitacao): consulta/relatório NÃO volta p/ aprovação
	// — relatório da whitelist já sai 'aprovado' e o executor roda; consulta livre vai p/ o
	// worker ('revisao'). Pedido do próprio aprovador também não espera ninguém. Só alteração
	// de dado pedida por outra pessoa fica 'pendente'. (21/10/2026: correção de relatório do
	// Alisson caía na aprovação dele mesmo.)
	status, aprovPor := "pendente", interface{}(nil)
	if procedit.EhLeitura(novaMsg.String, acaoPtr) {
		if acaoPtr != nil {
			status, aprovPor = "aprovado", "automático (consulta)"
		} else {
			status = "revisao"
		}
	} else if ehAprovador(c) {
		status, aprovPor = "aprovado", uname+" (pedido do próprio aprovador)"
	}
	_, _ = sqlDB.Exec(`UPDATE FT_SOLICITACOES SET acao_json=?, status=?, aprovado_por=?,
	    aprovado_em=IF(? IS NULL, NULL, NOW()) WHERE id=?`, acaoJSON, status, aprovPor, aprovPor, id)

	c.JSON(http.StatusOK, gin.H{"ok": true, "status": status})
}

// ResponderConfirmacao — POST /api/v1/solicitacoes/:id/responder-confirmacao
//
//	{ "respostas": ["...", "..."], "texto": "..." }
//
// O SOLICITANTE responde às perguntas simples que o worker fez (status 'preciso_confirmar').
// A resposta é anexada ao pedido e ele volta para a fila do worker ('revisao') para continuar
// de onde parou, agora com a informação que faltava.
func ResponderConfirmacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	var body struct {
		Respostas []string `json:"respostas"`
		Texto     string   `json:"texto"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	uid, uname := usuarioIA(c)

	// só o próprio solicitante responde; e só se estiver aguardando confirmação
	var dono sql.NullInt64
	var st, pergJSON sql.NullString
	if err := sqlDB.QueryRow("SELECT id_usuario, status, COALESCE(perguntas_json,'') FROM FT_SOLICITACOES WHERE id=?", id).
		Scan(&dono, &st, &pergJSON); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "pedido não encontrado"})
		return
	}
	if !dono.Valid || dono.Int64 != uid {
		c.JSON(http.StatusForbidden, gin.H{"error": "este pedido não é seu"})
		return
	}
	if solStr(st) != "preciso_confirmar" {
		c.JSON(http.StatusConflict, gin.H{"error": "este pedido não está aguardando a sua confirmação"})
		return
	}

	// monta um texto legível: casa cada pergunta com a resposta dada
	var perg struct {
		Perguntas []struct {
			Texto string `json:"texto"`
		} `json:"perguntas"`
	}
	_ = json.Unmarshal([]byte(solStr(pergJSON)), &perg)
	var bloco strings.Builder
	bloco.WriteString("[Resposta do solicitante]")
	for i, r := range body.Respostas {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		pq := ""
		if i < len(perg.Perguntas) {
			pq = strings.TrimSpace(perg.Perguntas[i].Texto)
		}
		if pq != "" {
			bloco.WriteString("\n- " + pq + " → " + r)
		} else {
			bloco.WriteString("\n- " + r)
		}
	}
	if tx := strings.TrimSpace(body.Texto); tx != "" {
		bloco.WriteString("\n- " + tx)
	}
	resposta := bloco.String()
	if resposta == "[Resposta do solicitante]" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "responda ao menos uma pergunta"})
		return
	}

	_, _ = sqlDB.Exec(`INSERT INTO FT_SOLICITACOES_MSGS (id_solicitacao, autor_nome, mensagem) VALUES (?,?,?)`, id, uname, resposta)
	// re-enfileira para o worker: anexa a resposta à mensagem, limpa resultado/perguntas e
	// volta para 'revisao' com executado_em NULL (o has_work.py volta a enxergar o pedido).
	_, err := sqlDB.Exec(`UPDATE FT_SOLICITACOES
	    SET mensagem = CONCAT(mensagem, '\n\n', ?),
	        resposta_confirmacao = ?,
	        perguntas_json = NULL,
	        resultado = NULL,
	        status = 'revisao',
	        executado_em = NULL
	  WHERE id=? AND status='preciso_confirmar'`, resposta, resposta, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": "revisao"})
}

// BaixarAnexoSolicitacao — GET /api/v1/solicitacoes/:id/anexo/:aid
func BaixarAnexoSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	var nome, mime sql.NullString
	var conteudo []byte
	err := sqlDB.QueryRow(
		`SELECT nome, COALESCE(mime,''), conteudo FROM FT_SOLICITACOES_ANEXOS WHERE id=? AND id_solicitacao=?`,
		c.Param("aid"), c.Param("id")).Scan(&nome, &mime, &conteudo)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "anexo não encontrado"})
		return
	}
	ct := mime.String
	if ct == "" {
		ct = "application/octet-stream"
	}
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, nome.String))
	c.Data(http.StatusOK, ct, conteudo)
}

// FeedbackSolicitacao — PUT /api/v1/solicitacoes/:id/feedback  { "verdict": "aprovado"|"rejeitado" }
// O SOLICITANTE avalia o resultado entregue (diferente da aprovação do gestor p/ executar).
func FeedbackSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	var body struct {
		Verdict string `json:"verdict"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	v := strings.ToLower(strings.TrimSpace(body.Verdict))
	if v != "aprovado" && v != "rejeitado" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "verdict deve ser 'aprovado' ou 'rejeitado'"})
		return
	}
	uid, _ := usuarioIA(c)
	// só o próprio solicitante avalia o próprio pedido
	r, err := sqlDB.Exec(
		`UPDATE FT_SOLICITACOES SET feedback_solicitante=?, feedback_em=NOW() WHERE id=? AND id_usuario=?`,
		v, id, uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if n, _ := r.RowsAffected(); n == 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": "pedido não é seu ou não existe"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "feedback": v})
}

// ExportarSolicitacao — GET /api/v1/solicitacoes/:id/export?formato=excel|pdf|word|txt
// (e também /excel por compatibilidade). Converte o resultado num arquivo para download
// no formato escolhido pelo usuário.
func ExportarSolicitacao(c *gin.Context) {
	sqlDB := solicDB(c)
	if sqlDB == nil {
		return
	}
	id := c.Param("id")
	formato := strings.ToLower(strings.TrimSpace(c.Query("formato")))
	if strings.HasSuffix(c.FullPath(), "/excel") || formato == "" {
		formato = "excel"
	}
	var resultado sql.NullString
	if err := sqlDB.QueryRow("SELECT resultado FROM FT_SOLICITACOES WHERE id=?", id).Scan(&resultado); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "solicitação não encontrada"})
		return
	}
	texto := resultado.String
	titulo, header, linhas := parseMarkdownTabela(texto)

	switch formato {
	case "txt":
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="relatorio_sure_%s.txt"`, id))
		c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(texto))
	case "word", "doc":
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="relatorio_sure_%s.doc"`, id))
		c.Data(http.StatusOK, "application/msword; charset=utf-8", []byte(gerarHTMLWord(titulo, header, linhas, texto)))
	case "pdf":
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="relatorio_sure_%s.pdf"`, id))
		c.Data(http.StatusOK, "application/pdf", gerarPDF(titulo, header, linhas, texto))
	default: // excel
		if len(header) == 0 {
			c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "este resultado não tem tabela para exportar como Excel (tente TXT/Word/PDF)"})
			return
		}
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="relatorio_sure_%s.xlsx"`, id))
		c.Header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		if abas := parseMarkdownAbas(texto); len(abas) > 1 {
			_ = gerarExcelAbas(abas).Write(c.Writer) // relatório com várias tabelas → 1 aba cada
			return
		}
		_ = gerarExcel(titulo, header, linhas).Write(c.Writer)
	}
}

func gerarExcel(titulo string, header []string, linhas [][]string) *excelize.File {
	f := excelize.NewFile()
	sh := "Relatório"
	idx, _ := f.NewSheet(sh)
	f.DeleteSheet("Sheet1")
	f.SetActiveSheet(idx)
	linha := 1
	if titulo != "" {
		f.SetCellValue(sh, "A1", titulo)
		st, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true, Size: 12}})
		f.SetCellStyle(sh, "A1", "A1", st)
		linha = 3
	}
	hstyle, _ := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true, Color: "FFFFFF"},
		Fill: excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"1E3A5F"}},
	})
	for ci, hd := range header {
		cell, _ := excelize.CoordinatesToCellName(ci+1, linha)
		f.SetCellValue(sh, cell, hd)
		f.SetCellStyle(sh, cell, cell, hstyle)
	}
	for _, row := range linhas {
		linha++
		for ci, v := range row {
			cell, _ := excelize.CoordinatesToCellName(ci+1, linha)
			f.SetCellValue(sh, cell, v)
		}
	}
	for ci := range header {
		col, _ := excelize.ColumnNumberToName(ci + 1)
		_ = f.SetColWidth(sh, col, col, 22)
	}
	return f
}

func gerarHTMLWord(titulo string, header []string, linhas [][]string, texto string) string {
	var b strings.Builder
	b.WriteString(`<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt">`)
	if titulo != "" {
		b.WriteString("<h3>" + html.EscapeString(titulo) + "</h3>")
	}
	if len(header) > 0 {
		b.WriteString(`<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse"><tr style="background:#1E3A5F;color:#fff">`)
		for _, hd := range header {
			b.WriteString("<th>" + html.EscapeString(hd) + "</th>")
		}
		b.WriteString("</tr>")
		for _, row := range linhas {
			b.WriteString("<tr>")
			for _, v := range row {
				b.WriteString("<td>" + html.EscapeString(v) + "</td>")
			}
			b.WriteString("</tr>")
		}
		b.WriteString("</table>")
	} else {
		b.WriteString("<pre style=\"white-space:pre-wrap\">" + html.EscapeString(texto) + "</pre>")
	}
	b.WriteString("</body></html>")
	return b.String()
}

func gerarPDF(titulo string, header []string, linhas [][]string, texto string) []byte {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.SetMargins(12, 12, 12)
	pdf.AddPage()
	tr := pdf.UnicodeTranslatorFromDescriptor("") // cp1252 p/ acentos
	if titulo != "" {
		pdf.SetFont("Arial", "B", 13)
		pdf.MultiCell(0, 7, tr(titulo), "", "L", false)
		pdf.Ln(2)
	}
	if len(header) > 0 {
		nc := len(header)
		w := 186.0 / float64(nc)
		pdf.SetFont("Arial", "B", 8)
		pdf.SetFillColor(30, 58, 95)
		pdf.SetTextColor(255, 255, 255)
		for _, hd := range header {
			pdf.CellFormat(w, 6, tr(hd), "1", 0, "L", true, 0, "")
		}
		pdf.Ln(-1)
		pdf.SetFont("Arial", "", 8)
		pdf.SetTextColor(0, 0, 0)
		for _, row := range linhas {
			for i := 0; i < nc; i++ {
				v := ""
				if i < len(row) {
					v = row[i]
				}
				pdf.CellFormat(w, 5, tr(v), "1", 0, "L", false, 0, "")
			}
			pdf.Ln(-1)
		}
	} else {
		pdf.SetFont("Arial", "", 10)
		pdf.MultiCell(0, 5, tr(texto), "", "L", false)
	}
	var buf bytes.Buffer
	_ = pdf.Output(&buf)
	return buf.Bytes()
}

var reMDSep = regexp.MustCompile(`^:?-{2,}:?$`)

// parseMarkdownTabela extrai (título, cabeçalho, linhas) de um resultado em markdown.
func parseMarkdownTabela(txt string) (titulo string, header []string, linhas [][]string) {
	for _, ln := range strings.Split(txt, "\n") {
		t := strings.TrimSpace(ln)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "### ") {
			if header != nil {
				break // várias abas: Word/PDF/prévia usam a 1ª tabela; o Excel traz todas
			}
			continue
		}
		if strings.HasPrefix(t, "|") {
			cells := splitMDRow(t)
			allSep := len(cells) > 0
			for _, cc := range cells {
				if !reMDSep.MatchString(strings.TrimSpace(cc)) {
					allSep = false
					break
				}
			}
			if allSep {
				continue // linha separadora |---|
			}
			if header == nil {
				header = cells
			} else {
				linhas = append(linhas, cells)
			}
		} else if titulo == "" && header == nil {
			titulo = strings.TrimSpace(strings.TrimLeft(t, "📊📥🧾⚠️↩️✅🔴🎙️ "))
		}
	}
	return
}

func splitMDRow(t string) []string {
	t = strings.Trim(t, "|")
	parts := strings.Split(t, "|")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}

// helpers locais (prefixo sol* p/ nao colidir com outros handlers)
func solNull(v string) interface{} {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return v
}
func solStr(ns sql.NullString) string {
	if ns.Valid {
		return ns.String
	}
	return ""
}
func solInt(ni sql.NullInt64) int64 {
	if ni.Valid {
		return ni.Int64
	}
	return 0
}

// abaMD = uma tabela do resultado, com o nome do "### Nome" que vem antes dela.
type abaMD struct {
	nome   string
	header []string
	linhas [][]string
}

// parseMarkdownAbas lê TODAS as tabelas do resultado (cada uma sob "### Nome").
func parseMarkdownAbas(txt string) []abaMD {
	var abas []abaMD
	nome := ""
	aberta := false
	for _, ln := range strings.Split(txt, "\n") {
		t := strings.TrimSpace(ln)
		if strings.HasPrefix(t, "### ") {
			nome = strings.TrimSpace(t[4:])
			aberta = false
			continue
		}
		if !strings.HasPrefix(t, "|") {
			continue
		}
		cells := splitMDRow(t)
		allSep := len(cells) > 0
		for _, cc := range cells {
			if !reMDSep.MatchString(strings.TrimSpace(cc)) {
				allSep = false
				break
			}
		}
		if allSep {
			continue
		}
		if !aberta {
			abas = append(abas, abaMD{nome: nome, header: cells})
			aberta = true
			continue
		}
		abas[len(abas)-1].linhas = append(abas[len(abas)-1].linhas, cells)
	}
	return abas
}

// gerarExcelAbas: uma planilha por tabela (nome ≤ 31 chars, sem []:*?/\, sem repetir).
func gerarExcelAbas(abas []abaMD) *excelize.File {
	f := excelize.NewFile()
	hstyle, _ := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true, Color: "FFFFFF"},
		Fill: excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"1E3A5F"}},
	})
	usados := map[string]bool{}
	ruim := strings.NewReplacer("[", "", "]", "", ":", "-", "*", "", "?", "", "/", "-", `\`, "-")
	for i, a := range abas {
		nm := strings.TrimSpace(ruim.Replace(a.nome))
		if nm == "" {
			nm = fmt.Sprintf("Tabela %d", i+1)
		}
		if r := []rune(nm); len(r) > 31 {
			nm = string(r[:31])
		}
		base := nm
		for k := 2; usados[strings.ToLower(nm)]; k++ {
			suf := fmt.Sprintf(" (%d)", k)
			r := []rune(base)
			if len(r)+len(suf) > 31 {
				r = r[:31-len(suf)]
			}
			nm = string(r) + suf
		}
		usados[strings.ToLower(nm)] = true
		idx, _ := f.NewSheet(nm)
		if i == 0 {
			f.SetActiveSheet(idx)
		}
		for ci, hd := range a.header {
			cell, _ := excelize.CoordinatesToCellName(ci+1, 1)
			f.SetCellValue(nm, cell, hd)
			f.SetCellStyle(nm, cell, cell, hstyle)
		}
		for ri, row := range a.linhas {
			for ci, v := range row {
				cell, _ := excelize.CoordinatesToCellName(ci+1, ri+2)
				f.SetCellValue(nm, cell, v)
			}
		}
		for ci, hd := range a.header {
			col, _ := excelize.ColumnNumberToName(ci + 1)
			w := 22.0
			if hd == "Comentário" {
				w = 90
			}
			_ = f.SetColWidth(nm, col, col, w)
		}
		_ = f.SetPanes(nm, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})
	}
	f.DeleteSheet("Sheet1")
	return f
}
