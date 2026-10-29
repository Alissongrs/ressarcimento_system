package handlers

// Handler dedicado da ACER (empresa 2028). Fonte: FATURA_ACER_DADOS_EXTRAIDOS (espelho
// da FDE, populado pelo normalizador JSON). Reaproveita o MESMO motor (motorApontamentosCachedT
// / AvaliarDesvio) apontado para a tabela da Acer — mesma lógica de apontamento do resto do
// sistema, só muda a tabela de origem. Métricas (cards) são agregação em Go sobre os
// apontamentos do motor + atributos por id (query na tabela Acer).
//
//   GET /api/v1/acer/resumo        -> cards (unidades, faturas, ressarcimento estimado, por ficha/dist)
//   GET /api/v1/acer/apontamentos  -> lista paginada dos apontamentos Acer

import (
	"database/sql"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

const acerTabela = "FATURA_ACER_DADOS_EXTRAIDOS"

func acerRound2(x float64) float64 { return math.Round(x*100) / 100 }

// acerRessEstimado — ressarcimento estimado da Acer SEM o fator de retenção (100%, valor cheio).
// (A FDE usa ressEstimadoDesvio, que aplica -42%; a Acer é 100% por decisão do usuário.)
func acerRessEstimado(energia, desvioPct float64) float64 {
	d := desvioPct / 100.0
	if energia > 0 && d > 0 {
		return energia * (d / (1 + d))
	}
	return 0
}

// acerApontamentoValido — na Acer, F01 (cross-check leitura×faturado) é RUÍDO: a extração
// do .pdf.json captura leitura de forma inconsistente (leit. anterior 0 em troca de medidor,
// multi-medidor, leitura garglada) → F01 falso em massa. Só consideramos apontamento real
// se disparou F02/F04/F05 (desvio de consumo). Fichas F01-only são descartadas.
func acerApontamentoValido(fichas []string) bool {
	for _, f := range fichas {
		switch strings.ToUpper(strings.TrimSpace(f)) {
		case "F02", "F03", "F04", "F05":
			return true
		}
	}
	return false
}

// atributos de uma fatura Acer usados nas métricas/lista
type acerAttr struct {
	energia float64
	total   float64
	dist    string
	uc      string
	mes     string
	kwh     float64
	grupo   string
	link    string
	uid     string
}

func acerCarregarAtributos(sqlDB *sql.DB, ids []string) map[int64]acerAttr {
	out := map[int64]acerAttr{}
	if len(ids) == 0 {
		return out
	}
	q := `SELECT id,
	             COALESCE(valor_energia_ativa,0),
	             COALESCE(valor_total_fatura,0),
	             COALESCE(TRIM(distribuidora),''),
	             COALESCE(TRIM(numero_instalacao),''),
	             COALESCE(mes_referencia,''),
	             COALESCE(kwh_total,0),
	             COALESCE(TRIM(grupo_tarifario),''),
	             COALESCE(link_fatura,''),
	             COALESCE(uid,'')
	      FROM ` + acerTabela + ` WHERE id IN (` + strings.Join(ids, ",") + `)`
	rows, err := sqlDB.Query(q)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var a acerAttr
		if rows.Scan(&id, &a.energia, &a.total, &a.dist, &a.uc, &a.mes, &a.kwh, &a.grupo, &a.link, &a.uid) == nil {
			out[id] = a
		}
	}
	return out
}

// GetAcerResumo — GET /api/v1/acer/resumo
// Cards da aba Acer: totais do parque Acer + apontamentos do motor + ressarcimento estimado.
func GetAcerResumo(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	var totalFaturas, totalUCs int64
	_ = sqlDB.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT NULLIF(TRIM(numero_instalacao),'')) FROM ` + acerTabela).
		Scan(&totalFaturas, &totalUCs)

	apont, mErr := motorApontamentosCachedT(sqlDB, "", true, acerTabela)
	if mErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no motor: " + mErr.Error()})
		return
	}
	resp := gin.H{
		"total_faturas":          totalFaturas,
		"total_ucs":              totalUCs,
		"faturas_apontadas":      0,
		"ucs_apontadas":          0,
		"ressarcimento_estimado": 0.0,
		"por_ficha":              gin.H{},
		"por_distribuidora":      []gin.H{},
	}
	if len(apont) == 0 {
		c.JSON(http.StatusOK, resp)
		return
	}

	ids := make([]string, 0, len(apont))
	for id := range apont {
		ids = append(ids, strconv.FormatInt(id, 10))
	}
	attr := acerCarregarAtributos(sqlDB, ids)

	var ress float64
	porFicha := map[string]int{}
	type dagg struct {
		n    int
		ress float64
	}
	porDist := map[string]*dagg{}
	ucsApont := map[string]bool{}
	nValid := 0
	for id, mr := range apont {
		if !acerApontamentoValido(mr.FichasAplicadas) {
			continue // F01-only = ruído de extração na Acer (troca de medidor / leitura garglada)
		}
		nValid++
		a := attr[id]
		energia := a.energia
		if energia <= 0 {
			energia = a.total
		}
		r := acerRessEstimado(energia, mr.DesvioPctMax)
		ress += r
		for _, f := range mr.FichasAplicadas {
			porFicha[strings.ToUpper(f)]++
		}
		d := a.dist
		if d == "" {
			d = "(sem distribuidora)"
		}
		g := porDist[d]
		if g == nil {
			g = &dagg{}
			porDist[d] = g
		}
		g.n++
		g.ress += r
		if a.uc != "" {
			ucsApont[a.uc] = true
		}
	}

	distList := make([]gin.H, 0, len(porDist))
	for d, g := range porDist {
		distList = append(distList, gin.H{"distribuidora": d, "apontamentos": g.n, "ressarcimento": acerRound2(g.ress)})
	}
	sort.Slice(distList, func(i, j int) bool {
		return distList[i]["ressarcimento"].(float64) > distList[j]["ressarcimento"].(float64)
	})
	if len(distList) > 20 {
		distList = distList[:20]
	}

	resp["faturas_apontadas"] = nValid
	resp["ucs_apontadas"] = len(ucsApont)
	resp["ressarcimento_estimado"] = acerRound2(ress)
	resp["por_ficha"] = porFicha
	resp["por_distribuidora"] = distList
	c.JSON(http.StatusOK, resp)
}

// GetAcerUCHistorico — GET /api/v1/acer/uc-historico?uc=<numero_instalacao>
// Série de consumo (todas as faturas da UC na base Acer) p/ o gráfico "Analisar UC".
func GetAcerUCHistorico(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}
	uc := strings.TrimSpace(c.Query("uc"))
	if uc == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "uc obrigatório"})
		return
	}
	q := `SELECT DATE_FORMAT(mes_referencia,'%Y-%m') AS mes,
	             COALESCE(kwh_total,0), COALESCE(valor_energia_ativa,0),
	             COALESCE(valor_total_fatura,0), COALESCE(link_fatura,''),
	             COALESCE(TRIM(distribuidora),''), COALESCE(TRIM(grupo_tarifario),'')
	      FROM ` + acerTabela + `
	      WHERE numero_instalacao = ? AND mes_referencia IS NOT NULL
	      ORDER BY mes_referencia`
	rows, qErr := sqlDB.Query(q, uc)
	if qErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro na consulta: " + qErr.Error()})
		return
	}
	defer rows.Close()
	out := make([]gin.H, 0, 24)
	for rows.Next() {
		var mes, link, dist, grupo string
		var kwh, ea, total float64
		if rows.Scan(&mes, &kwh, &ea, &total, &link, &dist, &grupo) == nil {
			out = append(out, gin.H{
				"mes": mes, "kwh_total": kwh, "valor_energia_ativa": ea,
				"valor_total_fatura": total, "link_fatura": link, "distribuidora": dist, "grupo_tarifario": grupo,
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"uc": uc, "historico": out})
}

// GetAcerApontamentos — GET /api/v1/acer/apontamentos?limit=&offset=&ficha=&dist=
// Lista paginada dos apontamentos do motor sobre a tabela Acer, ordenada por ressarcimento desc.
func GetAcerApontamentos(c *gin.Context) {
	db := database.GormDB_App
	if db == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "banco indisponível"})
		return
	}
	sqlDB, err := db.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro ao obter conexão"})
		return
	}

	limit := 200
	if v, e := strconv.Atoi(strings.TrimSpace(c.DefaultQuery("limit", "200"))); e == nil && v > 0 && v <= 1000 {
		limit = v
	}
	offset := 0
	if v, e := strconv.Atoi(strings.TrimSpace(c.DefaultQuery("offset", "0"))); e == nil && v >= 0 {
		offset = v
	}
	fichaSel := strings.ToUpper(strings.TrimSpace(c.Query("ficha")))
	distSel := strings.ToUpper(strings.TrimSpace(c.Query("dist")))

	apont, mErr := motorApontamentosCachedT(sqlDB, "", true, acerTabela)
	if mErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "erro no motor: " + mErr.Error()})
		return
	}
	ids := make([]string, 0, len(apont))
	for id := range apont {
		ids = append(ids, strconv.FormatInt(id, 10))
	}
	attr := acerCarregarAtributos(sqlDB, ids)

	rowsOut := make([]gin.H, 0, len(apont))
	for id, mr := range apont {
		if !acerApontamentoValido(mr.FichasAplicadas) {
			continue // F01-only = ruído de extração na Acer
		}
		a := attr[id]
		if fichaSel != "" {
			has := false
			for _, f := range mr.FichasAplicadas {
				if strings.ToUpper(f) == fichaSel {
					has = true
					break
				}
			}
			if !has {
				continue
			}
		}
		if distSel != "" && !strings.Contains(strings.ToUpper(a.dist), distSel) {
			continue
		}
		energia := a.energia
		if energia <= 0 {
			energia = a.total
		}
		rowsOut = append(rowsOut, gin.H{
			"id":                     id,
			"uid":                    a.uid,
			"uc":                     a.uc,
			"numero_instalacao":      a.uc,
			"fonte":                  "acer",
			"distribuidora":          a.dist,
			"mes_ref":                a.mes,
			"grupo_tarifario":        a.grupo,
			"kwh_total":              a.kwh,
			"valor_energia_ativa":    energia,
			"desvio_pct_max":         mr.DesvioPctMax,
			"fichas_aplicadas":       strings.Join(mr.FichasAplicadas, ","),
			"classe_desvio":          mr.ClasseDesvio,
			"ressarcimento_estimado": acerRound2(acerRessEstimado(energia, mr.DesvioPctMax)),
			"link_fatura":            a.link,
		})
	}
	sort.Slice(rowsOut, func(i, j int) bool {
		return rowsOut[i]["ressarcimento_estimado"].(float64) > rowsOut[j]["ressarcimento_estimado"].(float64)
	})

	total := len(rowsOut)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	c.JSON(http.StatusOK, gin.H{"rows": rowsOut[offset:end], "total": total, "count": end - offset})
}
