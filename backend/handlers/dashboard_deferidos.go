package handlers

import (
	"database/sql"
	"log"
	"net/http"

	"ressarcimento-backend/database"

	"github.com/gin-gonic/gin"
)

type deferidoRow struct {
	Cliente            sql.NullString
	Concessionaria     sql.NullString
	CreditoSimples     sql.NullFloat64
	CreditoDobro       sql.NullFloat64
	DataProcedenciaSim sql.NullString
	DataProcedenciaDob sql.NullString
	Obs                sql.NullString
	Responsavel        sql.NullString
	Status             sql.NullString
	Unidade            sql.NullString
}

func GetDashboardDeferidos(c *gin.Context) {
	query := `
SELECT
  COALESCE(r.cliente, '')                AS cliente,
  COALESCE(r.concessionaria, '')         AS concessionaria,
  COALESCE(d.credito_simples, 0)         AS credito_simples,
  COALESCE(d.credito_dobro, 0)           AS credito_dobro,
  DATE_FORMAT(d.data_procedencia, '%Y-%m-%d')     AS data_procedencia_simples,
  DATE_FORMAT(d.data_credito_dobro, '%Y-%m-%d')   AS data_procedencia_dobro,
  COALESCE(r.descricao_irregularidade, '') AS obs,
  COALESCE(u.nome_usuario, '')             AS responsavel,
  COALESCE(s.status, '')                   AS status,
  COALESCE(r.uc, '')                       AS unidade
FROM FT_DEFERIMENTOS d
JOIN FT_PROCESSOS p ON p.id_processo = d.id_processo
LEFT JOIN FT_REQUISICOES r ON r.id_requisicao = d.id_processo
LEFT JOIN DM_STATUS s ON s.id_status = r.id_status
LEFT JOIN DM_USUARIO u ON u.id_usuario = p.id_responsavel
`
	rows, err := database.DB_App.Query(query)
	if err != nil {
		log.Printf("[dashboard] deferidos query failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falha ao carregar deferidos"})
		return
	}
	defer rows.Close()

	totalCredito := 0.0
	statusCounts := map[string]int{}
	statusCredit := map[string]float64{}
	concessionariaMap := map[string]struct {
		Concessionaria string
		Count          int
		Credito        float64
	}{}
	details := make([]map[string]any, 0)
	bars := make([]map[string]any, 0)

	for rows.Next() {
		var r deferidoRow
		if err := rows.Scan(
			&r.Cliente,
			&r.Concessionaria,
			&r.CreditoSimples,
			&r.CreditoDobro,
			&r.DataProcedenciaSim,
			&r.DataProcedenciaDob,
			&r.Obs,
			&r.Responsavel,
			&r.Status,
			&r.Unidade,
		); err != nil {
			continue
		}
		credito := 0.0
		if r.CreditoSimples.Valid {
			credito += r.CreditoSimples.Float64
		}
		if r.CreditoDobro.Valid {
			credito += r.CreditoDobro.Float64
		}
		totalCredito += credito
		status := "Desconhecido"
		if r.Status.Valid && r.Status.String != "" {
			status = r.Status.String
		}
		statusCounts[status]++
		statusCredit[status] += credito

		conc := "Sem Concessionária"
		if r.Concessionaria.Valid && r.Concessionaria.String != "" {
			conc = r.Concessionaria.String
		}
		entry := concessionariaMap[conc]
		entry.Concessionaria = conc
		entry.Count++
		entry.Credito += credito
		concessionariaMap[conc] = entry

		cliente := ""
		if r.Cliente.Valid {
			cliente = r.Cliente.String
		}
		details = append(details, map[string]any{
			"cliente":                  cliente,
			"concessionaria":           conc,
			"credito":                  credito,
			"credito_simples":          r.CreditoSimples.Float64,
			"credito_dobro":            r.CreditoDobro.Float64,
			"data_procedencia_simples": r.DataProcedenciaSim.String,
			"data_procedencia_dobro":   r.DataProcedenciaDob.String,
			"observacao":               r.Obs.String,
			"responsavel":              r.Responsavel.String,
			"status":                   status,
			"unidade":                  r.Unidade.String,
		})
		bars = append(bars, map[string]any{
			"cliente":        cliente,
			"concessionaria": conc,
			"credito":        credito,
		})
	}

	concessionarias := make([]map[string]any, 0, len(concessionariaMap))
	for _, v := range concessionariaMap {
		concessionarias = append(concessionarias, map[string]any{
			"concessionaria": v.Concessionaria,
			"count":          v.Count,
			"credito":        v.Credito,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"total_credito":   totalCredito,
		"status_counts":   statusCounts,
		"status_creditos": statusCredit,
		"concessionarias": concessionarias,
		"detalhes":        details,
		"barra":           bars,
	})
}
