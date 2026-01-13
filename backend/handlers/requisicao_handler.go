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
CREATE – compatibilidade
============================================================ */

// CreateRequisicao: mantida para compatibilidade com rotas legadas.
// Hoje delega para CreateRequisicaoSimple (não persiste em banco).
func CreateRequisicao(c *gin.Context) {
	CreateRequisicaoSimple(c)
}

// createRequisicaoPersistente insere em FT_REQUISICOES e FT_PROCESSOS (fluxo básico).
func createRequisicaoPersistente(c *gin.Context) {
	userIDVal, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	_ = userIDVal // reservado para futura auditoria

	if err := c.Request.ParseMultipartForm(20 << 20); err != nil && !strings.Contains(strings.ToLower(err.Error()), "eof") {
		log.Printf("[CreateRequisicaoPersist] ParseMultipartForm aviso: %v", err)
	}

	get := func(name string) string {
		if c.Request != nil && c.Request.MultipartForm != nil {
			if vals, ok := c.Request.MultipartForm.Value[name]; ok && len(vals) > 0 {
				return vals[0]
			}
		}
		return c.PostForm(name)
	}

	cliente := strings.TrimSpace(get("cliente"))
	uc := strings.TrimSpace(get("uc"))
	concessionaria := strings.TrimSpace(get("concessionaria"))
	enderecoCompleto := strings.TrimSpace(get("enderecoCompleto"))
	descricaoIrregularidade := strings.TrimSpace(get("descricaoIrregularidade"))
	periodosIrregularidade := strings.TrimSpace(get("periodosIrregularidade"))
	linkFatura := strings.TrimSpace(get("linkFatura"))
	var ressarc string
	keysRessarc := []string{
		"ressarcimento_estimado",
		"valor_estimado",
		"ressarcimentoEstimado",
		"RessarcimentoEstimado",
	}
	for _, k := range keysRessarc {
		ressarc = strings.TrimSpace(get(k))
		if ressarc != "" {
			break
		}
	}
	var ressarcNum sql.NullFloat64
	if ressarc != "" {
		clean := strings.ReplaceAll(strings.ReplaceAll(ressarc, ".", ""), ",", ".")
		if v, err := strconv.ParseFloat(clean, 64); err == nil {
			ressarcNum.Valid = true
			ressarcNum.Float64 = v
		}
	}

	tx, err := database.DB_App.Begin()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transação"})
		return
	}
	defer tx.Rollback()

	log.Printf("[CreateRequisicaoPersist] recebidos: uc=%q cliente=%q endereco=%q descricao=%q periodos=%q link=%q",
		uc, cliente, enderecoCompleto, descricaoIrregularidade, periodosIrregularidade, linkFatura)

	res, err := tx.Exec(`
			INSERT INTO FT_REQUISICOES (
				cliente,
				uc,
				concessionaria,
				ressarcimento_estimado,
				endereco_completo,
				descricao_irregularidade,
				periodos_irregularidade,
				link_fatura,
				data_criacao,
				data_mudanca_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
		valOrNullStr(cliente),
		valOrNullStr(uc),
		valOrNullStr(concessionaria),
		nullFloatOrNil(ressarcNum),
		valOrNullStr(enderecoCompleto),
		valOrNullStr(descricaoIrregularidade),
		valOrNullStr(periodosIrregularidade),
		valOrNullStr(linkFatura))
	if err != nil {
		log.Printf("Erro ao inserir requisicao: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar requisição"})
		return
	}
	lastID, _ := res.LastInsertId()
	pid := int(lastID)

	// cria FT_PROCESSOS básico (etapa Distribuidora ou fallback)
	var etapaID int
	if err := tx.QueryRow("SELECT id_etapa_processo FROM DM_ETAPAS_PROCESSO WHERE etapa = 'Distribuidora' LIMIT 1").Scan(&etapaID); err != nil {
		etapaID = 1
	}
	if _, err := tx.Exec(`INSERT INTO FT_PROCESSOS (id_processo, id_etapa_processo, sub_etapa, relevancia, ultima_atualizacao) VALUES (?, ?, '', 0, NOW())`, pid, etapaID); err != nil {
		log.Printf("Erro ao criar processo: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar processo"})
		return
	}

	// histórico inicial
	_, _ = tx.Exec(`INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, relevancia_anterior, relevancia_nova, comentario, data_movimentacao, justificativa_atraso, tipo_movimentacao) VALUES (?, NULL, '', 'Distribuidora', '', 'Distribuidora', '', NULL, NULL, 'Requisição criada via API', NOW(), NULL, 'movimentacao')`, pid)

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"id": pid, "message": "Requisição criada"})
}

func valOrNullStr(s string) interface{} {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func nullFloatOrNil(n sql.NullFloat64) interface{} {
	if n.Valid {
		return n.Float64
	}
	return nil
}

// CreateRequisicaoPersist: persiste em FT_REQUISICOES e FT_PROCESSOS.
func CreateRequisicaoPersist(c *gin.Context) {
	createRequisicaoPersistente(c)
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
		var createdAt sql.NullTime
		if err := database.DB_App.QueryRow(
			"SELECT data_criacao FROM FT_REQUISICOES WHERE id_requisicao = ?",
			id,
		).Scan(&createdAt); err == nil && createdAt.Valid {
			ts := createdAt.Time.In(time.Local).Format("02/01/2006 15:04:05")
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
				DataMovimentacao:   ts,
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
	if err := database.DB_App.QueryRow(
		"SELECT DATE_FORMAT(data_criacao, '%Y-%m-%d %H:%i:%s') FROM FT_REQUISICOES WHERE id_requisicao = ?",
		id,
	).Scan(&createdAt); err == nil && createdAt != "" {
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
	limitStr := strings.TrimSpace(c.Query("limit"))
	offsetStr := strings.TrimSpace(c.Query("offset"))

	limitSQL := ""
	offsetSQL := ""

	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 {
			limitSQL = strconv.Itoa(n)
		}
	}
	if offsetStr != "" {
		if n, err := strconv.Atoi(offsetStr); err == nil && n >= 0 {
			offsetSQL = strconv.Itoa(n)
		}
	}

	query := base
	if limitSQL != "" {
		query += " LIMIT " + limitSQL
		if offsetSQL != "" {
			query += " OFFSET " + offsetSQL
		}
	}

	rows, err := database.DB_App.Query(query)
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
// Regra atual: todo usuário autenticado visualiza todas as requisições (sem filtro por departamento).
func GetRequisicoesDepartamento(c *gin.Context) {
	// usuário autenticado (validamos presença apenas)
	if _, ok := c.Get("userID"); !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}

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

	limitStr := strings.TrimSpace(c.Query("limit"))
	offsetStr := strings.TrimSpace(c.Query("offset"))

	limitSQL := ""
	offsetSQL := ""

	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 {
			limitSQL = strconv.Itoa(n)
		}
	}
	if offsetStr != "" {
		if n, err := strconv.Atoi(offsetStr); err == nil && n >= 0 {
			offsetSQL = strconv.Itoa(n)
		}
	}

	query := baseSelect + orderBy
	if limitSQL != "" {
		query += " LIMIT " + limitSQL
		if offsetSQL != "" {
			query += " OFFSET " + offsetSQL
		}
	}

	rows, err := database.DB_App.Query(query)
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
		DataMudancaStatus       string  `json:"data_mudanca_status"`
		CreatedAt               string  `json:"created_at"`
		DescricaoIrregularidade string  `json:"descricao_irregularidade"`
		PeriodosIrregularidade  string  `json:"periodos_irregularidade"`
		TipoIrregularidade      string  `json:"tipo_irregularidade"`
		SubtipoIrregularidade   string  `json:"subtipo_irregularidade"`
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
				DATE_FORMAT(r.data_mudanca_status, '%Y-%m-%d %H:%i:%s') AS data_mudanca_status,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS created_at,
				COALESCE(r.descricao_irregularidade, '') AS descricao_irregularidade,
				COALESCE(r.periodos_irregularidade, '')  AS periodos_irregularidade,
				COALESCE(ti.nome, '')                     AS tipo_irregularidade,
				COALESCE(sti.nome, '')                    AS subtipo_irregularidade,
				COALESCE(r.link_fatura, '')              AS link_fatura
			FROM FT_REQUISICOES r
			LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
			LEFT JOIN DM_TIPO_IRREGULARIDADE ti ON ti.id_tipo_irregularidade = r.id_tipo_irregularidade
			LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo_irregularidade = r.id_subtipo_irregularidade
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
		&d.DataMudancaStatus,
		&d.CreatedAt,
		&d.DescricaoIrregularidade,
		&d.PeriodosIrregularidade,
		&d.TipoIrregularidade,
		&d.SubtipoIrregularidade,
		&d.LinkFatura,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Requisição não encontrada"})
			return
		}
		// Fallback: ambientes sem tabela/coluna de subtipo.
		log.Printf("GetRequisicaoByID: erro na query completa id=%s: %v", id, err)
		const qFallback = `
			SELECT
				r.id_requisicao,
				COALESCE(r.cliente, '')                AS cliente,
				COALESCE(r.uc, '')                     AS uc,
				COALESCE(r.concessionaria, '')         AS concessionaria,
				COALESCE(r.ressarcimento_estimado, 0)  AS ressarcimento_estimado,
				COALESCE(r.endereco_completo, '')      AS endereco_completo,
				COALESCE(s.status, 'Nova Requisição')  AS status,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS data_criacao,
				DATE_FORMAT(r.data_mudanca_status, '%Y-%m-%d %H:%i:%s') AS data_mudanca_status,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS created_at,
				COALESCE(r.descricao_irregularidade, '') AS descricao_irregularidade,
				COALESCE(r.periodos_irregularidade, '')  AS periodos_irregularidade,
				''                                        AS tipo_irregularidade,
				''                                        AS subtipo_irregularidade,
				COALESCE(r.link_fatura, '')              AS link_fatura
			FROM FT_REQUISICOES r
			LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
			WHERE r.id_requisicao = ?
			LIMIT 1`
		if err2 := database.DB_App.QueryRow(qFallback, id).Scan(
			&d.ID,
			&d.Cliente,
			&d.UC,
			&d.Concessionaria,
			&d.ValorEstimado,
			&d.EnderecoCompleto,
			&d.Status,
			&d.DataCriacao,
			&d.DataMudancaStatus,
			&d.CreatedAt,
			&d.DescricaoIrregularidade,
			&d.PeriodosIrregularidade,
			&d.TipoIrregularidade,
			&d.SubtipoIrregularidade,
			&d.LinkFatura,
		); err2 != nil {
			if errors.Is(err2, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "Requisição não encontrada"})
				return
			}
			log.Printf("GetRequisicaoByID: erro no fallback id=%s: %v", id, err2)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar requisição"})
			return
		}
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
	if list == nil {
		list = []Fat{}
	}
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
		// JSON
		var body struct {
			Comentario            string `json:"comentario"`
			RessarcimentoEstimado string `json:"ressarcimento_estimado"`
			Etapa                 string `json:"etapa"`
			EtapaAtual            string `json:"etapa_atual"`
			SubEtapa              string `json:"sub_etapa"`
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
		// multipart (comentário + arquivos + possível etapa/subetapa)
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
		}
	}

	// Atualiza classificação (tipo/subtipo) se informados
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
		// Busca etapa/subetapa vigentes do processo (se existir)
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
			etapaTxt = "Distribuidora" // fallback (ajuste se desejar)
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
	// =========================
	if statusPost != "" {
		// Validações de negócio: classificação e prazo
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

		// Histórico da mudança de status (status_anterior/status_novo) com tipo/subtipo
		var etapaAtual sql.NullString
		var subAtual sql.NullString
		_ = tx.QueryRow(`
				SELECT e.etapa, p.sub_etapa
				FROM FT_PROCESSOS p
				JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
				WHERE p.id_processo = ?
				LIMIT 1`, id).Scan(&etapaAtual, &subAtual)

		commentParts := []string{}
		if tipoIDPost != "" || tipoAtual.Valid {
			var tipoNome sql.NullString
			tid := tipoIDPost
			if tid == "" && tipoAtual.Valid {
				tid = strconv.FormatInt(tipoAtual.Int64, 10)
			}
			if tid != "" {
				_ = tx.QueryRow("SELECT nome FROM DM_TIPO_IRREGULARIDADE WHERE id_tipo_irregularidade = ?", tid).Scan(&tipoNome)
				if tipoNome.Valid {
					commentParts = append(commentParts, "Tipo: "+strings.TrimSpace(tipoNome.String))
				}
			}
		}
		if subtipoIDPost != "" || subtipoAtual.Valid {
			var subTipoNome sql.NullString
			sid := subtipoIDPost
			if sid == "" && subtipoAtual.Valid {
				sid = strconv.FormatInt(subtipoAtual.Int64, 10)
			}
			if sid != "" {
				_ = tx.QueryRow("SELECT nome FROM DM_SUBTIPO_IRREGULARIDADE WHERE id_subtipo_irregularidade = ?", sid).Scan(&subTipoNome)
				if subTipoNome.Valid {
					commentParts = append(commentParts, "Subtipo: "+strings.TrimSpace(subTipoNome.String))
				}
			}
		}
		statusAnterior := strings.TrimSpace(currStatus)
		if statusAnterior == "" {
			statusAnterior = "Nova Requisição"
		}
		statusNovo := strings.TrimSpace(statusPost)
		histComentario := strings.Join(commentParts, " | ")

		_, _ = tx.Exec(`
				INSERT INTO FT_HISTORICO_MOVIMENTACOES
				(id_requisicao, id_usuario_gestor,
				status_anterior, status_novo,
				etapa_anterior, etapa_nova, sub_etapa,
				comentario, data_movimentacao, tipo_movimentacao)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'status')`,
			id, gestorID,
			statusAnterior, statusNovo,
			etapaAtual.String, etapaAtual.String, subAtual.String,
			histComentario,
		)

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
				if err := tx.QueryRow(
					"SELECT e.id_etapa_processo FROM DM_ETAPAS_PROCESSO e "+
						"JOIN DM_KANBAN_COLUNAS kc ON kc.id_coluna = e.id_coluna_kanban "+
						"WHERE kc.nome_coluna = ? ORDER BY e.id_etapa_processo ASC LIMIT 1",
					initialCol,
				).Scan(&idEtapa); err != nil {
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
	if strings.Contains(ctype, "multipart/form-data") && c.Request.MultipartForm != nil {
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
