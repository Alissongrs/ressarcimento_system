package v2

// Status × histórico (melhoria 3): lista os processos cujo espelho (FT_PROCESSOS) não bate
// com a última movimentação e corrige um a um, com backup. Só administradores.
//
//   GET  /api/v2/divergencias/status            → { total, itens: [...] }
//   POST /api/v2/divergencias/status/corrigir   { id_processo, direcao } → { ok }

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"ressarcimento-backend/services"
)

func exigeAdmin(c *gin.Context) bool {
	if adm, _ := c.Get("isAdmin"); adm == true {
		return true
	}
	apiError(c, http.StatusForbidden, "SEM_PERMISSAO", "Só administradores podem ver e corrigir divergências de status.", nil)
	return false
}

func ListarDivergenciasStatus(c *gin.Context) {
	db := requireDB(c)
	if db == nil || !exigeAdmin(c) {
		return
	}
	lista, err := services.ListarDivergencias(c.Request.Context(), db)
	if err != nil {
		apiError(c, http.StatusInternalServerError, "DB_ERR", err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"total": len(lista), "itens": lista})
}

type corrigirDivergenciaReq struct {
	IDProcesso int    `json:"id_processo"`
	Direcao    string `json:"direcao"` // "historico" | "processo"
}

func CorrigirDivergenciaStatus(c *gin.Context) {
	db := requireDB(c)
	if db == nil || !exigeAdmin(c) {
		return
	}
	var in corrigirDivergenciaReq
	if !bindJSON(c, &in) {
		return
	}
	if in.IDProcesso <= 0 {
		apiError(c, http.StatusBadRequest, "CAMPO_OBRIGATORIO", "id_processo é obrigatório", nil)
		return
	}
	if err := services.CorrigirDivergencia(c.Request.Context(), db, in.IDProcesso, in.Direcao, resolverUsuarioV2(c, db)); err != nil {
		apiError(c, http.StatusBadRequest, "RECONCILIACAO", err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
