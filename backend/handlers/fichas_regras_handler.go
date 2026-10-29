package handlers

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// ============================================================================
// Catálogo de Regras (fichas F01–F61) — página /regras.
//
//   - DM_FICHAS_REGRAS: texto editável de cada regra (interpretação + aplicação).
//     Semeada a partir de data/fichas_seed.json (gerado do CATALOGO_INTERPRETACAO_MASTER)
//     com INSERT IGNORE — edições feitas na tela NUNCA são sobrescritas pelo seed.
//   - DM_FICHAS_REGRAS_BACKUP: cada "Alterar" grava o antes/depois (reversível).
//   - FT_TESTES_REGRA: fila de testes "fatura × regras". O PDF fica no próprio banco
//     (LONGBLOB em FT_TESTES_REGRA_ARQUIVOS, como FT_SOLICITACOES_ANEXOS; 1 a 13 faturas da mesma UC); quem processa é o agente claude -p da
//     VPS (worker/run_testes_regras.sh), que pega status='pendente', grava o laudo em
//     `resultado` e marca 'concluido'. O front faz polling do status.
// ============================================================================

//go:embed data/fichas_seed.json
var fichasSeedJSON []byte

type fichaRegra struct {
	Codigo        string  `json:"codigo"`
	Ordem         int     `json:"ordem"`
	Nome          string  `json:"nome"`
	Grupo         string  `json:"grupo"`
	Interpretacao string  `json:"interpretacao"`
	FaturasNecess string  `json:"faturas_necessarias"`
	Criterios     string  `json:"criterios"`
	Aplicacao     string  `json:"aplicacao"`
	BaseLegal     string  `json:"base_legal"`
	NoMotor       bool    `json:"no_motor"`
	AtualizadoPor *string `json:"atualizado_por,omitempty"`
	AtualizadoEm  *string `json:"atualizado_em,omitempty"`
}

var (
	fichasTblOnce sync.Once
	reCodigoFicha = regexp.MustCompile(`^F\d{2}$`)
)

func ensureFichasRegrasTables(db *sql.DB) {
	_, _ = db.Exec(`
CREATE TABLE IF NOT EXISTS DM_FICHAS_REGRAS (
  codigo         VARCHAR(8)   NOT NULL PRIMARY KEY,
  ordem          INT          NOT NULL DEFAULT 0,
  nome           VARCHAR(255) NOT NULL,
  grupo          VARCHAR(80)  NULL,
  interpretacao  TEXT         NULL,
  faturas_necessarias TEXT    NULL,
  criterios      TEXT         NULL,
  aplicacao      TEXT         NULL,
  base_legal     TEXT         NULL,
  no_motor       TINYINT      NOT NULL DEFAULT 0,
  atualizado_por VARCHAR(255) NULL,
  atualizado_em  DATETIME     NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	_, _ = db.Exec(`
CREATE TABLE IF NOT EXISTS DM_FICHAS_REGRAS_BACKUP (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  codigo       VARCHAR(8)   NOT NULL,
  valor_antigo TEXT         NULL,
  valor_novo   TEXT         NULL,
  usuario_nome VARCHAR(255) NULL,
  criado_em    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY k_codigo (codigo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	_, _ = db.Exec(`
CREATE TABLE IF NOT EXISTS FT_TESTES_REGRA (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  fichas        TEXT         NOT NULL,              -- "F01,F02,..." (regras a aplicar)
  arquivo_nome  VARCHAR(500) NOT NULL,              -- nome(s) da(s) fatura(s), p/ exibir
  qtd_arquivos  INT          NOT NULL DEFAULT 1,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pendente', -- pendente|processando|concluido|erro|cancelado
  resultado     MEDIUMTEXT   NULL,                  -- laudo (markdown) gravado pelo agente
  id_usuario    BIGINT       NULL,
  usuario_nome  VARCHAR(255) NULL,
  salvo         TINYINT      NOT NULL DEFAULT 0,
  criado_em     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  iniciado_em   DATETIME     NULL,
  concluido_em  DATETIME     NULL,
  KEY k_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	_, _ = db.Exec(`
CREATE TABLE IF NOT EXISTS FT_TESTES_REGRA_ARQUIVOS (
  id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_teste  BIGINT       NOT NULL,
  ordem     INT          NOT NULL DEFAULT 0,
  nome      VARCHAR(255) NOT NULL,
  mime      VARCHAR(120) NULL,
  conteudo  LONGBLOB     NOT NULL,              -- PDF da fatura
  KEY k_teste (id_teste)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

	var seed []fichaRegra
	if err := json.Unmarshal(fichasSeedJSON, &seed); err != nil || len(seed) == 0 {
		return
	}
	// só semeia se faltar regra do catálogo (no dia a dia: 1 consulta e pronto) e,
	// quando precisa, num INSERT único de várias linhas (sem 61 idas ao banco).
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM DM_FICHAS_REGRAS WHERE codigo <= ?`, seed[len(seed)-1].Codigo).Scan(&n)
	if n >= len(seed) {
		return
	}
	vals := make([]string, 0, len(seed))
	args := make([]interface{}, 0, len(seed)*10)
	for _, f := range seed {
		vals = append(vals, "(?,?,?,?,?,?,?,?,?,?)")
		args = append(args, f.Codigo, f.Ordem, f.Nome, f.Grupo, f.Interpretacao, f.FaturasNecess, f.Criterios, f.Aplicacao, f.BaseLegal, b2i(f.NoMotor))
	}
	_, _ = db.Exec(`INSERT IGNORE INTO DM_FICHAS_REGRAS
  (codigo, ordem, nome, grupo, interpretacao, faturas_necessarias, criterios, aplicacao, base_legal, no_motor)
  VALUES `+strings.Join(vals, ","), args...)
}

func fichasDB(c *gin.Context) *sql.DB {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil || sqlDB == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "banco indisponível"})
		return nil
	}
	fichasTblOnce.Do(func() { ensureFichasRegrasTables(sqlDB) })
	return sqlDB
}

func lerFichaRegra(db *sql.DB, codigo string) (*fichaRegra, error) {
	var f fichaRegra
	var grupo, interp, fat, crit, aplic, base, por, em sql.NullString
	var motor int
	err := db.QueryRow(`SELECT codigo, ordem, nome, grupo, interpretacao, faturas_necessarias, criterios, aplicacao, base_legal, no_motor,
  atualizado_por, DATE_FORMAT(atualizado_em,'%Y-%m-%d %H:%i')
  FROM DM_FICHAS_REGRAS WHERE codigo = ?`, codigo).
		Scan(&f.Codigo, &f.Ordem, &f.Nome, &grupo, &interp, &fat, &crit, &aplic, &base, &motor, &por, &em)
	if err != nil {
		return nil, err
	}
	f.Grupo, f.Interpretacao, f.Aplicacao, f.BaseLegal = grupo.String, interp.String, aplic.String, base.String
	f.FaturasNecess, f.Criterios = fat.String, crit.String
	f.NoMotor = motor == 1
	if por.Valid {
		f.AtualizadoPor = &por.String
	}
	if em.Valid {
		f.AtualizadoEm = &em.String
	}
	return &f, nil
}

// ListarFichasRegras — GET /api/v1/fichas-regras
func ListarFichasRegras(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	// UMA consulta para todas as regras (antes era 1 + 61 consultas → página lenta)
	rows, err := db.Query(`SELECT codigo, ordem, nome, grupo, interpretacao, faturas_necessarias, criterios, aplicacao,
  base_legal, no_motor, atualizado_por, DATE_FORMAT(atualizado_em,'%Y-%m-%d %H:%i')
  FROM DM_FICHAS_REGRAS ORDER BY ordem, codigo`)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := make([]fichaRegra, 0, 64)
	for rows.Next() {
		var f fichaRegra
		var grupo, interp, fat, crit, aplic, base, por, em sql.NullString
		var motor int
		if rows.Scan(&f.Codigo, &f.Ordem, &f.Nome, &grupo, &interp, &fat, &crit, &aplic, &base, &motor, &por, &em) != nil {
			continue
		}
		f.Grupo, f.Interpretacao, f.FaturasNecess, f.Criterios = grupo.String, interp.String, fat.String, crit.String
		f.Aplicacao, f.BaseLegal, f.NoMotor = aplic.String, base.String, motor == 1
		if por.Valid {
			f.AtualizadoPor = &por.String
		}
		if em.Valid {
			f.AtualizadoEm = &em.String
		}
		out = append(out, f)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// CriarFichaRegra — POST /api/v1/fichas-regras  {nome, grupo, interpretacao, faturas_necessarias,
// criterios, aplicacao, base_legal}. Cria a PRÓXIMA regra do catálogo (F62, F63…) direto na
// tabela DM_FICHAS_REGRAS (com registro no backup: valor_antigo NULL = foi criada).
func CriarFichaRegra(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	var b struct {
		Nome          string `json:"nome"`
		Grupo         string `json:"grupo"`
		Interpretacao string `json:"interpretacao"`
		FaturasNecess string `json:"faturas_necessarias"`
		Criterios     string `json:"criterios"`
		Aplicacao     string `json:"aplicacao"`
		BaseLegal     string `json:"base_legal"`
	}
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	b.Nome, b.Interpretacao, b.Aplicacao = strings.TrimSpace(b.Nome), strings.TrimSpace(b.Interpretacao), strings.TrimSpace(b.Aplicacao)
	if b.Nome == "" || b.Interpretacao == "" || b.Aplicacao == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nome, interpretação e aplicação são obrigatórios"})
		return
	}
	_, uname := usuarioIA(c)
	tx, err := db.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer func() { _ = tx.Rollback() }()
	// próximo número (trava a tabela p/ dois cadastros simultâneos não pegarem o mesmo código)
	var maxNum, maxOrdem sql.NullInt64
	if err := tx.QueryRow(`SELECT MAX(CAST(SUBSTRING(codigo,2) AS UNSIGNED)), MAX(ordem) FROM DM_FICHAS_REGRAS FOR UPDATE`).Scan(&maxNum, &maxOrdem); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	prox := int(maxNum.Int64) + 1
	if prox > 99 {
		c.JSON(http.StatusConflict, gin.H{"error": "limite de 99 regras atingido"})
		return
	}
	codigo := fmt.Sprintf("F%02d", prox)
	if _, err := tx.Exec(`INSERT INTO DM_FICHAS_REGRAS (codigo, ordem, nome, grupo, interpretacao, faturas_necessarias,
  criterios, aplicacao, base_legal, no_motor, atualizado_por, atualizado_em) VALUES (?,?,?,?,?,?,?,?,?,0,?,NOW())`,
		codigo, maxOrdem.Int64+1, b.Nome, strings.TrimSpace(b.Grupo), b.Interpretacao, strings.TrimSpace(b.FaturasNecess),
		strings.TrimSpace(b.Criterios), b.Aplicacao, strings.TrimSpace(b.BaseLegal), uname); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	novo, _ := json.Marshal(b)
	_, _ = tx.Exec(`INSERT INTO DM_FICHAS_REGRAS_BACKUP (codigo, valor_antigo, valor_novo, usuario_nome) VALUES (?,NULL,?,?)`, codigo, string(novo), uname)
	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	f, _ := lerFichaRegra(db, codigo)
	c.JSON(http.StatusOK, gin.H{"ok": true, "item": f})
}

// AtualizarFichaRegra — PUT /api/v1/fichas-regras/:codigo  {interpretacao, aplicacao, base_legal?}
// Grava backup (antes/depois) em DM_FICHAS_REGRAS_BACKUP.
func AtualizarFichaRegra(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	codigo := strings.ToUpper(c.Param("codigo"))
	if !reCodigoFicha.MatchString(codigo) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "código inválido"})
		return
	}
	var body struct {
		Interpretacao *string `json:"interpretacao"`
		FaturasNecess *string `json:"faturas_necessarias"`
		Criterios     *string `json:"criterios"`
		Aplicacao     *string `json:"aplicacao"`
		BaseLegal     *string `json:"base_legal"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	antes, err := lerFichaRegra(db, codigo)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "regra não encontrada"})
		return
	}
	depois := *antes
	set := func(dst *string, v *string) {
		if v != nil {
			*dst = strings.TrimSpace(*v)
		}
	}
	set(&depois.Interpretacao, body.Interpretacao)
	set(&depois.FaturasNecess, body.FaturasNecess)
	set(&depois.Criterios, body.Criterios)
	set(&depois.Aplicacao, body.Aplicacao)
	set(&depois.BaseLegal, body.BaseLegal)
	if depois.Interpretacao == "" || depois.Aplicacao == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "interpretação e aplicação não podem ficar vazias"})
		return
	}
	_, uname := usuarioIA(c)
	snap := func(f fichaRegra) string {
		b, _ := json.Marshal(map[string]string{"interpretacao": f.Interpretacao, "faturas_necessarias": f.FaturasNecess,
			"criterios": f.Criterios, "aplicacao": f.Aplicacao, "base_legal": f.BaseLegal})
		return string(b)
	}
	tx, err := db.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if _, err = tx.Exec(`INSERT INTO DM_FICHAS_REGRAS_BACKUP (codigo, valor_antigo, valor_novo, usuario_nome) VALUES (?,?,?,?)`,
		codigo, snap(*antes), snap(depois), uname); err == nil {
		_, err = tx.Exec(`UPDATE DM_FICHAS_REGRAS SET interpretacao=?, faturas_necessarias=?, criterios=?, aplicacao=?, base_legal=?,
  atualizado_por=?, atualizado_em=NOW() WHERE codigo=?`,
			depois.Interpretacao, depois.FaturasNecess, depois.Criterios, depois.Aplicacao, depois.BaseLegal, uname, codigo)
	}
	if err != nil {
		_ = tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err = tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	f, _ := lerFichaRegra(db, codigo)
	c.JSON(http.StatusOK, gin.H{"ok": true, "item": f})
}

// CriarTesteRegra — POST /api/v1/fichas-regras/testes
// multipart: arquivos=PDF (1 a 13 faturas da MESMA unidade), fichas="F01,F02"
// Enfileira o teste para o agente da VPS. Devolve o id para o front acompanhar.
func CriarTesteRegra(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	var cods []string
	for _, p := range strings.Split(c.PostForm("fichas"), ",") {
		p = strings.ToUpper(strings.TrimSpace(p))
		if reCodigoFicha.MatchString(p) {
			cods = append(cods, p)
		}
	}
	if len(cods) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "selecione ao menos uma regra"})
		return
	}
	form, err := c.MultipartForm()
	if err != nil || form == nil || len(form.File["arquivos"]) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "anexe ao menos uma fatura (PDF)"})
		return
	}
	fhs := form.File["arquivos"]
	const maxArq, maxBytes, maxTotal = 13, 15 << 20, 80 << 20
	if len(fhs) > maxArq {
		c.JSON(http.StatusBadRequest, gin.H{"error": "máximo de 13 faturas por teste"})
		return
	}
	type arq struct {
		nome, mime string
		buf        []byte
	}
	var arqs []arq
	var nomes []string
	total := 0
	for _, fh := range fhs {
		nome := filepath.Base(fh.Filename)
		if !strings.HasSuffix(strings.ToLower(nome), ".pdf") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "todas as faturas precisam ser PDF: " + nome})
			return
		}
		if fh.Size > maxBytes {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "arquivo muito grande (máx. 15 MB): " + nome})
			return
		}
		f, err := fh.Open()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		buf, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
		f.Close()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		total += len(buf)
		if total > maxTotal {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "o conjunto de faturas passou de 80 MB"})
			return
		}
		arqs = append(arqs, arq{nome, fh.Header.Get("Content-Type"), buf})
		nomes = append(nomes, nome)
	}
	resumo := strings.Join(nomes, ", ")
	if len(resumo) > 480 {
		resumo = resumo[:480] + "…"
	}
	uid, uname := usuarioIA(c)
	tx, err := db.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// entra como 'enviando' e só vira 'pendente' depois que todos os PDFs foram gravados,
	// para o agente nunca pegar um teste pela metade.
	res, err := tx.Exec(`INSERT INTO FT_TESTES_REGRA (fichas, arquivo_nome, qtd_arquivos, status, id_usuario, usuario_nome)
  VALUES (?,?,?,'enviando',?,?)`, strings.Join(cods, ","), resumo, len(arqs), uid, uname)
	var id int64
	if err == nil {
		id, _ = res.LastInsertId()
		for i, a := range arqs {
			if _, err = tx.Exec(`INSERT INTO FT_TESTES_REGRA_ARQUIVOS (id_teste, ordem, nome, mime, conteudo) VALUES (?,?,?,?,?)`,
				id, i+1, a.nome, a.mime, a.buf); err != nil {
				break
			}
		}
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE FT_TESTES_REGRA SET status='pendente' WHERE id=?`, id)
	}
	if err != nil {
		_ = tx.Rollback()
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err = tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id, "status": "pendente", "qtd_arquivos": len(arqs)})
}

// StatusTesteRegra — GET /api/v1/fichas-regras/testes/:id
func StatusTesteRegra(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	var fichas, nome, status string
	var resultado, criado, iniciado, concluido sql.NullString
	var salvo, naFrente int
	err := db.QueryRow(`SELECT fichas, arquivo_nome, status, resultado, salvo,
  DATE_FORMAT(criado_em,'%d/%m/%Y %H:%i:%s'), DATE_FORMAT(iniciado_em,'%d/%m/%Y %H:%i:%s'),
  DATE_FORMAT(concluido_em,'%d/%m/%Y %H:%i:%s'),
  (SELECT COUNT(*) FROM FT_TESTES_REGRA t2 WHERE t2.status IN ('pendente','processando') AND t2.id < t.id)
  FROM FT_TESTES_REGRA t WHERE id = ?`, id).
		Scan(&fichas, &nome, &status, &resultado, &salvo, &criado, &iniciado, &concluido, &naFrente)
	if err == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "teste não encontrado"})
		return
	} else if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id": id, "fichas": strings.Split(fichas, ","), "arquivo_nome": nome, "status": status,
		"resultado": resultado.String, "salvo": salvo == 1, "na_frente": naFrente,
		"criado_em": criado.String, "iniciado_em": iniciado.String, "concluido_em": concluido.String,
	})
}

// CancelarTesteRegra — POST /api/v1/fichas-regras/testes/:id/cancelar  (só se ainda não concluiu)
func CancelarTesteRegra(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	res, err := db.Exec(`UPDATE FT_TESTES_REGRA SET status='cancelado', concluido_em=NOW()
  WHERE id=? AND status IN ('pendente','processando')`, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	n, _ := res.RowsAffected()
	c.JSON(http.StatusOK, gin.H{"ok": true, "cancelado": n > 0})
}

// SalvarTesteRegra — POST /api/v1/fichas-regras/testes/:id/salvar  (guarda o laudo no histórico)
func SalvarTesteRegra(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	id, _ := strconv.ParseInt(c.Param("id"), 10, 64)
	res, err := db.Exec(`UPDATE FT_TESTES_REGRA SET salvo=1 WHERE id=? AND status='concluido'`, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "o teste ainda não foi concluído"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ListarTestesSalvos — GET /api/v1/fichas-regras/testes?codigo=F01  (histórico de testes salvos)
func ListarTestesSalvos(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	q := `SELECT id, fichas, arquivo_nome, usuario_nome, DATE_FORMAT(concluido_em,'%d/%m/%Y %H:%i'), resultado
  FROM FT_TESTES_REGRA WHERE salvo=1`
	args := []interface{}{}
	if cod := strings.ToUpper(strings.TrimSpace(c.Query("codigo"))); reCodigoFicha.MatchString(cod) {
		q += ` AND FIND_IN_SET(?, fichas) > 0`
		args = append(args, cod)
	}
	q += ` ORDER BY id DESC LIMIT 50`
	rows, err := db.Query(q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id int64
		var fichas, nome string
		var usu, quando, resultado sql.NullString
		if rows.Scan(&id, &fichas, &nome, &usu, &quando, &resultado) == nil {
			out = append(out, gin.H{"id": id, "fichas": strings.Split(fichas, ","), "arquivo_nome": nome,
				"usuario_nome": usu.String, "concluido_em": quando.String, "resultado": resultado.String})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// MelhorarFichaRegra — POST /api/v1/fichas-regras/:codigo/melhorar
// {interpretacao, faturas_necessarias, criterios, aplicacao, base_legal} → mesmos campos
// REESCRITOS pela IA: interpreta o que a pessoa escreveu ao alterar e melhora clareza,
// estrutura e completude SEM inventar limites/números. Não grava nada — a pessoa revisa
// na tela e só então clica em Salvar (que faz o backup normal).
func MelhorarFichaRegra(c *gin.Context) {
	db := fichasDB(c)
	if db == nil {
		return
	}
	codigo := strings.ToUpper(c.Param("codigo"))
	atual, err := lerFichaRegra(db, codigo)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "regra não encontrada"})
		return
	}
	var body map[string]string
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "corpo inválido"})
		return
	}
	if openAIKey() == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "IA indisponível (chave não configurada)"})
		return
	}
	entrada, _ := json.Marshal(map[string]string{
		"interpretacao": body["interpretacao"], "faturas_necessarias": body["faturas_necessarias"],
		"criterios": body["criterios"], "aplicacao": body["aplicacao"], "base_legal": body["base_legal"],
	})
	system := `Você é auditor sênior de faturas de energia elétrica (REN ANEEL 1000/2021, PRODIST) e editor técnico.
Recebe os textos de UMA regra do Catálogo de Erros de Faturamento, já alterados por um analista.
Tarefa: INTERPRETAR o que o analista quis dizer e devolver os mesmos 5 campos reescritos com clareza,
corrigindo português, organizando e completando lacunas óbvias — sem mudar a intenção dele.
Regras:
- NÃO invente limites, percentuais, prazos ou artigos que não estejam no texto; se algo essencial faltar,
  escreva "[definir: …]" no ponto exato.
- Mantenha o formato: interpretacao começa com "A regra NN trata de"; faturas_necessarias com linhas
  "Mínimo:", "Ideal:", "Com uma fatura só:"; criterios com linhas "ERRO quando:", "ALERTA quando:",
  "OK quando:", "NÃO SE APLICA quando:", "Limites e tolerâncias:", "Exceções que afastam o erro:";
  aplicacao começa com "Na prática, passo a passo:" e tem passos numerados (1., 2., …), um por linha.
- Primeira pessoa ("eu leio", "eu confiro"), português do Brasil, campos da fatura como aparecem impressos.
- Responda SOMENTE um JSON com as chaves: interpretacao, faturas_necessarias, criterios, aplicacao, base_legal,
  observacoes (1–3 frases dizendo o que você mudou e o que ficou "[definir]").`
	user := fmt.Sprintf("Regra %s — %s (grupo %s).\nTextos alterados pelo analista (JSON):\n%s", codigo, atual.Nome, atual.Grupo, entrada)
	payload, _ := json.Marshal(map[string]interface{}{
		"model":           openAIChatModel(),
		"response_format": map[string]string{"type": "json_object"},
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	})
	ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
	defer cancel()
	if err := acquireSlot(ctx); err != nil {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "IA ocupada, tente novamente em instantes"})
		return
	}
	defer releaseSlot()
	up, err := doOpenAIWithRetry(ctx, payload)
	if err != nil || up.status != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"error": "a IA não respondeu", "status": up.status})
		return
	}
	var resp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(up.body, &resp) != nil || len(resp.Choices) == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"error": "resposta da IA ilegível"})
		return
	}
	var out map[string]string
	if err := json.Unmarshal([]byte(resp.Choices[0].Message.Content), &out); err != nil ||
		strings.TrimSpace(out["interpretacao"]) == "" || strings.TrimSpace(out["aplicacao"]) == "" {
		c.JSON(http.StatusBadGateway, gin.H{"error": "a IA não devolveu os campos esperados"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "sugestao": out})
}
