package v2

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// GetHistoricoGlobal — GET /api/v2/historico
//
// Lista global de movimentações (tela admin /historico).
// Retorna cada movimentação resolvida com FKs novas:
//   instancia, etapa, status, aprovacao  (todos como {id, nome})
//
// Query params:
//   ?limit=N        (default 2000, max 5000)
//   ?etapa=ID       filtra por DM_ETAPAS.id_etapa
//   ?instancia=ID   filtra por DM_INSTANCIAS.id_instancia
//   ?status=ID      filtra por DM_STATUS_PROCESSO.id_status
//   ?distribuidora=NOME parcial (LIKE %x%)
//   ?uc=CODIGO      parcial em FT_PROCESSOS.uc
//   ?q=texto        busca livre (cliente, comentario, uc)
func GetHistoricoGlobal(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}

	limit := queryInt(c, "limit")
	if limit <= 0 {
		limit = 2000
	}
	// Ampliado para 50k pra suportar export com histórico de vários processos (~300 movs/processo).
	if limit > 50000 {
		limit = 50000
	}

	where := []string{"1=1"}
	args := []interface{}{}

	if v := queryInt(c, "etapa"); v > 0 {
		where = append(where, "m.id_etapa_nova = ?")
		args = append(args, v)
	}
	if v := queryInt(c, "instancia"); v > 0 {
		where = append(where, "m.id_instancia_nova = ?")
		args = append(args, v)
	}
	if v := queryInt(c, "status"); v > 0 {
		where = append(where, "m.id_status_novo = ?")
		args = append(args, v)
	}
	if d := strings.TrimSpace(c.Query("distribuidora")); d != "" {
		where = append(where, "p.concessionaria LIKE ?")
		args = append(args, "%"+d+"%")
	}
	if u := strings.TrimSpace(c.Query("uc")); u != "" {
		where = append(where, "p.uc LIKE ?")
		args = append(args, "%"+u+"%")
	}
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		like := "%" + q + "%"
		where = append(where, "(p.cliente LIKE ? OR p.uc LIKE ? OR m.comentario LIKE ?)")
		args = append(args, like, like, like)
	}
	// Filtro por lista de processos (?processos=1,2,3) — usado pelo export com histórico
	// no Controle de Processos v2. Já traduz CSV → IN(?,?,...).
	if procIDs := queryIntList(c, "processos"); len(procIDs) > 0 {
		if len(procIDs) > 5000 {
			procIDs = procIDs[:5000] // hard cap defensivo
		}
		placeholders := strings.Repeat("?,", len(procIDs))
		placeholders = placeholders[:len(placeholders)-1]
		where = append(where, "m.id_processo IN ("+placeholders+")")
		for _, id := range procIDs {
			args = append(args, id)
		}
	}

	whereSQL := strings.Join(where, " AND ")

	query := `
SELECT
    m.id_historico,
    m.id_processo                    AS id_processo,
    p.codigo_publico,
    COALESCE(p.uc, '')                 AS uc,
    COALESCE(p.cliente, '')            AS cliente,
    COALESCE(p.concessionaria, '')     AS distribuidora,

    m.id_instancia_nova,  COALESCE(i.nome, '') AS instancia_nome,
    m.id_etapa_nova,   COALESCE(e.nome, '') AS etapa_nome,
    m.id_status_novo,  COALESCE(s.nome, '') AS status_nome,
    m.id_aprovacao_nova,  COALESCE(a.nome, '') AS aprovacao_nome,

    m.tipo_movimentacao,
    COALESCE(m.comentario, '')         AS comentario,
    COALESCE(m.mail_graph_message_id,'') AS mail_graph_message_id,
    m.id_usuario_gestor,
    COALESCE(u.nome_usuario, '')       AS usuario_nome,
    m.data_movimentacao
FROM FT_HISTORICO_MOVIMENTACOES m
LEFT JOIN FT_PROCESSOS         p ON p.id_processo  = m.id_processo
LEFT JOIN DM_INSTANCIAS        i ON i.id_instancia = m.id_instancia_nova
LEFT JOIN DM_ETAPAS            e ON e.id_etapa     = m.id_etapa_nova
LEFT JOIN DM_STATUS_PROCESSO   s ON s.id_status    = m.id_status_novo
LEFT JOIN DM_STATUS_APROVACAO  a ON a.id_aprovacao = m.id_aprovacao_nova
LEFT JOIN DM_USUARIO           u ON u.id_usuario   = m.id_usuario_gestor
WHERE ` + whereSQL + `
ORDER BY m.data_movimentacao DESC, m.id_historico DESC
LIMIT ?`

	args = append(args, limit)

	rows, err := db.QueryContext(c.Request.Context(), query, args...)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var (
			idHist                     int64
			idProc                     sql.NullInt64
			codigoPub                  sql.NullString
			uc, cliente, dist          string
			instID                     sql.NullInt64
			instNome                   string
			etapaID                    sql.NullInt64
			etapaNome                  string
			statusID                   sql.NullInt64
			statusNome                 string
			aprovID                    sql.NullInt64
			aprovNome                  string
			tipoMov                    sql.NullString
			comentario                 string
			mailID                     string
			usrID                      sql.NullInt64
			usrNome                    string
			dtMov                      sql.NullTime
		)
		if err := rows.Scan(&idHist, &idProc, &codigoPub,
			&uc, &cliente, &dist,
			&instID, &instNome,
			&etapaID, &etapaNome,
			&statusID, &statusNome,
			&aprovID, &aprovNome,
			&tipoMov, &comentario, &mailID,
			&usrID, &usrNome,
			&dtMov); err != nil {
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}

		item := gin.H{
			"id_historico":          idHist,
			"id_processo":           nilInt2(toIntPtr(idProc)),
			"codigo_publico":        nilStr(codigoPub),
			"uc":                    uc,
			"cliente":               cliente,
			"distribuidora":         dist,
			"instancia":             nilableRef(intFromNull(instID), instNome),
			"etapa":                 nilableRef(intFromNull(etapaID), etapaNome),
			"status":                nilableRef(intFromNull(statusID), statusNome),
			"aprovacao":             nilableRef(intFromNull(aprovID), aprovNome),
			"tipo_movimentacao":     nilStr(tipoMov),
			"comentario":            nullableStr(comentario),
			"mail_graph_message_id": nullableStr(mailID),
			"usuario": func() interface{} {
				if usrID.Valid {
					return gin.H{"id": usrID.Int64, "nome": usrNome}
				}
				return nil
			}(),
		}
		if dtMov.Valid {
			item["data_movimentacao"] = dtMov.Time.Format("2006-01-02T15:04:05Z07:00")
		}
		items = append(items, item)
	}

	c.JSON(http.StatusOK, gin.H{
		"total": len(items),
		"items": items,
	})
}

// Helpers locais
func toIntPtr(n sql.NullInt64) *int {
	if !n.Valid {
		return nil
	}
	v := int(n.Int64)
	return &v
}

func nilStr(n sql.NullString) interface{} {
	if !n.Valid || n.String == "" {
		return nil
	}
	return n.String
}
