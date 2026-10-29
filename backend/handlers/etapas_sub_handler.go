package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetEtapaSubCombinacoes — DESABILITADO no V2.
//
// TODO V2: DM_SUBETAPA_PROCESSOS foi removida na migração V2. O conceito de
// "sub-etapa" virou `id_status_atual` (DM_STATUS_PROCESSO), aplicado a qualquer
// (instância, etapa). Por isso não há mais um mapa fixo etapa→subetapa.
// Os consumidores devem usar GET /api/v2/dimensoes (retorna status, instancias, etapas).
//
// Mantemos o endpoint vivo retornando struct vazia pra não quebrar callers legados.
// @Router /api/v1/filtros/etapas-subetapas [get]
func GetEtapaSubCombinacoes(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"map": gin.H{}})
}
