package handlers

// Faturas Claro pelo portal PDP (Accenture) — apoio do backend ao módulo Claro da extensão do SURE.
// A extensão faz login, baixa os zips novos e entrega ao processamento local (C:\claro_bf); o backend só
// (1) devolve o código de segurança que o portal mandou por e-mail e (2) informa a situação da base.

import (
	"database/sql"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/services"
)

// GET /api/v1/claro-pdp/codigo?desde=<ms desde 1970 | RFC3339>
// → {"codigo":"837376","recebido_em":"..."} ou {"codigo":""} se ainda não chegou.
func CodigoPDPClaroHandler(c *gin.Context) {
	desde := time.Now().Add(-10 * time.Minute)
	if v := c.Query("desde"); v != "" {
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil && ms > 0 {
			desde = time.UnixMilli(ms)
		} else if t, err := time.Parse(time.RFC3339, v); err == nil {
			desde = t
		}
	}
	// tolerância de relógio entre o computador e o servidor de e-mail
	desde = desde.Add(-90 * time.Second)
	if time.Since(desde) > 2*time.Hour {
		desde = time.Now().Add(-2 * time.Hour)
	}
	cod, rec, _, err := services.CodigoPDPClaro(desde)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "não consegui ler o e-mail do código: " + err.Error()})
		return
	}
	out := gin.H{"codigo": cod}
	if cod != "" {
		out["recebido_em"] = rec.Format(time.RFC3339)
	}
	c.JSON(http.StatusOK, out)
}

// situacaoClaro — mesma resposta de /tarefas-vps/situacao para a base Claro (FATURA_CLARO_DADOS_EXTRAIDOS).
// A tabela tem ~1,5 mi de linhas e processado_em não tem índice: olha só a janela das linhas mais novas
// pelo id (as cargas entram em ordem), o que cobre folgado os últimos 30 dias.
func situacaoClaro(c *gin.Context, db *sql.DB) {
	var maxID sql.NullInt64
	_ = db.QueryRow(`SELECT MAX(id) FROM FATURA_CLARO_DADOS_EXTRAIDOS`).Scan(&maxID)
	var ult sql.NullString
	var d1, d7, d30 sql.NullInt64
	_ = db.QueryRow(`SELECT DATE_FORMAT(MAX(processado_em),'%Y-%m-%dT%H:%i:%s'),
		SUM(processado_em >= NOW() - INTERVAL 1 DAY), SUM(processado_em >= NOW() - INTERVAL 7 DAY),
		SUM(processado_em >= NOW() - INTERVAL 30 DAY)
		FROM FATURA_CLARO_DADOS_EXTRAIDOS WHERE id > ?`, maxID.Int64-400000).Scan(&ult, &d1, &d7, &d30)
	dias := -1
	if t, err := time.Parse("2006-01-02T15:04:05", ult.String); err == nil {
		dias = int(time.Since(t).Hours() / 24)
	}
	c.JSON(http.StatusOK, gin.H{
		"ultima": ult.String, "dias_sem_entrar": dias,
		"d1": d1.Int64, "d7": d7.Int64, "d30": d30.Int64, "por_empresa_30d": []situacaoEmpresa{},
	})
}
