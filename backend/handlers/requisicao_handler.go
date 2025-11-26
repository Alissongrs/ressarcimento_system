// backend/handlers/requisicao_handler.go
package handlers

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
)

/* ============================================================
   CREATE (stub)
   ============================================================ */

// CreateRequisicao (stub temporário até reimplementação segura)
func CreateRequisicao(c *gin.Context) {
	userIDValue, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	if _, ok := userIDValue.(int64); !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Tipo do ID do usuário inválido"})
		return
	}
	if err := c.Request.ParseMultipartForm(10 << 20); err != nil { // 10MB
		c.JSON(http.StatusBadRequest, gin.H{"error": "Erro ao processar formulário: " + err.Error()})
		return
	}
	c.JSON(http.StatusNotImplemented, gin.H{"error": "Criação de requisição não implementada nesta versão"})
}

/* ============================================================
   HISTÓRICO
   ============================================================ */

// GET /api/requisicoes/:id/historico
func GetHistoricoByRequisicaoID(c *gin.Context) {
	id := c.Param("id")

	type HistoricoItem struct {
		ID                 int    `json:"id"`
		NomeUsuario        string `json:"nome_usuario"`
		StatusAnterior     string `json:"status_anterior"`
		StatusNovo         string `json:"status_novo"`
		StatusComposto     string `json:"status_composto"`
		EtapaAnterior      string `json:"etapa_anterior"`
		EtapaNova          string `json:"etapa_nova"`
		SubEtapaAnterior   string `json:"sub_etapa_anterior"`
		SubEtapaNova       string `json:"sub_etapa_nova"`
		RelevanciaAnterior string `json:"relevancia_anterior"`
		RelevanciaNova     string `json:"relevancia_nova"`
		Comentario         string `json:"comentario"`
		DataMovimentacao   string `json:"data_movimentacao"` // formatada como string
		TipoMovimentacao   string `json:"tipo_movimentacao"`
	}
	historicos := make([]HistoricoItem, 0)

	// --- Tenta "schema novo" (com sub_etapa_anterior/nova e tipo_movimentacao)
	queryNew := `
        SELECT
            h.id_historico,
            IFNULL(u.nome_usuario, 'Sistema') AS nome_usuario,
            IFNULL(
                CASE
                    WHEN COALESCE(h.sub_etapa_anterior,'') <> '' THEN CONCAT(IFNULL(h.etapa_anterior,''), ' - ', h.sub_etapa_anterior)
                    ELSE IFNULL(h.etapa_anterior,'')
                END, ''
            ) AS status_anterior,
            IFNULL(
                CASE
                    WHEN COALESCE(h.sub_etapa_nova,'') <> '' THEN CONCAT(IFNULL(h.etapa_nova,''), ' - ', h.sub_etapa_nova)
                    ELSE IFNULL(h.etapa_nova,'')
                END, ''
            ) AS status_novo,
            IFNULL(
                CASE
                    WHEN COALESCE(h.sub_etapa_nova,'') <> '' THEN CONCAT(IFNULL(h.etapa_nova,''), ' - ', h.sub_etapa_nova)
                    ELSE IFNULL(h.etapa_nova,'')
                END, ''
            ) AS status_composto,
            IFNULL(h.etapa_anterior, '') AS etapa_anterior,
            IFNULL(h.etapa_nova, '')     AS etapa_nova,
            IFNULL(h.sub_etapa_anterior, '') AS sub_etapa_anterior,
            IFNULL(h.sub_etapa_nova, '') AS sub_etapa_nova,
            IFNULL(CAST(h.relevancia_anterior AS CHAR), '') AS relevancia_anterior,
            IFNULL(CAST(h.relevancia_nova AS CHAR), '')     AS relevancia_nova,
            IFNULL(h.comentario, '') AS comentario,
            DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') AS data_movimentacao,
            IFNULL(h.tipo_movimentacao,'') AS tipo_movimentacao
        FROM FT_HISTORICO_MOVIMENTACOES h
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        WHERE h.id_requisicao = ?
        ORDER BY h.data_movimentacao DESC`

	if rows, err := database.DB_App.Query(queryNew, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var it HistoricoItem
			if err := rows.Scan(
				&it.ID,
				&it.NomeUsuario,
				&it.StatusAnterior,
				&it.StatusNovo,
				&it.StatusComposto,
				&it.EtapaAnterior,
				&it.EtapaNova,
				&it.SubEtapaAnterior,
				&it.SubEtapaNova,
				&it.RelevanciaAnterior,
				&it.RelevanciaNova,
				&it.Comentario,
				&it.DataMovimentacao,
				&it.TipoMovimentacao,
			); err != nil {
				continue
			}
			historicos = append(historicos, it)
		}
		if historicos == nil {
			historicos = make([]HistoricoItem, 0)
		}
		// Prepend criação do processo, se houver
		var createdAt string
		if err := database.DB_App.QueryRow("SELECT DATE_FORMAT(data_criacao, '%Y-%m-%d %H:%i:%s') FROM FT_REQUISICOES WHERE id_requisicao = ?", id).Scan(&createdAt); err == nil && createdAt != "" {
			created := HistoricoItem{
				ID:                 0,
				NomeUsuario:        "Sistema",
				StatusAnterior:     "",
				StatusNovo:         "Criação do Processo",
				StatusComposto:     "Criação do Processo",
				EtapaAnterior:      "",
				EtapaNova:          "",
				SubEtapaAnterior:   "",
				SubEtapaNova:       "",
				RelevanciaAnterior: "",
				RelevanciaNova:     "",
				Comentario:         "Processo criado",
				DataMovimentacao:   createdAt,
				TipoMovimentacao:   "criacao",
			}
			historicos = append([]HistoricoItem{created}, historicos...)
		}
		c.JSON(http.StatusOK, historicos)
		return
	}

	// --- Fallback: "schema antigo" (sub_etapa única)
	queryOld := `
        SELECT
            h.id_historico,
            IFNULL(u.nome_usuario, 'Sistema') AS nome_usuario,
            IFNULL(
                CASE
                    WHEN COALESCE(h.sub_etapa,'') <> '' THEN CONCAT(IFNULL(h.etapa_anterior,''), ' - ', h.sub_etapa)
                    ELSE IFNULL(h.etapa_anterior,'')
                END, ''
            ) AS status_anterior,
            IFNULL(
                CASE
                    WHEN COALESCE(h.sub_etapa,'') <> '' THEN CONCAT(IFNULL(h.etapa_nova,''), ' - ', h.sub_etapa)
                    ELSE IFNULL(h.etapa_nova,'')
                END, ''
            ) AS status_novo,
            IFNULL(
                CASE
                    WHEN COALESCE(h.sub_etapa,'') <> '' THEN CONCAT(IFNULL(h.etapa_nova,''), ' - ', h.sub_etapa)
                    ELSE IFNULL(h.etapa_nova,'')
                END, ''
            ) AS status_composto,
            IFNULL(h.etapa_anterior, '') AS etapa_anterior,
            IFNULL(h.etapa_nova, '')     AS etapa_nova,
            IFNULL(h.sub_etapa, '')      AS sub_etapa,
            IFNULL(CAST(h.relevancia_anterior AS CHAR), '') AS relevancia_anterior,
            IFNULL(CAST(h.relevancia_nova AS CHAR), '')     AS relevancia_nova,
            IFNULL(h.comentario, '')     AS comentario,
            DATE_FORMAT(h.data_movimentacao, '%Y-%m-%d %H:%i:%s') AS data_movimentacao
        FROM FT_HISTORICO_MOVIMENTACOES h
        LEFT JOIN DM_USUARIO u ON u.id_usuario = h.id_usuario_gestor
        WHERE h.id_requisicao = ?
        ORDER BY h.data_movimentacao DESC`

	rows2, err2 := database.DB_App.Query(queryOld, id)
	if err2 != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar histórico"})
		return
	}
	defer rows2.Close()
	for rows2.Next() {
		var it HistoricoItem
		var subEtapa string
		if err := rows2.Scan(
			&it.ID,
			&it.NomeUsuario,
			&it.StatusAnterior,
			&it.StatusNovo,
			&it.StatusComposto,
			&it.EtapaAnterior,
			&it.EtapaNova,
			&subEtapa,
			&it.RelevanciaAnterior,
			&it.RelevanciaNova,
			&it.Comentario,
			&it.DataMovimentacao,
		); err != nil {
			continue
		}
		it.SubEtapaAnterior = "" // não existe nesse schema
		it.SubEtapaNova = subEtapa
		it.TipoMovimentacao = ""
		historicos = append(historicos, it)
	}
	if historicos == nil {
		historicos = make([]HistoricoItem, 0)
	}
	// Prepend criação do processo, se houver
	var createdAt string
	if err := database.DB_App.QueryRow("SELECT DATE_FORMAT(data_criacao, '%Y-%m-%d %H:%i:%s') FROM FT_REQUISICOES WHERE id_requisicao = ?", id).Scan(&createdAt); err == nil && createdAt != "" {
		created := HistoricoItem{
			ID:                 0,
			NomeUsuario:        "Sistema",
			StatusAnterior:     "",
			StatusNovo:         "Criação do Processo",
			StatusComposto:     "Criação do Processo",
			EtapaAnterior:      "",
			EtapaNova:          "",
			SubEtapaAnterior:   "",
			SubEtapaNova:       "",
			RelevanciaAnterior: "",
			RelevanciaNova:     "",
			Comentario:         "Processo criado",
			DataMovimentacao:   createdAt,
			TipoMovimentacao:   "criacao",
		}
		historicos = append([]HistoricoItem{created}, historicos...)
	}
	c.JSON(http.StatusOK, historicos)
}

/* ============================================================
   CREATE (versão simples para destravar o front)
   ============================================================ */

// CreateRequisicaoSimple aceita multipart/form-data e retorna 201 com eco dos dados.
// Não persiste em banco nesta versão.
func CreateRequisicaoSimple(c *gin.Context) {
	userIDValue, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	if _, ok := userIDValue.(int64); !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Tipo do ID do usuário inválido"})
		return
	}
	if err := c.Request.ParseMultipartForm(20 << 20); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Erro ao processar formulário: " + err.Error()})
		return
	}

	uc := c.PostForm("uc")
	cliente := c.PostForm("cliente")
	razaoSocialFatura := c.PostForm("razaoSocialFatura")
	concessionaria := c.PostForm("concessionaria")
	cnpj := c.PostForm("cnpj")
	enderecoCompleto := c.PostForm("enderecoCompleto")
	ressarcimentoEstimado := c.PostForm("RessarcimentoEstimado")
	descricaoIrregularidade := c.PostForm("descricaoIrregularidade")
	linkFatura := c.PostForm("linkFatura")
	periodos := c.PostForm("periodosIrregularidade")

	anexos := []string{}
	if form := c.Request.MultipartForm; form != nil {
		if files, ok := form.File["anexos"]; ok {
			for _, f := range files {
				anexos = append(anexos, f.Filename)
			}
		}
	}

	idFake := time.Now().Unix()
	c.JSON(http.StatusCreated, gin.H{
		"id":                       idFake,
		"uc":                       uc,
		"cliente":                  cliente,
		"razao_social_fatura":      razaoSocialFatura,
		"concessionaria":           concessionaria,
		"cnpj":                     cnpj,
		"endereco_completo":        enderecoCompleto,
		"ressarcimento_estimado":   ressarcimentoEstimado,
		"descricao_irregularidade": descricaoIrregularidade,
		"link_fatura":              linkFatura,
		"periodos_irregularidade":  periodos,
		"anexos":                   anexos,
		"message":                  "Requisição recebida (sem persistência nesta versão)",
	})
}

/* ============================================================
   ANEXOS
   ============================================================ */

// GET /api/requisicoes/:id/anexos
func GetAnexosByRequisicaoID(c *gin.Context) {
	id := c.Param("id")

	type AnexoOut struct {
		ID             int    `json:"id"`
		NomeArquivo    string `json:"nome_arquivo"`
		CaminhoArquivo string `json:"caminho_arquivo"`
		EnviadoPor     string `json:"enviado_por"`
		DataUpload     string `json:"data_upload"` // string formatada
	}
	anexos := make([]AnexoOut, 0)

	// Tenta com data_upload
	qNew := `
		SELECT id_anexo, nome_arquivo, caminho_arquivo, enviado_por,
		       DATE_FORMAT(data_upload, '%Y-%m-%d %H:%i:%s') AS data_upload
		FROM FT_ANEXOS
		WHERE id_requisicao = ?
		ORDER BY data_upload DESC`
	if rows, err := database.DB_App.Query(qNew, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var a AnexoOut
			if err := rows.Scan(&a.ID, &a.NomeArquivo, &a.CaminhoArquivo, &a.EnviadoPor, &a.DataUpload); err != nil {
				continue
			}
			anexos = append(anexos, a)
		}
		if anexos == nil {
			anexos = make([]AnexoOut, 0)
		}
		c.JSON(http.StatusOK, anexos)
		return
	}

	// Fallback sem data_upload
	qOld := `
		SELECT id_anexo, nome_arquivo, caminho_arquivo, enviado_por
		FROM FT_ANEXOS
		WHERE id_requisicao = ?`
	rows2, err2 := database.DB_App.Query(qOld, id)
	if err2 != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar anexos"})
		return
	}
	defer rows2.Close()
	for rows2.Next() {
		var a AnexoOut
		if err := rows2.Scan(&a.ID, &a.NomeArquivo, &a.CaminhoArquivo, &a.EnviadoPor); err != nil {
			continue
		}
		a.DataUpload = ""
		anexos = append(anexos, a)
	}
	if anexos == nil {
		anexos = make([]AnexoOut, 0)
	}
	c.JSON(http.StatusOK, anexos)
}

/* ============================================================
   LISTAGEM E DETALHE
   ============================================================ */

// GET /api/requisicoes
func GetAllRequisicoes(c *gin.Context) {
	type RequisicaoListItem struct {
		ID                int     `json:"id"`
		Cliente           string  `json:"cliente"`
		UC                string  `json:"uc"`
		Concessionaria    string  `json:"concessionaria"`
		ValorEstimado     float64 `json:"ressarcimento_estimado"`
		EnderecoCompleto  string  `json:"endereco_completo"`
		Status            string  `json:"status"`
		DataCriacao       string  `json:"data_criacao"`
		DataMudancaStatus string  `json:"data_mudanca_status"`
	}

	base := `
        SELECT
            r.id_requisicao,
            COALESCE(r.cliente,'')               AS cliente,
            COALESCE(r.uc,'')                    AS uc,
            COALESCE(r.concessionaria,'')        AS concessionaria,
            COALESCE(r.ressarcimento_estimado,0) AS ressarcimento_estimado,
            COALESCE(r.endereco_completo,'')     AS endereco_completo,
        COALESCE(s.status,'Nova Requisição') AS status,
            DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS data_criacao,
            DATE_FORMAT(r.data_mudanca_status, '%Y-%m-%d %H:%i:%s') AS data_mudanca_status
        FROM FT_REQUISICOES r
        LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
        ORDER BY r.data_criacao DESC`

	// Suporte opcional a paginação: ?limit=...&offset=...
	limit := strings.TrimSpace(c.Query("limit"))
	offset := strings.TrimSpace(c.Query("offset"))

	var rows *sql.Rows
	var err error
	if limit != "" {
		// Sanitizar para inteiro
		if _, errParse := strconv.Atoi(limit); errParse == nil {
			if offset != "" {
				if _, errOff := strconv.Atoi(offset); errOff == nil {
					rows, err = database.DB_App.Query(base + " LIMIT " + limit + " OFFSET " + offset)
				}
			}
			if rows == nil && err == nil {
				rows, err = database.DB_App.Query(base + " LIMIT " + limit)
			}
		}
	}
	if rows == nil && err == nil {
		// Sem limite explícito: retorna tudo (atenção a volume). Para segurança, pode-se definir um teto via env.
		rows, err = database.DB_App.Query(base)
	}
	if err != nil {
		log.Printf("GetAllRequisicoes: erro na query: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao listar requisições"})
		return
	}
	defer rows.Close()

	list := make([]RequisicaoListItem, 0, 200)
	for rows.Next() {
		var it RequisicaoListItem
		if err := rows.Scan(
			&it.ID,
			&it.Cliente,
			&it.UC,
			&it.Concessionaria,
			&it.ValorEstimado,
			&it.EnderecoCompleto,
			&it.Status,
			&it.DataCriacao,
			&it.DataMudancaStatus,
		); err != nil {
			continue
		}
		list = append(list, it)
	}
	if list == nil {
		list = []RequisicaoListItem{}
	}
	c.JSON(http.StatusOK, list)
}

// GET /api/v1/requisicoes/departamento
// Ajuste de regra: todo usuário autenticado visualiza todas as requisições (sem filtro por departamento).
func GetRequisicoesDepartamento(c *gin.Context) {
	// usuário autenticado (validamos presença apenas)
	if _, ok := c.Get("userID"); !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}

	// role não é mais utilizado para filtrar; mantido apenas para compatibilidade de contexto

	type RequisicaoListItem struct {
		ID                int     `json:"id"`
		Cliente           string  `json:"cliente"`
		UC                string  `json:"uc"`
		Concessionaria    string  `json:"concessionaria"`
		ValorEstimado     float64 `json:"ressarcimento_estimado"`
		EnderecoCompleto  string  `json:"endereco_completo"`
		Status            string  `json:"status"`
		DataCriacao       string  `json:"data_criacao"`
		DataMudancaStatus string  `json:"data_mudanca_status"`
	}

	baseSelect := `
        SELECT
            r.id_requisicao,
            COALESCE(r.cliente,'')               AS cliente,
            COALESCE(r.uc,'')                    AS uc,
            COALESCE(r.concessionaria,'')        AS concessionaria,
            COALESCE(r.ressarcimento_estimado,0) AS ressarcimento_estimado,
            COALESCE(r.endereco_completo,'')     AS endereco_completo,
            COALESCE(s.status,'Nova Requisição') AS status,
            DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS data_criacao,
            DATE_FORMAT(r.data_mudanca_status, '%Y-%m-%d %H:%i:%s') AS data_mudanca_status
        FROM FT_REQUISICOES r
        LEFT JOIN DM_STATUS s ON r.id_status = s.id_status`

	orderBy := " ORDER BY r.data_criacao DESC"

	// paginação opcional
	limit := strings.TrimSpace(c.Query("limit"))
	offset := strings.TrimSpace(c.Query("offset"))

	var (
		rows *sql.Rows
		err  error
	)

	// Regra atual: todos autenticados veem todas as requisições (sem filtro por departamento)
	q := baseSelect + orderBy
	if limit != "" {
		if _, errParse := strconv.Atoi(limit); errParse == nil {
			if offset != "" {
				if _, errOff := strconv.Atoi(offset); errOff == nil {
					rows, err = database.DB_App.Query(q + " LIMIT " + limit + " OFFSET " + offset)
				}
			}
			if rows == nil && err == nil {
				rows, err = database.DB_App.Query(q + " LIMIT " + limit)
			}
		}
	}
	if rows == nil && err == nil {
		rows, err = database.DB_App.Query(q)
	}

	if err != nil {
		log.Printf("GetRequisicoesDepartamento: erro na query: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao listar requisições"})
		return
	}
	defer rows.Close()

	list := make([]RequisicaoListItem, 0, 200)
	for rows.Next() {
		var it RequisicaoListItem
		if err := rows.Scan(
			&it.ID,
			&it.Cliente,
			&it.UC,
			&it.Concessionaria,
			&it.ValorEstimado,
			&it.EnderecoCompleto,
			&it.Status,
			&it.DataCriacao,
			&it.DataMudancaStatus,
		); err != nil {
			continue
		}
		list = append(list, it)
	}
	if list == nil {
		list = []RequisicaoListItem{}
	}
	c.JSON(http.StatusOK, list)
}

// GET /api/requisicoes/:id
func GetRequisicaoByID(c *gin.Context) {
	id := c.Param("id")

	type RequisicaoDetail struct {
		ID                      int     `json:"id"`
		Cliente                 string  `json:"cliente"`
		UC                      string  `json:"uc"`
		Concessionaria          string  `json:"concessionaria"`
		ValorEstimado           float64 `json:"ressarcimento_estimado"`
		EnderecoCompleto        string  `json:"endereco_completo"`
		Status                  string  `json:"status"`
		DataCriacao             string  `json:"data_criacao"`
		CreatedAt               string  `json:"created_at"`
		DescricaoIrregularidade string  `json:"descricao_irregularidade"`
		PeriodosIrregularidade  string  `json:"periodos_irregularidade"`
		LinkFatura              string  `json:"link_fatura"`
	}

	const q = `
        SELECT
            r.id_requisicao,
            COALESCE(r.cliente, '')                AS cliente,
            COALESCE(r.uc, '')                     AS uc,
            COALESCE(r.concessionaria, '')         AS concessionaria,
            COALESCE(r.ressarcimento_estimado, 0)  AS ressarcimento_estimado,
            COALESCE(r.endereco_completo, '')      AS endereco_completo,
        COALESCE(s.status, 'Nova Requisição')  AS status,
            DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS data_criacao,
            DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS created_at,
            COALESCE(r.descricao_irregularidade, '') AS descricao_irregularidade,
            COALESCE(r.periodos_irregularidade, '')  AS periodos_irregularidade,
            COALESCE(r.link_fatura, '')              AS link_fatura
        FROM FT_REQUISICOES r
        LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
        WHERE r.id_requisicao = ?
        LIMIT 1`

	var d RequisicaoDetail
	if err := database.DB_App.QueryRow(q, id).Scan(
		&d.ID,
		&d.Cliente,
		&d.UC,
		&d.Concessionaria,
		&d.ValorEstimado,
		&d.EnderecoCompleto,
		&d.Status,
		&d.DataCriacao,
		&d.CreatedAt,
		&d.DescricaoIrregularidade,
		&d.PeriodosIrregularidade,
		&d.LinkFatura,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Requisição não encontrada"})
			return
		}
		log.Printf("GetRequisicaoByID: erro ao buscar id=%s: %v", id, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar requisição"})
		return
	}

	c.JSON(http.StatusOK, d)
}

// GET /api/requisicoes/:id/faturas
func GetFaturasSelecionadasByRequisicaoID(c *gin.Context) {
    id := c.Param("id")

    type Fat struct {
        Link         string   `json:"link"`
        MesRef       string   `json:"mes_ref"`
        DtVencimento string   `json:"dt_vencimento"`
        ValorTotal   *float64 `json:"valor_total"`
    }
    list := make([]Fat, 0)

    const q = `SELECT link, COALESCE(mes_ref,''), COALESCE(dt_vencimento,''), valor_total
               FROM FT_REQUISICOES_FATURAS
               WHERE id_requisicao = ?
               ORDER BY id ASC`
    rows, err := database.DB_App.Query(q, id)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar faturas"})
        return
    }
    defer rows.Close()
    for rows.Next() {
        var it Fat
        if err := rows.Scan(&it.Link, &it.MesRef, &it.DtVencimento, &it.ValorTotal); err == nil {
            list = append(list, it)
        }
    }
    if list == nil { list = []Fat{} }
    c.JSON(http.StatusOK, gin.H{"faturas": list})
}

/* ============================================================
   UPDATE (com histórico completo)
   ============================================================ */

// POST /api/requisicoes/:id/update
func UpdateRequisicaoCompleta(c *gin.Context) {
	id := c.Param("id")

	// usuário logado
	userIDVal, ok := c.Get("userID")
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	gestorID, _ := userIDVal.(int64)

	// Aceita multipart (com anexos) e JSON (sem anexos)
	var comentario, valorEstimado, etapaPost, subEtapaPost, statusPost string
	var tipoIDPost, subtipoIDPost string
	ctype := strings.ToLower(c.GetHeader("Content-Type"))
	if !strings.Contains(ctype, "multipart/form-data") {
		var body struct {
			Comentario            string `json:"comentario"`
			RessarcimentoEstimado string `json:"ressarcimento_estimado"`
			Etapa                 string `json:"etapa"`
			EtapaAtual            string `json:"etapa_atual"`
			SubEtapa              string `json:"sub_etapa"`
			// opcional: novo status textual (ex.: "Aprovado")
			// não usado neste ramo JSON por ora
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo inválido: " + err.Error()})
			return
		}
		comentario = strings.TrimSpace(body.Comentario)
		valorEstimado = strings.TrimSpace(body.RessarcimentoEstimado)
		etapaPost = strings.TrimSpace(body.EtapaAtual)
		if etapaPost == "" {
			etapaPost = strings.TrimSpace(body.Etapa)
		}
		subEtapaPost = strings.TrimSpace(body.SubEtapa)
	} else {
		// multipart (comentário + arquivos + possivel etapa/subetapa)
		if err := c.Request.ParseMultipartForm(50 << 20); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Form inválido: " + err.Error()})
			return
		}
		comentario = strings.TrimSpace(c.PostForm("comentario"))
		valorEstimado = strings.TrimSpace(c.PostForm("ressarcimento_estimado"))
		statusPost = strings.TrimSpace(c.PostForm("status"))
		tipoIDPost = strings.TrimSpace(c.PostForm("id_tipo_irregularidade"))
		subtipoIDPost = strings.TrimSpace(c.PostForm("id_subtipo_irregularidade"))
		// aceitar tanto "etapa_atual" quanto "etapa"
		etapaPost = strings.TrimSpace(c.PostForm("etapa_atual"))
		if etapaPost == "" {
			etapaPost = strings.TrimSpace(c.PostForm("etapa"))
		}
		subEtapaPost = strings.TrimSpace(c.PostForm("sub_etapa"))
	}

	tx, err := database.DB_App.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	// Atualiza valor estimado, se veio (aceita "," decimal e remove separadores de milhar)
	if valorEstimado != "" {
		norm := strings.ReplaceAll(strings.TrimSpace(valorEstimado), ".", "")
		norm = strings.ReplaceAll(norm, ",", ".")
		if f, err := strconv.ParseFloat(norm, 64); err == nil {
			if _, err := tx.Exec(`
                UPDATE FT_REQUISICOES
                   SET ressarcimento_estimado = ?
                 WHERE id_requisicao = ?`,
				f, id); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar valor estimado"})
				return
			}
		} else {
			// ignora valor inválido silenciosamente
		}
	}

	// Atualiza classificacao (tipo/subtipo) se informados
	if tipoIDPost != "" || subtipoIDPost != "" {
		setParts := make([]string, 0, 2)
		args := make([]interface{}, 0, 3)
		if tipoIDPost != "" {
			setParts = append(setParts, "id_tipo_irregularidade = ?")
			args = append(args, tipoIDPost)
		}
		if subtipoIDPost != "" {
			setParts = append(setParts, "id_subtipo_irregularidade = ?")
			args = append(args, subtipoIDPost)
		}
		q := "UPDATE FT_REQUISICOES SET " + strings.Join(setParts, ", ") + " WHERE id_requisicao = ?"
		args = append(args, id)
		if _, err := tx.Exec(q, args...); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar classificação"})
			return
		}
		// Registrar no histórico (informativo)
		var etapaAtual, subAtual sql.NullString
		_ = tx.QueryRow(`
            SELECT e.etapa, p.sub_etapa
              FROM FT_PROCESSOS p
              JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
             WHERE p.id_processo = ?`,
			id,
		).Scan(&etapaAtual, &subAtual)
		statusComp := strings.TrimSpace(etapaAtual.String)
		if strings.TrimSpace(subAtual.String) != "" {
			statusComp = statusComp + " - " + strings.TrimSpace(subAtual.String)
		}
		if _, err := tx.Exec(`
            INSERT INTO FT_HISTORICO_MOVIMENTACOES
              (id_requisicao, id_usuario_gestor,
               status_anterior, status_novo,
               etapa_anterior, etapa_nova, sub_etapa,
               comentario, data_movimentacao, tipo_movimentacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'classificacao')`,
			id, gestorID,
			statusComp, statusComp,
			etapaAtual.String, etapaAtual.String, subAtual.String,
			"Classificação atualizada",
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar histórico de classificação"})
			return
		}
	}

	// =========================
	// Histórico de comentário (com etapa/subetapa)
	// =========================
	if comentario != "" || etapaPost != "" || subEtapaPost != "" {
		// Busca etapa/subetapa VIGENTES do processo (se existir)
		var etapaAtual, subAtual sql.NullString
		_ = tx.QueryRow(`
			SELECT e.etapa, p.sub_etapa
			  FROM FT_PROCESSOS p
			  JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
			 WHERE p.id_processo = ?`,
			id,
		).Scan(&etapaAtual, &subAtual)

		// Resolve valores finais
		etapaTxt := strings.TrimSpace(etapaAtual.String)
		if etapaPost != "" {
			etapaTxt = etapaPost
		}
		if etapaTxt == "" {
			etapaTxt = "Distribuidora" // fallback sensato (ajuste se desejar)
		}

		subTxt := strings.TrimSpace(subAtual.String)
		if subEtapaPost != "" {
			subTxt = subEtapaPost
		}

		// Monta "Etapa - Subetapa"
		status := etapaTxt
		if subTxt != "" {
			status = status + " - " + subTxt
		}

		if _, err := tx.Exec(`
            INSERT INTO FT_HISTORICO_MOVIMENTACOES
              (id_requisicao, id_usuario_gestor,
               status_anterior, status_novo,
               etapa_anterior, etapa_nova, sub_etapa,
               comentario, data_movimentacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			id, gestorID,
			status, status,
			etapaTxt, etapaTxt, subTxt,
			comentario,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar comentário no histórico"})
			return
		}

		// Sinaliza via SSE atualização de histórico/kanban (inclui sub_etapa)
		go func(pid int, sub string, statusComp string) {
			defer func() { recover() }()
			payload := map[string]interface{}{
				"sub_etapa":       strings.TrimSpace(sub),
				"status_composto": statusComp,
			}
			sse.Broadcast(pid, sse.Event{Type: "processo_update", ProcessoID: pid, Payload: payload})
		}(func() int { v, _ := strconv.Atoi(id); return v }(), subTxt, status)
	}

	// =========================
	// Atualização de status da requisição (se informado)
	if statusPost != "" {
		// Validacoes de negocio: classificacao e prazo
		var currStatus string
		var dataMudanca sql.NullTime
		var tipoAtual sql.NullInt64
		var subtipoAtual sql.NullInt64
		_ = tx.QueryRow(`
            SELECT s.status, r.data_mudanca_status, r.id_tipo_irregularidade, r.id_subtipo_irregularidade
              FROM FT_REQUISICOES r
              LEFT JOIN DM_STATUS s ON s.id_status = r.id_status
             WHERE r.id_requisicao = ?`, id).Scan(&currStatus, &dataMudanca, &tipoAtual, &subtipoAtual)

		if strings.EqualFold(currStatus, "Nova Requisição") && !strings.EqualFold(statusPost, "Nova Requisição") {
			if (!tipoAtual.Valid && strings.TrimSpace(c.PostForm("id_tipo_irregularidade")) == "") ||
				(!subtipoAtual.Valid && strings.TrimSpace(c.PostForm("id_subtipo_irregularidade")) == "") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Preencha Tipo e Subtipo da irregularidade antes de sair de Nova Requisição."})
				return
			}
		}

		prazoDias := 0
		if strings.EqualFold(currStatus, "Nova Requisição") {
			prazoDias = 5
		} else if strings.EqualFold(currStatus, "Em Análise") || strings.EqualFold(currStatus, "Em Analise") {
			prazoDias = 10
		}
		if prazoDias > 0 && dataMudanca.Valid {
			deadline := dataMudanca.Time.Add(time.Duration(prazoDias*24) * time.Hour)
			if time.Now().After(deadline) && strings.TrimSpace(comentario) == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Movimentação vencida: adicione justificativa no comentário."})
				return
			}
		}
		// Busca id do status
		var idStatus int
		if err := tx.QueryRow("SELECT id_status FROM DM_STATUS WHERE status = ?", statusPost).Scan(&idStatus); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Status informado inválido"})
			return
		}
		if _, err := tx.Exec(`
            UPDATE FT_REQUISICOES
               SET id_status = ?, data_mudanca_status = NOW()
             WHERE id_requisicao = ?`, idStatus, id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar status da requisição"})
			return
		}

		// Se aprovado, garantir criação do processo para aparecer no Kanban
		if strings.EqualFold(statusPost, "Aprovado") {
			var cnt int
			if err := tx.QueryRow("SELECT COUNT(1) FROM FT_PROCESSOS WHERE id_processo = ?", id).Scan(&cnt); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao verificar processo"})
				return
			}
			autoCreate := func() bool {
				v := strings.TrimSpace(os.Getenv("AUTO_CREATE_PROCESS_ON_APPROVAL"))
				if v == "" {
					return true
				}
				return strings.EqualFold(v, "true") || v == "1"
			}()
			if cnt == 0 && autoCreate {
				// coluna inicial (DEFAULT: "Ativos"), pode ajustar via env INITIAL_KANBAN_COLUMN
				initialCol := strings.TrimSpace(os.Getenv("INITIAL_KANBAN_COLUMN"))
				if initialCol == "" {
					initialCol = "Ativos"
				}
				var idEtapa int
				if err := tx.QueryRow("SELECT e.id_etapa_processo FROM DM_ETAPAS_PROCESSO e JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban WHERE kc.nome_coluna = ? ORDER BY e.id_etapa_processo ASC LIMIT 1", initialCol).Scan(&idEtapa); err != nil {
					// fallback: menor id de etapa (qualquer)
					_ = tx.QueryRow("SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO ORDER BY id_etapa_processo ASC LIMIT 1").Scan(&idEtapa)
				}
				if idEtapa == 0 {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Etapa inicial não encontrada (Pendente/Distribuidora)"})
					return
				}
				if _, err := tx.Exec(`
                    INSERT INTO FT_PROCESSOS (id_processo, id_etapa_processo, id_responsavel, sub_etapa, relevancia, data_alerta, ultima_atualizacao)
                    VALUES (?, ?, ?, NULL, FALSE, NULL, NOW())`, id, idEtapa, gestorID); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar processo após aprovação"})
					return
				}
				log.Printf("[REQ %s] Processo criado (FT_PROCESSOS) com etapa id=%d", id, idEtapa)
			}
		}
	}

	// Anexos (campo: anexosGestor) - apenas para multipart
	// =========================
	if !strings.HasPrefix(ctype, "application/json") {
		form := c.Request.MultipartForm
		files := form.File["anexosGestor"]
		if len(files) > 0 {
			if err := os.MkdirAll("uploads", os.ModePerm); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao preparar diretório de upload"})
				return
			}
			for _, f := range files {
				name := filepath.Base(f.Filename)
				path := filepath.Join("uploads", fmt.Sprintf("%s-%d-%s", id, time.Now().UnixNano(), name))
				if err := c.SaveUploadedFile(f, path); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao salvar anexo"})
					return
				}
				if _, err := tx.Exec(`
                    INSERT INTO FT_ANEXOS
                    (id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload)
                    VALUES (?, ?, ?, 'gestor', NOW())`,
					id, name, path); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao registrar anexo"})
					return
				}
			}
		}
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar a transação"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":   "Requisição atualizada",
		"sub_etapa": strings.TrimSpace(subEtapaPost),
		"status_composto": func() string {
			if subEtapaPost != "" {
				return strings.TrimSpace(etapaPost) + " - " + strings.TrimSpace(subEtapaPost)
			}
			if etapaPost != "" {
				return strings.TrimSpace(etapaPost)
			}
			return ""
		}(),
	})
}
