package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"ressarcimento-backend/database"
)

// GetEtapaSubCombinacoes retorna combinaÃ§Ãµes vÃ¡lidas etapa -> sub_etapas.
// PreferÃªncia: DM_ETAPA_SUBETAPAS_VALIDAS; fallback: pares observados em FT_PROCESSOS.
func GetEtapaSubCombinacoes(c *gin.Context) {
	db := database.DB_App
	if db == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "DB not initialized"})
		return
	}

	// Tenta via tabelas de domÃ­nio (se existirem)
	rows, err := db.Query(`
        SELECT e.etapa AS nome_etapa, s.sub_etapa AS nome_subetapa
          FROM DM_ETAPA_SUBETAPAS_VALIDAS v
          JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = v.id_etapa_processo
          JOIN DM_SUBETAPA_PROCESSOS s ON s.id_subetapa = v.id_subetapa
         ORDER BY e.etapa, s.sub_etapa`)
	if err != nil {
		rows = nil
	}
	type pair struct{ etapa, sub string }
	pairs := make([]pair, 0, 128)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var e, s string
			if err := rows.Scan(&e, &s); err == nil && e != "" && s != "" {
				pairs = append(pairs, pair{e, s})
			}
		}
	}
	if len(pairs) == 0 {
		// Fallback: observar pares existentes em processos
		rows2, err2 := db.Query(`
            SELECT DISTINCT e.etapa AS nome_etapa, p.sub_etapa AS nome_subetapa
              FROM FT_PROCESSOS p
              JOIN DM_ETAPAS_PROCESSO e ON e.id_etapa_processo = p.id_etapa_processo
             WHERE p.sub_etapa IS NOT NULL AND TRIM(p.sub_etapa) <> ''
             ORDER BY e.etapa, p.sub_etapa`)
		if err2 != nil {
			c.JSON(http.StatusOK, gin.H{"map": gin.H{}})
			return
		}
		defer rows2.Close()
		for rows2.Next() {
			var e, s string
			if err := rows2.Scan(&e, &s); err == nil && e != "" && s != "" {
				pairs = append(pairs, pair{e, s})
			}
		}
	}

	out := make(map[string][]string)
	for _, p := range pairs {
		out[p.etapa] = append(out[p.etapa], p.sub)
	}

	// Regras de negÃ³cio: garantir subetapas do Fluxo de Ressarcimento
	ensure := func(m map[string][]string, etapa string, subs ...string) {
		cur := m[etapa]
		exists := func(s string) bool {
			for _, x := range cur {
				if strings.EqualFold(strings.TrimSpace(x), strings.TrimSpace(s)) {
					return true
				}
			}
			return false
		}
		for _, s := range subs {
			if s == "" {
				continue
			}
			if !exists(s) {
				cur = append(cur, s)
			}
		}
		m[etapa] = cur
	}
	ensure(out, "Fluxo de Ressarcimento", "Enviado ao Financeiro", "Enviado")
	c.JSON(http.StatusOK, gin.H{"map": out})
}

