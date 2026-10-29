package v2

import (
	"database/sql"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetHistorico — GET /api/v2/processos/:id/historico
func GetHistorico(c *gin.Context) {
	db := requireDB(c)
	if db == nil {
		return
	}
	id, ok := pathInt(c, "id")
	if !ok {
		return
	}

	const q = `
SELECT
    m.id_historico, m.data_movimentacao, COALESCE(m.tipo_movimentacao,''),
    m.id_usuario_gestor,       COALESCE(u.nome_usuario,''),
    m.id_etapa_anterior, COALESCE(ea.nome,''),
    m.id_instancia_anterior, COALESCE(ia.nome,''),
    m.id_status_anterior, COALESCE(sa.nome,''),
    m.id_aprovacao_anterior, COALESCE(apa.nome,''),
    m.id_etapa_nova,     COALESCE(en.nome,''),
    m.id_instancia_nova, COALESCE(in_.nome,''),
    m.id_status_novo,    COALESCE(sn.nome,''),
    m.id_aprovacao_nova, COALESCE(apn.nome,''),
    COALESCE(m.comentario,''),
    COALESCE(m.justificativa_atraso,''),
    COALESCE(m.mail_graph_message_id,''),
    COALESCE(mm.subject,''), COALESCE(mm.from_name,''), COALESCE(mm.from_email,''),
    mm.received_at, COALESCE(mm.snippet,''), COALESCE(mm.has_attachments, 0)
FROM FT_HISTORICO_MOVIMENTACOES m
LEFT JOIN DM_USUARIO u    ON u.id_usuario  = m.id_usuario_gestor
LEFT JOIN DM_ETAPAS ea     ON ea.id_etapa   = m.id_etapa_anterior
LEFT JOIN DM_INSTANCIAS ia ON ia.id_instancia = m.id_instancia_anterior
LEFT JOIN DM_STATUS_PROCESSO sa ON sa.id_status = m.id_status_anterior
LEFT JOIN DM_STATUS_APROVACAO apa ON apa.id_aprovacao = m.id_aprovacao_anterior
LEFT JOIN DM_ETAPAS en          ON en.id_etapa   = m.id_etapa_nova
LEFT JOIN DM_INSTANCIAS in_ ON in_.id_instancia = m.id_instancia_nova
LEFT JOIN DM_STATUS_PROCESSO sn ON sn.id_status = m.id_status_novo
LEFT JOIN DM_STATUS_APROVACAO apn ON apn.id_aprovacao = m.id_aprovacao_nova
LEFT JOIN mail_messages mm ON mm.graph_message_id = m.mail_graph_message_id COLLATE utf8mb4_bin -- id do Graph diferencia maiúsculas
WHERE m.id_processo = ?
ORDER BY m.data_movimentacao DESC, m.id_historico DESC`

	rows, err := db.QueryContext(c.Request.Context(), q, id)
	if err != nil {
		log.Printf("[v2/historico] query err id=%d: %v", id, err)
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	defer rows.Close()

	// Mapa id_historico → [{id_canal, nome}]
	canais := map[int64][]gin.H{}
	cRows, cErr := db.QueryContext(c.Request.Context(), `
SELECT hc.id_historico, c.id_canal, c.nome
  FROM FT_HISTORICO_CANAIS hc
  JOIN DM_CANAIS_COMUNICACAO c ON c.id_canal = hc.id_canal
  JOIN FT_HISTORICO_MOVIMENTACOES m ON m.id_historico = hc.id_historico
 WHERE m.id_processo = ?`, id)
	if cErr == nil {
		defer cRows.Close()
		for cRows.Next() {
			var idH int64
			var idCanal int
			var nome string
			if err := cRows.Scan(&idH, &idCanal, &nome); err == nil {
				canais[idH] = append(canais[idH], gin.H{"id": idCanal, "nome": nome})
			}
		}
	}

	items := []gin.H{}
	for rows.Next() {
		var (
			idMov                                              int64
			dtMov                                              sql.NullTime
			tipo                                               string
			usrID                                              sql.NullInt64
			usrNome                                            string
			eaID                                               sql.NullInt64
			eaNome                                             string
			iaID                                               sql.NullInt64
			iaNome                                             string
			saID                                               sql.NullInt64
			saNome                                             string
			apaID                                              sql.NullInt64
			apaNome                                            string
			enID                                               sql.NullInt64
			enNome                                             string
			inID                                               sql.NullInt64
			inNome                                             string
			snID                                               sql.NullInt64
			snNome                                             string
			apnID                                              sql.NullInt64
			apnNome                                            string
			comentario, justAtraso                             string
			mailMsgID, mailSubject, mailFromName, mailFromEmail, mailSnippet string
			mailReceived                                       sql.NullTime
			mailHasAttach                                      sql.NullInt64
		)
		if err := rows.Scan(&idMov, &dtMov, &tipo,
			&usrID, &usrNome,
			&eaID, &eaNome,
			&iaID, &iaNome,
			&saID, &saNome,
			&apaID, &apaNome,
			&enID, &enNome,
			&inID, &inNome,
			&snID, &snNome,
			&apnID, &apnNome,
			&comentario, &justAtraso,
			&mailMsgID,
			&mailSubject, &mailFromName, &mailFromEmail,
			&mailReceived, &mailSnippet, &mailHasAttach); err != nil {
			log.Printf("[v2/historico] scan err id=%d: %v", id, err)
			apiError(c, http.StatusInternalServerError, "DB_ERR", "scan: "+err.Error(), nil)
			return
		}
		item := gin.H{
			"id_movimentacao":   idMov,
			"tipo_movimentacao": tipo,
			"comentario":        nullableStr(comentario),
			"justificativa_atraso": nullableStr(justAtraso),
		}
		if dtMov.Valid {
			item["data_movimentacao"] = dtMov.Time.Format("2006-01-02T15:04:05Z07:00")
		}
		if usrID.Valid {
			item["usuario"] = gin.H{"id": usrID.Int64, "nome": usrNome}
		} else {
			item["usuario"] = nil
		}
		item["de"] = gin.H{
			"etapa":     nilableRef(intFromNull(eaID), eaNome),
			"instancia": nilableRef(intFromNull(iaID), iaNome),
			"status":    nilableRef(intFromNull(saID), saNome),
			"aprovacao": nilableRef(intFromNull(apaID), apaNome),
		}
		item["para"] = gin.H{
			"etapa":     nilableRef(intFromNull(enID), enNome),
			"instancia": nilableRef(intFromNull(inID), inNome),
			"status":    nilableRef(intFromNull(snID), snNome),
			"aprovacao": nilableRef(intFromNull(apnID), apnNome),
		}
		// Canais de comunicação (N:N)
		if cs := canais[idMov]; cs != nil {
			item["canais"] = cs
		} else {
			item["canais"] = []gin.H{}
		}
		// Email vinculado — se há message_id, expõe subject/from/received_at/snippet
		// pra UI expandir inline sem chamada extra.
		if mailMsgID != "" {
			mail := gin.H{
				"message_id":      mailMsgID,
				"subject":         nullableStr(mailSubject),
				"from_name":       nullableStr(mailFromName),
				"from_email":      nullableStr(mailFromEmail),
				"snippet":         nullableStr(mailSnippet),
				"has_attachments": mailHasAttach.Valid && mailHasAttach.Int64 == 1,
			}
			if mailReceived.Valid {
				mail["received_at"] = mailReceived.Time.Format("2006-01-02T15:04:05Z07:00")
			}
			item["email"] = mail
		}
		items = append(items, item)
	}

	c.JSON(http.StatusOK, gin.H{"items": items})
}

func nullableStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
