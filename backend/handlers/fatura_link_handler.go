package handlers

// Busca automática do link da fatura por (UC + período) no sgeeasy
// (Faturas_Registradas_Cache). Tolerante ao formato da UC: no sgeeasy a UC pode vir
// com sufixo (ex.: "585359105940 - DDG"), então casamos por dígitos (prefixo).
//
//   GET /api/v1/faturas/link-sgeeasy?uc=<uc>&periodo=YYYY-MM
//
// Retorna { uc, periodo, uid, link, cod_empresa, mes_ref }.

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/database"
)

// somenteDigitos devolve apenas os dígitos de s.
func somenteDigitos(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// normalizaPeriodoYYYYMM aceita "2026-06", "2026-06-01", "06/2026" e devolve "2026-06".
func normalizaPeriodoYYYYMM(s string) string {
	s = strings.TrimSpace(s)
	if m := reISOData.FindStringSubmatch(s); m != nil { // ^(YYYY)-(MM)
		return m[1] + "-" + fmt02int(m[2])
	}
	if m := reBRMesAno.FindStringSubmatch(s); m != nil { // ^(MM)/(YYYY)$
		return m[2] + "-" + fmt02int(m[1])
	}
	return s
}

func fmt02int(s string) string {
	s = strings.TrimSpace(s)
	if len(s) == 1 {
		return "0" + s
	}
	return s
}

func BuscarLinkFaturaSgeeasy(c *gin.Context) {
	ucDig := somenteDigitos(c.Query("uc"))
	periodo := normalizaPeriodoYYYYMM(c.Query("periodo"))
	if ucDig == "" || periodo == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe uc e periodo (YYYY-MM)"})
		return
	}
	if database.GormDB_Faturas == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "conexão sgeeasy indisponível"})
		return
	}
	sqlDB, err := database.GormDB_Faturas.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Casa por dígitos da UC (prefixo) + mês. Pega o registro mais recente com link.
	var uid, uc, mesRef, link, razao sql.NullString
	var cod sql.NullInt64
	// Casa por dígitos da UC (prefixo) OU pela lista de UCs anteriores (UCs_Anteriores),
	// porque a UC pode ter mudado de número ao longo do tempo.
	e := sqlDB.QueryRow(`
		SELECT uid, UC, Cod_Empresa, Mes_Ref, Link, RAZAO_SOCIAL
		  FROM Faturas_Registradas_Cache
		 WHERE (
		        REPLACE(REPLACE(REPLACE(UC,' ',''),'-',''),'.','') LIKE CONCAT(?, '%')
		     OR REPLACE(REPLACE(REPLACE(COALESCE(UCs_Anteriores,''),' ',''),'-',''),'.','') LIKE CONCAT('%', ?, '%')
		   )
		   AND Mes_Ref LIKE CONCAT(?, '%')
		   AND Link IS NOT NULL AND TRIM(Link) <> ''
		 ORDER BY id DESC
		 LIMIT 1`, ucDig, ucDig, periodo).Scan(&uid, &uc, &cod, &mesRef, &link, &razao)
	if e == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{
			"error": "fatura não encontrada no sgeeasy para essa UC/período", "uc": ucDig, "periodo": periodo,
		})
		return
	}
	if e != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"uc":            uc.String,
		"periodo":       periodo,
		"mes_ref":       mesRef.String,
		"uid":           uid.String,
		"cod_empresa":   cod.Int64,
		"razao_social":  razao.String,
		"link":          link.String,
	})
}

// BuscarDadosUCSgeeasy — GET /api/v1/faturas/buscar-uc?uc=<uc>
// Usado na CRIAÇÃO de requisição: ao digitar a UC, busca no sgeeasy
// (Faturas_Registradas_Cache) por UC OU UCs_Anteriores (tolerante a formato) e
// devolve os dados do cliente pra preencher o formulário + a fatura mais recente.
func BuscarDadosUCSgeeasy(c *gin.Context) {
	ucDig := somenteDigitos(c.Query("uc"))
	if len(ucDig) < 4 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "informe a UC (mínimo 4 dígitos)"})
		return
	}
	if database.GormDB_Faturas == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "conexão sgeeasy indisponível"})
		return
	}
	sqlDB, err := database.GormDB_Faturas.DB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var uc, razao, conc, mesRef, link, uid sql.NullString
	var cod sql.NullInt64
	e := sqlDB.QueryRow(`
		SELECT UC, RAZAO_SOCIAL, Concessionaria, Cod_Empresa, Mes_Ref, Link, uid
		  FROM Faturas_Registradas_Cache
		 WHERE REPLACE(REPLACE(REPLACE(UC,' ',''),'-',''),'.','') LIKE CONCAT(?, '%')
		    OR REPLACE(REPLACE(REPLACE(COALESCE(UCs_Anteriores,''),' ',''),'-',''),'.','') LIKE CONCAT('%', ?, '%')
		 ORDER BY Mes_Ref DESC, id DESC
		 LIMIT 1`, ucDig, ucDig).Scan(&uc, &razao, &conc, &cod, &mesRef, &link, &uid)
	if e == sql.ErrNoRows {
		c.JSON(http.StatusNotFound, gin.H{"error": "UC não encontrada no sgeeasy", "uc": ucDig})
		return
	}
	if e != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"uc":               uc.String,
		"razao_social":     razao.String,
		"cliente":          razao.String,
		"concessionaria":   conc.String,
		"cod_empresa":      cod.Int64,
		"ultimo_mes_ref":   mesRef.String,
		"ultimo_link":      link.String,
		"uid":              uid.String,
	})
}
