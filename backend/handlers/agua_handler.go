package handlers

// Auditoria de Faturas de Água — espelho leve do fluxo de energia (fde-analise), mas sobre
// os dados estruturados da FATURA_AGUA_DADOS + snapshot FATURA_APONTAMENTOS_AGUA_AUDITADOS.
// Fase 1: leitura (lista/resumo/histórico) + rejeição persistente. Sem OCR.

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

// GET /api/v1/faturas/agua-analise?empresa=&ficha=&limit=&offset=
// Lista apontamentos de água (exclui os rejeitados). aba padrão = apontados.
func ListAguaAnalise(c *gin.Context) {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	where := []string{"1=1"}
	args := []interface{}{}
	if e := strings.TrimSpace(c.Query("empresa")); e != "" {
		where = append(where, "a.cod_empresa = ?")
		args = append(args, e)
	}
	if f := strings.TrimSpace(c.Query("ficha")); f != "" {
		where = append(where, "a.ficha = ?")
		args = append(args, f)
	}
	// exclui rejeitados (tabela própria da água)
	where = append(where, "NOT EXISTS (SELECT 1 FROM FATURA_AGUA_REJEICOES r WHERE r.id = a.id)")
	limit := 200
	if l, e := strconv.Atoi(c.Query("limit")); e == nil && l > 0 && l <= 2000 {
		limit = l
	}
	offset, _ := strconv.Atoi(c.Query("offset"))

	q := `SELECT a.id, a.cod_empresa, a.cod_uc, a.uc, a.concessionaria,
	         DATE_FORMAT(a.mes_referencia,'%Y-%m-%d') mes, a.consumo_m3, a.mediana_m3, a.n_meses,
	         a.desvio_pct, a.ficha, a.base_rs, a.ressarcimento_estimado, a.link_fatura,
	         COALESCE(d.cidade,''), COALESCE(d.uf,''), COALESCE(d.apelido,''),
	         COALESCE(te.Rz_Social, CONCAT('Empresa ', a.cod_empresa)),
	         COALESCE(cf.veredito,''), COALESCE(cf.observacao,''), COALESCE(cf.causa,''), COALESCE(cf.recalcular,0), COALESCE(cf.evidencia,''), COALESCE(cf.texto_aviso,'')
	       FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS a
	       LEFT JOIN FATURA_AGUA_CONFERENCIA cf ON cf.id = a.id
	       LEFT JOIN FATURA_AGUA_DADOS d ON d.cod_empresa = a.cod_empresa AND d.cod_uc = a.cod_uc AND d.mes_referencia = a.mes_referencia
	       LEFT JOIN Tab_Empresa te ON te.Cod_Empresa = a.cod_empresa
	       WHERE ` + strings.Join(where, " AND ") +
		` ORDER BY a.ressarcimento_estimado DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)

	rows, err := sqlDB.Query(q, args...)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := make([]gin.H, 0, limit)
	for rows.Next() {
		var id, codEmp, codUC, nMeses int64
		var uc, conc, mes, ficha, link, cidade, uf, apelido, clienteNome, veredito, obsConf, causa, evidencia, textoAviso sql.NullString
		var recalcular sql.NullBool
		var consumo, mediana, desvio, base, est sql.NullFloat64
		if err := rows.Scan(&id, &codEmp, &codUC, &uc, &conc, &mes, &consumo, &mediana, &nMeses,
			&desvio, &ficha, &base, &est, &link, &cidade, &uf, &apelido, &clienteNome, &veredito, &obsConf, &causa, &recalcular, &evidencia, &textoAviso); err != nil {
			continue
		}
		out = append(out, gin.H{
			"id": id, "cod_empresa": codEmp, "cod_uc": codUC, "uc": uc.String,
			"concessionaria": conc.String, "mes_referencia": mes.String,
			"consumo_m3": consumo.Float64, "mediana_m3": mediana.Float64, "n_meses": nMeses,
			"desvio_pct": desvio.Float64, "ficha": ficha.String, "base_rs": base.Float64,
			"ressarcimento_estimado": est.Float64, "link_fatura": link.String,
			"cidade": cidade.String, "uf": uf.String, "apelido": apelido.String,
			"cliente_nome": clienteNome.String,
			"conferencia":  veredito.String, "conferencia_obs": obsConf.String,
			"conferencia_causa": causa.String, "conferencia_recalcular": recalcular.Bool,
			"conferencia_evidencia": evidencia.String, "conferencia_aviso": textoAviso.String,
		})
	}
	c.JSON(http.StatusOK, gin.H{"faturas": out, "n": len(out)})
}

// GET /api/v1/faturas/agua-analise/resumo?empresa=  → KPIs
func GetAguaResumo(c *gin.Context) {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	cond := "NOT EXISTS (SELECT 1 FROM FATURA_AGUA_REJEICOES r WHERE r.id = a.id)"
	args := []interface{}{}
	if e := strings.TrimSpace(c.Query("empresa")); e != "" {
		cond += " AND a.cod_empresa = ?"
		args = append(args, e)
	}
	var nApont, nUC int64
	var totalRS sql.NullFloat64
	_ = sqlDB.QueryRow("SELECT COUNT(*), COUNT(DISTINCT a.cod_uc), COALESCE(SUM(a.ressarcimento_estimado),0) "+
		"FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS a WHERE "+cond, args...).Scan(&nApont, &nUC, &totalRS)

	empresas := []gin.H{}
	// nome vem do Tab_Empresa (JOIN); fallback "Empresa <cod>" se não cadastrada.
	er, e := sqlDB.Query("SELECT a.cod_empresa, COALESCE(te.Rz_Social, CONCAT('Empresa ', a.cod_empresa)) nome, " +
		"COUNT(*) n, COALESCE(SUM(a.ressarcimento_estimado),0) rs " +
		"FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS a " +
		"LEFT JOIN Tab_Empresa te ON te.Cod_Empresa = a.cod_empresa WHERE " +
		"NOT EXISTS (SELECT 1 FROM FATURA_AGUA_REJEICOES r WHERE r.id=a.id) " +
		"GROUP BY a.cod_empresa, te.Rz_Social ORDER BY rs DESC")
	if e == nil {
		defer er.Close()
		for er.Next() {
			var emp, n int64
			var nome sql.NullString
			var rs sql.NullFloat64
			if er.Scan(&emp, &nome, &n, &rs) == nil {
				empresas = append(empresas, gin.H{"cod_empresa": emp, "nome": nome.String, "n": n, "ressarcimento": rs.Float64})
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"apontamentos": nApont, "ucs": nUC, "ressarcimento_estimado": totalRS.Float64,
		"por_empresa": empresas,
	})
}

// GET /api/v1/faturas/agua/:id/historico  → série de consumo m³ da UC (para o gráfico)
func GetAguaHistorico(c *gin.Context) {
	id := c.Param("id")
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	// :id e o id do APONTAMENTO (FATURA_APONTAMENTOS_AGUA_AUDITADOS), NAO da FATURA_AGUA_DADOS.
	// As duas tabelas tem sequencias de id independentes — buscar a fatura por esse id cruzava com
	// outra unidade (mesmo numero de id por coincidencia). Pega cod_uc+cod_empresa do apontamento.
	var codUC, codEmp sql.NullInt64
	if e := sqlDB.QueryRow("SELECT cod_uc, cod_empresa FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE id=?", id).Scan(&codUC, &codEmp); e != nil || !codUC.Valid {
		c.JSON(http.StatusOK, gin.H{"historico": []gin.H{}})
		return
	}
	rows, err := sqlDB.Query(`SELECT id, DATE_FORMAT(mes_referencia,'%Y-%m') mes, consumo_m3, rs_total_fat, TRIM(link_fatura)
	  FROM FATURA_AGUA_DADOS WHERE cod_uc=? AND cod_empresa=? AND (COALESCE(consumo_m3,0)>0 OR COALESCE(rs_total_fat,0)>0)
	  ORDER BY mes_referencia`, codUC.Int64, codEmp.Int64)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	hist := []gin.H{}
	for rows.Next() {
		var id sql.NullInt64
		var mes, link sql.NullString
		var consumo, rs sql.NullFloat64
		if rows.Scan(&id, &mes, &consumo, &rs, &link) == nil {
			// sem_consumo: fatura com valor mas sem m³ no banco (a origem não trouxe o volume) — o pico
			// pode estar escondido aí; a tela marca o mês para conferir no PDF.
			hist = append(hist, gin.H{"id": id.Int64, "mes": mes.String, "consumo_m3": consumo.Float64, "rs_total": rs.Float64,
				"link_fatura": link.String, "sem_consumo": !consumo.Valid || consumo.Float64 == 0})
		}
	}
	c.JSON(http.StatusOK, gin.H{"cod_uc": codUC.Int64, "historico": hist})
}

// hosts de onde as faturas de água podem ser buscadas (o endpoint não vira proxy para qualquer URL)
var aguaPDFHosts = map[string]bool{"sgevia.com.br": true, "www.sgevia.com.br": true, "clientes.sgeeasy.com.br": true}

// GET /api/v1/faturas/agua/:id/pdf  — PDF da fatura do apontamento, servido inline para a tela mostrar o
// histórico/gráfico de consumo impresso (a prova do pico) sem o analista sair do sistema.
func GetAguaFaturaPDF(c *gin.Context) {
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	var link sql.NullString
	if e := sqlDB.QueryRow("SELECT TRIM(link_fatura) FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE id=?", c.Param("id")).Scan(&link); e != nil || link.String == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "apontamento sem link de fatura"})
		return
	}
	pdfs, err := baixarFaturasAgua(link.String)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// ?n=2 escolhe a 2ª fatura quando o link traz a página "1º Fatura / 2º Fatura"; X-Faturas diz quantas há
	n, _ := strconv.Atoi(c.DefaultQuery("n", "1"))
	if n < 1 || n > len(pdfs) {
		n = 1
	}
	c.Header("X-Faturas", strconv.Itoa(len(pdfs)))
	c.Header("Access-Control-Expose-Headers", "X-Faturas")
	c.Header("Content-Disposition", "inline; filename=fatura_agua.pdf")
	c.Data(http.StatusOK, "application/pdf", pdfs[n-1])
}

// POST /api/v1/faturas/agua/:id/rejeitar  { "motivo": "..." }
func RejeitarAguaApontamento(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Motivo string `json:"motivo"`
	}
	_ = c.ShouldBindJSON(&body)
	sqlDB, err := database.GormDB_App.DB()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	uid, uname := usuarioIA(c)
	// Tabela PRÓPRIA da água (FATURA_AGUA_REJEICOES) — SEM a FK da energia.
	// Antes gravava em FATURA_REANALISES, cuja FK exige fatura_id em FATURA_DADOS_EXTRAIDOS
	// (energia); id de água não existe lá → erro 1452. ON DUPLICATE cobre re-rejeição.
	if _, err := sqlDB.Exec(`INSERT INTO FATURA_AGUA_REJEICOES (id, motivo, usuario_id, usuario_nome, criado_em)
		VALUES (?, ?, ?, ?, NOW())
		ON DUPLICATE KEY UPDATE motivo=VALUES(motivo), usuario_id=VALUES(usuario_id), usuario_nome=VALUES(usuario_nome), criado_em=NOW()`,
		id, truncarIA(body.Motivo, 2000), uid, uname); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// remove imediatamente do snapshot vivo (mesma lógica da energia)
	_, _ = sqlDB.Exec("DELETE FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE id = ?", id)
	c.JSON(http.StatusOK, gin.H{"ok": true, "rejeitado": true})
}
