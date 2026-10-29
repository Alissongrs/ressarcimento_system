package handlers

// Observação do analista por apontamento (FATURA_APONTAMENTOS_AUDITADOS.observacao).
// A coluna já é preservada pelo rebuild do motor (auditados_rebuild.go lê e reaplica),
// e a lista de Auditados já devolve observacao_auditado. Aqui só o WRITE.

import (
	"database/sql"
	"net/http"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// POST /api/v1/faturas/:id/observacao-auditado  { "observacao": "..." }
// Grava/atualiza a nota de verificação do analista no apontamento. Sobrevive ao rebuild.
func SetObservacaoAuditado(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Observacao string `json:"observacao"`
	}
	_ = c.ShouldBindJSON(&body)
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	obs := strings.TrimSpace(body.Observacao)
	if len(obs) > 4000 {
		obs = obs[:4000]
	}
	res, err := sqlDB.Exec("UPDATE FATURA_APONTAMENTOS_AUDITADOS SET observacao=? WHERE id=?", obs, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	n, _ := res.RowsAffected()
	c.JSON(http.StatusOK, gin.H{"ok": true, "atualizado": n, "observacao": obs})
}

// GET /api/v1/faturas/uc-apontamentos?uc=<codigo_uc ou numero_instalacao>
// Retorna TODOS os apontamentos (meses flagados) daquela UC no snapshot — usado pelo
// modal pra montar os chips e destacar o gráfico mesmo com a lista paginada/filtrada.
func ListApontamentosUC(c *gin.Context) {
	uc := strings.TrimSpace(c.Query("uc"))
	if uc == "" {
		c.JSON(http.StatusOK, gin.H{"apontamentos": []gin.H{}})
		return
	}
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	// fonte=acer: não há snapshot p/ Acer — usa o motor ao vivo (mesmo de /acer/*) filtrado pela UC.
	if c.Query("fonte") == "acer" {
		apont, mErr := motorApontamentosCachedT(sqlDB, "", true, "FATURA_ACER_DADOS_EXTRAIDOS")
		if mErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": mErr.Error()})
			return
		}
		r2, e2 := sqlDB.Query(`SELECT id, DATE_FORMAT(mes_referencia,'%Y-%m-%d'), COALESCE(codigo_uc,''),
		       COALESCE(numero_instalacao,''), COALESCE(kwh_total,0), COALESCE(valor_energia_ativa,0)
		     FROM FATURA_ACER_DADOS_EXTRAIDOS WHERE TRIM(codigo_uc)=? OR numero_instalacao=? ORDER BY mes_referencia`, uc, uc)
		if e2 != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": e2.Error()})
			return
		}
		defer r2.Close()
		out := []gin.H{}
		for r2.Next() {
			var id int64
			var mes, codUC, inst sql.NullString
			var kwh, ea sql.NullFloat64
			if r2.Scan(&id, &mes, &codUC, &inst, &kwh, &ea) != nil {
				continue
			}
			mr, ok := apont[id]
			if !ok || !acerApontamentoValido(mr.FichasAplicadas) {
				continue
			}
			energia := ea.Float64
			if energia <= 0 {
				energia = kwh.Float64
			}
			out = append(out, gin.H{
				"id": id, "codigo_uc": codUC.String, "numero_instalacao": inst.String,
				"mes_referencia": mes.String, "kwh_total": kwh.Float64, "desvio_pct_max": mr.DesvioPctMax,
				"fichas_aplicadas": strings.Join(mr.FichasAplicadas, ","), "ressarcimento_estimado": acerRessEstimado(energia, mr.DesvioPctMax),
				"observacao_auditado": "",
			})
		}
		c.JSON(http.StatusOK, gin.H{"apontamentos": out, "n": len(out)})
		return
	}
	rows, err := sqlDB.Query(`SELECT id, COALESCE(codigo_uc,''), COALESCE(numero_instalacao,''),
	       DATE_FORMAT(mes_referencia,'%Y-%m-%d'), COALESCE(kwh_total,0), COALESCE(desvio_pct,0),
	       COALESCE(fichas,''), COALESCE(ressarcimento_estimado,0), COALESCE(observacao,'')
	     FROM FATURA_APONTAMENTOS_AUDITADOS
	     WHERE TRIM(codigo_uc)=? OR numero_instalacao=?
	     ORDER BY mes_referencia`, uc, uc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []gin.H{}
	for rows.Next() {
		var id int64
		var codUC, inst, mes, fichas, obs sql.NullString
		var kwh, desvio, ress sql.NullFloat64
		if rows.Scan(&id, &codUC, &inst, &mes, &kwh, &desvio, &fichas, &ress, &obs) != nil {
			continue
		}
		out = append(out, gin.H{
			"id": id, "codigo_uc": codUC.String, "numero_instalacao": inst.String,
			"mes_referencia": mes.String, "kwh_total": kwh.Float64, "desvio_pct_max": desvio.Float64,
			"fichas_aplicadas": fichas.String, "ressarcimento_estimado": ress.Float64,
			"observacao_auditado": obs.String,
		})
	}
	c.JSON(http.StatusOK, gin.H{"apontamentos": out, "n": len(out)})
}
