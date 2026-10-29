package v2

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"

	"ressarcimento-backend/services"

	"github.com/gin-gonic/gin"
)

// ListProcessos — GET /api/v2/processos
func ListProcessos(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	where := []string{"1=1"}
	args := []interface{}{}

	// Filtros aceitam multi-valor via vírgula: ?etapa=1,2,3
	addIntListFilter := func(param, column string) {
		ids := queryIntList(c, param)
		if len(ids) == 0 {
			return
		}
		placeholders := make([]string, len(ids))
		for i, v := range ids {
			placeholders[i] = "?"
			args = append(args, v)
		}
		where = append(where, column+" IN ("+strings.Join(placeholders, ",")+")")
	}
	addIntListFilter("etapa", "p.id_etapa_atual")
	addIntListFilter("instancia", "p.id_instancia_atual")
	addIntListFilter("status", "p.id_status_atual")
	addIntListFilter("aprovacao", "p.id_aprovacao_atual")
	addStrListFilter := func(param, column string) {
		raw := strings.TrimSpace(c.Query(param))
		if raw == "" {
			return
		}
		parts := strings.Split(raw, ",")
		clean := make([]string, 0, len(parts))
		for _, p := range parts {
			t := strings.TrimSpace(p)
			if t != "" {
				clean = append(clean, t)
			}
		}
		if len(clean) == 0 {
			return
		}
		if len(clean) == 1 {
			where = append(where, column+" = ?")
			args = append(args, clean[0])
		} else {
			placeholders := make([]string, len(clean))
			for i, n := range clean {
				placeholders[i] = "?"
				args = append(args, n)
			}
			where = append(where, column+" IN ("+strings.Join(placeholders, ",")+")")
		}
	}
	addStrListFilter("distribuidora", "p.concessionaria")
	addStrListFilter("cliente", "p.cliente")
	// "suspenso" agora é derivado do status: id_status=5 ('Suspenso'). A flag (p.id_status_atual=5)/* TODO V2 */ foi dropada.
	if v, defined := queryBool(c, "suspenso"); defined {
		if v {
			where = append(where, "p.id_status_atual = 5")
		} else {
			where = append(where, "(p.id_status_atual IS NULL OR p.id_status_atual <> 5)")
		}
	}
	if v, defined := queryBool(c, "relevante"); defined {
		if v {
			where = append(where, "p.relevancia = 1")
		} else {
			where = append(where, "(p.relevancia IS NULL OR p.relevancia = 0)")
		}
	}
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		like := "%" + q + "%"
		// Busca ampla: além dos campos do processo (código/cliente/UC), varre o que foi
		// INSERIDO no histórico (comentários — onde ficam protocolos, nºs de nota etc.), o
		// protocolo/CNPJ da requisição e o número da NF.
		//
		// Estratégia: resolvemos os id_processo que casam numa ÚNICA passada (cada varredura
		// roda 1x via UNION) e depois filtramos por lista de IDs. EXISTS/IN correlacionado no
		// WHERE re-executava a subconsulta por linha (O(processos × tabela)) e levava dezenas
		// de segundos; assim fica ~0,2s. Limite de 5000 candidatos (a busca serve p/ afunilar).
		const idQ = `
			SELECT id_processo FROM (
			    SELECT id_processo FROM FT_PROCESSOS
			      WHERE codigo_publico LIKE ? OR cliente LIKE ? OR uc LIKE ?
			    UNION SELECT id_processo  FROM FT_HISTORICO_MOVIMENTACOES WHERE comentario LIKE ?
			    UNION SELECT id_requisicao FROM FT_REQUISICOES WHERE numero_protocolo LIKE ? OR cnpj LIKE ?
			    UNION SELECT id_processo  FROM FT_FATURAMENTO WHERE numero_nf LIKE ?
			) t
			LIMIT 5000`
		idRows, err := db.QueryContext(c.Request.Context(), idQ, like, like, like, like, like, like, like)
		if err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "busca: "+err.Error(), nil)
			return
		}
		var ids []interface{}
		for idRows.Next() {
			var pid int
			if scanErr := idRows.Scan(&pid); scanErr == nil {
				ids = append(ids, pid)
			}
		}
		idRows.Close()
		if len(ids) == 0 {
			where = append(where, "1=0") // busca sem resultados
		} else {
			ph := strings.TrimRight(strings.Repeat("?,", len(ids)), ",")
			where = append(where, "p.id_processo IN ("+ph+")")
			args = append(args, ids...)
		}
	}

	whereSQL := strings.Join(where, " AND ")

	page := queryInt(c, "page")
	if page < 1 {
		page = 1
	}
	pageSize := queryInt(c, "page_size")
	if pageSize <= 0 {
		pageSize = 50
	}
	if pageSize > 5000 {
		pageSize = 5000
	}
	offset := (page - 1) * pageSize

	orderBy := sanitizeOrderBy(c.DefaultQuery("order_by", "data_ultima_movimentacao DESC"))

	var total int
	countSQL := "SELECT COUNT(*) FROM FT_PROCESSOS p WHERE " + whereSQL
	if err := db.QueryRowContext(c.Request.Context(), countSQL, args...).Scan(&total); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "count: "+err.Error(), nil)
		return
	}

	// data_ultima_movimentacao vem do histórico (MAX por processo). Fallback: data_criacao.
	// ultima_atualizacao da FT_PROCESSOS foi poluído pelo ETL (todos 2026-06-23/24) — não usar.
	itemsSQL := `
SELECT
    p.id_processo, COALESCE(p.codigo_publico, ''),
    COALESCE(p.cliente, ''),
    COALESCE(p.concessionaria, ''),
    COALESCE(p.uc, ''),
    p.id_etapa_atual, COALESCE(e.nome, ''),
    p.id_instancia_atual,  COALESCE(i.nome, ''),
    p.id_status_atual,     COALESCE(s.nome, ''),
    p.id_aprovacao_atual,  COALESCE(a.nome, ''),
    p.id_responsavel,      COALESCE(u.nome_usuario, ''),
    COALESCE(rq.ressarcimento_estimado, p.ressarcimento_estimado),
    p.credito_simples,
    p.credito_dobro,
    p.cod_empresa,
    p.data_procedencia,
    DATE(p.data_criacao),
    COALESCE(hu.data_ultima_mov, p.data_criacao) AS data_ultima_movimentacao,
    COALESCE(fr.valor_repasse_executado, 0) AS valor_repasse_executado,
    p.percentual_repasse,
    hs.data_movimentacao AS prazo_data_base
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES         rq ON rq.id_requisicao = p.id_processo
LEFT JOIN DM_ETAPAS              e ON e.id_etapa     = p.id_etapa_atual
LEFT JOIN DM_INSTANCIAS          i ON i.id_instancia = p.id_instancia_atual
LEFT JOIN DM_STATUS_PROCESSO     s ON s.id_status    = p.id_status_atual
LEFT JOIN DM_STATUS_APROVACAO    a ON a.id_aprovacao = p.id_aprovacao_atual
LEFT JOIN DM_USUARIO             u ON u.id_usuario   = p.id_responsavel
LEFT JOIN (
    SELECT id_processo, MAX(data_movimentacao) AS data_ultima_mov
      FROM FT_HISTORICO_MOVIMENTACOES
     GROUP BY id_processo
) hu ON hu.id_processo = p.id_processo
LEFT JOIN (
    SELECT id_processo, SUM(COALESCE(valor,0)) AS valor_repasse_executado
      FROM FT_FLUXO_RESSARCIMENTO
     GROUP BY id_processo
) fr ON fr.id_processo = p.id_processo
LEFT JOIN (
    -- data em que o processo entrou no status ATUAL (base do cálculo de prazo, Fase 1)
    SELECT id_processo, id_status_novo, MAX(data_movimentacao) AS data_movimentacao
      FROM FT_HISTORICO_MOVIMENTACOES
     GROUP BY id_processo, id_status_novo
) hs ON hs.id_processo = p.id_processo AND hs.id_status_novo = p.id_status_atual
WHERE ` + whereSQL + `
ORDER BY ` + orderBy + `
LIMIT ? OFFSET ?`

	args2 := append(append([]interface{}{}, args...), pageSize, offset)
	rows, err := db.QueryContext(c.Request.Context(), itemsSQL, args2...)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "list: "+err.Error(), nil)
		return
	}
	defer rows.Close()

	type itemOut struct {
		ID                     int      `json:"id_processo"`
		CodigoPublico          string   `json:"codigo_publico"`
		Cliente                string   `json:"cliente"`
		Distribuidora          string   `json:"distribuidora"`
		CodigoUC               string   `json:"codigo_uc"`
		Etapa                  *RefID   `json:"etapa"`
		Instancia              *RefID   `json:"instancia"`
		Status                 *RefID   `json:"status"`
		Aprovacao              *RefID   `json:"aprovacao"`
		Prioridade             *RefID   `json:"prioridade"`
		Responsavel            *RefID   `json:"responsavel"`
		RessarcimentoEstimado  *float64 `json:"ressarcimento_estimado"`
		CreditoSimples         *float64 `json:"credito_simples"`
		CreditoDobro           *float64 `json:"credito_dobro"`
		CodEmpresa             *int     `json:"cod_empresa"`
		DataProcedencia        *string  `json:"data_procedencia"`
		DataAbertura           string   `json:"data_abertura"`
		DataUltimaMovimentacao string   `json:"data_ultima_movimentacao"`
		ValorRepasseExecutado  float64  `json:"valor_repasse_executado"`
		PercentualRepasse      *float64 `json:"percentual_repasse"`
		PrazoDias              *int     `json:"prazo_dias,omitempty"`
		PrazoDiasUteis         *bool    `json:"prazo_dias_uteis,omitempty"`
		PrazoDiasDecorridos    *int     `json:"prazo_dias_decorridos,omitempty"`
		PrazoAtrasado          *bool    `json:"prazo_atrasado,omitempty"`
	}

	items := []itemOut{}
	for rows.Next() {
		var (
			it         itemOut
			etapaID    sql.NullInt64
			etapaNome  string
			instID     sql.NullInt64
			instNome   string
			statusID   sql.NullInt64
			statusNome string
			aprovID    sql.NullInt64
			aprovNome  string
			respID     sql.NullInt64
			respNome   string
			ressNull   sql.NullFloat64
			csNull     sql.NullFloat64
			cdNull     sql.NullFloat64
			codEmpNull sql.NullInt64
			dtProcNull sql.NullTime
			dtAb       sql.NullTime
			dtUlt      sql.NullTime
		)
		var repasseExec sql.NullFloat64
		var pctRep sql.NullFloat64
		var prazoDataBase sql.NullTime
		if err := rows.Scan(&it.ID, &it.CodigoPublico,
			&it.Cliente, &it.Distribuidora, &it.CodigoUC,
			&etapaID, &etapaNome,
			&instID, &instNome,
			&statusID, &statusNome,
			&aprovID, &aprovNome,
			&respID, &respNome,
			&ressNull, &csNull, &cdNull, &codEmpNull, &dtProcNull, &dtAb, &dtUlt,
			&repasseExec, &pctRep, &prazoDataBase); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		if etapaID.Valid {
			it.Etapa = &RefID{ID: int(etapaID.Int64), Nome: etapaNome}
		}
		if instID.Valid {
			it.Instancia = &RefID{ID: int(instID.Int64), Nome: instNome}
		}
		if statusID.Valid {
			it.Status = &RefID{ID: int(statusID.Int64), Nome: statusNome}
		}
		if aprovID.Valid {
			it.Aprovacao = &RefID{ID: int(aprovID.Int64), Nome: aprovNome}
		}
		if respID.Valid {
			it.Responsavel = &RefID{ID: int(respID.Int64), Nome: respNome}
		}
		if ressNull.Valid {
			v := ressNull.Float64
			it.RessarcimentoEstimado = &v
		}
		if csNull.Valid {
			v := csNull.Float64
			it.CreditoSimples = &v
		}
		if cdNull.Valid {
			v := cdNull.Float64
			it.CreditoDobro = &v
		}
		if codEmpNull.Valid {
			v := int(codEmpNull.Int64)
			it.CodEmpresa = &v
		}
		if repasseExec.Valid {
			it.ValorRepasseExecutado = repasseExec.Float64
		}
		if pctRep.Valid {
			v := pctRep.Float64
			it.PercentualRepasse = &v
		}
		if dtProcNull.Valid {
			s := dtProcNull.Time.Format("2006-01-02")
			it.DataProcedencia = &s
		}
		if dtAb.Valid {
			it.DataAbertura = dtAb.Time.Format("2006-01-02")
		}
		if dtUlt.Valid {
			it.DataUltimaMovimentacao = dtUlt.Time.Format("2006-01-02T15:04:05Z07:00")
		}
		// Prazo (Fase 1): só calcula para os status cobertos pela regra (2=Em elaboração,
		// 3=Aguardando retorno) com instância conhecida e data-base resolvida.
		if statusID.Valid && instID.Valid && prazoDataBase.Valid {
			sid := int(statusID.Int64)
			if _, coberto := services.StatusEtapas[sid]; coberto {
				if regra, ok := services.PrazoPorInstancia[int(instID.Int64)]; ok {
					var decorridos int
					if regra.Uteis {
						decorridos = services.DiasUteisEntre(prazoDataBase.Time, time.Now())
					} else {
						decorridos = services.DiasCorridosEntre(prazoDataBase.Time, time.Now())
					}
					dias := regra.Dias
					uteis := regra.Uteis
					atrasado := decorridos > regra.Dias
					it.PrazoDias = &dias
					it.PrazoDiasUteis = &uteis
					it.PrazoDiasDecorridos = &decorridos
					it.PrazoAtrasado = &atrasado
				}
			}
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "rows: "+err.Error(), nil)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"total":     total,
		"page":      page,
		"page_size": pageSize,
		"items":     items,
	})
}

// sanitizeOrderBy aceita "<campo> [asc|desc]". Os campos do mapa retornam
// a expressão SQL JÁ qualificada (com "p." ou "hu." conforme a origem) —
// data_ultima_movimentacao sai do subquery, o resto da FT_PROCESSOS.
func sanitizeOrderBy(raw string) string {
	allowed := map[string]string{
		"data_ultima_movimentacao": "hu.data_ultima_mov",
		"data_abertura":            "p.data_criacao",
		"ressarcimento_estimado":   "p.ressarcimento_estimado",
		"codigo_publico":           "p.codigo_publico",
		"cliente":                  "p.cliente",
		"concessionaria":           "p.concessionaria",
		"data_alerta":              "p.data_alerta",
		"ultima_atualizacao":       "hu.data_ultima_mov", // alias do legado
	}
	parts := strings.Fields(strings.ToLower(raw))
	expr := "hu.data_ultima_mov"
	dir := "DESC"
	if len(parts) >= 1 {
		if mapped, ok := allowed[parts[0]]; ok {
			expr = mapped
		}
	}
	if len(parts) >= 2 && (parts[1] == "asc" || parts[1] == "desc") {
		dir = strings.ToUpper(parts[1])
	}
	// NULLs por último (processo sem histórico fica no fim ASC ou DESC).
	return expr + " IS NULL, " + expr + " " + dir
}

// GetProcesso — GET /api/v2/processos/:id
func GetProcesso(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	det, err := loadProcessoDetalhes(c.Request.Context(), db, id)
	if err == sql.ErrNoRows {
		apiError(c, http.StatusNotFound, "PROCESSO_NAO_ENCONTRADO",
			"Processo "+fmt.Sprint(id)+" não existe", nil)
		return
	}
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", "loadProcessoDetalhes: "+err.Error(), nil)
		return
	}

	counts := gin.H{}
	loadCount := func(query string) int {
		var n int
		_ = db.QueryRowContext(c.Request.Context(), query, id).Scan(&n)
		return n
	}
	counts["historico"]   = loadCount("SELECT COUNT(*) FROM FT_HISTORICO_MOVIMENTACOES WHERE id_processo=?")
	counts["anexos"]      = loadCount("SELECT COUNT(*) FROM FT_ANEXOS WHERE id_processo=?")
	counts["deferimento"] = loadCount("SELECT COUNT(*) FROM FT_DEFERIMENTOS WHERE id_processo=?")
	counts["faturamento"] = loadCount("SELECT COUNT(*) FROM FT_FATURAMENTO WHERE id_processo=?")
	counts["repasse"]     = loadCount("SELECT COUNT(*) FROM FT_FLUXO_RESSARCIMENTO WHERE id_processo=?")
	det["counts"] = counts

	c.JSON(http.StatusOK, det)
}

func loadProcessoDetalhes(ctx context.Context, db *sql.DB, id int) (gin.H, error) {
	const q = `
SELECT
    p.id_processo,
    COALESCE(p.codigo_publico,''),
    COALESCE(p.cliente,''),
    COALESCE(r.cnpj,''),
    COALESCE(p.uc,''),
    COALESCE(r.endereco_completo,''),
    COALESCE(p.concessionaria,''),
    p.id_etapa_atual, COALESCE(e.nome,''),
    p.id_instancia_atual,  COALESCE(i.nome,''),
    p.id_status_atual,     COALESCE(s.nome,''),
    p.id_aprovacao_atual,  COALESCE(a.nome,''),
    p.id_responsavel, COALESCE(u.nome_usuario,''), COALESCE(u.email,''),
    r.id_tipo_irregularidade,    COALESCE(ti.nome,''),
    r.id_subtipo_irregularidade, COALESCE(sti.nome,''),
    -- Valor estimado pela requisição (informado pelo cliente na abertura)
    COALESCE(r.ressarcimento_estimado, p.ressarcimento_estimado),
    -- Crédito simples / em dobro do deferimento (sobrescritos por FT_DEFERIMENTOS quando existir)
    p.credito_simples,
    p.credito_dobro,
    COALESCE(r.descricao_irregularidade, p.descricao_irregularidade, ''),
    COALESCE(r.numero_protocolo,''),
    COALESCE(r.link_fatura,''),
    COALESCE(p.periodos_irregularidade, r.periodos_irregularidade),
    COALESCE(p.relevancia, 0),
    p.cod_empresa,
    p.data_procedencia,
    -- Data de abertura: vem da REQUISIÇÃO (origem). Fallback no processo só se a req não tiver.
    DATE(COALESCE(r.data_criacao, p.data_criacao)),
    p.data_alerta,
    COALESCE(hu.data_ultima_mov, p.data_criacao) AS data_ultima_movimentacao,
    p.percentual_repasse
FROM FT_PROCESSOS p
LEFT JOIN FT_REQUISICOES           r   ON r.id_requisicao   = p.id_processo
LEFT JOIN (
    SELECT id_processo, MAX(data_movimentacao) AS data_ultima_mov
      FROM FT_HISTORICO_MOVIMENTACOES WHERE id_processo = ?
     GROUP BY id_processo
) hu ON hu.id_processo = p.id_processo
LEFT JOIN DM_ETAPAS                e   ON e.id_etapa        = p.id_etapa_atual
LEFT JOIN DM_INSTANCIAS            i   ON i.id_instancia    = p.id_instancia_atual
LEFT JOIN DM_STATUS_PROCESSO       s   ON s.id_status       = p.id_status_atual
LEFT JOIN DM_STATUS_APROVACAO      a   ON a.id_aprovacao    = p.id_aprovacao_atual
LEFT JOIN DM_USUARIO               u   ON u.id_usuario      = p.id_responsavel
LEFT JOIN DM_TIPO_IRREGULARIDADE   ti  ON ti.id_tipo        = r.id_tipo_irregularidade
LEFT JOIN DM_SUBTIPO_IRREGULARIDADE sti ON sti.id_subtipo   = r.id_subtipo_irregularidade
WHERE p.id_processo = ?`

	var (
		pID                 int
		codigoPublico       string
		cliente, cnpj       string
		codigoUC, endereco  string
		distribuidora       string
		etapaID             sql.NullInt64
		etapaNome           string
		instID              sql.NullInt64
		instNome            string
		statusID            sql.NullInt64
		statusNome          string
		aprovID             sql.NullInt64
		aprovNome           string
		respID              sql.NullInt64
		respNome, respEmail string
		tipoID              sql.NullInt64
		tipoNome            string
		subID               sql.NullInt64
		subNome             string
		ressNull            sql.NullFloat64
		creditoSimples      sql.NullFloat64
		creditoDobro        sql.NullFloat64
		motivo, protocolo   string
		linkFatura          string
		periodosJSON        sql.NullString
		relevancia          int
		codEmpresaNull      sql.NullInt64
		dataProcNull        sql.NullTime
		dtAbertura          sql.NullTime
		dtAlerta            sql.NullTime
		dtUltMov            sql.NullTime
		pctRepasse          sql.NullFloat64
	)
	err := db.QueryRowContext(ctx, q, id, id).Scan(
		&pID, &codigoPublico,
		&cliente, &cnpj,
		&codigoUC, &endereco, &distribuidora,
		&etapaID, &etapaNome,
		&instID, &instNome,
		&statusID, &statusNome,
		&aprovID, &aprovNome,
		&respID, &respNome, &respEmail,
		&tipoID, &tipoNome,
		&subID, &subNome,
		&ressNull, &creditoSimples, &creditoDobro,
		&motivo, &protocolo, &linkFatura, &periodosJSON, &relevancia,
		&codEmpresaNull, &dataProcNull,
		&dtAbertura, &dtAlerta, &dtUltMov,
		&pctRepasse,
	)
	if err != nil {
		return nil, err
	}

	out := gin.H{
		"id_processo":    pID,
		"codigo_publico": codigoPublico,
		"cliente": gin.H{
			"razao_social": cliente,
			"cnpj":         cnpj,
		},
		"uc": gin.H{
			"codigo_uc": codigoUC,
			"endereco":  endereco,
		},
		"distribuidora":    distribuidora,
		"etapa_atual":      nilableRef(intFromNull(etapaID), etapaNome),
		"instancia_atual":  nilableRef(intFromNull(instID), instNome),
		"status_atual":     nilableRef(intFromNull(statusID), statusNome),
		"aprovacao_atual":  nilableRef(intFromNull(aprovID), aprovNome),
		"suspenso":         statusID.Valid && statusID.Int64 == 5, // derivado do status
		"motivo_objeto":    motivo,
		"numero_protocolo": protocolo,
		"link_fatura":      nullableStr(linkFatura),
		"relevante":        relevancia == 1,
	}
	if codEmpresaNull.Valid {
		out["cod_empresa"] = int(codEmpresaNull.Int64)
	} else {
		out["cod_empresa"] = nil
	}
	if dataProcNull.Valid {
		out["data_procedencia"] = dataProcNull.Time.Format("2006-01-02")
	} else {
		out["data_procedencia"] = nil
	}
	if respID.Valid {
		out["responsavel"] = gin.H{"id": int(respID.Int64), "nome": respNome, "email": respEmail}
	} else {
		out["responsavel"] = nil
	}
	out["tipo_irregularidade"]    = nilableRef(intFromNull(tipoID), tipoNome)
	out["subtipo_irregularidade"] = nilableRef(intFromNull(subID), subNome)
	if ressNull.Valid {
		out["ressarcimento_estimado"] = ressNull.Float64
	} else {
		out["ressarcimento_estimado"] = nil
	}
	if creditoSimples.Valid {
		out["credito_simples"] = creditoSimples.Float64
	} else {
		out["credito_simples"] = nil
	}
	if creditoDobro.Valid {
		out["credito_dobro"] = creditoDobro.Float64
	} else {
		out["credito_dobro"] = nil
	}
	if dtAbertura.Valid {
		out["data_abertura"] = dtAbertura.Time.Format("2006-01-02")
	}
	if dtAlerta.Valid {
		out["data_alerta"] = dtAlerta.Time.Format("2006-01-02")
	}
	if dtUltMov.Valid {
		out["data_ultima_movimentacao"] = dtUltMov.Time.Format("2006-01-02T15:04:05Z07:00")
	}
	// percentual_repasse: override manual por processo (null = usa o percentual da empresa)
	if pctRepasse.Valid {
		out["percentual_repasse"] = pctRepasse.Float64
	} else {
		out["percentual_repasse"] = nil
	}

	// meses_referencia: string humana (ex.: "mai/23, jun/23" ou "mai/23 até ago/23")
	// derivada de periodos_irregularidade. Retorna também o array raw pra quem quiser.
	if periodosJSON.Valid && periodosJSON.String != "" {
		if arr, txt := formatarMesesReferencia(periodosJSON.String); txt != "" {
			out["meses_referencia"] = txt
			out["periodos_irregularidade"] = arr
		}
	}

	return out, nil
}

func intFromNull(n sql.NullInt64) int {
	if !n.Valid {
		return 0
	}
	return int(n.Int64)
}
