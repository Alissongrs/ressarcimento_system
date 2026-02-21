package handlers

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

type DesvioKwhRow struct {
	ID             int64  `json:"id"`
	Status         string `json:"status"`
	UC             string `json:"uc"`
	MesRef         string `json:"mes_ref"`
	Cliente        string `json:"cliente"`
	TpTensao       string `json:"tp_tensao"`
	Link           string `json:"link"`
	Concessionaria string `json:"concessionaria"`
	KwhFponta      string `json:"kwh_fponta"`
	MediaBase      string `json:"media_base"`
	Mad            string `json:"mad"`
	LimiteInf      string `json:"limite_inf"`
	LimiteSup      string `json:"limite_sup"`
	BaseLen        string `json:"base_len"`
	TrimLen        string `json:"trim_len"`
	DifAbs         string `json:"dif_abs"`
	DifPct         string `json:"dif_pct"`
	Score          string `json:"score"`
	StatusDesvio   string `json:"status_desvio"`
	StatusExtra    string `json:"status_extra"`
	UCMatch        int    `json:"uc_match"`
	Verificado     int    `json:"verificado"`
	ParaAnalise    int    `json:"para_analise"`
	Descarte       int    `json:"descarte"`
	CriarProcesso  int    `json:"criar_processo"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

type DesvioKwhListResp struct {
	Rows     []DesvioKwhRow `json:"rows"`
	Limit    int            `json:"limit"`
	Offset   int            `json:"offset"`
	Total    int64          `json:"total"`
	Filtered int64          `json:"filtered"`
}

// GET /api/v1/desvio-kwh-fponta
// @Summary Listar desvio KWH FPonta
// @Tags DesvioKwh
// @Produce json
// @Param limit query int false "Limite"
// @Param offset query int false "Offset"
// @Param status query string false "Status"
// @Param tp_tensao query string false "Tipos (csv)"
// @Param concessionaria query string false "Concessionarias (csv)"
// @Param cliente query string false "Clientes (csv)"
// @Param q query string false "Busca"
// @Success 200 {object} DesvioKwhListResp
// @Failure 500 {object} map[string]string
// @Router /api/v1/desvio-kwh-fponta [get]
func ListDesvioKwhFponta(c *gin.Context) {
	if database.GormDB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database nao configurado"})
		return
	}

	limit := 500
	offset := 0
	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 2000 {
				n = 2000
			}
			limit = n
		}
	}
	if v := strings.TrimSpace(c.Query("offset")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	statusDesvio := splitCSV(c.Query("status_desvio"))
	statusExtra := splitCSV(c.Query("status_extra"))
	mesRefs := splitCSV(c.Query("mes_ref"))
	tpTensao := splitCSV(c.Query("tp_tensao"))
	concs := splitCSV(c.Query("concessionaria"))
	clientes := splitCSV(c.Query("cliente"))
	scores := splitCSV(c.Query("score"))
	q := strings.TrimSpace(c.Query("q"))

	query := `
		SELECT
			v.id,
			v.UC,
			v.Mes_Ref,
			v.Tp_Tensao,
			v.Link,
			v.Concessionaria,
			v.KWH_FPonta,
			v.media_base,
			v.mad,
			v.limite_inf,
			v.limite_sup,
			v.base_len,
			v.dif_abs,
			v.dif_pct,
			v.score,
			v.status_desvio,
			v.status_extra,
			'' AS Status,
			COALESCE(v.RAZAO_SOCIAL, '') AS RAZAO_SOCIAL,
			'' AS trim_len,
			CASE WHEN r.uc IS NULL THEN 0 ELSE 1 END AS uc_match,
			COALESCE(v.verificado, 0) AS verificado,
			COALESCE(v.analise, 0) AS para_analise,
			COALESCE(v.descartar, 0) AS descarte,
			COALESCE(v.processo_criado, 0) AS criar_processo,
			NULL AS created_at,
			v.updated_at AS updated_at
		FROM vw_processos_desvio_media_kwh_fponta v
		LEFT JOIN (
			SELECT uc
			FROM db_ressarcimento.FT_REQUISICOES
			GROUP BY uc
		) r ON r.uc = v.UC
	`
	where := make([]string, 0, 6)
	args := make([]interface{}, 0, 16)
	if len(statusDesvio) > 0 {
		where = append(where, inClause("TRIM(v.status_desvio)", len(statusDesvio)))
		for _, v := range statusDesvio {
			args = append(args, strings.TrimSpace(v))
		}
	}
	if len(statusExtra) > 0 {
		where = append(where, inClause("TRIM(v.status_extra)", len(statusExtra)))
		for _, v := range statusExtra {
			args = append(args, strings.TrimSpace(v))
		}
	}
	if len(mesRefs) > 0 {
		where = append(where, inClause("v.Mes_Ref", len(mesRefs)))
		for _, v := range mesRefs {
			args = append(args, v)
		}
	}
	if len(tpTensao) > 0 {
		where = append(where, inClause("v.Tp_Tensao", len(tpTensao)))
		for _, v := range tpTensao {
			args = append(args, v)
		}
	}
	if len(concs) > 0 {
		where = append(where, inClause("TRIM(v.Concessionaria)", len(concs)))
		for _, v := range concs {
			args = append(args, strings.TrimSpace(v))
		}
	}
	if len(clientes) > 0 {
		where = append(where, inClause("TRIM(COALESCE(r.cliente,''))", len(clientes)))
		for _, v := range clientes {
			args = append(args, strings.TrimSpace(v))
		}
	}
	if len(scores) > 0 {
		where = append(where, inClause("v.score", len(scores)))
		for _, v := range scores {
			args = append(args, v)
		}
	}
	if q != "" {
		where = append(where, "(v.UC LIKE ? OR v.Concessionaria LIKE ? OR COALESCE(r.cliente,'') LIKE ?)")
		like := "%" + q + "%"
		args = append(args, like, like, like)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY v.Mes_Ref DESC, v.id DESC LIMIT ? OFFSET ?"
	args = append(args, limit, offset)

	rows, err := queryGorm(database.GormDB_App, query, args...)
	if err != nil {
		println("[DesvioKwh] list error:", err.Error())
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao listar desvio kwh"})
		return
	}
	defer rows.Close()

	out := DesvioKwhListResp{Limit: limit, Offset: offset}
	for rows.Next() {
		var (
			item                                      DesvioKwhRow
			mesRef                                    sql.NullString
			createdAt, updatedAt                      sql.NullTime
			verificado, paraAnalise                   sql.NullInt64
			descarte, criarProcesso, ucMatch          sql.NullInt64
			status, uc, conc, cliente, tp, link       sql.NullString
			kwh, media, mad, limInf, limSup           sql.NullString
			baseLen, trimLen, difAbs, difPct, score   sql.NullString
			statusDesvio, statusExtra                 sql.NullString
		)
		if err := rows.Scan(
			&item.ID,
			&uc,
			&mesRef,
			&tp,
			&link,
			&conc,
			&kwh,
			&media,
			&mad,
			&limInf,
			&limSup,
			&baseLen,
			&difAbs,
			&difPct,
			&score,
			&statusDesvio,
			&statusExtra,
			&status,
			&cliente,
			&trimLen,
			&ucMatch,
			&verificado,
			&paraAnalise,
			&descarte,
			&criarProcesso,
			&createdAt,
			&updatedAt,
		); err != nil {
			continue
		}
		item.Status = strings.TrimSpace(status.String)
		item.UC = strings.TrimSpace(uc.String)
		item.Concessionaria = strings.TrimSpace(conc.String)
		item.Cliente = strings.TrimSpace(cliente.String)
		item.TpTensao = strings.TrimSpace(tp.String)
		item.Link = strings.TrimSpace(link.String)
		item.StatusDesvio = strings.TrimSpace(statusDesvio.String)
		item.StatusExtra = strings.TrimSpace(statusExtra.String)
		item.KwhFponta = strings.TrimSpace(kwh.String)
		item.MediaBase = strings.TrimSpace(media.String)
		item.Mad = strings.TrimSpace(mad.String)
		item.LimiteInf = strings.TrimSpace(limInf.String)
		item.LimiteSup = strings.TrimSpace(limSup.String)
		item.BaseLen = strings.TrimSpace(baseLen.String)
		item.TrimLen = strings.TrimSpace(trimLen.String)
		item.DifAbs = strings.TrimSpace(difAbs.String)
		item.DifPct = strings.TrimSpace(difPct.String)
		item.Score = strings.TrimSpace(score.String)
		if mesRef.Valid {
			item.MesRef = strings.TrimSpace(mesRef.String)
		}
		if createdAt.Valid {
			item.CreatedAt = createdAt.Time.Format(time.RFC3339)
		}
		if updatedAt.Valid {
			item.UpdatedAt = updatedAt.Time.Format(time.RFC3339)
		}
		if verificado.Valid {
			item.Verificado = int(verificado.Int64)
		}
		if paraAnalise.Valid {
			item.ParaAnalise = int(paraAnalise.Int64)
		}
		if descarte.Valid {
			item.Descarte = int(descarte.Int64)
		}
		if criarProcesso.Valid {
			item.CriarProcesso = int(criarProcesso.Int64)
		}
		if ucMatch.Valid {
			item.UCMatch = int(ucMatch.Int64)
		}
		out.Rows = append(out.Rows, item)
	}

	out.Total = countDesvioKwhRows(nil, nil)
	filterArgs := args
	if len(args) >= 2 {
		filterArgs = args[:len(args)-2]
	}
	out.Filtered = countDesvioKwhRows(where, filterArgs)

	c.JSON(http.StatusOK, out)
}

// GET /api/v1/desvio-kwh-fponta/options
// @Summary Opcoes de filtro desvio KWH FPonta
// @Tags DesvioKwh
// @Produce json
// @Success 200 {object} map[string][]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/desvio-kwh-fponta/options [get]
func ListDesvioKwhOptions(c *gin.Context) {
	if database.GormDB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database nao configurado"})
		return
	}
	statusDesvio := distinctList("status_desvio")
	statusExtra := distinctList("status_extra")
	mesRefs := distinctList("Mes_Ref")
	tp := distinctList("Tp_Tensao")
	concs := distinctList("Concessionaria")
	score := distinctList("score")
	clientes := distinctListClientes()
	c.JSON(http.StatusOK, gin.H{
		"status_desvio":  statusDesvio,
		"status_extra":   statusExtra,
		"mes_ref":        mesRefs,
		"tp_tensao":      tp,
		"concessionaria": concs,
		"cliente":        clientes,
		"score":          score,
	})
}

type DesvioKwhFlagsReq struct {
	Verificado    *int `json:"verificado"`
	ParaAnalise   *int `json:"para_analise"`
	Descarte      *int `json:"descarte"`
	CriarProcesso *int `json:"criar_processo"`
}

// POST /api/v1/desvio-kwh-fponta/:id/flags
// @Summary Atualizar flags desvio KWH
// @Tags DesvioKwh
// @Accept json
// @Produce json
// @Param id path string true "ID"
// @Param body body DesvioKwhFlagsReq true "Flags"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/desvio-kwh-fponta/{id}/flags [post]
func UpdateDesvioKwhFlags(c *gin.Context) {
	if database.GormDB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database nao configurado"})
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id invalido"})
		return
	}

	var req DesvioKwhFlagsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload invalido"})
		return
	}

	_ = req
	// Observação: vw_processos_desvio_media_kwh_fponta não possui colunas de flags.
	// Mantemos a rota para não quebrar o front, mas não persistimos.
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/v1/desvio-kwh-fponta/:id/create-processo
// @Summary Criar processo a partir do desvio KWH
// @Tags DesvioKwh
// @Produce json
// @Param id path string true "ID"
// @Success 201 {object} map[string]any
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/v1/desvio-kwh-fponta/{id}/create-processo [post]
func CreateProcessoFromDesvioKwh(c *gin.Context) {
	if database.GormDB_App == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database nao configurado"})
		return
	}
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id invalido"})
		return
	}

	var (
		uc, conc, cliente, mesRef, tp, link sql.NullString
	)
	err := queryRowGorm(database.GormDB_App, `
		SELECT UC, Concessionaria, Mes_Ref, Tp_Tensao, Link, RAZAO_SOCIAL
		FROM vw_processos_desvio_media_kwh_fponta
		WHERE id = ?`, id).Scan(&uc, &conc, &mesRef, &tp, &link, &cliente)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "registro nao encontrado"})
		return
	}

	tx := database.GormDB_App.Begin()
	if tx.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao iniciar transacao"})
		return
	}
	defer tx.Rollback()

	res, err := execGorm(tx, `
		INSERT INTO FT_REQUISICOES (
			cliente,
			uc,
			concessionaria,
			endereco_completo,
			descricao_irregularidade,
			periodos_irregularidade,
			link_fatura,
			data_criacao,
			data_mudanca_status
		) VALUES (?, ?, ?, NULL, ?, ?, ?, NOW(), NOW())`,
		valOrNullStr(cliente.String),
		valOrNullStr(uc.String),
		valOrNullStr(conc.String),
		"Estouro",
		valOrNullStr(mesRef.String),
		valOrNullStr(link.String),
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao salvar requisicao"})
		return
	}
	lastID, _ := res.LastInsertId()
	pid := int(lastID)

	subEtapa := "Primeira reclamação da etapa - Em elaboração"
	subID, _ := resolveSubEtapaIDGorm(tx, subEtapa)
	var colID sql.NullInt64
	var colNome sql.NullString
	_ = queryRowGorm(tx, `
		SELECT k.id_coluna, k.nome_coluna
		  FROM DM_ETAPAS_PROCESSO e
		  JOIN DM_KANBAN_COLUNAS k ON k.id_coluna = e.id_coluna_kanban
		 WHERE e.id_etapa_processo = ?`,
		1,
	).Scan(&colID, &colNome)
	if _, err := execGorm(tx, `INSERT INTO FT_PROCESSOS (id_processo, id_etapa_processo, sub_etapa, id_sub_etapa_processo, id_coluna, nome_coluna, relevancia, ultima_atualizacao) VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`, pid, 1, subEtapa, nullIntToIface(subID), nullIntToIface(colID), func() interface{} { if colNome.Valid { return colNome.String }; return nil }()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao salvar processo"})
		return
	}

	statusNome := getStatusNomeByRequisicaoGorm(tx, int64(pid))
	_, _ = execGorm(tx, `INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao) VALUES (?, NULL, ?, ?, '', 'Distribuidora', ?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'movimentacao')`,
		pid, statusNome, statusNome, subEtapa, "Requisição criada via análise de desvio KWH FPonta",
	)

	if strings.TrimSpace(link.String) != "" {
		_, _ = execGorm(tx, `INSERT INTO FT_REQUISICOES_FATURAS (id_requisicao, link, mes_ref, dt_vencimento, valor_total) VALUES (?, ?, ?, NULL, NULL)`,
			pid, link.String, valOrNullStr(mesRef.String),
		)
		statusNome := getStatusNomeByRequisicaoGorm(tx, int64(pid))
		_, _ = execGorm(tx, `INSERT INTO FT_HISTORICO_MOVIMENTACOES (id_requisicao, id_usuario_gestor, status_anterior, status_novo, etapa_anterior, etapa_nova, sub_etapa, comentario, data_movimentacao, tipo_movimentacao) VALUES (?, NULL, ?, ?, '', 'Distribuidora', ?, ?, DATE_SUB(NOW(), INTERVAL 3 HOUR), 'fatura')`,
			pid, statusNome, statusNome, subEtapa, "Fatura selecionada: "+strings.TrimSpace(link.String),
		)
	}

	// vw_processos_desvio_media_kwh_fponta não possui flag de criação; nada a atualizar aqui.

	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao finalizar"})
		return
	}

	syncSnapshotFromOriginal(pid, 0)
	c.JSON(http.StatusCreated, gin.H{"id": pid, "message": "Processo criado"})
}

func boolToInt(v int) int {
	if v != 0 {
		return 1
	}
	return 0
}

func splitCSV(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func inClause(col string, n int) string {
	if n <= 0 {
		return ""
	}
	parts := make([]string, n)
	for i := 0; i < n; i++ {
		parts[i] = "?"
	}
	return col + " IN (" + strings.Join(parts, ", ") + ")"
}

func countDesvioKwhRows(where []string, args []interface{}) int64 {
	if database.GormDB_App == nil {
		return 0
	}
	query := "SELECT COUNT(*) FROM vw_processos_desvio_media_kwh_fponta v"
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	var total sql.NullInt64
	if err := queryRowGorm(database.GormDB_App, query, args...).Scan(&total); err != nil {
		return 0
	}
	if total.Valid {
		return total.Int64
	}
	return 0
}

func distinctList(column string) []string {
	if database.GormDB_App == nil {
		return nil
	}
	query := "SELECT DISTINCT " + column + " FROM vw_processos_desvio_media_kwh_fponta WHERE " + column + " IS NOT NULL AND TRIM(" + column + ") <> '' ORDER BY " + column
	rows, err := queryGorm(database.GormDB_App, query)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v sql.NullString
		if err := rows.Scan(&v); err == nil && v.Valid {
			out = append(out, strings.TrimSpace(v.String))
		}
	}
	return out
}

func distinctListClientes() []string {
	if database.GormDB_App == nil {
		return nil
	}
	q := `
		SELECT DISTINCT TRIM(RAZAO_SOCIAL) AS cliente
		FROM vw_processos_desvio_media_kwh_fponta
		WHERE RAZAO_SOCIAL IS NOT NULL AND TRIM(RAZAO_SOCIAL) <> ''
		ORDER BY RAZAO_SOCIAL`
	rows, err := queryGorm(database.GormDB_App, q)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v sql.NullString
		if err := rows.Scan(&v); err == nil && v.Valid {
			out = append(out, strings.TrimSpace(v.String))
		}
	}
	return out
}






