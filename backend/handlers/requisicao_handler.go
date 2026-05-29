// backend/handlers/requisicao_handler.go
package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ressarcimento-backend/database"
	"ressarcimento-backend/sse"

	"github.com/gin-gonic/gin"
)

// CreateRequisicao: mantida para compatibilidade com rotas legadas.
// Hoje delega para CreateRequisicaoSimple (não persiste em banco).
func CreateRequisicao(c *gin.Context) {
	CreateRequisicaoSimple(c)
}

// CreateRequisicaoPayload representa o payload de criaÃ§ão de requisiÃ§ão.
type CreateRequisicaoPayload struct {
	UC                      string                  `json:"uc" form:"uc" example:"48341497"`
	IDUC                    string                  `json:"id_uc" form:"id_uc" example:"12345"`
	IDEmpresa               string                  `json:"id_empresa" form:"id_empresa" example:"10"`
	IDConcessionaria        string                  `json:"id_concessionaria" form:"id_concessionaria" example:"22"`
	Cliente                 string                  `json:"cliente" form:"cliente" example:"CLARO S.A."`
	RazaoSocialFatura       string                  `json:"razaoSocialFatura" form:"razaoSocialFatura" example:"CLARO S.A."`
	CNPJ                    string                  `json:"cnpj" form:"cnpj" example:"00.000.000/0000-00"`
	Concessionaria          string                  `json:"concessionaria" form:"concessionaria" example:"CEMIG"`
	EnderecoCompleto        string                  `json:"enderecoCompleto" form:"enderecoCompleto" example:"Rua X, 123 - Cidade/UF"`
	RessarcimentoEstimado   string                  `json:"ressarcimentoEstimado" form:"ressarcimentoEstimado" example:"12500,00"`
	DescricaoIrregularidade string                  `json:"descricaoIrregularidade" form:"descricaoIrregularidade" example:"CobranÃ§a indevida..."`
	PeriodosIrregularidade  string                  `json:"periodosIrregularidade" form:"periodosIrregularidade" example:"[{\"mes\":\"01\",\"ano\":\"2026\"}]"`
	LinkFatura              string                  `json:"linkFatura" form:"linkFatura" example:"https://..."`
	ProblemaIdentificado    string                  `json:"problemaIdentificado" form:"problemaIdentificado" example:"DescriÃ§ão adicional"`
	GostariaAnexarFatura    bool                    `json:"gostariaAnexarFatura" form:"gostariaAnexarFatura" example:"false"`
	Anexos                  []*multipart.FileHeader `json:"-" form:"anexos"`
}

// createRequisicaoPersistente insere em FT_REQUISICOES e FT_PROCESSOS (fluxo básico).
func createRequisicaoPersistente(c *gin.Context) {
	userIDVal, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuário não autenticado"})
		return
	}
	var userIDNull sql.NullInt64
	switch v := userIDVal.(type) {
	case int64:
		userIDNull = sql.NullInt64{Int64: v, Valid: true}
	case int:
		userIDNull = sql.NullInt64{Int64: int64(v), Valid: true}
	case float64:
		userIDNull = sql.NullInt64{Int64: int64(v), Valid: true}
	}

	if err := c.Request.ParseMultipartForm(20 << 20); err != nil && !strings.Contains(strings.ToLower(err.Error()), "eof") {
		log.Printf("[CreateRequisicaoPersist] ParseMultipartForm aviso: %v", err)
	}

	var payload CreateRequisicaoPayload
	if strings.HasPrefix(strings.ToLower(c.GetHeader("Content-Type")), "application/json") {
		if err := c.ShouldBindJSON(&payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Payload JSON inválido", "detail": err.Error()})
			return
		}
	}

	get := func(name string) string {
		if c.Request != nil && c.Request.MultipartForm != nil {
			if vals, ok := c.Request.MultipartForm.Value[name]; ok && len(vals) > 0 {
				return vals[0]
			}
		}
		return c.PostForm(name)
	}

	cliente := strings.TrimSpace(payload.Cliente)
	if cliente == "" {
		cliente = strings.TrimSpace(get("cliente"))
	}
	uc := strings.TrimSpace(payload.UC)
	if uc == "" {
		uc = strings.TrimSpace(get("uc"))
	}
	concessionaria := strings.TrimSpace(payload.Concessionaria)
	if concessionaria == "" {
		concessionaria = strings.TrimSpace(get("concessionaria"))
	}
	enderecoCompleto := strings.TrimSpace(payload.EnderecoCompleto)
	if enderecoCompleto == "" {
		enderecoCompleto = strings.TrimSpace(get("enderecoCompleto"))
	}
	descricaoIrregularidade := strings.TrimSpace(payload.DescricaoIrregularidade)
	if descricaoIrregularidade == "" {
		descricaoIrregularidade = strings.TrimSpace(get("descricaoIrregularidade"))
	}
	periodosIrregularidade := strings.TrimSpace(payload.PeriodosIrregularidade)
	if periodosIrregularidade == "" {
		periodosIrregularidade = strings.TrimSpace(get("periodosIrregularidade"))
	}
	if periodosIrregularidade == "" {
		periodosIrregularidade = strings.TrimSpace(get("periodos"))
	}
	if periodosIrregularidade == "" {
		periodosIrregularidade = strings.TrimSpace(get("periodos_irregularidade"))
	}
	linkFatura := strings.TrimSpace(payload.LinkFatura)
	if linkFatura == "" {
		linkFatura = strings.TrimSpace(get("linkFatura"))
	}
	// Lista completa de faturas com link + mes_ref enviada pelo frontend
	type faturaDetalhe struct {
		Link   string `json:"link"`
		MesRef string `json:"mes_ref"`
	}
	var linksFaturasDetalhes []faturaDetalhe
	if raw := strings.TrimSpace(get("linksFaturasDetalhes")); raw != "" {
		_ = json.Unmarshal([]byte(raw), &linksFaturasDetalhes)
	}
	// Se veio lista completa, o linkFatura é o primeiro da lista
	if len(linksFaturasDetalhes) > 0 && linkFatura == "" {
		linkFatura = strings.TrimSpace(linksFaturasDetalhes[0].Link)
	}
	cnpj := strings.TrimSpace(payload.CNPJ)
	if cnpj == "" {
		cnpj = strings.TrimSpace(get("cnpj"))
	}
	razaoSocialFatura := strings.TrimSpace(payload.RazaoSocialFatura)
	if razaoSocialFatura == "" {
		razaoSocialFatura = strings.TrimSpace(get("razaoSocialFatura"))
	}
	_ = razaoSocialFatura
	_ = cnpj
	tipoID := strings.TrimSpace(get("id_tipo_irregularidade"))
	if tipoID == "" {
		tipoID = strings.TrimSpace(get("idTipoIrregularidade"))
	}
	subtipoID := strings.TrimSpace(get("id_subtipo_irregularidade"))
	if subtipoID == "" {
		subtipoID = strings.TrimSpace(get("idSubtipoIrregularidade"))
	}
	var ressarc string
	if strings.TrimSpace(payload.RessarcimentoEstimado) != "" {
		ressarc = strings.TrimSpace(payload.RessarcimentoEstimado)
	}
	keysRessarc := []string{
		"ressarcimento_estimado",
		"valor_estimado",
		"ressarcimentoEstimado",
		"RessarcimentoEstimado",
	}
	if ressarc == "" {
		for _, k := range keysRessarc {
			ressarc = strings.TrimSpace(get(k))
			if ressarc != "" {
				break
			}
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

	var missing []string
	if uc == "" {
		missing = append(missing, "uc")
	}
	if cliente == "" {
		missing = append(missing, "cliente")
	}
	if concessionaria == "" {
		missing = append(missing, "concessionaria")
	}
	if descricaoIrregularidade == "" {
		missing = append(missing, "descricaoIrregularidade")
	}
	if periodosIrregularidade == "" {
		missing = append(missing, "periodosIrregularidade")
	}
	if !ressarcNum.Valid || ressarcNum.Float64 <= 0 {
		missing = append(missing, "ressarcimentoEstimado")
	}
	if len(missing) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":          "Campos obrigatórios ausentes",
			"missing_fields": missing,
		})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transaÃ§ão"})
		return
	}
	defer tx.Rollback()

	log.Printf("[CreateRequisicaoPersist] recebidos: uc=%q cliente=%q endereco=%q descricao=%q periodos=%q link=%q",
		uc, cliente, enderecoCompleto, descricaoIrregularidade, periodosIrregularidade, linkFatura)

	res, err := execGorm(tx, `
			INSERT INTO FT_REQUISICOES (
				cliente,
				uc,
				concessionaria,
				ressarcimento_estimado,
				endereco_completo,
				descricao_irregularidade,
				periodos_irregularidade,
				link_fatura,
				id_usuario,
				id_tipo_irregularidade,
				id_subtipo_irregularidade,
				id_status,
				data_criacao,
				data_mudanca_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
		valOrNullStr(cliente),
		valOrNullStr(uc),
		valOrNullStr(concessionaria),
		nullFloatOrNil(ressarcNum),
		valOrNullStr(enderecoCompleto),
		valOrNullStr(descricaoIrregularidade),
		valOrNullStr(periodosIrregularidade),
		valOrNullStr(linkFatura),
		nullIntOrNil(userIDNull),
		valOrNullStr(tipoID),
		valOrNullStr(subtipoID))
	if err != nil {
		log.Printf("Erro ao inserir requisicao: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao salvar requisiÃ§ão"})
		return
	}
	lastID, _ := res.LastInsertId()
	pid := int(lastID)

	// Busca nomes de tipo/subtipo para o histórico
	tipoNome := ""
	subtipoNome := ""
	if strings.TrimSpace(tipoID) != "" {
		_ = queryRowGorm(tx, "SELECT nome FROM DM_TIPO_IRREGULARIDADE WHERE id_tipo = ?", tipoID).Scan(&tipoNome)
	}
	if strings.TrimSpace(subtipoID) != "" {
		_ = queryRowGorm(tx, "SELECT nome FROM DM_SUBTIPO_IRREGULARIDADE WHERE id_subtipo = ?", subtipoID).Scan(&subtipoNome)
	}

	// NÃO cria FT_PROCESSOS automaticamente — a requisição segue o fluxo normal de aprovação.
	// FT_PROCESSOS só é criado quando a requisição for aprovada (status=3) com triagem=1.

	// Histórico de criação com todos os detalhes da requisição
	anexosCount := 0
	if c.Request != nil && c.Request.MultipartForm != nil {
		if files, ok := c.Request.MultipartForm.File["anexos"]; ok {
			anexosCount = len(files)
		}
	}
	criadoEmStr := time.Now().Format("02/01/2006, 15:04")
	periodoStr := formatPeriodos(periodosIrregularidade)
	if strings.TrimSpace(periodoStr) == "" {
		periodoStr = "-"
	}
	classStr := fmt.Sprintf("Irregularidade: %s | Sub irregularidade: %s", fallbackDash(tipoNome), fallbackDash(subtipoNome))
	faturaStr := strings.TrimSpace(linkFatura)
	if faturaStr == "" {
		faturaStr = "-"
	}
	histComentario := strings.Join([]string{
		fmt.Sprintf("UC: %s", uc),
		fmt.Sprintf("Cliente: %s", cliente),
		fmt.Sprintf("Concessionária: %s", concessionaria),
		fmt.Sprintf("Valor estimado: %s", formatBRL(ressarcNum)),
		fmt.Sprintf("Criado em: %s", criadoEmStr),
		fmt.Sprintf("Período: %s", periodoStr),
		fmt.Sprintf("Classificação: %s", classStr),
		fmt.Sprintf("Fatura: %s", faturaStr),
		fmt.Sprintf("Anexos: %d", anexosCount),
		fmt.Sprintf("Descrição: %s", descricaoIrregularidade),
	}, "\n")
	_, _ = execGorm(tx, `
		INSERT INTO FT_HISTORICO_MOVIMENTACOES
		(id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao)
		VALUES (?, ?, '', 'Nova Requisição', '', 'Nova Requisição', '', ?, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'criacao')`,
		pid, nullIntOrNil(userIDNull), histComentario)

	// Registra faturas em FT_REQUISICOES_FATURAS com mes_ref
	// Preferência: lista completa (linksFaturasDetalhes); fallback: linkFatura isolado
	if len(linksFaturasDetalhes) > 0 {
		for _, fd := range linksFaturasDetalhes {
			lnk := strings.TrimSpace(fd.Link)
			mr := strings.TrimSpace(fd.MesRef)
			if lnk == "" {
				continue
			}
			var mrVal interface{} = nil
			if mr != "" {
				mrVal = mr
			}
			_, _ = execGorm(tx, `
				INSERT INTO FT_REQUISICOES_FATURAS (id_requisicao, link, mes_ref, dt_vencimento, valor_total)
				VALUES (?, ?, ?, NULL, NULL)`,
				pid, lnk, mrVal,
			)
		}
		statusNome := strings.TrimSpace(getStatusNomeByRequisicaoGorm(tx, int64(pid)))
		if statusNome == "" {
			statusNome = "Nova Requisição"
		}
		_, _ = execGorm(tx, `
			INSERT INTO FT_HISTORICO_MOVIMENTACOES
			(id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao)
			VALUES (?, ?, ?, ?, '', '', '', ?, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'fatura')`,
			pid, nullIntOrNil(userIDNull), statusNome, statusNome,
			fmt.Sprintf("%d fatura(s) selecionada(s)", len(linksFaturasDetalhes)),
		)
	} else if strings.TrimSpace(linkFatura) != "" {
		_, _ = execGorm(tx, `
			INSERT INTO FT_REQUISICOES_FATURAS (id_requisicao, link, mes_ref, dt_vencimento, valor_total)
			VALUES (?, ?, NULL, NULL, NULL)`,
			pid, linkFatura,
		)
		statusNome := strings.TrimSpace(getStatusNomeByRequisicaoGorm(tx, int64(pid)))
		if statusNome == "" {
			statusNome = "Nova Requisição"
		}
		_, _ = execGorm(tx, `
			INSERT INTO FT_HISTORICO_MOVIMENTACOES
			(id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao)
			VALUES (?, ?, ?, ?, '', '', '', ?, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'fatura')`,
			pid, nullIntOrNil(userIDNull), statusNome, statusNome, "Fatura selecionada: "+strings.TrimSpace(linkFatura),
		)
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar"})
		return
	}

	syncSnapshotFromOriginal(pid, 0)

	// Dispara cálculo de score em background para o novo processo
	go func(reqID int) {
		var data ScoreData
		const q = `
		SELECT
			COALESCE(COUNT(DISTINCT hm.id_historico), 0),
			COALESCE((SELECT COUNT(DISTINCT id_anexo) FROM FT_ANEXOS WHERE id_requisicao = p.id_requisicao), 0),
			COALESCE(p.ressarcimento_estimado, 0),
			COALESCE(DATEDIFF(NOW(), p.data_criacao), 0),
			0,
			COALESCE(p.id_tipo_irregularidade, 0),
			COALESCE(p.id_subtipo_irregularidade, 0),
			CASE WHEN COALESCE(p.descricao_irregularidade, '') != '' THEN 1 ELSE 0 END,
			CASE WHEN COALESCE(p.link_fatura, '') != '' THEN 1 ELSE 0 END,
			CASE WHEN COALESCE(p.periodos_irregularidade, '') != '' THEN 1 ELSE 0 END
		FROM FT_REQUISICOES p
		LEFT JOIN FT_HISTORICO_MOVIMENTACOES hm ON p.id_requisicao = hm.id_requisicao
		WHERE p.id_requisicao = ?
		GROUP BY p.id_requisicao, p.ressarcimento_estimado, p.data_criacao,
		         p.id_tipo_irregularidade, p.id_subtipo_irregularidade,
		         p.descricao_irregularidade, p.link_fatura, p.periodos_irregularidade`
		if err := database.GormDB_App.Raw(q, reqID).Scan(&data).Error; err != nil {
			return
		}
		result, err := callScoreAPI(data)
		if err != nil {
			return
		}
		resp := ScoreResponse{}
		if v, ok := result["score"].(float64); ok { resp.Score = v }
		if v, ok := result["label"].(string); ok { resp.Label = v }
		if v, ok := result["percentual"].(float64); ok { resp.Percentual = v }
		if v, ok := result["erro"].(string); ok { resp.Erro = v }
		if resp.Erro == "" {
			saveScoreCache(fmt.Sprintf("%d", reqID), resp)
		}
	}(pid)

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

func nullIntOrNil(n sql.NullInt64) interface{} {
	if n.Valid {
		return n.Int64
	}
	return nil
}

func fallbackDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return strings.TrimSpace(s)
}

func formatPeriodos(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	type pItem struct {
		Mes string `json:"mes"`
		Ano string `json:"ano"`
	}
	var arr []pItem
	if err := json.Unmarshal([]byte(raw), &arr); err != nil || len(arr) == 0 {
		return strings.TrimSpace(raw)
	}
	out := make([]string, 0, len(arr))
	for _, p := range arr {
		m := strings.TrimSpace(p.Mes)
		a := strings.TrimSpace(p.Ano)
		if m == "" || a == "" {
			continue
		}
		if len(m) == 1 {
			m = "0" + m
		}
		out = append(out, fmt.Sprintf("%s/%s", m, a))
	}
	return strings.Join(out, ", ")
}

func formatBRL(n sql.NullFloat64) string {
	if !n.Valid {
		return "R$ 0,00"
	}
	v := math.Round(n.Float64*100) / 100
	s := fmt.Sprintf("%.2f", v)
	parts := strings.SplitN(s, ".", 2)
	intPart := parts[0]
	decPart := "00"
	if len(parts) > 1 {
		decPart = parts[1]
	}
	neg := ""
	if strings.HasPrefix(intPart, "-") {
		neg = "-"
		intPart = strings.TrimPrefix(intPart, "-")
	}
	var chunks []string
	for len(intPart) > 3 {
		chunks = append([]string{intPart[len(intPart)-3:]}, chunks...)
		intPart = intPart[:len(intPart)-3]
	}
	if intPart != "" {
		chunks = append([]string{intPart}, chunks...)
	}
	return fmt.Sprintf("R$ %s%s,%s", neg, strings.Join(chunks, "."), decPart)
}

// CreateRequisicaoPersist: persiste em FT_REQUISICOES e FT_PROCESSOS.
// @Summary Criar requisicao (persistente)
// @Tags Requisicoes
// @Accept json
// @Accept multipart/form-data
// @Produce json
// @Param body body CreateRequisicaoPayload true "Dados da requisicao"
// @Param anexos formData file false "Anexos (multipart/form-data)"
// @Success 201 {object} map[string]any
// @Failure 400 {object} map[string]any
// @Failure 500 {object} map[string]any
// @Router /api/v1/requisicoes [post]
func CreateRequisicaoPersist(c *gin.Context) {
	createRequisicaoPersistente(c)
}

/* ============================================================
HISTÓRICO
============================================================ */

// GET /api/requisicoes/:id/historico
// @Summary Historico da requisicao
// @Tags Requisicoes
// @Produce json
// @Param id path int true "ID da requisicao"
// @Success 200 {array} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/{id}/historico [get]
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
	var hasNewCols int
	_ = database.GormDB_App.Raw(`
		SELECT COUNT(1)
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE()
		  AND TABLE_NAME = 'FT_HISTORICO_MOVIMENTACOES'
		  AND COLUMN_NAME IN ('sub_etapa_anterior','sub_etapa_nova','tipo_movimentacao')`,
	).Row().Scan(&hasNewCols)
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

	if hasNewCols >= 2 {
		if rows, err := database.GormDB_App.Raw(queryNew, id).Rows(); err == nil {
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
		// Prepend criaÃ§ão do processo, se houver
		var createdAt sql.NullTime
		if err := database.GormDB_App.Raw(
			"SELECT data_criacao FROM FT_REQUISICOES WHERE id_requisicao = ?",
			id,
		).Row().Scan(&createdAt); err == nil && createdAt.Valid {
			ts := createdAt.Time.In(time.Local).Format("02/01/2006 15:04:05")
			created := HistoricoItem{
				ID:                 0,
				NomeUsuario:        "Sistema",
				StatusAnterior:     "",
				StatusNovo:         "CriaÃ§ão do Processo",
				StatusComposto:     "CriaÃ§ão do Processo",
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

	rows2, err2 := database.GormDB_App.Raw(queryOld, id).Rows()
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
	// Prepend criaÃ§ão do processo, se houver
	var createdAt string
	if err := database.GormDB_App.Raw(
		"SELECT DATE_FORMAT(data_criacao, '%Y-%m-%d %H:%i:%s') FROM FT_REQUISICOES WHERE id_requisicao = ?",
		id,
	).Row().Scan(&createdAt); err == nil && createdAt != "" {
		created := HistoricoItem{
			ID:                 0,
			NomeUsuario:        "Sistema",
			StatusAnterior:     "",
			StatusNovo:         "CriaÃ§ão do Processo",
			StatusComposto:     "CriaÃ§ão do Processo",
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
		"message":                  "RequisiÃ§ão recebida (sem persistência nesta versão)",
	})
}

/* ============================================================
ANEXOS
============================================================ */

// GET /api/requisicoes/:id/anexos
// @Summary Listar anexos da requisicao
// @Tags Requisicoes
// @Produce json
// @Param id path int true "ID da requisicao"
// @Success 200 {array} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/{id}/anexos [get]
func GetAnexosByRequisicaoID(c *gin.Context) {
	id := c.Param("id")

	type AnexoOut struct {
		ID             int    `json:"id"`
		NomeArquivo    string `json:"nome_arquivo"`
		CaminhoArquivo string `json:"caminho_arquivo"`
		URL            string `json:"url,omitempty"`
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
	if rows, err := database.GormDB_App.Raw(qNew, id).Rows(); err == nil {
		defer rows.Close()
		for rows.Next() {
			var a AnexoOut
			if err := rows.Scan(&a.ID, &a.NomeArquivo, &a.CaminhoArquivo, &a.EnviadoPor, &a.DataUpload); err != nil {
				continue
			}
			if a.ID > 0 {
				a.URL = anexoDownloadURL(int64(a.ID))
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
	rows2, err2 := database.GormDB_App.Raw(qOld, id).Rows()
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
		if a.ID > 0 {
			a.URL = anexoDownloadURL(int64(a.ID))
		}
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
// @Summary Listar requisicoes
// @Tags Requisicoes
// @Produce json
// @Success 200 {object} map[string]any
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes [get]
func GetAllRequisicoes(c *gin.Context) {
	type RequisicaoListItem struct {
		ID                int     `json:"id"`
		Cliente           string  `json:"cliente"`
		UC                string  `json:"uc"`
		Concessionaria    string  `json:"concessionaria"`
		ValorEstimado     float64 `json:"ressarcimento_estimado"`
		EnderecoCompleto  string  `json:"endereco_completo"`
		Status            string  `json:"status"`
		Etapa             string  `json:"etapa"`
		SubEtapa          string  `json:"sub_etapa"`
		Triagem           int     `json:"triagem"`
		ProcessoCriado    int     `json:"processo_criado"`
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
				COALESCE(e.etapa,'')                 AS etapa,
				COALESCE(p.sub_etapa,'')             AS sub_etapa,
				COALESCE(r.triagem,0)                AS triagem,
				COALESCE(r.processo_criado,0)        AS processo_criado,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS data_criacao,
				DATE_FORMAT(r.data_mudanca_status, '%Y-%m-%d %H:%i:%s') AS data_mudanca_status
			FROM FT_REQUISICOES r
			LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
			LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
			LEFT JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
			ORDER BY r.data_criacao DESC`

	// Suporte opcional a paginaÃ§ão: ?limit=...&offset=...
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

	rows, err := database.GormDB_App.Raw(query).Rows()
	if err != nil {
		log.Printf("GetAllRequisicoes: erro na query: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao listar requisiÃ§ões"})
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
			&it.Etapa,
			&it.SubEtapa,
			&it.Triagem,
			&it.ProcessoCriado,
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
// Regra atual: todo usuário autenticado visualiza todas as requisiÃ§ões (sem filtro por departamento).
// @Summary Listar requisicoes por departamento
// @Tags Requisicoes
// @Produce json
// @Success 200 {object} map[string]any
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/departamento [get]
func GetRequisicoesDepartamento(c *gin.Context) {
	// usuário autenticado (validamos presenÃ§a apenas)
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
		Triagem           int     `json:"triagem"`
		ProcessoCriado    int     `json:"processo_criado"`
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
				COALESCE(r.triagem,0)                AS triagem,
				COALESCE(r.processo_criado,0)        AS processo_criado,
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

	rows, err := database.GormDB_App.Raw(query).Rows()
	if err != nil {
		log.Printf("GetRequisicoesDepartamento: erro na query: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao listar requisiÃ§ões"})
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
			&it.Triagem,
			&it.ProcessoCriado,
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
// @Summary Buscar requisicao por ID
// @Tags Requisicoes
// @Produce json
// @Param id path int true "ID da requisicao"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/{id} [get]
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
		// Instância do deferimento atual (FT_PROCESSOS.instancia_deferimento → DM_INSTANCIA_DEFERIMENTO).
		// 0 quando ainda não escolhido.
		InstanciaDeferimento     int    `json:"instancia_deferimento"`
		InstanciaDeferimentoNome string `json:"instancia_deferimento_nome"`
	}

	const q = `
			SELECT
				r.id_requisicao,
				COALESCE(r.cliente, '')                AS cliente,
				COALESCE(r.uc, '')                     AS uc,
				COALESCE(r.concessionaria, '')         AS concessionaria,
				COALESCE(r.ressarcimento_estimado, 0)  AS ressarcimento_estimado,
				COALESCE(r.endereco_completo, '')      AS endereco_completo,
				COALESCE(s.status, 'Nova RequisiÃ§ão')  AS status,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS data_criacao,
				DATE_FORMAT(r.data_mudanca_status, '%Y-%m-%d %H:%i:%s') AS data_mudanca_status,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS created_at,
				COALESCE(r.descricao_irregularidade, '') AS descricao_irregularidade,
				COALESCE(r.periodos_irregularidade, '')  AS periodos_irregularidade,
				COALESCE(ti.nome, '')                     AS tipo_irregularidade,
				COALESCE(sti.nome, '')                    AS subtipo_irregularidade,
				COALESCE(r.link_fatura, '')              AS link_fatura,
				COALESCE(p.instancia_deferimento, 0)      AS instancia_deferimento,
				COALESCE(di.nome, '')                     AS instancia_deferimento_nome
			FROM FT_REQUISICOES r
			LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
			LEFT JOIN DM_TIPO_IRREGULARIDADE ti ON ti.id_tipo = r.id_tipo_irregularidade
			LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo = r.id_subtipo_irregularidade
			LEFT JOIN FT_PROCESSOS p ON p.id_processo = r.id_requisicao
			LEFT JOIN DM_INSTANCIA_DEFERIMENTO di ON di.id_instancia = p.instancia_deferimento
			WHERE r.id_requisicao = ?
			LIMIT 1`

	var d RequisicaoDetail
	if err := database.GormDB_App.Raw(q, id).Row().Scan(
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
		&d.InstanciaDeferimento,
		&d.InstanciaDeferimentoNome,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "RequisiÃ§ão não encontrada"})
			return
		}
		// Fallback: ambientes sem tabela/coluna de subtipo ou DM_INSTANCIA_DEFERIMENTO.
		log.Printf("GetRequisicaoByID: erro na query completa id=%s: %v", id, err)
		const qFallback = `
			SELECT
				r.id_requisicao,
				COALESCE(r.cliente, '')                AS cliente,
				COALESCE(r.uc, '')                     AS uc,
				COALESCE(r.concessionaria, '')         AS concessionaria,
				COALESCE(r.ressarcimento_estimado, 0)  AS ressarcimento_estimado,
				COALESCE(r.endereco_completo, '')      AS endereco_completo,
				COALESCE(s.status, 'Nova RequisiÃ§ão')  AS status,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS data_criacao,
				DATE_FORMAT(r.data_mudanca_status, '%Y-%m-%d %H:%i:%s') AS data_mudanca_status,
				DATE_FORMAT(r.data_criacao, '%Y-%m-%d %H:%i:%s') AS created_at,
				COALESCE(r.descricao_irregularidade, '') AS descricao_irregularidade,
				COALESCE(r.periodos_irregularidade, '')  AS periodos_irregularidade,
				''                                        AS tipo_irregularidade,
				''                                        AS subtipo_irregularidade,
				COALESCE(r.link_fatura, '')              AS link_fatura,
				0                                         AS instancia_deferimento,
				''                                        AS instancia_deferimento_nome
			FROM FT_REQUISICOES r
			LEFT JOIN DM_STATUS s ON r.id_status = s.id_status
			WHERE r.id_requisicao = ?
			LIMIT 1`
		if err2 := database.GormDB_App.Raw(qFallback, id).Row().Scan(
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
			&d.InstanciaDeferimento,
			&d.InstanciaDeferimentoNome,
		); err2 != nil {
			if errors.Is(err2, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "RequisiÃ§ão não encontrada"})
				return
			}
			log.Printf("GetRequisicaoByID: erro no fallback id=%s: %v", id, err2)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao buscar requisiÃ§ão"})
			return
		}
	}

	c.JSON(http.StatusOK, d)
}

// GET /api/requisicoes/:id/faturas
// @Summary Faturas selecionadas da requisicao
// @Tags Requisicoes
// @Produce json
// @Param id path int true "ID da requisicao"
// @Success 200 {array} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/{id}/faturas [get]
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
	rows, err := database.GormDB_App.Raw(q, id).Rows()
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
// @Summary Atualizar requisicao
// @Tags Requisicoes
// @Accept json
// @Produce json
// @Param id path int true "ID da requisicao"
// @Param body body map[string]any true "Dados"
// @Success 200 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/requisicoes/{id}/update [post]
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
	var triagemPost *int
	var processoCriadoPost *int
	var clientePost *string
	var ucPost *string
	var concessionariaPost *string
	var linkFaturaPost *string
	var descricaoIrregularidadePost *string
	var periodosIrregularidadePost *string
	var enderecoCompletoPost *string
	createdProcess := false
	classificacaoUpdated := false
	var tipoIDPost, subtipoIDPost string
	ctype := strings.ToLower(c.GetHeader("Content-Type"))

	if !strings.Contains(ctype, "multipart/form-data") {
		// JSON
		var body struct {
			Comentario              string  `json:"comentario"`
			RessarcimentoEstimado   string  `json:"ressarcimento_estimado"`
			Status                  string  `json:"status"`
			Etapa                   string  `json:"etapa"`
			EtapaAtual              string  `json:"etapa_atual"`
			SubEtapa                string  `json:"sub_etapa"`
			Triagem                 *int    `json:"triagem"`
			ProcessoCriado          *int    `json:"processo_criado"`
			Cliente                 *string `json:"cliente"`
			UC                      *string `json:"uc"`
			Concessionaria          *string `json:"concessionaria"`
			LinkFatura              *string `json:"link_fatura"`
			DescricaoIrregularidade *string `json:"descricao_irregularidade"`
			PeriodosIrregularidade  *string `json:"periodos_irregularidade"`
			EnderecoCompleto        *string `json:"endereco_completo"`
			IdTipoIrregularidade    string  `json:"id_tipo_irregularidade"`
			IdSubtipoIrregularidade string  `json:"id_subtipo_irregularidade"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Corpo inválido: " + err.Error()})
			return
		}
		comentario = strings.TrimSpace(body.Comentario)
		valorEstimado = strings.TrimSpace(body.RessarcimentoEstimado)
		statusPost = strings.TrimSpace(body.Status)
		etapaPost = strings.TrimSpace(body.EtapaAtual)
		if etapaPost == "" {
			etapaPost = strings.TrimSpace(body.Etapa)
		}
		subEtapaPost = strings.TrimSpace(body.SubEtapa)
		triagemPost = body.Triagem
		processoCriadoPost = body.ProcessoCriado
		clientePost = body.Cliente
		ucPost = body.UC
		concessionariaPost = body.Concessionaria
		linkFaturaPost = body.LinkFatura
		descricaoIrregularidadePost = body.DescricaoIrregularidade
		periodosIrregularidadePost = body.PeriodosIrregularidade
		enderecoCompletoPost = body.EnderecoCompleto
		tipoIDPost = strings.TrimSpace(body.IdTipoIrregularidade)
		subtipoIDPost = strings.TrimSpace(body.IdSubtipoIrregularidade)
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
		if raw := strings.TrimSpace(c.PostForm("triagem")); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil {
				triagemPost = &n
			}
		}
		if raw := strings.TrimSpace(c.PostForm("processo_criado")); raw != "" {
			if n, err := strconv.Atoi(raw); err == nil {
				processoCriadoPost = &n
			}
		}
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao iniciar transaÃ§ão"})
		return
	}
	defer tx.Rollback()

	// Atualiza valor estimado, se veio (aceita "," decimal e remove separadores de milhar)
	if valorEstimado != "" {
		norm := strings.ReplaceAll(strings.TrimSpace(valorEstimado), ".", "")
		norm = strings.ReplaceAll(norm, ",", ".")
		if f, err := strconv.ParseFloat(norm, 64); err == nil {
			if _, err := execGorm(tx, `
					UPDATE FT_REQUISICOES
					SET ressarcimento_estimado = ?
					WHERE id_requisicao = ?`,
				f, id); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar valor estimado"})
				return
			}
		}
	}

	// Atualiza campos de informações da requisição, se vieram
	if clientePost != nil || ucPost != nil || concessionariaPost != nil || linkFaturaPost != nil ||
		descricaoIrregularidadePost != nil || periodosIrregularidadePost != nil || enderecoCompletoPost != nil {
		setParts := []string{}
		args := []any{}

		if clientePost != nil {
			setParts = append(setParts, "cliente = ?")
			args = append(args, strings.TrimSpace(*clientePost))
		}
		if ucPost != nil {
			setParts = append(setParts, "uc = ?")
			args = append(args, strings.TrimSpace(*ucPost))
		}
		if concessionariaPost != nil {
			setParts = append(setParts, "concessionaria = ?")
			args = append(args, strings.TrimSpace(*concessionariaPost))
		}
		if linkFaturaPost != nil {
			setParts = append(setParts, "link_fatura = ?")
			args = append(args, strings.TrimSpace(*linkFaturaPost))
		}
		if descricaoIrregularidadePost != nil {
			setParts = append(setParts, "descricao_irregularidade = ?")
			args = append(args, strings.TrimSpace(*descricaoIrregularidadePost))
		}
		if periodosIrregularidadePost != nil {
			raw := strings.TrimSpace(*periodosIrregularidadePost)
			if raw != "" {
				// atualiza apenas quando o valor parece JSON válido
				if strings.HasPrefix(raw, "[") || strings.HasPrefix(raw, "{") {
					if json.Valid([]byte(raw)) {
						setParts = append(setParts, "periodos_irregularidade = ?")
						args = append(args, raw)
					}
				}
			}
		}
		if enderecoCompletoPost != nil {
			setParts = append(setParts, "endereco_completo = ?")
			args = append(args, strings.TrimSpace(*enderecoCompletoPost))
		}

		if len(setParts) > 0 {
			args = append(args, id)
			if _, err := execGorm(tx, "UPDATE FT_REQUISICOES SET "+strings.Join(setParts, ", ")+" WHERE id_requisicao = ?", args...); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar informações da requisição"})
				return
			}
		}
	}

	// Atualiza flags de triagem/processo_criado, se vieram
	if triagemPost != nil || processoCriadoPost != nil {
		set := []string{}
		args := []any{}
		if triagemPost != nil {
			set = append(set, "triagem = ?")
			args = append(args, *triagemPost)
		}
		if processoCriadoPost != nil {
			set = append(set, "processo_criado = ?")
			args = append(args, *processoCriadoPost)
		}
		if len(set) > 0 {
			args = append(args, id)
			if _, err := execGorm(tx, "UPDATE FT_REQUISICOES SET "+strings.Join(set, ", ")+" WHERE id_requisicao = ?", args...); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar flags da requisição"})
				return
			}
		}
	}

	// Atualiza classificaÃ§ão (tipo/subtipo) se informados
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
		if _, err := execGorm(tx, q, args...); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar classificaÃ§ão"})
			return
		}
		classificacaoUpdated = true
		// Registrar no histórico (informativo)
		var etapaAtual, subAtual sql.NullString
		_ = queryRowGorm(tx, `
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
		if _, err := execGorm(tx, `
				INSERT INTO FT_HISTORICO_MOVIMENTACOES
				(id_requisicao, id_usuario_gestor,
				status_anterior, status_novo,
				etapa_anterior, etapa_nova, sub_etapa,
				comentario, data_movimentacao, tipo_movimentacao)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'classificacao')`,
			id, gestorID,
			statusComp, statusComp,
			etapaAtual.String, etapaAtual.String, subAtual.String,
			"Classificação atualizada",
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar histórico de classificaÃ§ão"})
			return
		}
	}

	// =========================
	// Histórico de comentário (com etapa/subetapa)
	// =========================
	if comentario != "" || etapaPost != "" || subEtapaPost != "" {
		// Busca etapa/subetapa vigentes do processo (se existir)
		var etapaAtual, subAtual sql.NullString
		_ = queryRowGorm(tx, `
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

		if _, err := execGorm(tx, `
				INSERT INTO FT_HISTORICO_MOVIMENTACOES
				(id_requisicao, id_usuario_gestor,
				status_anterior, status_novo,
				etapa_anterior, etapa_nova, sub_etapa,
				comentario, data_movimentacao)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR))`,
			id, gestorID,
			status, status,
			etapaTxt, etapaTxt, subTxt,
			comentario,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao registrar comentário no histórico"})
			return
		}

		// Sinaliza via SSE atualizaÃ§ão de histórico/kanban (inclui sub_etapa)
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
	// AtualizaÃ§ão de status da requisiÃ§ão (se informado)
	// =========================
	if statusPost != "" {
		// ValidaÃ§ões de negócio: classificaÃ§ão e prazo
		var currStatus string
		var dataMudanca sql.NullTime
		var tipoAtual sql.NullInt64
		var subtipoAtual sql.NullInt64
		_ = queryRowGorm(tx, `
				SELECT s.status, r.data_mudanca_status, r.id_tipo_irregularidade, r.id_subtipo_irregularidade
				FROM FT_REQUISICOES r
				LEFT JOIN DM_STATUS s ON s.id_status = r.id_status
				WHERE r.id_requisicao = ?`, id).Scan(&currStatus, &dataMudanca, &tipoAtual, &subtipoAtual)

		if strings.EqualFold(currStatus, "Nova RequisiÃ§ão") && !strings.EqualFold(statusPost, "Nova RequisiÃ§ão") {
			if (!tipoAtual.Valid && strings.TrimSpace(c.PostForm("id_tipo_irregularidade")) == "") ||
				(!subtipoAtual.Valid && strings.TrimSpace(c.PostForm("id_subtipo_irregularidade")) == "") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Preencha Tipo e Subtipo da irregularidade antes de sair de Nova RequisiÃ§ão."})
				return
			}
		}

		prazoDias := 0
		if strings.EqualFold(currStatus, "Nova RequisiÃ§ão") {
			prazoDias = 5
		} else if strings.EqualFold(currStatus, "Em Análise") || strings.EqualFold(currStatus, "Em Analise") {
			prazoDias = 10
		}
		if prazoDias > 0 && dataMudanca.Valid {
			deadline := dataMudanca.Time.Add(time.Duration(prazoDias*24) * time.Hour)
			if time.Now().After(deadline) && strings.TrimSpace(comentario) == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "MovimentaÃ§ão vencida: adicione justificativa no comentário."})
				return
			}
		}

		// Busca id do status
		var idStatus int
		if err := queryRowGorm(tx, "SELECT id_status FROM DM_STATUS WHERE status = ?", statusPost).Scan(&idStatus); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Status informado inválido"})
			return
		}
		if _, err := execGorm(tx, `
				UPDATE FT_REQUISICOES
				SET id_status = ?, data_mudanca_status = NOW()
				WHERE id_requisicao = ?`, idStatus, id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao atualizar status da requisiÃ§ão"})
			return
		}

		// Histórico da mudanÃ§a de status (status_anterior/status_novo) com tipo/subtipo
		var etapaAtual sql.NullString
		var subAtual sql.NullString
		_ = queryRowGorm(tx, `
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
				_ = queryRowGorm(tx, "SELECT nome FROM DM_TIPO_IRREGULARIDADE WHERE id_tipo = ?", tid).Scan(&tipoNome)
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
				_ = queryRowGorm(tx, "SELECT nome FROM DM_SUBTIPO_IRREGULARIDADE WHERE id_subtipo = ?", sid).Scan(&subTipoNome)
				if subTipoNome.Valid {
					commentParts = append(commentParts, "Subtipo: "+strings.TrimSpace(subTipoNome.String))
				}
			}
		}
		statusAnterior := strings.TrimSpace(currStatus)
		if statusAnterior == "" {
			statusAnterior = "Nova RequisiÃ§ão"
		}
		statusNovo := strings.TrimSpace(statusPost)
		histComentario := strings.Join(commentParts, " | ")

		_, _ = execGorm(tx, `
				INSERT INTO FT_HISTORICO_MOVIMENTACOES
				(id_requisicao, id_usuario_gestor,
				status_anterior, status_novo,
				etapa_anterior, etapa_nova, sub_etapa,
				comentario, data_movimentacao, tipo_movimentacao)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'status')`,
			id, gestorID,
			statusAnterior, statusNovo,
			etapaAtual.String, etapaAtual.String, subAtual.String,
			histComentario,
		)

		// Se aprovado, marca triagem e processo_criado=1 e aguarda envio para Ativos
		if strings.EqualFold(statusPost, "Aprovado") {
			if _, err := execGorm(tx, "UPDATE FT_REQUISICOES SET triagem = 1, processo_criado = 1 WHERE id_requisicao = ?", id); err != nil {
				if !strings.Contains(strings.ToLower(err.Error()), "unknown column") {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao marcar triagem"})
					return
				}
			}
			// Garante etapa/subetapa default do processo aprovado (id 1)
			subEtapa := "Primeira reclamação da etapa - Em elaboração"
			if nome, e2 := resolveSubEtapaNameByIDGorm(tx, 1); e2 == nil && nome.Valid {
				subEtapa = strings.TrimSpace(nome.String)
			}
			subID, _ := resolveSubEtapaIDGorm(tx, subEtapa)
			if !subID.Valid {
				subID = sql.NullInt64{Int64: 1, Valid: true}
			}
			responsavelID := sql.NullInt64{Int64: gestorID, Valid: gestorID > 0}
			// INSERT ... ON DUPLICATE KEY UPDATE — cria o processo se ainda não
			// existe (caso da requisição aprovada sem registro em FT_PROCESSOS),
			// ou atualiza os campos se já existir. Antes era só UPDATE, e quando
			// o processo não existia o UPDATE afetava 0 linhas silenciosamente,
			// causando 404 quando o front tentava movimentar o processo depois.
			if _, err := execGorm(tx,
				`INSERT INTO FT_PROCESSOS
				    (id_processo, id_etapa_processo, etapa, sub_etapa, id_sub_etapa_processo,
				     id_coluna, nome_coluna, id_responsavel, relevancia, ultima_atualizacao)
				 VALUES (?, 1, 'Distribuidora', ?, ?, 1, 'Ativos', ?, 0, NOW())
				 ON DUPLICATE KEY UPDATE
				     id_etapa_processo     = VALUES(id_etapa_processo),
				     etapa                 = VALUES(etapa),
				     sub_etapa             = VALUES(sub_etapa),
				     id_sub_etapa_processo = VALUES(id_sub_etapa_processo),
				     id_coluna             = VALUES(id_coluna),
				     nome_coluna           = VALUES(nome_coluna),
				     id_responsavel        = VALUES(id_responsavel),
				     ultima_atualizacao    = NOW()`,
				id, subEtapa, nullIntToIface(subID), nullIntToIface(responsavelID),
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao criar/atualizar processo: " + err.Error()})
				return
			}
		}
	}

	// Anexos (campo: anexosGestor) - apenas para multipart (grava no banco)
	if strings.Contains(ctype, "multipart/form-data") && c.Request.MultipartForm != nil {
		form := c.Request.MultipartForm
		files := form.File["anexosGestor"]
		for _, f := range files {
			name, data, mimeType, sizeBytes, err := readAnexoFile(f)
			if err != nil {
				c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Arquivo excede o tamanho maximo permitido"})
				return
			}
			pidInt, _ := strconv.Atoi(id)
			pseudoPath := buildAnexoPath(pidInt, 0, name)
			if _, err := execGorm(tx,
				`INSERT INTO FT_ANEXOS
				(id_requisicao, nome_arquivo, caminho_arquivo, enviado_por, data_upload, mime_type, tamanho_bytes, arquivo_blob)
				VALUES (?, ?, ?, 'gestor', NOW(), ?, ?, ?)`,
				id, name, pseudoPath, mimeType, sizeBytes, data); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Falha ao registrar anexo"})
				return
			}
		}
	}

	// Sincroniza FT_PROCESSOS com a ultima movimentacao do historico (best-effort).
	// Cobre classificacao/comentario/status registrados acima na mesma tx.
	if idInt, convErr := strconv.Atoi(id); convErr == nil {
		_ = SincronizarStatusProcesso(tx, idInt)
	}

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Erro ao finalizar a transaÃ§ão"})
		return
	}
	if createdProcess {
		if idInt, convErr := strconv.Atoi(id); convErr == nil {
			syncSnapshotFromOriginal(idInt, int(gestorID))
		}
	}
	if classificacaoUpdated {
		if idInt, convErr := strconv.Atoi(id); convErr == nil {
			syncSnapshotFromOriginal(idInt, int(gestorID))
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"message":   "RequisiÃ§ão atualizada",
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
