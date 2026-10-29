package handlers

// =============================================================================
// apontamentos_origem_handler.go — apontamentos do motor VERIFICADO sobre a
// Faturas_Registradas_Cache (sgeeasy), materializados em
// db_ressarcimento.apontamentos_desvio_origem (mesmo conjunto do dossiê .html).
//
//   GET /api/v1/desvio/origem            — lista (filtros: empresa, ficha, veredito, limit)
//   GET /api/v1/desvio/origem/empresas   — empresas + contagem (p/ sub-abas)
//   GET /api/v1/desvio/origem/resumo     — totais por ficha e veredito
// =============================================================================

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

func sqlDBApp() (*sql.DB, error) {
	return database.GormDB_App.DB()
}

// ListApontamentosOrigem — GET /api/v1/desvio/origem
func ListApontamentosOrigem(c *gin.Context) {
	db, err := sqlDBApp()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	empresa := strings.TrimSpace(c.Query("empresa"))
	ficha := strings.ToUpper(strings.TrimSpace(c.Query("ficha")))     // F01..F05
	veredito := strings.ToUpper(strings.TrimSpace(c.Query("veredito"))) // ANOMALIA|ATIVACAO|INFORMAR
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "3000"))
	if limit <= 0 || limit > 10000 {
		limit = 3000
	}

	conds := []string{"1=1"}
	args := []interface{}{}
	if empresa != "" && empresa != "0" {
		conds = append(conds, "Cod_Empresa = ?")
		args = append(args, empresa)
	}
	if ficha != "" {
		conds = append(conds, "flag_"+strings.ToLower(ficha)+" = 1")
	}
	if veredito != "" {
		conds = append(conds, "veredito_f02 = ?")
		args = append(args, veredito)
	}

	q := `SELECT id, UC, Cod_Empresa, Concessionaria, Mes_Ref, Tp_Tensao, Modalidade_Tarifaria,
	             NroMedidor, Link, RS_Total_Fatura,
	             flag_f01, flag_f02, flag_f03, flag_f04, flag_f05,
	             COALESCE(segmentos_f01,''), COALESCE(segmentos_alerta_f02,''), COALESCE(status_alerta_f02,''),
	             desvio_pct_max_f02, media_f02, consumo_atual_f02,
	             COALESCE(serie_f02,''), COALESCE(veredito_seg_f02,''), COALESCE(veredito_f02,''),
	             COALESCE(detalhe_f04,''), COALESCE(detalhe_f05,''), COALESCE(fichas_aplicadas,'')
	      FROM apontamentos_desvio_origem
	      WHERE ` + strings.Join(conds, " AND ") + `
	      ORDER BY CASE veredito_f02 WHEN 'ANOMALIA' THEN 0 WHEN 'INFORMAR' THEN 1 WHEN 'ATIVACAO' THEN 2 ELSE 3 END,
	               COALESCE(desvio_pct_max_f02,0) DESC, id DESC
	      LIMIT ?`
	args = append(args, limit)

	rows, qErr := db.Query(q, args...)
	if qErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao buscar apontamentos: " + qErr.Error()})
		return
	}
	defer rows.Close()

	out := []map[string]interface{}{}
	for rows.Next() {
		var (
			id, codEmp                                  sql.NullInt64
			uc, conc, mes, tp, modal, med, link         sql.NullString
			rsTot, desv, media, consAtu                 sql.NullFloat64
			f01, f02, f03, f04, f05                      sql.NullInt64
			segF01, segF02, statF02                      sql.NullString
			serie, veredSeg, vered, detF04, detF05, fich sql.NullString
		)
		if rows.Scan(&id, &uc, &codEmp, &conc, &mes, &tp, &modal, &med, &link, &rsTot,
			&f01, &f02, &f03, &f04, &f05, &segF01, &segF02, &statF02,
			&desv, &media, &consAtu, &serie, &veredSeg, &vered, &detF04, &detF05, &fich) != nil {
			continue
		}
		ns := func(n sql.NullString) string { return n.String }
		nf := func(n sql.NullFloat64) interface{} { if n.Valid { return n.Float64 }; return nil }
		ni := func(n sql.NullInt64) int64 { return n.Int64 }
		out = append(out, map[string]interface{}{
			"id": ni(id), "UC": ns(uc), "cod_empresa": ni(codEmp), "concessionaria": ns(conc),
			"mes_ref": ns(mes), "tp_tensao": ns(tp), "modalidade": ns(modal), "medidor": ns(med),
			"link": ns(link), "rs_total_fatura": nf(rsTot),
			"flag_f01": ni(f01), "flag_f02": ni(f02), "flag_f03": ni(f03), "flag_f04": ni(f04), "flag_f05": ni(f05),
			"segmentos_f01": ns(segF01), "segmentos_f02": ns(segF02), "status_f02": ns(statF02),
			"desvio_pct_max_f02": nf(desv), "media_f02": nf(media), "consumo_atual_f02": nf(consAtu),
			"serie_f02": ns(serie), "veredito_seg_f02": ns(veredSeg), "veredito_f02": ns(vered),
			"detalhe_f04": ns(detF04), "detalhe_f05": ns(detF05), "fichas_aplicadas": ns(fich),
		})
	}
	c.JSON(http.StatusOK, out)
}

// ListEmpresasApontamentosOrigem — GET /api/v1/desvio/origem/empresas
func ListEmpresasApontamentosOrigem(c *gin.Context) {
	db, err := sqlDBApp()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	rows, qErr := db.Query(`SELECT Cod_Empresa, MAX(Concessionaria), COUNT(*),
		SUM(veredito_f02='ANOMALIA'), SUM(flag_f01=1), SUM(flag_f05=1)
		FROM apontamentos_desvio_origem WHERE Cod_Empresa IS NOT NULL
		GROUP BY Cod_Empresa ORDER BY COUNT(*) DESC`)
	if qErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": qErr.Error()})
		return
	}
	defer rows.Close()
	res := []map[string]interface{}{}
	for rows.Next() {
		var cod, qtd, anom, f01, f05 sql.NullInt64
		var conc sql.NullString
		if rows.Scan(&cod, &conc, &qtd, &anom, &f01, &f05) != nil {
			continue
		}
		res = append(res, map[string]interface{}{
			"cod_empresa": cod.Int64, "concessionaria": conc.String,
			"qtd": qtd.Int64, "anomalia": anom.Int64, "f01": f01.Int64, "f05": f05.Int64,
		})
	}
	c.JSON(http.StatusOK, res)
}

// ResumoApontamentosOrigem — GET /api/v1/desvio/origem/resumo
func ResumoApontamentosOrigem(c *gin.Context) {
	db, err := sqlDBApp()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	r := map[string]interface{}{}
	row := db.QueryRow(`SELECT COUNT(*),
		SUM(flag_f01=1), SUM(flag_f02=1), SUM(flag_f04=1), SUM(flag_f05=1),
		SUM(veredito_f02='ANOMALIA'), SUM(veredito_f02='ATIVACAO'), SUM(veredito_f02='INFORMAR')
		FROM apontamentos_desvio_origem`)
	var tot, f01, f02, f04, f05, anom, ativ, inf sql.NullInt64
	if row.Scan(&tot, &f01, &f02, &f04, &f05, &anom, &ativ, &inf) == nil {
		r = map[string]interface{}{"total": tot.Int64, "f01": f01.Int64, "f02": f02.Int64,
			"f04": f04.Int64, "f05": f05.Int64, "anomalia": anom.Int64, "ativacao": ativ.Int64, "informar": inf.Int64}
	}
	c.JSON(http.StatusOK, r)
}
